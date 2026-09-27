import { createWebServer } from "./http.js";
import { SSEBroadcaster } from "./bridge.js";
import { ApprovalCoordinator, loadUserRules, persistUserRule } from "./approval.js";
import { SessionManager } from "./session.js";
import type { BuildHarness, SessionStoreModule, TraceModule } from "./types.js";
import { createLogger, initLogger } from "@blh/logger";

const log = createLogger("web-server.index");

export type { BuildHarness, SessionStoreModule, TraceModule } from "./types.js";
export type { WebEvent, AgentEvent } from "./bridge.js";

export interface WebServerOptions {
  workdir: string;
  cli?: Record<string, unknown>;
  port?: number;
  /** 前端静态目录；dev 模式传 null（页面由 Vite dev server 提供）。 */
  staticDir?: string | null;
  skipPermissions?: boolean;
  sessionStore: SessionStoreModule;
  buildHarness: BuildHarness;
  /** 可选 trace 读取模块（根包注入 createTraceModule(config.workdir)）。 */
  trace?: TraceModule;
}

export interface RunningWebServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startWebServer(options: WebServerOptions): Promise<RunningWebServer> {
  const workdir = options.workdir;
  initLogger(workdir);

  const broadcaster = new SSEBroadcaster();
  const approvals = new ApprovalCoordinator((event) => broadcaster.broadcast(event));

  const userRules = loadUserRules(workdir);
  // web 交互模式：非破坏性 bash 默认放行，不弹框（破坏性命令仍由 isDestructiveBashCommand 与 deny 规则硬拦截）
  userRules.unshift({ tool: "bash", target: "*", action: "allow" });
  const harness = options.buildHarness({
    workdir,
    ...(options.cli !== undefined ? { cli: options.cli } : {}),
    askUser: (req) => approvals.ask(req),
    skipPermissions: options.skipPermissions ?? false,
    userRules,
    persistRule: (rule) => persistUserRule(workdir, rule),
  });

  const lock = harness.jobs?.agentLock;
  if (lock === undefined) {
    throw new Error("web server requires a harness with an agent lock");
  }

  const session = new SessionManager(
    harness,
    lock,
    (event) => broadcaster.broadcast(event),
    approvals,
    options.sessionStore,
  );
  session.create(workdir);

  const server = createWebServer({
    session,
    broadcaster,
    workdir,
    sessionStore: options.sessionStore,
    staticDir: options.staticDir ?? null,
    ...(options.trace !== undefined ? { trace: options.trace } : {}),
  });

  const port = options.port !== undefined && Number.isInteger(options.port) ? options.port : 8123;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const url = `http://127.0.0.1:${port}`;
  log.info("web server started", { url, workdir });

  return {
    url,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else {
            log.info("web server closed");
            resolve();
          }
        });
      }),
  };
}
