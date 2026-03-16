import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import type { Task, WorktreeEntry, WorktreeIndex } from "../types.js";
import type { TaskManager } from "./tasks.js";

export class EventBus {
  constructor(private readonly logPath: string) {
    mkdirSync(dirname(logPath), { recursive: true });
    if (!existsSync(logPath)) {
      writeFileSync(logPath, "", "utf-8");
    }
  }

  emit(
    event: string,
    task?: Partial<Task>,
    worktree?: Record<string, unknown>,
    error?: string,
  ): void {
    const payload = {
      event,
      ts: Date.now() / 1000,
      task: task ?? {},
      worktree: worktree ?? {},
      ...(error ? { error } : {}),
    };
    appendFileSync(this.logPath, `${JSON.stringify(payload)}\n`, "utf-8");
  }

  listRecent(limit = 20): string {
    const lines = readFileSync(this.logPath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean);
    const recent = lines.slice(-Math.min(limit, 200));
    const parsed = recent.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { event: "parse_error", raw: line };
      }
    });
    return JSON.stringify(parsed, null, 2);
  }
}

export class WorktreeManager {
  private readonly worktreesDir: string;
  private readonly indexPath: string;
  private readonly gitAvailable: boolean;

  constructor(
    private readonly repoRoot: string,
    private readonly tasks: TaskManager,
    private readonly events: EventBus,
  ) {
    this.worktreesDir = join(repoRoot, ".worktrees");
    mkdirSync(this.worktreesDir, { recursive: true });

    this.indexPath = join(this.worktreesDir, "index.json");
    if (!existsSync(this.indexPath)) {
      this.saveIndex({ worktrees: [] });
    }

    this.gitAvailable = this.isGitRepo();
  }

  private isGitRepo(): boolean {
    const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: this.repoRoot,
      timeout: 10_000,
      stdio: "ignore",
    });
    return result.status === 0;
  }

  private runGit(args: string[]): string {
    if (!this.gitAvailable) {
      throw new Error("Not in a git repository.");
    }

    const result = spawnSync("git", args, {
      cwd: this.repoRoot,
      timeout: 120_000,
      encoding: "utf-8",
    });

    if (result.status !== 0) {
      const stderr = (result.stderr || "").trim();
      const stdout = (result.stdout || "").trim();
      throw new Error(stderr || stdout || `git ${args.join(" ")} failed`);
    }

    return (result.stdout || "").trim();
  }

  private loadIndex(): WorktreeIndex {
    return JSON.parse(readFileSync(this.indexPath, "utf-8")) as WorktreeIndex;
  }

  private saveIndex(data: WorktreeIndex): void {
    writeFileSync(this.indexPath, JSON.stringify(data, null, 2), "utf-8");
  }

  private find(name: string): WorktreeEntry | undefined {
    return this.loadIndex().worktrees.find((entry) => entry.name === name);
  }

  async create(
    name: string,
    taskId?: number,
    baseRef = "HEAD",
  ): Promise<string> {
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(name)) {
      throw new Error("Invalid worktree name");
    }

    const existing = this.find(name);
    if (existing && existing.status !== "removed") {
      throw new Error(`Worktree '${name}' already exists`);
    }

    const wtPath = resolve(this.worktreesDir, name);
    const branch = `wt/${name}`;

    this.events.emit(
      "worktree.create.before",
      taskId != null ? { id: taskId } : undefined,
      { name, base_ref: baseRef },
    );

    this.runGit(["worktree", "add", "-b", branch, wtPath, baseRef]);

    const entry: WorktreeEntry = {
      name,
      path: wtPath,
      branch,
      task_id: taskId ?? null,
      status: "active",
      created_at: Date.now() / 1000,
    };

    const index = this.loadIndex();
    index.worktrees = index.worktrees.filter((item) => item.name !== name);
    index.worktrees.push(entry);
    this.saveIndex(index);

    if (taskId != null) {
      await this.tasks.bindWorktree(taskId, name);
    }

    this.events.emit(
      "worktree.create.after",
      taskId != null ? { id: taskId } : undefined,
      {
        name,
        path: wtPath,
        branch,
        status: "active",
      },
    );

    return JSON.stringify(entry, null, 2);
  }

  run(name: string, command: string): string {
    const entry = this.find(name);
    if (!entry) {
      return `Error: Unknown worktree '${name}'`;
    }
    if (entry.status !== "active") {
      return `Error: Worktree '${name}' is ${entry.status}`;
    }

    try {
      const out = execSync(command, {
        cwd: entry.path,
        timeout: 300_000,
        encoding: "utf-8",
      }).trim();
      return out || "(no output)";
    } catch (error: unknown) {
      const err = error as {
        message?: string;
        stdout?: string;
        stderr?: string;
      };
      const captured = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
      return captured || `Error: ${err.message ?? "command failed"}`;
    }
  }

  remove(name: string): string {
    const entry = this.find(name);
    if (!entry) {
      return `Error: Unknown worktree '${name}'`;
    }
    if (entry.status === "removed") {
      return `Worktree '${name}' already removed`;
    }

    this.events.emit(
      "worktree.remove.before",
      entry.task_id != null ? { id: entry.task_id } : undefined,
      { name: entry.name, path: entry.path, branch: entry.branch },
    );

    try {
      this.runGit(["worktree", "remove", "--force", entry.path]);
    } catch (error: unknown) {
      const err = error as { message?: string };
      this.events.emit(
        "worktree.remove.error",
        entry.task_id != null ? { id: entry.task_id } : undefined,
        { name: entry.name, path: entry.path, branch: entry.branch },
        err.message ?? "remove failed",
      );
      return `Error: ${err.message ?? "remove failed"}`;
    }

    entry.status = "removed";
    entry.removed_at = Date.now() / 1000;
    const index = this.loadIndex();
    index.worktrees = index.worktrees.map((item) =>
      item.name === name ? entry : item,
    );
    this.saveIndex(index);

    this.events.emit(
      "worktree.remove.after",
      entry.task_id != null ? { id: entry.task_id } : undefined,
      {
        name: entry.name,
        path: entry.path,
        branch: entry.branch,
        status: entry.status,
      },
    );

    return `Removed worktree '${name}'`;
  }

  keep(name: string): string {
    const entry = this.find(name);
    if (!entry) {
      return `Error: Unknown worktree '${name}'`;
    }

    entry.status = "kept";
    entry.kept_at = Date.now() / 1000;

    const index = this.loadIndex();
    index.worktrees = index.worktrees.map((item) =>
      item.name === name ? entry : item,
    );
    this.saveIndex(index);

    this.events.emit(
      "worktree.keep",
      entry.task_id != null ? { id: entry.task_id } : undefined,
      {
        name: entry.name,
        path: entry.path,
        branch: entry.branch,
        status: entry.status,
      },
    );

    return `Marked worktree '${name}' as kept`;
  }

  listAll(): string {
    const index = this.loadIndex();
    if (!index.worktrees.length) {
      return "No worktrees.";
    }

    return index.worktrees
      .map((wt) => `${wt.name}: [${wt.status}] ${wt.branch} (${wt.path})`)
      .join("\n");
  }

  status(name?: string): string {
    if (!name) {
      return this.listAll();
    }

    const entry = this.find(name);
    if (!entry) {
      return `Error: Unknown worktree '${name}'`;
    }

    return JSON.stringify(entry, null, 2);
  }
}
