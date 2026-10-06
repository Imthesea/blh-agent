import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createLogger } from "@blh/logger";

const log = createLogger("config.settings");

export interface Settings {
  provider?: string;
  model?: string;
}

function settingsFile(): string {
  return path.join(os.homedir(), ".blh", "settings.json");
}

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

export function saveSettings(settings: Settings): void {
  try {
    mkdirSync(path.join(os.homedir(), ".blh"), { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify(settings, null, 2) + "\n");
  } catch (error) {
    log.warn("保存 settings 失败", { error });
  }
}
