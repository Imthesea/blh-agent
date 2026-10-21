import { appendFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import type { ChatMessage } from "../contracts/types.js";

/** 本地日期 YYYY-MM-DD（与文件名匹配）。 */
export function localDay(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * 把一轮结束后的投影追加渲染到 <sessionsDir>/chat/<YYYY-MM-DD>.md。
 * 与 memory 系统完全独立，仅作审计与 agent 自查；跳过 system 与 isInternal。
 * 同一天多次运行是追加（append-only，与 transcript 一致）。
 */
export function appendDailyLog(
  sessionsDir: string,
  messages: readonly ChatMessage[],
  now: Date = new Date(),
): string {
  const dir = path.join(sessionsDir, "chat");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${localDay(now)}.md`);

  const sections: string[] = [`## ${now.toISOString()}`];
  for (const message of messages) {
    if (message.role === "system" || message.isInternal === true) continue;
    if (message.role === "assistant" && message.tool_calls?.length) {
      const calls = message.tool_calls
        .map((call) => `${call.function.name}(${call.function.arguments})`)
        .join("\n");
      sections.push(`### assistant\n${calls}`);
      if (message.content) sections.push(message.content);
    } else if (message.role === "tool") {
      sections.push(`### tool [${message.tool_call_id ?? ""}]\n${message.content ?? ""}`);
    } else {
      sections.push(`### ${message.role}\n${message.content ?? ""}`);
    }
  }

  const text = `${sections.join("\n\n")}\n\n`;
  appendFileSync(file, text, "utf8");
  return file;
}