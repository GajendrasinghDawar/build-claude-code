import * as readline from "node:readline";
import { join } from "node:path";
import { tool, type ModelMessage } from "ai";
import { z } from "zod";
import { runAgentLoop } from "./core/agent-loop.js";
import { MemoryStore } from "./intelligence/memory-store.js";
import { DeliveryQueue, chunkMessage } from "./delivery/queue.js";
import { DeliveryRunner } from "./delivery/runner.js";
import { MockDeliveryChannel } from "./delivery/mock-channel.js";
import "dotenv/config";

const MODEL_ID = process.env.MODEL_ID ?? "openai/gpt-5.4";
const WORKSPACE_DIR = join(process.cwd(), "workspace");
const QUEUE_DIR = join(WORKSPACE_DIR, "delivery-queue");

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const MAGENTA = "\x1b[35m";

const memoryStore = new MemoryStore(WORKSPACE_DIR);

function systemPrompt(): string {
  return [
    "You are Luna, a warm and curious AI companion.",
    "Keep replies concise and helpful.",
    "Use memory_write to save important facts.",
    "Use memory_search to recall past context.",
  ].join(" ");
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
      description: "Search long-term memory for relevant facts.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const results = await memoryStore.searchMemory(query, 5);
        if (!results.length) return "No memories found.";
        return results.map((r) => `- ${r.snippet}`).join("\n");
      },
    }),
  };
}

class SimpleHeartbeat {
  private timer: NodeJS.Timeout | null = null;
  private runCount = 0;
  private lastRun = 0;
  private enabled = false;

  constructor(
    private readonly queue: DeliveryQueue,
    private readonly channel: string,
    private readonly to: string,
    private readonly intervalSeconds = 120,
  ) {}

  start(): void {
    if (this.timer) return;
    this.enabled = true;
    this.timer = setInterval(() => {
      if (!this.enabled) return;
      void this.trigger();
    }, this.intervalSeconds * 1000);
  }

  async trigger(): Promise<void> {
    this.runCount += 1;
    this.lastRun = Date.now() / 1000;
    const text = `[Heartbeat #${this.runCount}] System check at ${new Date().toISOString().slice(11, 19)} -- all OK.`;
    const chunks = chunkMessage(text, this.channel);
    for (const chunk of chunks) {
      await this.queue.enqueue(this.channel, this.to, chunk);
    }
    console.log(
      `${DIM}  ${MAGENTA}[heartbeat]${RESET}${DIM} triggered #${this.runCount}${RESET}`,
    );
  }

  stop(): void {
    this.enabled = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getStatus(): {
    enabled: boolean;
    interval: number;
    run_count: number;
    last_run: string;
  } {
    return {
      enabled: this.enabled,
      interval: this.intervalSeconds,
      run_count: this.runCount,
      last_run: this.lastRun
        ? new Date(this.lastRun * 1000).toISOString().slice(11, 19)
        : "never",
    };
  }
}

async function handleCommand(
  cmd: string,
  queue: DeliveryQueue,
  runner: DeliveryRunner,
  heartbeat: SimpleHeartbeat,
  mockChannel: MockDeliveryChannel,
): Promise<boolean> {
  if (cmd === "/queue") {
    const pending = await queue.loadPending();
    if (!pending.length) {
      console.log(`${DIM}  Queue is empty.${RESET}`);
      return true;
    }

    console.log(`${DIM}  Pending deliveries (${pending.length}):${RESET}`);
    const now = Date.now() / 1000;
    for (const entry of pending) {
      const wait =
        entry.next_retry_at > now
          ? `, wait ${Math.ceil(entry.next_retry_at - now)}s`
          : "";
      const preview = entry.text.slice(0, 40).replace(/\n/g, " ");
      console.log(
        `${DIM}    ${entry.id.slice(0, 8)}... retry=${entry.retry_count}${wait} "${preview}"${RESET}`,
      );
    }
    return true;
  }

  if (cmd === "/failed") {
    const failed = await queue.loadFailed();
    if (!failed.length) {
      console.log(`${DIM}  No failed deliveries.${RESET}`);
      return true;
    }

    console.log(`${DIM}  Failed deliveries (${failed.length}):${RESET}`);
    for (const entry of failed) {
      const preview = entry.text.slice(0, 40).replace(/\n/g, " ");
      const err = (entry.last_error ?? "unknown").slice(0, 30);
      console.log(
        `${DIM}    ${entry.id.slice(0, 8)}... retries=${entry.retry_count} error="${err}" "${preview}"${RESET}`,
      );
    }
    return true;
  }

  if (cmd === "/retry") {
    const moved = await queue.retryFailed();
    console.log(`${DIM}  Moved ${moved} entries back to queue.${RESET}`);
    return true;
  }

  if (cmd === "/simulate-failure") {
    if (mockChannel.getFailRate() > 0) {
      mockChannel.setFailRate(0);
      console.log(
        `${DIM}  ${mockChannel.name} fail rate -> 0% (reliable)${RESET}`,
      );
    } else {
      mockChannel.setFailRate(0.5);
      console.log(
        `${DIM}  ${mockChannel.name} fail rate -> 50% (unreliable)${RESET}`,
      );
    }
    return true;
  }

  if (cmd === "/heartbeat") {
    const st = heartbeat.getStatus();
    console.log(
      `${DIM}  Heartbeat: enabled=${st.enabled}, interval=${st.interval}s, runs=${st.run_count}, last=${st.last_run}${RESET}`,
    );
    return true;
  }

  if (cmd === "/trigger") {
    await heartbeat.trigger();
    return true;
  }

  if (cmd === "/stats") {
    const st = await runner.getStats();
    console.log(
      `${DIM}  Delivery stats: pending=${st.pending}, failed=${st.failed}, attempted=${st.total_attempted}, succeeded=${st.total_succeeded}, errors=${st.total_failed}${RESET}`,
    );
    return true;
  }

  return false;
}

async function main(): Promise<void> {
  if (!process.env.AI_GATEWAY_API_KEY) {
    console.error(`${YELLOW}Error: AI_GATEWAY_API_KEY not set.${RESET}`);
    process.exit(1);
  }

  const mockChannel = new MockDeliveryChannel("console", 0);
  const defaultChannel = "console";
  const defaultTo = "user";

  const queue = new DeliveryQueue(QUEUE_DIR);
  await queue.init();

  const runner = new DeliveryRunner(queue, async (_channel, to, text) => {
    await mockChannel.send(to, text);
  });
  await runner.start();

  const heartbeat = new SimpleHeartbeat(queue, defaultChannel, defaultTo, 120);
  heartbeat.start();

  const messages: ModelMessage[] = [];

  console.log(`${DIM}${"=".repeat(60)}${RESET}`);
  console.log(`${DIM}  claw0-ts  |  Section 08: Delivery${RESET}`);
  console.log(`${DIM}  Model: ${MODEL_ID}${RESET}`);
  console.log(`${DIM}  Queue: ${QUEUE_DIR}${RESET}`);
  console.log(`${DIM}  Commands:${RESET}`);
  console.log(`${DIM}    /queue             - show pending deliveries${RESET}`);
  console.log(`${DIM}    /failed            - show failed deliveries${RESET}`);
  console.log(`${DIM}    /retry             - retry all failed${RESET}`);
  console.log(`${DIM}    /simulate-failure  - toggle 50% failure rate${RESET}`);
  console.log(`${DIM}    /heartbeat         - heartbeat status${RESET}`);
  console.log(
    `${DIM}    /trigger           - manually trigger heartbeat${RESET}`,
  );
  console.log(`${DIM}    /stats             - delivery statistics${RESET}`);
  console.log(`${DIM}  Type 'quit' or 'exit' to leave.${RESET}`);
  console.log(`${DIM}${"=".repeat(60)}${RESET}`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  try {
    while (true) {
      let raw = "";
      try {
        raw = await ask(`${CYAN}${BOLD}You > ${RESET}`);
      } catch {
        break;
      }

      const userInput = raw.trim();
      if (!userInput) continue;

      if (["q", "quit", "exit"].includes(userInput.toLowerCase())) {
        break;
      }

      if (userInput.startsWith("/")) {
        const handled = await handleCommand(
          userInput,
          queue,
          runner,
          heartbeat,
          mockChannel,
        );
        if (!handled) {
          console.log(`${DIM}  Unknown command: ${userInput}${RESET}`);
        }
        continue;
      }

      messages.push({ role: "user", content: userInput });

      try {
        const result = await runAgentLoop({
          modelId: MODEL_ID,
          systemPrompt: systemPrompt(),
          messages,
          tools: buildTools(),
          maxSteps: 30,
        });

        const assistantText =
          result.text || `[finish_reason=${result.finishReason}]`;
        console.log(`\n${GREEN}${BOLD}Assistant:${RESET} ${assistantText}\n`);

        const chunks = chunkMessage(assistantText, defaultChannel);
        for (const chunk of chunks) {
          await queue.enqueue(defaultChannel, defaultTo, chunk);
        }
      } catch (error: unknown) {
        const err = error as { message?: string };
        console.log(
          `\n${YELLOW}API Error: ${err.message ?? "unknown"}${RESET}\n`,
        );

        while (
          messages.length &&
          messages[messages.length - 1]?.role !== "user"
        ) {
          messages.pop();
        }
        if (messages.length) messages.pop();
      }
    }
  } finally {
    heartbeat.stop();
    await runner.stop();
    rl.close();
    console.log(
      `${DIM}Delivery runner stopped. Queue state preserved on disk.${RESET}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
