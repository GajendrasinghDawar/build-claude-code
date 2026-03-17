import Anthropic from "@anthropic-ai/sdk";
import * as readline from "node:readline";
import "dotenv/config";
import { runAgentLoop } from "./core/agent-loop.js";
import { TOOLS } from "./core/tool-dispatch.js";

const MODEL_ID = process.env.MODEL_ID ?? "claude-sonnet-4-20250514";
const SYSTEM_PROMPT = [
  "You are a helpful AI assistant with access to tools.",
  "Use tools for shell and file operations when needed.",
  "Always read a file before editing it.",
  "When using edit_file, old_string must match exactly.",
].join("\n");

const CYAN = "\u001b[36m";
const GREEN = "\u001b[32m";
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";

function printAssistant(text: string): void {
  console.log(`\n${GREEN}${BOLD}Assistant:${RESET} ${text}\n`);
}

function printInfo(text: string): void {
  console.log(`${DIM}${text}${RESET}`);
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "Error: ANTHROPIC_API_KEY not set. Copy .env.example to .env.",
    );
    process.exit(1);
  }

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
  });

  const messages: Anthropic.MessageParam[] = [];

  printInfo("=".repeat(60));
  printInfo("  claw0  |  Section 02: Tool Use");
  printInfo(`  Model: ${MODEL_ID}`);
  printInfo(`  Tools: ${TOOLS.map((t) => t.name).join(", ")}`);
  printInfo("  Type 'quit' or 'exit' to leave.");
  printInfo("=".repeat(60));
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  while (true) {
    const query = (await ask(`${CYAN}${BOLD}You > ${RESET}`)).trim();
    if (!query) continue;
    if (["quit", "exit"].includes(query.toLowerCase())) break;

    messages.push({ role: "user", content: query });

    try {
      const result = await runAgentLoop({
        client,
        modelId: MODEL_ID,
        systemPrompt: SYSTEM_PROMPT,
        messages,
        tools: TOOLS,
      });

      if (result.text) printAssistant(result.text);
      else printInfo(`[stop_reason=${result.stopReason}]`);
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
    }
  }

  rl.close();
  printInfo("Goodbye.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
