import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CronExpressionParser } from "cron-parser";

const AUTO_DISABLE_THRESHOLD = 5;

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: {
    kind: "cron" | "at" | "every";
    expr?: string;
    tz?: string;
    at?: string;
    every_seconds?: number;
    anchor?: string;
  };
  payload: {
    kind: "agent_turn" | "system_event";
    message?: string;
    text?: string;
  };
  delete_after_run: boolean;
  consecutiveErrors: number;
  lastRunAt: number;
  nextRunAt: number;
}

export class CronService {
  jobs: CronJob[] = [];
  private outputQueue: string[] = [];
  private readonly logPath: string;

  constructor(
    private readonly workspaceDir: string,
    private readonly runSingleTurn: (
      prompt: string,
      systemPrompt: string,
    ) => Promise<string>,
  ) {
    this.logPath = join(workspaceDir, "cron", "cron-runs.jsonl");
  }

  private cronFile(): string {
    return join(this.workspaceDir, "CRON.json");
  }

  private async ensureDirs(): Promise<void> {
    await mkdir(join(this.workspaceDir, "cron"), { recursive: true });
  }

  private computeNext(job: CronJob, nowMs: number): number {
    const now = nowMs;
    const cfg = job.schedule;

    if (cfg.kind === "at") {
      const ts = Date.parse(cfg.at ?? "");
      return Number.isFinite(ts) && ts > now ? ts : 0;
    }

    if (cfg.kind === "every") {
      const every = Math.max(1, Number(cfg.every_seconds ?? 3600));
      const anchor = Date.parse(cfg.anchor ?? "") || now;
      if (now < anchor) return anchor;
      const elapsedSec = (now - anchor) / 1000;
      const steps = Math.floor(elapsedSec / every) + 1;
      return anchor + steps * every * 1000;
    }

    if (cfg.kind === "cron") {
      const expr = cfg.expr ?? "";
      if (!expr) return 0;
      try {
        const interval = CronExpressionParser.parse(expr, {
          currentDate: new Date(now),
          tz: cfg.tz,
        });
        return interval.next().toDate().getTime();
      } catch {
        return 0;
      }
    }

    return 0;
  }

  async loadJobs(): Promise<void> {
    this.jobs = [];
    await this.ensureDirs();

    let raw = "";
    try {
      raw = await readFile(this.cronFile(), "utf-8");
    } catch {
      return;
    }

    let parsed: { jobs?: Array<any> } = {};
    try {
      parsed = JSON.parse(raw) as { jobs?: Array<any> };
    } catch {
      return;
    }

    const now = Date.now();
    for (const jd of parsed.jobs ?? []) {
      const schedule = jd.schedule ?? {};
      if (!["cron", "at", "every"].includes(String(schedule.kind ?? ""))) {
        continue;
      }

      const job: CronJob = {
        id: String(jd.id ?? ""),
        name: String(jd.name ?? ""),
        enabled: Boolean(jd.enabled ?? true),
        schedule: {
          kind: schedule.kind,
          expr: schedule.expr,
          tz: schedule.tz,
          at: schedule.at,
          every_seconds: schedule.every_seconds,
          anchor: schedule.anchor,
        },
        payload: {
          kind: String(
            jd.payload?.kind ?? "agent_turn",
          ) as CronJob["payload"]["kind"],
          message: jd.payload?.message,
          text: jd.payload?.text,
        },
        delete_after_run: Boolean(jd.delete_after_run ?? false),
        consecutiveErrors: 0,
        lastRunAt: 0,
        nextRunAt: 0,
      };

      job.nextRunAt = this.computeNext(job, now);
      this.jobs.push(job);
    }
  }

  async tick(): Promise<void> {
    const now = Date.now();
    const removeIds = new Set<string>();

    for (const job of this.jobs) {
      if (!job.enabled || job.nextRunAt <= 0 || now < job.nextRunAt) {
        continue;
      }

      await this.runJob(job, now);
      if (job.delete_after_run && job.schedule.kind === "at") {
        removeIds.add(job.id);
      }
    }

    if (removeIds.size) {
      this.jobs = this.jobs.filter((j) => !removeIds.has(j.id));
    }
  }

  private async runJob(job: CronJob, nowMs: number): Promise<void> {
    let output = "";
    let status: "ok" | "error" | "skipped" = "ok";
    let errorText = "";

    try {
      if (job.payload.kind === "agent_turn") {
        const message = (job.payload.message ?? "").trim();
        if (!message) {
          status = "skipped";
          output = "[empty message]";
        } else {
          const systemPrompt = [
            "You are performing a scheduled background task.",
            "Be concise and actionable.",
            `Current time: ${new Date().toISOString().replace("T", " ").replace(".000Z", " UTC")}`,
          ].join(" ");
          output = await this.runSingleTurn(message, systemPrompt);
        }
      } else if (job.payload.kind === "system_event") {
        output = (job.payload.text ?? "").trim();
        if (!output) {
          status = "skipped";
        }
      } else {
        status = "error";
        output = `[unknown kind: ${String(job.payload.kind)}]`;
        errorText = `unknown kind: ${String(job.payload.kind)}`;
      }
    } catch (error: unknown) {
      const err = error as { message?: string };
      status = "error";
      errorText = err.message ?? "unknown";
      output = `[cron error: ${errorText}]`;
    }

    job.lastRunAt = nowMs;

    if (status === "error") {
      job.consecutiveErrors += 1;
      if (job.consecutiveErrors >= AUTO_DISABLE_THRESHOLD) {
        job.enabled = false;
        const msg = `Job '${job.name}' auto-disabled after ${job.consecutiveErrors} consecutive errors: ${errorText}`;
        this.outputQueue.push(msg);
      }
    } else {
      job.consecutiveErrors = 0;
    }

    job.nextRunAt = this.computeNext(job, nowMs);

    const entry: Record<string, unknown> = {
      job_id: job.id,
      run_at: new Date(nowMs).toISOString(),
      status,
      output_preview: output.slice(0, 200),
    };
    if (errorText) entry.error = errorText;

    try {
      await appendFile(this.logPath, `${JSON.stringify(entry)}\n`, "utf-8");
    } catch {
      // ignore log failures
    }

    if (output && status !== "skipped") {
      this.outputQueue.push(`[${job.name}] ${output}`);
    }
  }

  async triggerJob(jobId: string): Promise<string> {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) return `Job '${jobId}' not found`;

    await this.runJob(job, Date.now());
    return `'${job.name}' triggered (errors=${job.consecutiveErrors})`;
  }

  listJobs(): Array<{
    id: string;
    name: string;
    enabled: boolean;
    kind: string;
    errors: number;
    last_run: string;
    next_run: string;
    next_in: number | null;
  }> {
    const now = Date.now();

    return this.jobs.map((j) => ({
      id: j.id,
      name: j.name,
      enabled: j.enabled,
      kind: j.schedule.kind,
      errors: j.consecutiveErrors,
      last_run: j.lastRunAt > 0 ? new Date(j.lastRunAt).toISOString() : "never",
      next_run: j.nextRunAt > 0 ? new Date(j.nextRunAt).toISOString() : "n/a",
      next_in:
        j.nextRunAt > 0
          ? Math.max(0, Math.round((j.nextRunAt - now) / 1000))
          : null,
    }));
  }

  drainOutput(): string[] {
    const out = [...this.outputQueue];
    this.outputQueue = [];
    return out;
  }
}
