import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { BackgroundNotification, BackgroundTask } from "../types.js";
import { WORKDIR } from "../tools/base.js";

const execAsync = promisify(exec);

function cap(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, limit) : "(no output)";
}

export class BackgroundManager {
  private readonly tasks = new Map<string, BackgroundTask>();
  private notifications: BackgroundNotification[] = [];

  run(command: string): string {
    const taskId = randomUUID().slice(0, 8);
    this.tasks.set(taskId, {
      status: "running",
      command,
      result: null,
    });

    execAsync(command, { cwd: WORKDIR, timeout: 300_000 })
      .then(({ stdout, stderr }) => {
        const output = cap(`${stdout}${stderr}`, 50_000);
        this.tasks.set(taskId, {
          status: "completed",
          command,
          result: output,
        });
        this.notifications.push({
          task_id: taskId,
          status: "completed",
          command: command.slice(0, 120),
          result: output.slice(0, 700),
        });
      })
      .catch((error: unknown) => {
        const err = error as {
          killed?: boolean;
          stdout?: string;
          stderr?: string;
          message?: string;
        };

        const fallback = err.killed
          ? "Error: Timeout (300s)"
          : `Error: ${err.message ?? "failed"}`;
        const captured = `${err.stdout ?? ""}${err.stderr ?? ""}`;
        const output = captured.trim() ? cap(captured, 50_000) : fallback;

        this.tasks.set(taskId, {
          status: "error",
          command,
          result: output,
        });
        this.notifications.push({
          task_id: taskId,
          status: "error",
          command: command.slice(0, 120),
          result: output.slice(0, 700),
        });
      });

    return `Background task ${taskId} started: ${command.slice(0, 120)}`;
  }

  check(taskId?: string): string {
    if (taskId) {
      const task = this.tasks.get(taskId);
      if (!task) {
        return `Error: Unknown task ${taskId}`;
      }
      return `[${task.status}] ${task.command.slice(0, 80)}\n${task.result ?? "(running)"}`;
    }

    if (!this.tasks.size) {
      return "No background tasks.";
    }

    const lines: string[] = [];
    for (const [id, task] of this.tasks) {
      lines.push(`${id}: [${task.status}] ${task.command.slice(0, 80)}`);
    }
    return lines.join("\n");
  }

  drainNotifications(): BackgroundNotification[] {
    const out = [...this.notifications];
    this.notifications = [];
    return out;
  }
}
