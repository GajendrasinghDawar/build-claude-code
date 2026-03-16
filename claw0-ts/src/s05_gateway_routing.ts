import * as readline from "node:readline";
import { tool } from "ai";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runAgentLoop } from "./core/agent-loop.js";
import {
  AgentManager,
  buildSessionKey,
  normalizeAgentId,
} from "./gateway/agent-manager.js";
import {
  BindingTable,
  bindingDisplay,
  type Binding,
} from "./gateway/routing-table.js";
import { GatewayServer } from "./gateway/gateway-server.js";
import "dotenv/config";

const MODEL_ID = process.env.MODEL_ID ?? "openai/gpt-5.4";
const WORKSPACE_DIR = join(process.cwd(), "workspace");
const MAX_READ = 30_000;

function buildTools() {
  return {
    read_file: tool({
      description: "Read the contents of a file.",
      inputSchema: z.object({ file_path: z.string() }),
      execute: async ({ file_path }) => {
        try {
          const content = await readFile(file_path, "utf-8");
          return content.length > MAX_READ
            ? `${content.slice(0, MAX_READ)}\n... [truncated, ${content.length} total chars]`
            : content;
        } catch (error: unknown) {
          const err = error as { message?: string };
          return `Error: ${err.message ?? "read failed"}`;
        }
      },
    }),
    get_current_time: tool({
      description: "Get the current date and time in UTC.",
      inputSchema: z.object({}),
      execute: async () =>
        new Date().toISOString().replace("T", " ").replace(".000Z", " UTC"),
    }),
  };
}

function systemPromptFor(manager: AgentManager, agentId: string): string {
  const agent = manager.getAgent(agentId);
  if (!agent) {
    return "You are a helpful AI assistant. Answer questions helpfully.";
  }

  const parts = [`You are ${agent.name}.`];
  if (agent.personality) {
    parts.push(`Your personality: ${agent.personality}`);
  }
  parts.push("Answer questions helpfully and stay in character.");
  return parts.join(" ");
}

function setupDemo(): { manager: AgentManager; bindings: BindingTable } {
  const manager = new AgentManager(WORKSPACE_DIR);
  manager.register({
    id: "luna",
    name: "Luna",
    personality:
      "warm, curious, and encouraging. You ask thoughtful follow-up questions.",
  });
  manager.register({
    id: "sage",
    name: "Sage",
    personality:
      "direct, analytical, and concise. You prefer facts over opinions.",
  });
  manager.register({ id: "main", name: "Main" });

  const bindings = new BindingTable();
  bindings.add({
    agentId: "luna",
    tier: 5,
    matchKey: "default",
    matchValue: "*",
    priority: 0,
  });
  bindings.add({
    agentId: "sage",
    tier: 4,
    matchKey: "channel",
    matchValue: "telegram",
    priority: 0,
  });
  bindings.add({
    agentId: "sage",
    tier: 1,
    matchKey: "peer_id",
    matchValue: "discord:admin-001",
    priority: 10,
  });

  return { manager, bindings };
}

function resolveRoute(
  manager: AgentManager,
  bindings: BindingTable,
  input: {
    channel: string;
    peerId: string;
    accountId?: string;
    guildId?: string;
  },
): { agentId: string; sessionKey: string; matched: Binding | null } {
  const resolved = bindings.resolve({
    channel: input.channel,
    accountId: input.accountId ?? "",
    guildId: input.guildId ?? "",
    peerId: input.peerId,
  });

  const agentId = resolved.agentId ?? "main";
  const agent = manager.getAgent(agentId);

  const sessionKey = buildSessionKey({
    agentId,
    channel: input.channel,
    accountId: input.accountId ?? "",
    peerId: input.peerId,
    dmScope: agent?.dmScope ?? "per-peer",
  });

  return {
    agentId,
    sessionKey,
    matched: resolved.binding,
  };
}

async function runTurn(params: {
  manager: AgentManager;
  agentId: string;
  sessionKey: string;
  userText: string;
}): Promise<string> {
  const { manager, agentId, sessionKey, userText } = params;
  const messages = manager.getSession(sessionKey);
  messages.push({ role: "user", content: userText });

  const result = await runAgentLoop({
    modelId: MODEL_ID,
    systemPrompt: systemPromptFor(manager, agentId),
    messages,
    tools: buildTools(),
    maxSteps: 20,
  });

  return result.text || `[finish_reason=${result.finishReason}]`;
}

async function main(): Promise<void> {
  if (!process.env.AI_GATEWAY_API_KEY) {
    console.error(
      "Error: AI_GATEWAY_API_KEY not set. Copy .env.example to .env.",
    );
    process.exit(1);
  }

  const { manager, bindings } = setupDemo();

  const gateway = new GatewayServer(
    manager,
    bindings,
    MODEL_ID,
    buildTools,
    (agentId) => systemPromptFor(manager, agentId),
  );

  let forceAgent = "";
  const channel = "cli";
  const peerId = "repl-user";

  console.log("=".repeat(64));
  console.log("  claw0-ts  |  Section 05: Gateway & Routing");
  console.log(`  Model: ${MODEL_ID}`);
  console.log("  /bindings  /route <ch> <peer> [account] [guild]");
  console.log("  /agents  /sessions  /switch <id|off>  /gateway");
  console.log("=".repeat(64));

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
        const [cmdRaw, ...rest] = input.split(/\s+/);
        const cmd = cmdRaw.toLowerCase();
        const args = rest;

        if (cmd === "/bindings") {
          const all = bindings.listAll();
          if (!all.length) {
            console.log("  (no bindings)");
          } else {
            for (const binding of all) {
              console.log(`  - ${bindingDisplay(binding)}`);
            }
          }
          continue;
        }

        if (cmd === "/route") {
          if (args.length < 2) {
            console.log(
              "  Usage: /route <channel> <peer_id> [account_id] [guild_id]",
            );
            continue;
          }
          const route = resolveRoute(manager, bindings, {
            channel: args[0],
            peerId: args[1],
            accountId: args[2] ?? "",
            guildId: args[3] ?? "",
          });
          console.log(`  Agent: ${route.agentId}`);
          console.log(`  Session: ${route.sessionKey}`);
          console.log(
            `  Match: ${route.matched ? bindingDisplay(route.matched) : "(default main)"}`,
          );
          continue;
        }

        if (cmd === "/agents") {
          for (const agent of manager.listAgents()) {
            console.log(
              `  - ${agent.id} (${agent.name}) dm_scope=${agent.dmScope ?? "per-peer"}`,
            );
          }
          continue;
        }

        if (cmd === "/sessions") {
          const sessions = manager.listSessions();
          const entries = Object.entries(sessions);
          if (!entries.length) {
            console.log("  (no sessions)");
          } else {
            for (const [key, count] of entries) {
              console.log(`  - ${key} (${count} msgs)`);
            }
          }
          continue;
        }

        if (cmd === "/switch") {
          if (!args.length) {
            console.log(`  force=${forceAgent || "(off)"}`);
            continue;
          }

          const target = args[0].toLowerCase();
          if (target === "off") {
            forceAgent = "";
            console.log("  Routing mode restored.");
            continue;
          }

          const normalized = normalizeAgentId(target);
          if (!manager.getAgent(normalized)) {
            console.log(`  Not found: ${normalized}`);
            continue;
          }

          forceAgent = normalized;
          console.log(`  Forcing agent: ${forceAgent}`);
          continue;
        }

        if (cmd === "/gateway") {
          if (gateway.isRunning()) {
            console.log("  Gateway already running on ws://127.0.0.1:8765");
          } else {
            await gateway.start(8765, "127.0.0.1");
            console.log("  Gateway running on ws://127.0.0.1:8765");
          }
          continue;
        }

        console.log(`  Unknown command: ${cmd}`);
        continue;
      }

      let chosenAgent = "";
      let sessionKey = "";

      if (forceAgent) {
        chosenAgent = forceAgent;
        const agent = manager.getAgent(chosenAgent);
        sessionKey = buildSessionKey({
          agentId: chosenAgent,
          channel,
          peerId,
          dmScope: agent?.dmScope ?? "per-peer",
        });
      } else {
        const route = resolveRoute(manager, bindings, { channel, peerId });
        chosenAgent = route.agentId;
        sessionKey = route.sessionKey;
      }

      const agent = manager.getAgent(chosenAgent);
      console.log(
        `  -> ${agent?.name ?? chosenAgent} (${chosenAgent}) | ${sessionKey}`,
      );

      const reply = await runTurn({
        manager,
        agentId: chosenAgent,
        sessionKey,
        userText: input,
      });

      console.log(
        `\n\x1b[32m\x1b[1m${agent?.name ?? chosenAgent}:\x1b[0m ${reply}\n`,
      );
    }
  } finally {
    rl.close();
    await gateway.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
