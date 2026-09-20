# MCP 客户端向后兼容 + Windows 启动修复

- 日期：2026-09-19
- 模块：extensions（m4）
- 涉及文件：`src/extensions/mcp.ts`、`test/extensions/mcp.test.ts`
- 状态：方案（待实现）

## 一、背景

接入 `@dangahagan/weather-mcp`（一个查天气的 MCP 服务器）时失败。排查后确认是两个问题叠加：

1. **Windows 上启动命令失败**：`spawn npx` 报 `ENOENT`，`spawn npx.cmd` 报 `EINVAL`，连子进程都起不来。
2. **协议不兼容**：本仓库的 MCP 客户端只实现了 `2026-07-28` 新版协议，遇到只支持旧版协议（`2025-06-18`）的服务器时，`server/discover` 探测失败就直接抛错，无法接入。

其中问题 2 是根因。`2026-07-28` 是真实存在的最新 MCP 协议（无状态、每请求带 `_meta`、用 `server/discover` 探测），本仓库的实现方向是正确的；但市面上绝大多数 MCP 工具（包括那个天气服务器）仍停留在旧版 `initialize` 握手协议，生态迁移还需要时间。所以正确做法不是「降级客户端」，而是把客户端改成**同时兼容新旧两版**（官方叫 dual-era），这正是官方规范明确推荐的做法。

## 二、目标

1. 修掉 Windows 上无法启动 MCP 服务器子进程的 bug。
2. 让客户端在保持 `2026-07-28` 新协议为主的前提下，遇到旧版服务器时自动回退到 `initialize` 握手，实现新旧服务器都能接。

## 三、官方规范依据（回退规则）

来源：MCP 规范 `Transports → stdio → Backward Compatibility` 与 `Basic → Versioning`。

术语：

- **Modern（新版）**：`2026-07-28` 及以后，每请求带 `_meta`，无握手。
- **Legacy（旧版）**：`2025-11-25` 及更早，靠 `initialize` 握手建会话。
- **Dual-era（双版本）**：同时支持 modern 和 legacy。本次改造目标就是把客户端变成 dual-era。

一个 dual-era 客户端在 stdio 上的探测流程（先发 `server/discover`），有三种结果：

1. 服务器返回 `DiscoverResult`（正常结果，含 `supportedVersions`）→ 服务器是 **modern**，从 `supportedVersions` 里选共同支持的版本继续。
2. 服务器返回**被识别的 modern 错误** `UnsupportedProtocolVersionError`（JSON-RPC 错误码 `-32022`）→ 服务器是 **modern 但不支持请求的版本**，用它的 `data.supported` 重试，**不要回退到 initialize**。
3. 服务器返回**其它任何错误**，或**在合理超时内不响应** → 服务器是 **legacy**，回退到 `initialize` 握手。

关键约束（官方原话）：**回退不能绑定到某个具体错误码**。因为旧服务器对未知的 pre-initialize 请求会返回各自实现定义的错误（常见是 `-32601` 或 `-32602`），甚至干脆不响应。所以我们判断「是否 legacy」的标准是：**只要不是 `-32022`，且不是正常 DiscoverResult，就按 legacy 处理**。

## 四、改动点 1：Windows 启动修复

- 位置：[mcp.ts](file:///f:/allProject/myProject/blh-claude-code-ts/src/extensions/mcp.ts) 的 `start()` 中 `spawn(...)` 那一行。

现状：

```ts
this.process = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });
```

问题：Windows 上 `npx` 实际是 `npx.cmd`（批处理文件）。不带 `shell` 时，Node 找不到无扩展名的 `npx`（`ENOENT`）；而直接写 `.cmd` 又被 Node 出于安全（CVE-2024-27980）拒绝（`EINVAL`）。

改法：**只对「需要 shell 解析的裸命令名」开 shell**，完整可执行路径（如 `node.exe`）不开：

```ts
this.process = spawn(this.command, this.args, {
  stdio: ["pipe", "pipe", "pipe"],
  shell: this.needsShell(),
});

// Windows 上只有 .exe / .com 是可执行文件、能直接 spawn；
// 无扩展名的裸命令（如 npx）实际是 .cmd 批处理，需要交给 shell 才能命中。
private needsShell(): boolean {
  if (process.platform !== "win32") return false;
  return !/\.(exe|com)$/i.test(this.command);
}
```

为什么不能简单写 `shell: process.platform === "win32"`：

- 测试（以及部分真实场景）用 `process.execPath`（完整路径，如 `node.exe`）+ `-e` + 多行代码启动子进程。
- 若对这种情况也开 `shell`，Node 会把 `command` 和 `args` 拼成一个 shell 命令字符串，且**不做转义**（触发 DEP0190 警告）；多行代码里的换行、引号会被 shell 拆坏，导致子进程启动即卡死、请求全部超时。
- 因此只在「命令是裸命令名、需要 shell 帮忙定位 `.cmd`」时才开 shell。

边界：

- `npx` / `uvx` 这类裸命令：走 shell，能正确命中 `npx.cmd` / `uvx.exe`。
- `node.exe` / 完整路径：不走 shell，参数原样传递。
- `shell: true` 对含空格 / 特殊字符的参数不做安全转义，仍是已知边界；本次目标场景（`npx -y <包名>`）参数简单，无影响。

## 五、改动点 2：dual-era 向后兼容

集中在 `src/extensions/mcp.ts` 的 `MCPClient` 类。

### 5.1 新增状态与构造参数

给 `MCPClient` 加一个 `mode` 字段记录当前按哪套协议通信，并新增一个 `discoverTimeoutMs` 构造参数。

构造函数现状是 `constructor(name, command, args = [], timeout = 30000)`，追加第 5 个参数：

```ts
constructor(
  readonly name: string,
  readonly command: string,
  readonly args: string[] = [],
  readonly timeout = 30000, // 普通请求的超时（毫秒）。
  readonly discoverTimeoutMs = 2000, // discover 探测的短超时（毫秒），快速识别不响应的 legacy 服务器。
) {}

// 当前通信模式：modern = 新协议（每请求带 _meta），legacy = 旧协议（initialize 握手后无 _meta）。
private mode: "modern" | "legacy" = "modern";
```

- 默认 `modern`，探测确认是旧服务器后切成 `legacy`。
- `discoverTimeoutMs` 做成构造参数，是为了测试能传一个很小的值（如 50ms），避免「超时回退」用例真的等 2 秒拖慢测试。

### 5.2 新增常量

```ts
// 旧版协议版本号：回退到 initialize 握手时，客户端声明自己按这一版旧协议通信。
// 2025-06-18 是当前生态里最主流的 legacy 版本（天气服务器用的就是它）。
const LEGACY_PROTOCOL_VERSION = "2025-06-18";

// 被识别的 modern 错误码：服务器是 modern 但不支持请求版本，不能回退 initialize。
const UNSUPPORTED_VERSION = -32022;
```

### 5.3 `request()` 支持可选超时 + 按模式决定是否带 `_meta`

现状 `request(method, params)` 里无条件注入 `_meta`，且超时固定用 `this.timeout`。

改法：

1. 加第三个可选参数 `timeoutMs`，缺省用 `this.timeout`，用于 discover 探测的短超时。
2. 注入 `_meta` 前先判断 `this.mode`：`legacy` 模式**不带** `_meta`（旧协议没有这个概念，带了反而会让旧服务器困惑）。

```ts
private request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
  const id = this.nextId++;
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new Error(`MCP request timed out after ${timeoutMs ?? this.timeout}ms`));
    }, timeoutMs ?? this.timeout);
    this.pending.set(id, { resolve, reject, timer });
    const base = (params as Record<string, unknown>) ?? {};
    // 只有 modern 模式才带 _meta；legacy 模式用旧协议，不带。
    const requestParams = this.mode === "legacy" ? base : { ...base, _meta: this.requestMeta() };
    this.send({ jsonrpc: "2.0", id, method, params: requestParams });
  });
}
```

### 5.4 新增 `sendNotification()`：发「通知」（无 id、不等待响应）

旧协议的 `initialize` 握手结束后，客户端要发一个 `notifications/initialized` 通知（没有 id、不需要响应）。现有 `request()` 只发「带 id 的请求」，所以补一个发送通知的方法：

```ts
// 发一条「通知」：没有 id，服务器不会回复。旧协议握手用得上。
private sendNotification(method: string, params?: unknown): void {
  this.send({ jsonrpc: "2.0", method, params: params ?? {} });
}
```

### 5.5 `start()` 改造：探测 + 回退

把现在「发 discover → 失败就抛错」的逻辑，改成按官方三种结果分流。

```ts
async start(): Promise<void> {
  // 1. 启动子进程（含 Windows shell 修复）。
  this.process = spawn(this.command, this.args, {
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  // ...（原有的 error / exit 监听、逐行读 stdout 逻辑不变）...

  // 2. 探测服务器是 modern 还是 legacy。
  let discovered: unknown;
  try {
    discovered = await this.request("server/discover", {}, this.discoverTimeoutMs);
  } catch (error) {
    // 只有「超时」才代表旧服务器不响应 discover，回退到旧协议；
    // 进程退出 / 启动失败等其它错误是真正的启动失败，直接抛出。
    if (!(error instanceof Error) || !error.message.includes("timed out")) {
      throw error;
    }
    this.mode = "legacy";
    await this.initializeLegacy();
    return;
  }

  // 3. discover 返回了错误。
  if (discovered && typeof discovered === "object" && "error" in discovered) {
    const code = (discovered as { error?: { code?: number } }).error?.code;
    if (code === UNSUPPORTED_VERSION) {
      // modern 服务器，但不支持我们请求的版本 —— 不回退，直接报错。
      throw new Error(`MCP server does not support protocol version ${PROTOCOL_VERSION}`);
    }
    // 其它任何错误（常见 -32601 Method not found）= 旧服务器，回退到 initialize。
    this.mode = "legacy";
    await this.initializeLegacy();
    return;
  }

  // 4. discover 正常返回 = modern 服务器，校验它支持的版本。
  const supported =
    (discovered as { supportedVersions?: string[] } | undefined)?.supportedVersions ?? [];
  if (!supported.includes(PROTOCOL_VERSION)) {
    throw new Error(
      `MCP server does not support protocol version ${PROTOCOL_VERSION} (supported: ${supported.join(", ") || "unknown"})`,
    );
  }
  // 保持 this.mode = "modern"，无需额外动作。
}
```

### 5.6 新增 `initializeLegacy()`：旧协议握手

```ts
// 旧协议（legacy）的初始化握手：发 initialize 建立会话，再发 notifications/initialized 通知。
private async initializeLegacy(): Promise<void> {
  // 注意：此刻 this.mode 已是 "legacy"，所以 request() 不会给 initialize 加 _meta。
  const result = await this.request("initialize", {
    protocolVersion: LEGACY_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  });
  if (result && typeof result === "object" && "error" in result) {
    throw new Error(`initialize failed: ${JSON.stringify(result.error)}`);
  }
  // 旧协议要求握手后补一条 initialized 通知。
  this.sendNotification("notifications/initialized");
}
```

要点：

- 旧协议的 `initialize` 请求里，`protocolVersion / capabilities / clientInfo` 直接放在 `params` 顶层（旧格式），**不带 `_meta`**。
- 握手成功后，后续 `tools/list`、`tools/call` 因为 `this.mode === "legacy"`，也不会再带 `_meta`，天然兼容旧协议。

### 5.7 `listTools()` / `callTool()` 无需改动

这两个方法调用 `this.request("tools/list"/"tools/call", ...)`，其返回结构（`.tools` / `.content`）在新旧协议里一致，且是否带 `_meta` 已由 `request()` 根据 `this.mode` 统一处理。因此只需改动 `request()`，这两个方法自动兼容两种模式，无需额外修改。

## 六、测试计划

文件：`test/extensions/mcp.test.ts`。

测试策略：每个用例都用「内联 JS 假服务器」（`process.execPath` + `-e` 传入代码，跨平台、无外部依赖）。假服务器除了回正确响应，还会**反向校验客户端发来的请求格式**（例如 legacy 请求是否误带 `_meta`），一旦发现格式不对就返回特定错误码，这样测试端就能通过「抛不抛错」间接断言客户端行为对不对。

### 6.1 回归：现有用例全部保持通过

现有 5 个 `MCPClient` 用例 + 2 个 `normalizeMcpName` 用例 + 4 个 `MCPRegistry` 用例，改造后**全部保持通过**，不删不改语义。

已知风险点：`start_rejects_when_command_does_not_exist` 在 Windows 上 `shell: true` 后，命令不存在时 Node 可能不触发 `error` 事件、而是 `cmd` 返回非零退出码（走 `exit` 分支）。此时 `start()` 里 pending 的 discover 请求会因进程退出被 `failPending` 拒绝，`start()` 仍会抛错，所以 `rejects.toThrow()` 大概率仍通过。实现后以实际测试结果为准，若该用例在 Windows 变红，再单独调整其断言。

### 6.2 新增：legacy 服务器（discover 返回 -32601）走 initialize 回退

假服务器 `LEGACY_SERVER_CODE` 的行为：

- `server/discover` → 返回 `{ error: { code: -32601, message: "Method not found" } }`（旧服务器不认识这个方法）。
- `initialize` → 校验 `params` 里**没有** `_meta`（旧协议不该有）；有则返回 `-32602`，否则返回 `{ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "legacy", version: "1.0.0" } }`。
- `notifications/initialized` → 通知，不回复。
- `tools/list` → 校验 `params` 里**没有** `_meta`；返回 `{ tools: TOOLS }`。
- `tools/call` → 返回 `{ content: [{ type: "text", text: "searched <query>" }], isError: false }`。

用例与断言：

```ts
it("start_falls_back_to_initialize_for_legacy_server", async () => {
  const client = new MCPClient("legacy", process.execPath, ["-e", LEGACY_SERVER_CODE]);
  try {
    await client.start(); // 应不抛错：discover 返回 -32601 触发回退，而非抛错
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["search"]);
    expect(await client.callTool("search", { query: "x" })).toBe("searched x");
  } finally {
    await client.close();
  }
});
```

验证点：`start()` 成功（-32601 被识别为 legacy 而非致命错误）；`listTools`/`callTool` 正常（说明 legacy 模式下请求不带 `_meta`，否则假服务器会返回 `-32602` 导致抛错）。

### 6.3 新增：legacy 服务器（discover 不响应）走超时回退

假服务器 `LEGACY_TIMEOUT_SERVER_CODE`：`server/discover` 收到后**故意不回复**（模拟旧服务器对未知方法沉默）；其余分支与 6.2 相同。

用例与断言：

```ts
it("start_falls_back_when_discover_times_out", async () => {
  const client = new MCPClient(
    "legacy-timeout",
    process.execPath,
    ["-e", LEGACY_TIMEOUT_SERVER_CODE],
    30000, // 普通请求超时
    50,    // discover 探测超时，故意设很小，避免测试真等 2 秒
  );
  try {
    await client.start(); // 短超时后回退，不抛错
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["search"]);
  } finally {
    await client.close();
  }
});
```

验证点：discover 超时触发回退（不抛错），且通过构造参数 `discoverTimeoutMs = 50` 让测试不拖慢。

### 6.4 新增：modern 服务器返回 -32022 时不回退、直接报错

假服务器 `UNSUPPORTED_SERVER_CODE`：`server/discover` 返回 `{ error: { code: -32022, message: "Unsupported protocol version" } }`。

用例与断言：

```ts
it("start_rejects_when_modern_server_unsupported_version", async () => {
  const client = new MCPClient("modern-unsupported", process.execPath, ["-e", UNSUPPORTED_SERVER_CODE]);
  await expect(client.start()).rejects.toThrow();
});
```

验证点：`-32022` 被识别为「modern 但不支持版本」的错误，直接抛错、**不走** initialize 回退。

### 6.5 用例清单汇总

| 用例 | 目的 | 假服务器行为 | 断言 |
|---|---|---|---|
| discover_and_list_tools（现有） | modern 正常发现 | discover 返回 `2026-07-28` | listTools 拿到 `search` |
| call_tool（现有） | modern 调工具 | 同上 | callTool 返回 `searched x` |
| call_unknown_tool（现有） | modern 未知工具 | 同上 | 返回含 `unknown tool` |
| start_rejects_when_command_does_not_exist（现有） | 命令不存在 | 无 | start 抛错 |
| start_rejects_when_server_exits_immediately（现有） | 进程立即退出 | 进程 `exit(1)` | start 抛错 |
| start_falls_back_to_initialize_for_legacy_server（新增） | `-32601` 回退 | discover 返回 `-32601`，initialize 走旧握手 | start 成功 + listTools/callTool 正常 |
| start_falls_back_when_discover_times_out（新增） | 超时回退 | discover 不响应 | start 成功 + listTools 正常 |
| start_rejects_when_modern_server_unsupported_version（新增） | `-32022` 不回退 | discover 返回 `-32022` | start 抛错 |

### 6.6 覆盖检查

- 官方三种探测结果都有用例覆盖：正常 `DiscoverResult`（现有用例）、`-32022`（6.4）、其它错误 / 超时（6.2 覆盖 `-32601`、6.3 覆盖超时）。
- legacy 请求「不带 `_meta`」通过假服务器反向校验覆盖（带了就返回 `-32602` → 测试失败）。
- initialize 握手正确性（先 `initialize`、后 `notifications/initialized`）由假服务器流程自然覆盖：若客户端漏发 `initialized` 通知，严格旧服务器会拒绝后续请求；本假服务器为宽松实现不强制校验通知，仅验证客户端不抛错即可。

## 七、风险与边界

- **`shell: true` 的注入面**：`command`/`args` 来自 `connect_mcp` 工具的调用，属于用户主动「连接服务器」的操作，风险级别和 `bash` 工具相当，可接受；但 `args` 含空格/特殊字符时转义不可靠，列为已知边界。
- **回退只针对 stdio 传输**：本仓库 MCP 客户端目前只支持 stdio（本地子进程），本方案不涉及 HTTP / SSE 传输的回退。
- **legacy 版本号固定为 `2025-06-18`**：这是生态主流版本；若未来要接更老（`2024-11-05` / `2025-03-26`）或更新的 legacy 服务器，可把版本号改为可配置。
- **不改变现有协议语义的对外表现**：modern 路径的发现、注册、命名（`mcp__server__tool`）行为完全不变。

## 八、验证方式

实现后运行：

```powershell
pnpm vitest run test/extensions/mcp.test.ts
```

预期：原有用例 + 新增用例全部通过。随后可手动用 `connect_mcp` 接入 `@dangahagan/weather-mcp` 做端到端验证：

```
name = weather
command = npx
args = ["-y", "@dangahagan/weather-mcp@latest"]
```

期望结果：在 Windows 上能成功连接并发现工具（`mcp__weather__*`），可正常调用查天气。
