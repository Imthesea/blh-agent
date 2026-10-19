import type { ThinkingStep } from "./turns";

/** 把工具参数渲染成更可读的预览：bash 直接显示命令，其余尽量展示关键字段。 */
function formatArguments(name: string, raw: string): string {
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    return raw;
  }
  if (parsed === null) return raw;
  if (name === "bash" && typeof parsed.command === "string") return parsed.command;
  if (name === "write_file" && typeof parsed.path === "string") {
    const content = typeof parsed.content === "string" ? parsed.content : "";
    const preview = content.length > 240 ? content.slice(0, 240) + "…" : content;
    return `path: ${parsed.path}\n${preview}`;
  }
  if (name === "edit_file" && typeof parsed.path === "string") {
    const oldText = typeof parsed.old_text === "string" ? parsed.old_text : "";
    const newText = typeof parsed.new_text === "string" ? parsed.new_text : "";
    return `path: ${parsed.path}\nold: ${oldText.slice(0, 80)}\nnew: ${newText.slice(0, 80)}`;
  }
  return JSON.stringify(parsed, null, 2);
}

/** 输出超长时截断，避免一屏刷爆。 */
function formatOutput(output: string): string {
  if (output.length <= 2000) return output;
  return output.slice(0, 2000) + `\n…[truncated, ${output.length} chars total]`;
}

export function ToolCallCard({ step }: { step: ThinkingStep }) {
  const running = step.output === undefined;
  return (
    <div className={`tool-card${step.isError === true ? " tool-card-error" : ""}`}>
      <div className="tool-card-head">
        <strong>{step.name ?? "tool"}</strong>
        <span>{running ? "执行中…" : step.isError === true ? "失败" : "完成"}</span>
      </div>
      {step.arguments !== undefined && (
        <pre className="tool-card-args">{formatArguments(step.name ?? "tool", step.arguments)}</pre>
      )}
      {step.output !== undefined && (
        <pre className="tool-card-output">{formatOutput(step.output)}</pre>
      )}
    </div>
  );
}
