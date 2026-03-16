import * as readline from "node:readline";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { tool, type ModelMessage } from "ai";
import { z } from "zod";
import { CronExpressionParser } from "cron-parser";
import { MemoryStore } from "./intelligence/memory-store.js";
import { CommandQueue } from "./concurrency/command-queue.js";
import { ContextGuard } from "./sessions/context-guard.js";
import { ProfileManager } from "./resilience/profile-manager.js";
import { ResilienceRunner } from "./resilience/runner.js";
import { SimulatedFailure } from "./resilience/simulated-failure.js";
import { type AuthProfile } from "./resilience/types.js";
import "dotenv/config";

const MODEL_ID = process.env.MODEL_ID ?? "openai/gpt-5.4";
const WORKSPACE_DIR = join(process.cwd(), "workspace");
const HEARTBEAT_PATH = join(WORKSPACE_DIR, "HEARTBEAT.md");
const CRON_PATH = join(WORKSPACE_DIR, "CRON.json");

const LANE_MAIN = "main";
const LANE_CRON = "cron";
const LANE_HEARTBEAT = "heartbeat";

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const MAGENTA = "\x1b[35m";
const BLUE = "\x1b[34m";

const memoryStore = new MemoryStore(WORKSPACE_DIR);

type CronJob = {
  id: string;
  name: string;
  enabled: boolean;
  schedule: {
    kind: "cron" | "at" | "every";
    expr?: string;
    tz?: string;
    at?: string;
    everySeconds?: number;
    anchor?: string;
  };
  payload: {
    kind: "agent_turn" | "system_event";
    message?: string;
    text?: string;
  };
  deleteAfterRun: boolean;
  lastRunAt: number;
  nextRunAt: number;
  consecutiveErrors: number;
};

function colorForLane(lane: string): string {
  if (lane === LANE_MAIN) return CYAN;
  if (lane === LANE_CRON) return MAGENTA;
  if (lane === LANE_HEARTBEAT) return BLUE;
  return YELLOW;
}

function printLane(lane: string, message: string): void {
  console.log(`${colorForLane(lane)}${BOLD}[${lane}]${RESET} ${message}`);
}

function buildProfiles(): AuthProfile[] {
  const main = process.env.AI_GATEWAY_API_KEY ?? "";
  const backup = process.env.AI_GATEWAY_API_KEY_BACKUP ?? main;
  const emergency = process.env.AI_GATEWAY_API_KEY_EMERGENCY ?? backup;

  return [
    {
      name: "main-key",
      provider: "gateway",
      apiKey: main,
      cooldownUntil: 0,
      failureReason: null,
      lastGoodAt: 0,
    },
    {
      name: "backup-key",
      provider: "gateway",
      apiKey: backup,
      cooldownUntil: 0,
      failureReason: null,
      lastGoodAt: 0,
    },
    {
      name: "emergency-key",
      provider: "gateway",
      apiKey: emergency,
      cooldownUntil: 0,
      failureReason: null,
      lastGoodAt: 0,
    },
  ];
}

function parseFallbackModels(): string[] {
  const raw = process.env.FALLBACK_MODELS ?? "";
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

async function loadSoulPrompt(): Promise<string> {
  try {
    const soul = (
      await readFile(join(WORKSPACE_DIR, "SOUL.md"), "utf-8")
    ).trim();
    return soul || "You are a helpful AI assistant.";
  } catch {
    return "You are a helpful AI assistant.";
  }
}

function buildMemoryTools() {
  return {
    memory_write: tool({
      description: "Save an important fact or preference to long-term memory.",
      inputSchema: z.object({ content: z.string() }),
      execute: async ({ content }) =>
        memoryStore.writeMemory(content, "general"),
    }),
    memory_search: tool({
      description: "Search long-term memory for relevant information.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const found = await memoryStore.searchMemory(query, 10);
        if (!found.length) return `No memories matching '${query}'.`;
        return found.map((x) => `[${x.path}] ${x.snippet}`).join("\n");
      },
    }),
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

class HeartbeatService {
  private lastRunAt = 0;
  private outputQueue: string[] = [];
  private lastOutput = "";

  constructor(
    private readonly commandQueue: CommandQueue,
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

  private inActiveHours(): boolean {
    const hour = new Date().getHours();
    const { activeStart, activeEnd } = this.options;
    if (activeStart <= activeEnd) {
      return hour >= activeStart && hour < activeEnd;
    }
    return !(hour >= activeEnd && hour < activeStart);
  }

  private async buildPrompt(): Promise<{
    instructions: string;
    systemPrompt: string;
  }> {
    let instructions = "";
    try {
      instructions = (await readFile(HEARTBEAT_PATH, "utf-8")).trim();
    } catch {
      instructions = "";
    }

    const mem = await memoryStore.loadEvergreen();
    const extra = [
      mem ? `## Known Context\n\n${mem}` : "",
      `Current time: ${new Date().toISOString().replace("T", " ").replace(".000Z", " UTC")}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    return {
      instructions,
      systemPrompt: `${await loadSoulPrompt()}\n\n${extra}`.trim(),
    };
  }

  private parse(response: string): string | null {
    if (response.includes("HEARTBEAT_OK")) {
      const stripped = response.replace("HEARTBEAT_OK", "").trim();
      return stripped.length > 5 ? stripped : null;
    }
    const t = response.trim();
    return t || null;
  }

  async tick(): Promise<void> {
    const now = Date.now() / 1000;
    if (now - this.lastRunAt < this.options.intervalSeconds) return;
    if (!this.inActiveHours()) return;

    const lane = this.commandQueue.getOrCreateLane(LANE_HEARTBEAT);
    if (lane.stats().active > 0) return;

    const task = async (): Promise<string | null> => {
      const built = await this.buildPrompt();
      if (!built.instructions) return null;
      const result = await this.runSingleTurn(
        built.instructions,
        built.systemPrompt,
      );
      return this.parse(result);
    };

    void this.commandQueue
      .enqueue(LANE_HEARTBEAT, task)
      .then((value) => {
        this.lastRunAt = Date.now() / 1000;
        if (!value) return;
        if (value.trim() === this.lastOutput) return;
        this.lastOutput = value.trim();
        this.outputQueue.push(value);
      })
      .catch((error) => {
        this.lastRunAt = Date.now() / 1000;
        this.outputQueue.push(`[heartbeat error: ${String(error)}]`);
      });
  }

  drainOutput(): string[] {
    const out = [...this.outputQueue];
    this.outputQueue = [];
    return out;
  }

  status(): Record<string, string | boolean> {
    const now = Date.now() / 1000;
    const elapsed = this.lastRunAt > 0 ? now - this.lastRunAt : 0;
    const nextIn =
      this.lastRunAt > 0
        ? Math.max(0, this.options.intervalSeconds - elapsed)
        : this.options.intervalSeconds;

    return {
      enabled: true,
      should_run: this.inActiveHours(),
      last_run: this.lastRunAt
        ? new Date(this.lastRunAt * 1000).toISOString()
        : "never",
      next_in: `${Math.round(nextIn)}s`,
      interval: `${this.options.intervalSeconds}s`,
      active_hours: `${this.options.activeStart}:00-${this.options.activeEnd}:00`,
      queue_size: String(this.outputQueue.length),
    };
  }
}

class CronService {
  jobs: CronJob[] = [];
  private outputQueue: string[] = [];

  constructor(
    private readonly commandQueue: CommandQueue,
    private readonly runSingleTurn: (
      prompt: string,
      systemPrompt: string,
    ) => Promise<string>,
  ) {}

  private computeNextRunAt(job: CronJob, nowMs: number): number {
    const schedule = job.schedule;

    if (schedule.kind === "at") {
      const ts = Date.parse(schedule.at ?? "");
      return Number.isFinite(ts) && ts > nowMs ? ts : 0;
    }

    if (schedule.kind === "every") {
      const everySeconds = Math.max(1, Number(schedule.everySeconds ?? 3600));
      const anchor = Date.parse(schedule.anchor ?? "") || nowMs;
      if (nowMs < anchor) return anchor;

      const elapsedSeconds = (nowMs - anchor) / 1000;
      const steps = Math.floor(elapsedSeconds / everySeconds) + 1;
      return anchor + steps * everySeconds * 1000;
    }

    if (schedule.kind === "cron") {
      const expr = schedule.expr ?? "";
      if (!expr) return 0;
      try {
        const interval = CronExpressionParser.parse(expr, {
          currentDate: new Date(nowMs),
          tz: schedule.tz,
        });
        return interval.next().toDate().getTime();
      } catch {
        return 0;
      }
    }

    return 0;
  }

  async load(): Promise<void> {
    this.jobs = [];

    let raw = "";
    try {
      raw = await readFile(CRON_PATH, "utf-8");
    } catch {
      return;
    }

    let parsed: { jobs?: Array<Record<string, unknown>> } = {};
    try {
      parsed = JSON.parse(raw) as { jobs?: Array<Record<string, unknown>> };
    } catch {
      return;
    }

    const nowMs = Date.now();
    for (const item of parsed.jobs ?? []) {
      const schedule = (item.schedule ?? {}) as Record<string, unknown>;
      const payload = (item.payload ?? {}) as Record<string, unknown>;

      const kind = String(schedule.kind ?? "").trim();
      if (!(["cron", "at", "every"] as const).includes(kind as any)) {
        continue;
      }

      const job: CronJob = {
        id: String(item.id ?? ""),
        name: String(item.name ?? ""),
        enabled: Boolean(item.enabled ?? true),
        schedule: {
          kind: kind as CronJob["schedule"]["kind"],
          expr: String(schedule.expr ?? "") || undefined,
          tz: String(schedule.tz ?? "") || undefined,
          at: String(schedule.at ?? "") || undefined,
          everySeconds: Number(schedule.every_seconds ?? 0) || undefined,
          anchor: String(schedule.anchor ?? "") || undefined,
        },
        payload: {
          kind: (String(payload.kind ?? "agent_turn") === "system_event"
            ? "system_event"
            : "agent_turn") as CronJob["payload"]["kind"],
          message: String(payload.message ?? "") || undefined,
          text: String(payload.text ?? "") || undefined,
        },
        deleteAfterRun: Boolean(item.delete_after_run ?? false),
        lastRunAt: 0,
        nextRunAt: 0,
        consecutiveErrors: 0,
      };

      job.nextRunAt = this.computeNextRunAt(job, nowMs);
      if (job.nextRunAt > 0) {
        this.jobs.push(job);
      }
    }
  }

  async tick(): Promise<void> {
    const nowMs = Date.now();

    for (const job of this.jobs) {
      if (!job.enabled || job.nextRunAt <= 0 || nowMs < job.nextRunAt) continue;

      job.nextRunAt = this.computeNextRunAt(job, nowMs);

      if (job.payload.kind === "system_event") {
        const text = (job.payload.text ?? "").trim();
        job.lastRunAt = nowMs / 1000;
        if (text) this.outputQueue.push(`[${job.name}] ${text}`);
        if (job.deleteAfterRun && job.schedule.kind === "at") {
          job.enabled = false;
          job.nextRunAt = 0;
        }
        continue;
      }

      const message = (job.payload.message ?? "").trim();
      if (!message) {
        if (job.deleteAfterRun && job.schedule.kind === "at") {
          job.enabled = false;
          job.nextRunAt = 0;
        }
        continue;
      }

      const systemPrompt = [
        "You are performing a scheduled background task.",
        "Be concise and actionable.",
        `Current time: ${new Date().toISOString().replace("T", " ").replace(".000Z", " UTC")}`,
      ].join(" ");

      void this.commandQueue
        .enqueue(LANE_CRON, async () =>
          this.runSingleTurn(message, systemPrompt),
        )
        .then((result) => {
          job.lastRunAt = Date.now() / 1000;
          job.consecutiveErrors = 0;
          if (result.trim()) {
            this.outputQueue.push(`[${job.name}] ${result}`);
          }
          if (job.deleteAfterRun && job.schedule.kind === "at") {
            job.enabled = false;
            job.nextRunAt = 0;
          }
        })
        .catch((error) => {
          job.lastRunAt = Date.now() / 1000;
          job.consecutiveErrors += 1;
          this.outputQueue.push(`[${job.name}] error: ${String(error)}`);
          if (job.consecutiveErrors >= 5) {
            job.enabled = false;
            this.outputQueue.push(
              `[${job.name}] auto-disabled after 5 consecutive errors`,
            );
          }
        });
    }
  }

  listJobs(): Array<Record<string, string | number | boolean | null>> {
    const now = Date.now() / 1000;

    return this.jobs.map((job) => ({
      id: job.id,
      name: job.name,
      enabled: job.enabled,
      schedule: job.schedule.kind,
      every_seconds: job.schedule.everySeconds ?? null,
      errors: job.consecutiveErrors,
      last_run: job.lastRunAt
        ? new Date(job.lastRunAt * 1000).toISOString()
        : "never",
      next_in:
        job.nextRunAt > 0
          ? Math.max(0, Math.round(job.nextRunAt / 1000 - now))
          : null,
    }));
  }

  drainOutput(): string[] {
    const out = [...this.outputQueue];
    this.outputQueue = [];
    return out;
  }
}

function printHelp(): void {
  console.log(`${DIM}Commands:${RESET}`);
  console.log(`${DIM}  /lanes                    Show lane stats${RESET}`);
  console.log(
    `${DIM}  /queue                    Show queued/active summary${RESET}`,
  );
  console.log(`${DIM}  /enqueue <lane> <message> Enqueue one message${RESET}`);
  console.log(
    `${DIM}  /concurrency <lane> <N>   Set lane max concurrency${RESET}`,
  );
  console.log(
    `${DIM}  /generation               Show lane generations${RESET}`,
  );
  console.log(
    `${DIM}  /reset                    Increment all generations${RESET}`,
  );
  console.log(
    `${DIM}  /heartbeat                Show heartbeat status${RESET}`,
  );
  console.log(`${DIM}  /trigger                  Force heartbeat tick${RESET}`);
  console.log(`${DIM}  /cron                     Show cron jobs${RESET}`);
  console.log(`${DIM}  /help                     Show this help${RESET}`);
  console.log(`${DIM}  quit / exit               Exit${RESET}`);
}

async function main(): Promise<void> {
  if (!process.env.AI_GATEWAY_API_KEY) {
    console.error(
      "Error: AI_GATEWAY_API_KEY not set. Copy .env.example to .env.",
    );
    process.exit(1);
  }

  const commandQueue = new CommandQueue();
  commandQueue.getOrCreateLane(LANE_MAIN, 1);
  commandQueue.getOrCreateLane(LANE_CRON, 1);
  commandQueue.getOrCreateLane(LANE_HEARTBEAT, 1);

  const profileManager = new ProfileManager(buildProfiles());
  const resilience = new ResilienceRunner(
    profileManager,
    MODEL_ID,
    parseFallbackModels(),
    new ContextGuard(),
    new SimulatedFailure(),
  );

  const soul = await loadSoulPrompt();
  const memory = await memoryStore.loadEvergreen();
  const memoryBlock = memory ? `## Long-term Memory\n\n${memory}` : "";
  const systemPrompt = [soul, memoryBlock].filter(Boolean).join("\n\n");

  const runSingleTurn = async (
    prompt: string,
    singleSystemPrompt: string,
  ): Promise<string> => {
    const result = await resilience.run({
      systemPrompt: singleSystemPrompt,
      messages: [{ role: "user", content: prompt }],
      maxSteps: 8,
    });
    return result.text || `[finish_reason=${result.finishReason}]`;
  };

  const heartbeat = new HeartbeatService(commandQueue, runSingleTurn, {
    intervalSeconds: Number(process.env.HEARTBEAT_INTERVAL ?? "1800"),
    activeStart: Number(process.env.HEARTBEAT_ACTIVE_START ?? "9"),
    activeEnd: Number(process.env.HEARTBEAT_ACTIVE_END ?? "22"),
  });
  const cron = new CronService(commandQueue, runSingleTurn);
  await cron.load();

  const memoryTools = buildMemoryTools();
  const messages: ModelMessage[] = [];

  const heartbeatTimer = setInterval(() => {
    void heartbeat.tick();
  }, 1000);
  const cronTimer = setInterval(() => {
    void cron.tick();
  }, 1000);

  console.log(`${DIM}${"=".repeat(60)}${RESET}`);
  console.log(`${DIM}  claw0-ts  |  Section 10: Concurrency${RESET}`);
  console.log(`${DIM}  Model: ${MODEL_ID}${RESET}`);
  console.log(`${DIM}  Lanes: ${commandQueue.laneNames().join(", ")}${RESET}`);
  console.log(
    `${DIM}  Heartbeat: on (${process.env.HEARTBEAT_INTERVAL ?? "1800"}s)${RESET}`,
  );
  console.log(`${DIM}  Cron jobs: ${cron.jobs.length}${RESET}`);
  console.log(`${DIM}  /help for commands. quit to exit.${RESET}`);
  console.log(`${DIM}${"=".repeat(60)}${RESET}`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let rlClosed = false;
  rl.on("close", () => {
    rlClosed = true;
  });
  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve, reject) => {
      if (rlClosed) {
        resolve("");
        return;
      }

      const onClose = () => {
        rl.off("close", onClose);
        resolve("");
      };

      rl.once("close", onClose);
      try {
        rl.question(prompt, (answer) => {
          rl.off("close", onClose);
          resolve(answer);
        });
      } catch (error) {
        rl.off("close", onClose);
        reject(error);
      }
    });

  try {
    while (true) {
      if (rlClosed) break;

      for (const out of heartbeat.drainOutput()) {
        printLane(LANE_HEARTBEAT, out);
      }
      for (const out of cron.drainOutput()) {
        printLane(LANE_CRON, out);
      }

      let raw = "";
      try {
        raw = await ask(`${CYAN}${BOLD}You > ${RESET}`);
      } catch {
        break;
      }

      const input = raw.trim();
      if (!input) {
        if (rlClosed) break;
        continue;
      }
      if (["q", "quit", "exit"].includes(input.toLowerCase())) break;

      if (input.startsWith("/")) {
        const [cmdRaw, ...rest] = input.split(/\s+/);
        const cmd = cmdRaw.toLowerCase();

        if (cmd === "/help") {
          printHelp();
          continue;
        }

        if (cmd === "/lanes") {
          const stats = commandQueue.stats();
          const names = Object.keys(stats);
          if (!names.length) {
            console.log(`${DIM}  No lanes.${RESET}`);
            continue;
          }

          for (const name of names) {
            const st = stats[name];
            const activeBar =
              "*".repeat(st.active) +
              ".".repeat(Math.max(0, st.maxConcurrency - st.active));
            console.log(
              `${DIM}  ${name.padEnd(12)} active=[${activeBar}] queued=${st.queueDepth} max=${st.maxConcurrency} gen=${st.generation}${RESET}`,
            );
          }
          continue;
        }

        if (cmd === "/queue") {
          const stats = commandQueue.stats();
          const total = Object.values(stats).reduce(
            (acc, s) => acc + s.queueDepth,
            0,
          );
          if (total === 0) {
            console.log(`${DIM}  All lanes empty.${RESET}`);
            continue;
          }

          for (const [name, st] of Object.entries(stats)) {
            if (st.queueDepth > 0 || st.active > 0) {
              console.log(
                `${DIM}  ${name}: ${st.queueDepth} queued, ${st.active} active${RESET}`,
              );
            }
          }
          continue;
        }

        if (cmd === "/enqueue") {
          if (rest.length < 2) {
            console.log(`${DIM}  Usage: /enqueue <lane> <message>${RESET}`);
            continue;
          }

          const laneName = rest[0];
          const message = rest.slice(1).join(" ").trim();
          if (!message) {
            console.log(`${DIM}  Message is required.${RESET}`);
            continue;
          }

          printLane(laneName, `queued: ${message.slice(0, 80)}`);
          void commandQueue
            .enqueue(laneName, async () =>
              runSingleTurn(message, "You are a helpful background worker."),
            )
            .then((result) => {
              printLane(laneName, `result: ${result.slice(0, 200)}`);
            })
            .catch((error) => {
              printLane(laneName, `error: ${String(error)}`);
            });
          continue;
        }

        if (cmd === "/concurrency") {
          if (rest.length < 2) {
            console.log(`${DIM}  Usage: /concurrency <lane> <N>${RESET}`);
            continue;
          }

          const laneName = rest[0];
          const next = Number(rest[1]);
          if (!Number.isInteger(next) || next <= 0) {
            console.log(`${DIM}  N must be a positive integer.${RESET}`);
            continue;
          }

          const changed = commandQueue.setLaneConcurrency(laneName, next);
          console.log(
            `${DIM}  ${laneName}: max_concurrency ${changed.oldValue} -> ${changed.newValue}${RESET}`,
          );
          continue;
        }

        if (cmd === "/generation") {
          const stats = commandQueue.stats();
          for (const [name, st] of Object.entries(stats)) {
            console.log(`${DIM}  ${name}: generation=${st.generation}${RESET}`);
          }
          continue;
        }

        if (cmd === "/reset") {
          const result = commandQueue.resetAll();
          console.log(`${DIM}  Generation incremented on all lanes:${RESET}`);
          for (const [name, gen] of Object.entries(result)) {
            console.log(`${DIM}    ${name}: generation -> ${gen}${RESET}`);
          }
          continue;
        }

        if (cmd === "/heartbeat") {
          const status = heartbeat.status();
          for (const [k, v] of Object.entries(status)) {
            console.log(`${DIM}  ${k}: ${String(v)}${RESET}`);
          }
          continue;
        }

        if (cmd === "/trigger") {
          await heartbeat.tick();
          console.log(`${DIM}  Heartbeat tick triggered.${RESET}`);
          for (const out of heartbeat.drainOutput()) {
            printLane(LANE_HEARTBEAT, out);
          }
          continue;
        }

        if (cmd === "/cron") {
          const jobs = cron.listJobs();
          if (!jobs.length) {
            console.log(`${DIM}  No cron jobs.${RESET}`);
            continue;
          }

          for (const job of jobs) {
            const on = job.enabled
              ? `${GREEN}ON${RESET}`
              : `${YELLOW}OFF${RESET}`;
            const err = Number(job.errors) > 0 ? ` err:${job.errors}` : "";
            const next =
              typeof job.next_in === "number" ? ` in ${job.next_in}s` : "";
            console.log(`  [${on}] ${job.id} - ${job.name}${err}${next}`);
          }
          continue;
        }

        console.log(`${DIM}  Unknown command: ${input}${RESET}`);
        continue;
      }

      printLane(LANE_MAIN, "processing...");
      const future = commandQueue.enqueue(LANE_MAIN, async () => {
        messages.push({ role: "user", content: input });
        try {
          const result = await resilience.run({
            systemPrompt,
            messages,
            tools: memoryTools,
            maxSteps: 30,
          });
          messages.splice(0, messages.length, ...result.messages);
          return result.text || `[finish_reason=${result.finishReason}]`;
        } catch (error) {
          while (
            messages.length &&
            messages[messages.length - 1]?.role !== "user"
          ) {
            messages.pop();
          }
          if (messages.length) messages.pop();
          throw error;
        }
      });

      try {
        const reply = await withTimeout(future, 120_000);
        console.log(`\n${GREEN}${BOLD}Assistant:${RESET} ${reply}\n`);
      } catch (error) {
        const message = String(
          (error as { message?: string })?.message ?? error,
        );
        if (message.toLowerCase().includes("timeout")) {
          console.log(`\n${YELLOW}Request timed out.${RESET}\n`);
        } else {
          console.log(`\n${YELLOW}Error: ${message}${RESET}\n`);
        }
      }
    }
  } finally {
    clearInterval(heartbeatTimer);
    clearInterval(cronTimer);
    await commandQueue.waitForAll(3_000);
    rl.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
