import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startWebServer, type BuildHarness } from "@blh/web-server";
import { buildHarness } from "./buildHarness.js";
import { loadConfig } from "../core/config.js";
import { SessionStore } from "../session/store.js";

/** 根包对 web-server 的 harness 工厂适配：把 web 侧注入转成 buildHarness 的位置参数。 */
const buildHarnessForWeb: BuildHarness = (deps) =>
  buildHarness(deps.workdir, deps.cli, deps.askUser, deps.skipPermissions, {
    userRules: deps.userRules,
    persistRule: deps.persistRule,
  });

/** 生产模式下前端静态目录：dist/cli/main.js → ../web = dist/web；dev 返回 null（Vite 提供）。 */
function staticDir(dev: boolean): string | null {
  if (dev) return null;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "web");
}

export interface StartWebFromCliOptions {
  workdir?: string;
  cli: Record<string, string>;
  port?: number;
  dev?: boolean;
  skipPermissions?: boolean;
}

/** CLI 入口的 web 启动封装：解析 workdir 并注入根包依赖后交给 @blh/web-server。 */
export function startWebServerFromCli(options: StartWebFromCliOptions) {
  const config = loadConfig(options.workdir, options.cli);
  return startWebServer({
    workdir: config.workdir,
    cli: options.cli,
    sessionStore: SessionStore,
    buildHarness: buildHarnessForWeb,
    staticDir: staticDir(options.dev ?? false),
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.skipPermissions !== undefined ? { skipPermissions: options.skipPermissions } : {}),
  });
}
