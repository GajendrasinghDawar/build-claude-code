import * as readline from "node:readline";
import "dotenv/config";
import { buildConfig, ensureWorkspace } from "./config.js";
import { SessionCommandQueue } from "./queue.js";
import { resolveAgent } from "./router.js";
import { runAgentTurn } from "./agent.js";
import { startMorningHeartbeat } from "./heartbeat.js";
import { startHttpGateway } from "./http-gateway.js";
import type { AgentConfig } from "./types.js";

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function buildAgents(modelId: string, workspaceDir: string): Record<string, AgentConfig> {
  return {
    main: {
      id: "main",
      name: "Jarvis",
      modelId,
      sessionPrefix: "agent:main",
      soul: [
        "You are Jarvis, a personal AI assistant.",
        "Be genuinely helpful and concise.",
        "Use tools proactively when useful.",
        "Use save_memory for long-term facts and preferences.",
        `Workspace root: ${workspaceDir}`,
      ].join("\n"),
    },
    researcher: {
      id: "researcher",
      name: "Scout",
      modelId,
      sessionPrefix: "agent:researcher",
      soul: [
        "You are Scout, a research specialist.",
        "Cite evidence and be precise.",
        "Use web_search and save_memory to capture findings.",
      ].join("\n"),
    },
  };
}

async function main(): Promise<void> {
  if (!process.env.AI_GATEWAY_API_KEY) {
    console.error("AI_GATEWAY_API_KEY is required.");
    process.exit(1);
  }

  const config = buildConfig();
  await ensureWorkspace(config);

  const agents = buildAgents(config.modelId, config.workspaceDir);
  const queue = new SessionCommandQueue();

  const runTurn = (sessionKey: string, text: string, agent: AgentConfig) =>
    runAgentTurn({
      config,
      agent,
      sessionKey,
      userText: text,
    });

  const stopHeartbeat = startMorningHeartbeat({
    config,
    mainAgent: agents.main,
    runTurn,
  });

  const gateway = startHttpGateway({
    config,
    agents,
    queue,
    runTurn,
  });

  let mainSession = "agent:main:repl";

  console.log(`${DIM}Mini OpenClaw (TypeScript + AI SDK)${RESET}`);
  console.log(`${DIM}Workspace: ${config.workspaceDir}${RESET}`);
  console.log(`${DIM}Commands: /new, /research <query>, /quit${RESET}`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  try {
    while (true) {
      const input = (await ask(`${CYAN}${BOLD}You > ${RESET}`)).trim();
      if (!input) continue;

      if (["/quit", "/exit", "/q"].includes(input.toLowerCase())) {
        break;
      }

      if (input.toLowerCase() === "/new") {
        mainSession = `agent:main:repl:${Date.now()}`;
        console.log(`${DIM}Session reset.${RESET}`);
        continue;
      }

      const { agentId, text } = resolveAgent(input);
      const agent = agents[agentId];
      const sessionKey =
        agentId === "main" ? mainSession : `${agent.sessionPrefix}:repl`;

      const reply = await queue.enqueue(sessionKey, () =>
        runTurn(sessionKey, text, agent),
      );
      console.log(`\n${GREEN}${BOLD}[${agent.name}]${RESET} ${reply}\n`);
    }
  } finally {
    rl.close();
    stopHeartbeat();
    await gateway.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
