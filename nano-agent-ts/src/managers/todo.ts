import type { TodoItem, TodoStatus } from "../types.js";

const STATUS_MARKERS: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[x]",
};

export interface TodoInput {
  id?: string;
  text: string;
  status: TodoStatus;
}

export class TodoManager {
  items: TodoItem[] = [];

  update(items: TodoInput[]): string {
    if (items.length > 20) {
      throw new Error("Max 20 todos allowed");
    }

    let inProgressCount = 0;
    const validated: TodoItem[] = [];

    for (let idx = 0; idx < items.length; idx += 1) {
      const raw = items[idx];
      const id = raw.id?.trim() || String(idx + 1);
      const text = raw.text.trim();
      const status = raw.status;

      if (!text) {
        throw new Error(`Item ${id}: text required`);
      }
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Item ${id}: invalid status '${status}'`);
      }
      if (status === "in_progress") {
        inProgressCount += 1;
      }

      validated.push({ id, text, status });
    }

    if (inProgressCount > 1) {
      throw new Error("Only one task can be in_progress at a time");
    }

    this.items = validated;
    return this.render();
  }

  render(): string {
    if (!this.items.length) {
      return "No todos.";
    }

    const lines = this.items.map(
      (item) => `${STATUS_MARKERS[item.status]} #${item.id}: ${item.text}`,
    );
    const doneCount = this.items.filter(
      (item) => item.status === "completed",
    ).length;
    lines.push(`\n(${doneCount}/${this.items.length} completed)`);
    return lines.join("\n");
  }
}
