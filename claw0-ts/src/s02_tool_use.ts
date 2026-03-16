import * as readline from "node:readline";
import type { ModelMessage } from "ai";
import { runAgentLoop } from "./core/agent-loop.js";
import { buildS02Tools } from "./core/tool-dispatch.js";
import "dotenv/config";

const MODEL_ID = process.env.MODEL_ID ?? "openai/gpt-5.4";
const SYSTEM_PROMPT = [
  "You are a helpful AI assistant with access to tools.",
  "Use tools for shell and file operations when needed.",
  "Always read a file before editing it.",
  "For edit_file, old_string must match exactly once.",
].join("\n");

async function main(): Promise<void> {
  if (!process.env.AI_GATEWAY_API_KEY) {
    console.error(
      "Error: AI_GATEWAY_API_KEY not set. Copy .env.example to .env.",
    );
    process.exit(1);
  }

  const messages: ModelMessage[] = [];
  const tools = buildS02Tools();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  console.log("claw0-ts s02 (AI Gateway)");

  while (true) {
    const query = (await ask("\x1b[36mYou > \x1b[0m")).trim();
    if (!query) continue;
    if (["q", "quit", "exit"].includes(query.toLowerCase())) break;

    messages.push({ role: "user", content: query });
    const result = await runAgentLoop({
      modelId: MODEL_ID,
      systemPrompt: SYSTEM_PROMPT,
      messages,
      tools,
      maxSteps: 30,
    });

    console.log(
      `\n\x1b[32mAssistant:\x1b[0m ${result.text || `[finish_reason=${result.finishReason}]`}\n`,
    );
  }

  rl.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
