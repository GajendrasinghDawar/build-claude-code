import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LaneLock } from "./lane-lock.js";

export interface HeartbeatStatus {
  enabled: boolean;
  running: boolean;
  shouldRun: boolean;
  reason: string;
  lastRun: string;
  nextIn: string;
  interval: string;
  activeHours: string;
  queueSize: number;
}

export class HeartbeatRunner {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private lastRunAt = 0;
  private outputQueue: string[] = [];
  private lastOutput = "";

  constructor(
    private readonly workspaceDir: string,
    private readonly laneLock: LaneLock,
    private readonly runSingleTurn: (
      prompt: string,
      systemPrompt: string,
    ) => Promise<string>,
    private readonly options: {
      intervalSeconds: number;
      activeStart: number;
      activeEnd: number;
    },
  ) {}

  private heartbeatPath(): string {
    return join(this.workspaceDir, "HEARTBEAT.md");
  }

  private soulPath(): string {
    return join(this.workspaceDir, "SOUL.md");
  }

  private memoryPath(): string {
    return join(this.workspaceDir, "MEMORY.md");
  }

  private async readText(path: string): Promise<string> {
    try {
      return (await readFile(path, "utf-8")).trim();
    } catch {
      return "";
    }
  }

  private inActiveHours(now: Date): boolean {
    const h = now.getHours();
    const { activeStart: s, activeEnd: e } = this.options;
    if (s <= e) return h >= s && h < e;
    return !(h >= e && h < s);
  }

  shouldRun(): { ok: boolean; reason: string } {
    const nowMs = Date.now();
    if (this.stopped) return { ok: false, reason: "stopped" };
    if (this.running) return { ok: false, reason: "already running" };

    const elapsed = (nowMs - this.lastRunAt) / 1000;
    if (this.lastRunAt > 0 && elapsed < this.options.intervalSeconds) {
      return {
        ok: false,
        reason: `interval not elapsed (${Math.ceil(this.options.intervalSeconds - elapsed)}s remaining)`,
      };
    }

    if (!this.inActiveHours(new Date())) {
      return {
        ok: false,
        reason: `outside active hours (${this.options.activeStart}:00-${this.options.activeEnd}:00)`,
      };
    }

    return { ok: true, reason: "all checks passed" };
  }

  private parseResponse(response: string): string | null {
    if (response.includes("HEARTBEAT_OK")) {
      const rest = response.replace("HEARTBEAT_OK", "").trim();
      return rest.length > 5 ? rest : null;
    }
    const trimmed = response.trim();
    return trimmed || null;
  }

  private async buildPrompt(): Promise<{
    instructions: string;
    system: string;
  }> {
    const instructions = await this.readText(this.heartbeatPath());
    const soul =
      (await this.readText(this.soulPath())) ||
      "You are a helpful AI assistant.";
    const memory = await this.readText(this.memoryPath());

    const extraParts: string[] = [];
    if (memory) {
      extraParts.push(`## Known Context\n\n${memory}`);
    }
    extraParts.push(
      `Current time: ${new Date().toISOString().replace("T", " ").replace(".000Z", " UTC")}`,
    );

    return {
      instructions,
      system: `${soul}\n\n${extraParts.join("\n\n")}`,
    };
  }

  private async execute(): Promise<void> {
    if (!this.laneLock.tryAcquire()) return;
    this.running = true;

    try {
      const { instructions, system } = await this.buildPrompt();
      if (!instructions) return;

      const response = await this.runSingleTurn(instructions, system);
      const meaningful = this.parseResponse(response);
      if (!meaningful) return;

      if (meaningful.trim() === this.lastOutput) return;
      this.lastOutput = meaningful.trim();
      this.outputQueue.push(meaningful);
    } catch (error: unknown) {
      const err = error as { message?: string };
      this.outputQueue.push(`[heartbeat error: ${err.message ?? "unknown"}]`);
    } finally {
      this.running = false;
      this.lastRunAt = Date.now();
      this.laneLock.release();
    }
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      const check = this.shouldRun();
      if (check.ok) {
        void this.execute();
      }
    }, 1000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async trigger(): Promise<string> {
    if (!this.laneLock.tryAcquire()) {
      return "main lane occupied, cannot trigger";
    }
    this.running = true;

    try {
      const { instructions, system } = await this.buildPrompt();
      if (!instructions) return "HEARTBEAT.md is empty";

      const response = await this.runSingleTurn(instructions, system);
      const meaningful = this.parseResponse(response);
      if (!meaningful) return "HEARTBEAT_OK (nothing to report)";

      if (meaningful.trim() === this.lastOutput) {
        return "duplicate content (skipped)";
      }

      this.lastOutput = meaningful.trim();
      this.outputQueue.push(meaningful);
      return `triggered, output queued (${meaningful.length} chars)`;
    } catch (error: unknown) {
      const err = error as { message?: string };
      return `trigger failed: ${err.message ?? "unknown"}`;
    } finally {
      this.running = false;
      this.lastRunAt = Date.now();
      this.laneLock.release();
    }
  }

  drainOutput(): string[] {
    const out = [...this.outputQueue];
    this.outputQueue = [];
    return out;
  }

  status(): HeartbeatStatus {
    const elapsed =
      this.lastRunAt > 0 ? (Date.now() - this.lastRunAt) / 1000 : null;
    const nextIn =
      elapsed == null
        ? this.options.intervalSeconds
        : Math.max(0, this.options.intervalSeconds - elapsed);

    const check = this.shouldRun();

    return {
      enabled: true,
      running: this.running,
      shouldRun: check.ok,
      reason: check.reason,
      lastRun:
        this.lastRunAt > 0 ? new Date(this.lastRunAt).toISOString() : "never",
      nextIn: `${Math.round(nextIn)}s`,
      interval: `${this.options.intervalSeconds}s`,
      activeHours: `${this.options.activeStart}:00-${this.options.activeEnd}:00`,
      queueSize: this.outputQueue.length,
    };
  }
}
