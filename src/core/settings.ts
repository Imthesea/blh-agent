import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createLogger } from "@blh/logger";

const log = createLogger("core.settings");

export interface Settings {
  provider?: string;
  model?: string;
}

function settingsFile(): string {
  return path.join(os.homedir(), ".blh", "settings.json");
}

/** 读取上次显式选择的 provider/model；文件不存在或损坏时容错返回空对象。 */
export function loadSettings(): Settings {
  try {
    const raw = readFileSync(settingsFile(), "utf8");
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
    const obj = data as Record<string, unknown>;
    const result: Settings = {};
    if (typeof obj.provider === "string") result.provider = obj.provider;
    if (typeof obj.model === "string") result.model = obj.model;
    return result;
  } catch {
    return {};
  }
}

/** 保存显式选择；写入失败仅告警，不中断启动。 */
export function saveSettings(settings: Settings): void {
  try {
    mkdirSync(path.join(os.homedir(), ".blh"), { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify(settings, null, 2) + "\n");
  } catch (error) {
    log.warn("保存 settings 失败", { error });
  }
}
