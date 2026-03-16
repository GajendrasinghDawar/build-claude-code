import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as readline from "node:readline";
import { tool, type ModelMessage } from "ai";
import { z } from "zod";
import { runAgentLoop } from "./core/agent-loop.js";
import { ChannelManager } from "./channels/channel-manager.js";
import { CLIChannel } from "./channels/cli-channel.js";
import { TelegramChannel } from "./channels/telegram-channel.js";
import { FeishuChannel } from "./channels/feishu-channel.js";
import { buildSessionKey } from "./channels/channel.js";
import type { ChannelAccount, InboundMessage } from "./types.js";
import "dotenv/config";

const MODEL_ID = process.env.MODEL_ID ?? "openai/gpt-5.4";
const WORKSPACE_DIR = join(process.cwd(), "workspace");
const STATE_DIR = join(WORKSPACE_DIR, ".state");
const MEMORY_FILE = join(WORKSPACE_DIR, "MEMORY.md");

const SYSTEM_PROMPT = [
  "You are a helpful AI assistant connected to multiple messaging channels.",
  "You can save and search notes using memory tools.",
  "When responding, be concise and helpful.",
].join("\n");

function maskToken(token: string): string {
  return token.length > 8 ? `${token.slice(0, 8)}...` : token || "(none)";
}

async function toolMemoryWrite(content: string): Promise<string> {
  const line = `\n- ${content}\n`;
  await appendFile(MEMORY_FILE, line, "utf-8");
  return `Written to memory: ${content.slice(0, 80)}`;
}

async function toolMemorySearch(query: string): Promise<string> {
  try {
    const text = await readFile(MEMORY_FILE, "utf-8");
    const matches = text
      .split("\n")
      .filter((line) => line.toLowerCase().includes(query.toLowerCase()))
      .slice(0, 20);
    return matches.length ? matches.join("\n") : `No matches for '${query}'.`;
  } catch {
    return "Memory file is empty.";
  }
}

function buildS04Tools() {
  return {
    memory_write: tool({
      description: "Save a note to long-term memory.",
      inputSchema: z.object({ content: z.string() }),
      execute: async ({ content }) => toolMemoryWrite(content),
    }),
    memory_search: tool({
      description: "Search through saved memory notes.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => toolMemorySearch(query),
    }),
  };
}

async function runAgentTurn(
  inbound: InboundMessage,
  conversations: Map<string, ModelMessage[]>,
  manager: ChannelManager,
  tools: ReturnType<typeof buildS04Tools>,
): Promise<void> {
  const sessionKey = buildSessionKey(
    inbound.channel,
    inbound.accountId,
    inbound.peerId,
  );
  if (!conversations.has(sessionKey)) {
    conversations.set(sessionKey, []);
  }

  const messages = conversations.get(sessionKey)!;
  messages.push({ role: "user", content: inbound.text });

  const telegram = manager.get("telegram");
  if (inbound.channel === "telegram" && telegram instanceof TelegramChannel) {
    await telegram.sendTyping(inbound.peerId);
  }

  const result = await runAgentLoop({
    modelId: MODEL_ID,
    systemPrompt: SYSTEM_PROMPT,
    messages,
    tools,
    maxSteps: 30,
  });

  const reply = result.text || `[finish_reason=${result.finishReason}]`;
  const ch = manager.get(inbound.channel) ?? manager.get("cli");
  if (ch) {
    await ch.send(inbound.peerId, reply);
  } else {
    console.log(`\n\x1b[32m\x1b[1mAssistant:\x1b[0m ${reply}\n`);
  }
}

function printHelp(): void {
  console.log("  /channels  /accounts  /poll  /help  quit/exit");
}

async function main(): Promise<void> {
  if (!process.env.AI_GATEWAY_API_KEY) {
    console.error(
      "Error: AI_GATEWAY_API_KEY not set. Copy .env.example to .env.",
    );
    process.exit(1);
  }

  const manager = new ChannelManager();
  const cli = new CLIChannel();
  manager.register(cli);

  const tools = buildS04Tools();
  const conversations = new Map<string, ModelMessage[]>();

  let telegram: TelegramChannel | null = null;
  const tgToken = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  if (tgToken) {
    const tgAccount: ChannelAccount = {
      channel: "telegram",
      accountId: "tg-primary",
      token: tgToken,
      config: {
        allowed_chats: process.env.TELEGRAM_ALLOWED_CHATS ?? "",
      },
    };
    manager.accounts.push(tgAccount);
    telegram = new TelegramChannel(tgAccount, STATE_DIR);
    manager.register(telegram);
  }

  const fsId = (process.env.FEISHU_APP_ID ?? "").trim();
  const fsSecret = (process.env.FEISHU_APP_SECRET ?? "").trim();
  if (fsId && fsSecret) {
    const fsAccount: ChannelAccount = {
      channel: "feishu",
      accountId: "feishu-primary",
      token: "",
      config: {
        app_id: fsId,
        app_secret: fsSecret,
        is_lark: ["1", "true"].includes(
          (process.env.FEISHU_IS_LARK ?? "").toLowerCase(),
        ),
      },
    };
    manager.accounts.push(fsAccount);
    manager.register(new FeishuChannel(fsAccount));
  }

  console.log("=".repeat(60));
  console.log("  claw0-ts  |  Section 04: Channels");
  console.log(`  Model: ${MODEL_ID}`);
  console.log(`  Channels: ${manager.listChannels().join(", ")}`);
  printHelp();
  console.log("=".repeat(60));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  try {
    while (true) {
      const input = (await ask("\x1b[36m\x1b[1mYou > \x1b[0m")).trim();
      if (!input) continue;

      const lower = input.toLowerCase();
      if (["q", "quit", "exit"].includes(lower)) break;

      if (input.startsWith("/")) {
        if (lower === "/channels") {
          for (const name of manager.listChannels()) {
            console.log(`  - ${name}`);
          }
          continue;
        }

        if (lower === "/accounts") {
          for (const acc of manager.accounts) {
            console.log(
              `  - ${acc.channel}/${acc.accountId} token=${maskToken(acc.token)}`,
            );
          }
          continue;
        }

        if (lower === "/poll") {
          if (!telegram) {
            console.log("  Telegram channel is not configured.");
            continue;
          }

          const inboundList = await telegram.poll();
          if (!inboundList.length) {
            console.log("  No new Telegram messages.");
            continue;
          }

          for (const inbound of inboundList) {
            console.log(
              `  [telegram] ${inbound.senderId}: ${inbound.text.slice(0, 80)}`,
            );
            await runAgentTurn(inbound, conversations, manager, tools);
          }
          continue;
        }

        if (lower === "/help" || lower === "/h") {
          printHelp();
          continue;
        }
      }

      await runAgentTurn(
        {
          text: input,
          senderId: "cli-user",
          channel: "cli",
          accountId: "cli-local",
          peerId: "cli-user",
          isGroup: false,
          media: [],
          raw: {},
        },
        conversations,
        manager,
        tools,
      );
    }
  } finally {
    rl.close();
    await manager.closeAll();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
