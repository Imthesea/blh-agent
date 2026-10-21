const VALID_STATUSES = ["pending", "in_progress", "completed"] as const;
const MAX_ITEMS = 20;

export type TodoStatus = (typeof VALID_STATUSES)[number];

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

const MARKS: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
};

export class TodoManager {
  items: TodoItem[] = [];
  roundsSinceTodo = 0;

  update(todos: unknown): string {
    if (!Array.isArray(todos)) throw new Error("todos must be a list");
    const items: TodoItem[] = [];
    for (const todo of todos) {
      if (typeof todo !== "object" || todo === null) {
        throw new Error("each todo must be an object");
      }
      const raw = todo as Record<string, unknown>;
      const content = String(raw["content"] ?? "").trim();
      if (!content) throw new Error("todo content cannot be empty");
      const status = (raw["status"] ?? "pending") as TodoStatus;
      if (!VALID_STATUSES.includes(status)) {
        throw new Error(`invalid status ${JSON.stringify(status)}; must be one of ${VALID_STATUSES.join(", ")}`);
      }
      items.push({ content, status });
    }
    if (items.length > MAX_ITEMS) {
      throw new Error(`too many todos: ${items.length} (max ${MAX_ITEMS})`);
    }
    this.items = items;
    return this.render();
  }

  render(): string {
    if (this.items.length === 0) return "No todos.";
    return this.items.map((t) => `${MARKS[t.status]} ${t.content}`).join("\n");
  }

  noteRound(usedTodo: boolean): string | null {
    // 无未完成项时不提醒（避免 todo 已完成/空列表时还刷 <reminder>）
    const hasOpen = this.items.some((t) => t.status !== "completed");
    if (!hasOpen) {
      this.roundsSinceTodo = 0;
      return null;
    }
    this.roundsSinceTodo = usedTodo ? 0 : this.roundsSinceTodo + 1;
    if (this.roundsSinceTodo >= 3) {
      this.roundsSinceTodo = 0;
      return "<reminder>Update your todos.</reminder>";
    }
    return null;
  }
}
