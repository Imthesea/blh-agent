import { useState } from "react";

export function InputBar(props: {
  busy: boolean;
  canStop: boolean;
  onSend(text: string): void;
  onStop(): void;
}) {
  const { busy, canStop, onSend, onStop } = props;
  const [text, setText] = useState("");

  function submit() {
    const t = text.trim();
    if (t === "") return;
    setText("");
    onSend(t);
  }

  return (
    <form
      className="input-bar"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="输入消息…"
        disabled={busy}
      />
      {canStop ? (
        <button type="button" className="stop" onClick={() => onStop()}>
          停止
        </button>
      ) : (
        <button type="submit" disabled={busy || text.trim() === ""}>
          发送
        </button>
      )}
    </form>
  );
}
