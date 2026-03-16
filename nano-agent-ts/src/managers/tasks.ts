import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureCoreTables, getTursoClient } from "../lib/turso.js";
import type { Task, TaskStatus } from "../types.js";

function isTaskFile(fileName: string): boolean {
  return fileName.startsWith("task_") && fileName.endsWith(".json");
}

function parseIdFromFile(fileName: string): number {
  return Number.parseInt(
    fileName.replace("task_", "").replace(".json", ""),
    10,
  );
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values.filter((val) => Number.isInteger(val) && val > 0))];
}

export class TaskManager {
  private nextId = 1;
  private readonly tasksDir: string;
  private useTurso = false;

  constructor(tasksDir: string) {
    this.tasksDir = tasksDir;
    mkdirSync(this.tasksDir, { recursive: true });
    this.nextId = this.maxFileId() + 1;
  }

  async init(): Promise<string> {
    const client = getTursoClient();
    if (!client) {
      this.useTurso = false;
      return "TaskManager using file mode.";
    }

    await ensureCoreTables();
    this.useTurso = true;
    return "TaskManager using Turso mode.";
  }

  private maxFileId(): number {
    const ids = readdirSync(this.tasksDir)
      .filter(isTaskFile)
      .map(parseIdFromFile)
      .filter((id) => Number.isInteger(id));
    return ids.length ? Math.max(...ids) : 0;
  }

  private taskPath(id: number): string {
    return join(this.tasksDir, `task_${id}.json`);
  }

  private loadFileTask(id: number): Task {
    const filePath = this.taskPath(id);
    return JSON.parse(readFileSync(filePath, "utf-8")) as Task;
  }

  private saveFileTask(task: Task): void {
    writeFileSync(
      this.taskPath(task.id),
      JSON.stringify(task, null, 2),
      "utf-8",
    );
  }

  private async nextTursoId(): Promise<number> {
    const client = getTursoClient();
    if (!client) {
      return this.nextId++;
    }

    const row = await client.execute(
      "SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM tasks",
    );
    const value = row.rows[0]?.next_id;
    return typeof value === "number" ? value : Number(value ?? 1);
  }

  private parseTaskRow(row: Record<string, unknown>): Task {
    const blockedBy = JSON.parse(String(row.blocked_by ?? "[]")) as number[];
    const blocks = JSON.parse(String(row.blocks ?? "[]")) as number[];

    return {
      id: Number(row.id),
      subject: String(row.subject),
      description: String(row.description),
      status: String(row.status) as TaskStatus,
      owner: String(row.owner),
      blockedBy,
      blocks,
      worktree: row.worktree == null ? undefined : String(row.worktree),
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    };
  }

  private async loadTursoTask(id: number): Promise<Task> {
    const client = getTursoClient();
    if (!client) {
      throw new Error("Turso client unavailable");
    }

    const res = await client.execute({
      sql: "SELECT * FROM tasks WHERE id = ?",
      args: [id],
    });

    const row = res.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Task ${id} not found`);
    }

    return this.parseTaskRow(row);
  }

  private async saveTursoTask(task: Task): Promise<void> {
    const client = getTursoClient();
    if (!client) {
      throw new Error("Turso client unavailable");
    }

    await client.execute({
      sql: `
        INSERT INTO tasks (id, subject, description, status, owner, blocked_by, blocks, worktree, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          subject = excluded.subject,
          description = excluded.description,
          status = excluded.status,
          owner = excluded.owner,
          blocked_by = excluded.blocked_by,
          blocks = excluded.blocks,
          worktree = excluded.worktree,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `,
      args: [
        task.id,
        task.subject,
        task.description,
        task.status,
        task.owner,
        JSON.stringify(task.blockedBy),
        JSON.stringify(task.blocks),
        task.worktree ?? null,
        task.created_at ?? Date.now() / 1000,
        task.updated_at ?? Date.now() / 1000,
      ],
    });
  }

  private async clearDependency(completedId: number): Promise<void> {
    if (this.useTurso) {
      const client = getTursoClient();
      if (!client) return;

      const res = await client.execute("SELECT * FROM tasks");
      for (const row of res.rows as Record<string, unknown>[]) {
        const task = this.parseTaskRow(row);
        if (!task.blockedBy.includes(completedId)) {
          continue;
        }

        task.blockedBy = task.blockedBy.filter((id) => id !== completedId);
        task.updated_at = Date.now() / 1000;
        await this.saveTursoTask(task);
      }
      return;
    }

    const files = readdirSync(this.tasksDir).filter(isTaskFile);
    for (const fileName of files) {
      const task = this.loadFileTask(parseIdFromFile(fileName));
      if (!task.blockedBy.includes(completedId)) {
        continue;
      }

      task.blockedBy = task.blockedBy.filter((id) => id !== completedId);
      task.updated_at = Date.now() / 1000;
      this.saveFileTask(task);
    }
  }

  async create(subject: string, description = ""): Promise<string> {
    const id = this.useTurso ? await this.nextTursoId() : this.nextId++;
    const now = Date.now() / 1000;

    const task: Task = {
      id,
      subject,
      description,
      status: "pending",
      owner: "",
      blockedBy: [],
      blocks: [],
      created_at: now,
      updated_at: now,
    };

    if (this.useTurso) {
      await this.saveTursoTask(task);
    } else {
      this.saveFileTask(task);
    }

    return JSON.stringify(task, null, 2);
  }

  async get(id: number): Promise<string> {
    const task = this.useTurso
      ? await this.loadTursoTask(id)
      : this.loadFileTask(id);
    return JSON.stringify(task, null, 2);
  }

  async update(
    id: number,
    status?: TaskStatus,
    addBlockedBy?: number[],
    addBlocks?: number[],
  ): Promise<string> {
    const task = this.useTurso
      ? await this.loadTursoTask(id)
      : this.loadFileTask(id);

    if (status) {
      task.status = status;
      if (status === "completed") {
        await this.clearDependency(id);
      }
    }

    if (addBlockedBy?.length) {
      task.blockedBy = uniqueNumbers([...task.blockedBy, ...addBlockedBy]);
    }

    if (addBlocks?.length) {
      const normalized = uniqueNumbers(addBlocks);
      task.blocks = uniqueNumbers([...task.blocks, ...normalized]);

      for (const blockedId of normalized) {
        try {
          const blockedTask = this.useTurso
            ? await this.loadTursoTask(blockedId)
            : this.loadFileTask(blockedId);
          blockedTask.blockedBy = uniqueNumbers([...blockedTask.blockedBy, id]);
          blockedTask.updated_at = Date.now() / 1000;

          if (this.useTurso) {
            await this.saveTursoTask(blockedTask);
          } else {
            this.saveFileTask(blockedTask);
          }
        } catch {
          // Ignore missing tasks; callers may create them later.
        }
      }
    }

    task.updated_at = Date.now() / 1000;
    if (this.useTurso) {
      await this.saveTursoTask(task);
    } else {
      this.saveFileTask(task);
    }

    return JSON.stringify(task, null, 2);
  }

  async listAll(): Promise<string> {
    if (this.useTurso) {
      const client = getTursoClient();
      if (!client) {
        return "No tasks.";
      }

      const res = await client.execute("SELECT * FROM tasks ORDER BY id ASC");
      if (!res.rows.length) {
        return "No tasks.";
      }

      const lines = (res.rows as Record<string, unknown>[]).map((row) => {
        const task = this.parseTaskRow(row);
        const marker =
          { pending: "[ ]", in_progress: "[>]", completed: "[x]" }[
            task.status
          ] ?? "[?]";
        const blocked = task.blockedBy.length
          ? ` (blocked by: ${JSON.stringify(task.blockedBy)})`
          : "";
        return `${marker} #${task.id}: ${task.subject}${blocked}`;
      });

      return lines.join("\n");
    }

    const files = readdirSync(this.tasksDir).filter(isTaskFile).sort();
    if (!files.length) {
      return "No tasks.";
    }

    const lines = files.map((fileName) => {
      const task = this.loadFileTask(parseIdFromFile(fileName));
      const marker =
        { pending: "[ ]", in_progress: "[>]", completed: "[x]" }[task.status] ??
        "[?]";
      const blocked = task.blockedBy.length
        ? ` (blocked by: ${JSON.stringify(task.blockedBy)})`
        : "";
      return `${marker} #${task.id}: ${task.subject}${blocked}`;
    });

    return lines.join("\n");
  }

  async listUnclaimedPending(): Promise<Task[]> {
    if (this.useTurso) {
      const client = getTursoClient();
      if (!client) {
        return [];
      }

      const res = await client.execute(
        "SELECT * FROM tasks WHERE status = 'pending' AND owner = '' ORDER BY id ASC",
      );
      return (res.rows as Record<string, unknown>[]).map((row) =>
        this.parseTaskRow(row),
      );
    }

    const tasks = readdirSync(this.tasksDir)
      .filter(isTaskFile)
      .sort()
      .map((fileName) => this.loadFileTask(parseIdFromFile(fileName)));

    return tasks.filter((task) => task.status === "pending" && !task.owner);
  }

  async claimTask(id: number, owner: string): Promise<string> {
    const task = this.useTurso
      ? await this.loadTursoTask(id)
      : this.loadFileTask(id);

    if (task.status === "completed") {
      return `Error: Task ${id} is already completed`;
    }

    if (task.owner && task.owner !== owner) {
      return `Error: Task ${id} already owned by ${task.owner}`;
    }

    task.owner = owner;
    if (task.status === "pending") {
      task.status = "in_progress";
    }
    task.updated_at = Date.now() / 1000;

    if (this.useTurso) {
      await this.saveTursoTask(task);
    } else {
      this.saveFileTask(task);
    }

    return JSON.stringify(task, null, 2);
  }

  async bindWorktree(id: number, worktree: string): Promise<void> {
    const task = this.useTurso
      ? await this.loadTursoTask(id)
      : this.loadFileTask(id);
    task.worktree = worktree;
    task.updated_at = Date.now() / 1000;

    if (this.useTurso) {
      await this.saveTursoTask(task);
    } else {
      this.saveFileTask(task);
    }
  }
}
