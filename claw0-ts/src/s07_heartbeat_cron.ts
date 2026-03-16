import * as readline from "node:readline";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { tool, type ModelMessage } from "ai";
import { z } from "zod";
import { runAgentLoop } from "./core/agent-loop.js";
import { MemoryStore } from "./intelligence/memory-store.js";
import { HeartbeatRunner } from "./proactive/heartbeat-runner.js";
import { LaneLock } from "./proactive/lane-lock.js";
import { CronService } from "./proactive/cron-service.js";
import "dotenv/config";

const MODEL_ID = process.env.MODEL_ID ?? "openai/gpt-5.4";
const WORKSPACE_DIR = join(process.cwd(), "workspace");

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const MAGENTA = "\x1b[35m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const memoryStore = new MemoryStore(WORKSPACE_DIR);

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

function buildTools() {
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
        const results = await memoryStore.searchMemory(query, 10);
        if (!results.length) {
          return `No memories matching '${query}'.`;
        }
        return results.map((r) => `[${r.path}] ${r.snippet}`).join("\n");
      },
    }),
  };
}

async function runSingleTurn(
  prompt: string,
  systemPrompt?: string,
): Promise<string> {
  const messages: ModelMessage[] = [{ role: "user", content: prompt }];
  const result = await runAgentLoop({
    modelId: MODEL_ID,
    systemPrompt:
      systemPrompt ??
      "You are a helpful assistant performing a background check.",
    messages,
    maxSteps: 5,
  });
  return result.text.trim();
}

function printReplHelp(): void {
  console.log(`${DIM}REPL commands:${RESET}`);
  console.log(`${DIM}  /heartbeat         -- heartbeat status${RESET}`);
  console.log(`${DIM}  /trigger           -- force heartbeat now${RESET}`);
  console.log(`${DIM}  /cron              -- list cron jobs${RESET}`);
  console.log(`${DIM}  /cron-trigger <id> -- trigger a cron job${RESET}`);
  console.log(`${DIM}  /lanes             -- lane lock status${RESET}`);
  console.log(`${DIM}  /help              -- this help${RESET}`);
  console.log(`${DIM}  quit / exit        -- exit${RESET}`);
}

async function main(): Promise<void> {
  if (!process.env.AI_GATEWAY_API_KEY) {
    console.error(
      "Error: AI_GATEWAY_API_KEY not set. Copy .env.example to .env.",
    );
    process.exit(1);
  }

  const laneLock = new LaneLock();
  const heartbeat = new HeartbeatRunner(
    WORKSPACE_DIR,
    laneLock,
    runSingleTurn,
    {
      intervalSeconds: Number(process.env.HEARTBEAT_INTERVAL ?? "1800"),
      activeStart: Number(process.env.HEARTBEAT_ACTIVE_START ?? "9"),
      activeEnd: Number(process.env.HEARTBEAT_ACTIVE_END ?? "22"),
    },
  );
  const cronService = new CronService(WORKSPACE_DIR, runSingleTurn);
  await cronService.loadJobs();

  heartbeat.start();
  const cronTimer = setInterval(() => {
    void cronService.tick();
  }, 1000);

  const messages: ModelMessage[] = [];
  const soul = await loadSoulPrompt();
  const mem = await memoryStore.loadEvergreen();
  const extra = mem ? `## Long-term Memory\n\n${mem}` : "";
  const systemPrompt = [soul, extra].filter(Boolean).join("\n\n");

  const hbStatus = heartbeat.status();
  console.log(`${DIM}${"=".repeat(60)}${RESET}`);
  console.log(`${DIM}  claw0-ts  |  Section 07: Heartbeat & Cron${RESET}`);
  console.log(`${DIM}  Model: ${MODEL_ID}${RESET}`);
  console.log(
    `${DIM}  Heartbeat: ${hbStatus.enabled ? "on" : "off"} (${hbStatus.interval})${RESET}`,
  );
  console.log(`${DIM}  Cron jobs: ${cronService.jobs.length}${RESET}`);
  console.log(`${DIM}  /help for commands. quit to exit.${RESET}`);
  console.log(`${DIM}${"=".repeat(60)}${RESET}`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  try {
    while (true) {
      for (const msg of heartbeat.drainOutput()) {
        console.log(`${CYAN}${BOLD}[heartbeat]${RESET} ${msg}`);
      }
      for (const msg of cronService.drainOutput()) {
        console.log(`${MAGENTA}${BOLD}[cron]${RESET} ${msg}`);
      }

      let raw = "";
      try {
        raw = await ask(`${CYAN}${BOLD}You > ${RESET}`);
      } catch {
        break;
      }

      const input = raw.trim();
      if (!input) continue;
      const lower = input.toLowerCase();
      if (["q", "quit", "exit"].includes(lower)) break;

      if (input.startsWith("/")) {
        const [cmdRaw, ...rest] = input.split(/\s+/);
        const cmd = cmdRaw.toLowerCase();
        const arg = rest.join(" ").trim();

        if (cmd === "/help") {
          printReplHelp();
          continue;
        }

        if (cmd === "/heartbeat") {
          const st = heartbeat.status();
          for (const [k, v] of Object.entries(st)) {
            console.log(`${DIM}  ${k}: ${String(v)}${RESET}`);
          }
          continue;
        }

        if (cmd === "/trigger") {
          console.log(`${DIM}  ${await heartbeat.trigger()}${RESET}`);
          for (const msg of heartbeat.drainOutput()) {
            console.log(`${CYAN}${BOLD}[heartbeat]${RESET} ${msg}`);
          }
          continue;
        }

        if (cmd === "/cron") {
          const jobs = cronService.listJobs();
          if (!jobs.length) {
            console.log(`${DIM}No cron jobs.${RESET}`);
            continue;
          }

          for (const j of jobs) {
            const on = j.enabled ? `${GREEN}ON${RESET}` : `${DIM}OFF${RESET}`;
            const err = j.errors ? ` err:${j.errors}` : "";
            const next = j.next_in == null ? "" : ` in ${j.next_in}s`;
            console.log(`  [${on}] ${j.id} - ${j.name}${err}${next}`);
          }
          continue;
        }

        if (cmd === "/cron-trigger") {
          if (!arg) {
            console.log("Usage: /cron-trigger <job_id>");
          } else {
            console.log(`${DIM}  ${await cronService.triggerJob(arg)}${RESET}`);
            for (const msg of cronService.drainOutput()) {
              console.log(`${MAGENTA}${BOLD}[cron]${RESET} ${msg}`);
            }
          }
          continue;
        }

        if (cmd === "/lanes") {
          console.log(
            `${DIM}  main_locked: ${laneLock.isLocked()}  heartbeat_running: ${heartbeat.status().running}${RESET}`,
          );
          continue;
        }

        console.log(`Unknown: ${cmd}. /help for commands.`);
        continue;
      }

      await laneLock.acquire();
      try {
        messages.push({ role: "user", content: input });

        const result = await runAgentLoop({
          modelId: MODEL_ID,
          systemPrompt,
          messages,
          tools: buildTools(),
          maxSteps: 30,
        });

        const reply = result.text || `[finish_reason=${result.finishReason}]`;
        console.log(`\n${GREEN}${BOLD}Assistant:${RESET} ${reply}\n`);
      } catch (error: unknown) {
        const err = error as { message?: string };
        console.log(`\nAPI Error: ${err.message ?? "unknown"}\n`);
        while (
          messages.length &&
          messages[messages.length - 1]?.role !== "user"
        ) {
          messages.pop();
        }
        if (messages.length) messages.pop();
      } finally {
        laneLock.release();
      }
    }
  } finally {
    rl.close();
    heartbeat.stop();
    clearInterval(cronTimer);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
