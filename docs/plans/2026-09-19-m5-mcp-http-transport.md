# MCP 客户端 HTTP 传输支持方案

## 一、背景和目标

### 现状（一句话）

当前项目的 MCP 客户端只能连「本地 stdio」类型的 MCP 服务器——用 `spawn` 启动一个子进程、读写它的标准输入输出。远程 HTTP 类型的 MCP 服务器（streamable-http）接不了。

### 目标

给 MCP 客户端增加一种新传输方式：**streamable-http**。改完后，既能连本地 stdio 服务器（现有能力不丢），也能连远程 HTTP 服务器。

### 实际要接的目标服务（RollingGo）

这是用户真正的目标，已从官方文档确认清楚：

| 项 | 值 |
|---|---|
| 酒店端点 | `https://mcp.rollinggo.cn/mcp` |
| 机票端点 | `https://mcp.rollinggo.cn/mcp/flight` |
| 传输协议 | streamable-http（HTTP POST） |
| 认证方式 | 请求头 `Authorization: Bearer mcp_xxx`（或 `X-Secret-Key: mcp_xxx`） |
| 酒店工具 | searchHotels / getHotelDetail / getHotelSearchTags |
| 机票工具 | searchAirports / searchFlights |
| 关键注意点 | cURL 必须带 `Accept: application/json, text/event-stream` 头，否则返回 400 |

RollingGo 的**协议版本**官方文档没有明说，标注为「待验证」——大概率是 `2025-06-18` 旧协议（因为要兼容 Claude Desktop / Cursor / Cline 这些还停在旧协议的客户端）。这意味着 **HTTP 传输必须同时支持旧协议的 initialize 握手**，不能只做 2026-07-28 新协议。

---

## 二、现状分析（代码层面）

核心文件是 [mcp.ts](file:///f:/allProject/myProject/blh-claude-code-ts/src/extensions/mcp.ts)，`MCPClient` 类目前 **stdio 是硬编码的**，体现在三处：

1. `start()` 里 `spawn(this.command, this.args, ...)` 启动子进程，并用 `createInterface` 挂 stdout 逐行读。
2. `send()` 里 `p.stdin.write(...)` 写标准输入。
3. 构造函数参数是 `command / args`（可执行文件路径），根本没有「URL」这个概念。

`MCPClient` 已经做好的、跟传输无关的部分可以复用：

- `pending` 表 + `nextId` 自增编号 + 超时机制（把「请求」和「响应」按 id 对上）。
- `modern / legacy` 双协议判断（server/discover 探测 → 失败回退 initialize）。
- `listTools()` / `callTool()` 的上层逻辑。

所以这次改动要**只把「传输」这一层抽出来**，别动上层工具逻辑。

---

## 三、设计方案

### 1. 抽出一个「传输」接口（核心改造）

把「怎么发消息、怎么收消息」这件事从 `MCPClient` 里剥出来，定义成一个接口。两个实现：

```
Transport（接口）
├── start()              建立连接（stdio 就 spawn，http 就准备好 fetch）
├── send(msg)            发一条 JSON-RPC 消息
├── close()              关闭连接
└── 通过回调把「收到的响应」交回给 MCPClient
```

- `StdioTransport`：现有逻辑原样搬过去（spawn + readline + stdin/stdout）。
- `HttpTransport`：新增，用 Node 全局 `fetch` 发 POST。

`MCPClient` 改成依赖 `Transport`，不再直接碰 `spawn` / `fetch`。这样 MCPClient 本身保持短小，两种传输各一个类，职责清晰。

> 设计理由：现在 `MCPClient` 约 255 行，加 HTTP 后如果还写在一个类里会逼近 500 行，且 stdio / http 两套逻辑纠缠。抽接口符合「可读性优先、激进拆分」的约定。

### 2. `HttpTransport` 的实现细节

**发送**：每个 JSON-RPC 请求/通知，都是一次独立的 `fetch POST` 到 URL。

必带的请求头（按 streamable-http 规范）：

| 头 | 值 | 说明 |
|---|---|---|
| `Content-Type` | `application/json` | 请求体是 JSON |
| `Accept` | `application/json, text/event-stream` | 告诉服务器两种响应都收 |
| `MCP-Protocol-Version` | 当前协议版本 | 比如 `2026-07-28` |
| `Mcp-Method` | 方法名 | 比如 `tools/call` |
| `Mcp-Name` | 工具名（仅 tools/call 等） | 比如 `searchHotels` |
| 用户自定义头 | 如 `Authorization: Bearer mcp_xxx` | 认证用 |

**接收**：看响应头 `Content-Type`：

- `application/json` → 直接 `res.json()` 拿到响应。
- `text/event-stream` → 解析 SSE 流，从 `data:` 行里找到带 `id` 的那条 JSON-RPC response。

**超时**：用 `AbortSignal.timeout()`，跟 stdio 的超时机制对齐。

### 3. 协议握手（HTTP 下的探测）

复用现有 `modern / legacy` 两套逻辑，只是「发送」走 HTTP 而不是 stdio：

- 先发 `server/discover`（带 2026-07-28 的 `_meta`），看结果：
  - 正常返回且支持版本 → 走 modern。
  - 返回 `-32022` → 服务器是新版但不支持这版协议，报错。
  - 返回 `-32601`（方法不存在）或 404 → 旧版服务器，回退 `initialize` 握手。
- 回退 `initialize` 时，发 `initialize`（2025-06-18）+ `notifications/initialized` 通知。

**session 管理（新增，stdio 没有的概念）**：旧协议的 streamable-http 服务器在 `initialize` 响应里可能返回 `Mcp-Session-Id` 头，要求客户端后续请求都带上。处理方式很简单：

1. `initialize` 响应里读 `Mcp-Session-Id`。
2. 有就存下来。
3. 后续每个 POST 都带 `Mcp-Session-Id: <值>`。

### 4. `connect_mcp` 工具参数扩展

现在只有 `name / command / args` 三个参数。扩展成两种连接方式二选一：

```
connect_mcp 参数：
  name      string  必填，服务器名（两种方式都要）
  command   string  可选，stdio 用（本地启动命令）
  args      array   可选，stdio 用（启动参数）
  url       string  可选，http 用（远程端点）
  headers   object  可选，http 用（自定义请求头，如 Authorization）
```

规则：`command` 和 `url` 二选一。有 `url` 就走 HTTP，否则走 stdio。

### 5. `MCPRegistry.connect` 的适配

`connect()` 现在固定 `new MCPClient(name, command, args)`。改成根据参数构造对应的 Transport，再传给 MCPClient。

---

## 四、需要你拍板的几个点

1. **传输抽象方式**：抽 `Transport` 接口两个实现（推荐，更清晰）；还是就在 `MCPClient` 里加 if 分支（改动小但会变臃肿）。—— 我推荐前者。

2. **协议版本范围**：必须 modern + legacy 都支持（因为 RollingGo 大概率是旧协议）。这个我认为没得选，必须做。

3. **SSE 响应支持**：规范要求客户端两种响应都收。工具调用最常见的是 JSON 响应，SSE 是流式场景。建议**先支持 JSON，SSE 解析也一并做**（成本不高），但不做长连接流（subscriptions/listen 那种）。

4. **认证只做「自定义 headers」**：不做 OAuth2 授权码流程（那是另一套复杂的东西，RollingGo 的免费 Bearer 模式不需要）。

---

## 五、改动文件清单

| 文件 | 改动 |
|---|---|
| `src/extensions/mcp-transport.ts`（新增） | `Transport` 接口 + `StdioTransport`（搬现有 stdio 逻辑）+ `HttpTransport`（新增）+ SSE 解析 |
| `src/extensions/mcp.ts` | `MCPClient` 改成依赖 Transport；`MCPRegistry` 新增 `connectHttp`、抽出公共 `connectClient` |
| `src/extensions/tools.ts` | `connect_mcp` 参数加 `url` / `headers` |
| `test/extensions/mcp.test.ts` | 更新 stdio 测试构造方式；新增 7 个 HTTP 传输测试 |

> 实现时把传输层单独拆到了 `mcp-transport.ts`，避免 `mcp.ts` 因塞入 stdio + http 两套逻辑而超过 500 行。

---

## 六、测试方案

测试要覆盖「HTTP 传输」这条新链路，同时保证「stdio 老链路」不被改坏。

### 现有测试（必须继续通过）

- stdio 的 modern 探测、legacy 回退、_meta 校验等 14 个用例，原样保留。

### 新增测试（HTTP）

用 Node 内置 `http` 模块在测试里起一个本地 HTTP 服务，模拟 streamable-http 服务器，覆盖：

1. **HTTP 基础连接 + 工具发现**：服务器返回 tools/list（JSON），客户端能正确拿到工具列表。
2. **HTTP 下 legacy 回退**：服务器对 `server/discover` 返回 `-32601`，客户端回退 `initialize` 握手并成功连接。
3. **认证头传递**：连接时传入 `headers: { Authorization: Bearer xxx }`，断言服务器收到的请求里带了这个头。
4. **session 传递**：`initialize` 响应带 `Mcp-Session-Id: abc`，断言后续 `tools/call` 请求也带了 `Mcp-Session-Id: abc`。
5. **SSE 响应解析**：服务器用 `text/event-stream` 返回 `tools/call` 结果，断言客户端能正确解析出文本内容。
6. **错误处理**：服务器返回 401（认证失败），客户端报出清晰错误而不是崩溃。
7. **HTTP 请求头完整性**：断言每个 POST 都带 `Accept: application/json, text/event-stream` 和 `MCP-Protocol-Version`。

### 端到端验证（手动，代码测试通过后）

接真实 RollingGo：`connect_mcp` 传 `url` + `headers: { Authorization: Bearer mcp_xxx }`，让 AI 调 `searchHotels` 搜一家酒店，能返回真实结果即成功。

---

## 七、风险与边界

1. **RollingGo 协议版本未知**：如果它既不是标准 modern 也不是标准 legacy（比如有私有扩展），首次对接可能还有兼容性问题。方案里 modern/legacy 都做了，能覆盖绝大多数情况，剩最后一点只能靠真实请求验证。
2. **SSE 长连接不做**：`subscriptions/listen` 那种持续推送的流不实现，本次只做「请求-响应」的 SSE（即一个请求对应一个会结束的 SSE 流）。
3. **OAuth2 不做**：只支持静态 header 认证，不实现授权码流程。
