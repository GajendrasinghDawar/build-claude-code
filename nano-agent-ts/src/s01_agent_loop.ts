import { anthropic } from "@ai-sdk/anthropic";
import { generateText, tool, type ModelMessage, stepCountIs } from "ai";
import * as readline from "node:readline";
import { z } from "zod";
import { runBash, WORKDIR } from "./tools/base.js";
import "dotenv/config";

const MODEL = process.env.MODEL_ID ?? "claude-sonnet-4-6";

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use bash to solve tasks. Act, do not over-explain.`;

async function agentLoop(messages: ModelMessage[]): Promise<string> {
  const result = await generateText({
    model: anthropic(MODEL),
    system: SYSTEM,
    messages,
    stopWhen: stepCountIs(50),
    tools: {
      bash: tool({
        description: "Run a shell command.",
        inputSchema: z.object({ command: z.string() }),
        execute: async ({ command }) => {
          console.log(`\x1b[33m$ ${command}\x1b[0m`);
          const output = await runBash(command);
          console.log(output.slice(0, 200));
          return output;
        },
      }),
    },
  });

  messages.push(...result.response.messages);
  return result.text.trim();
}

async function main(): Promise<void> {
  const history: ModelMessage[] = [];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  while (true) {
    const query = await ask("\x1b[36ms01 >> \x1b[0m");
    const normalized = query.trim().toLowerCase();
    if (!query.trim() || normalized === "q" || normalized === "exit") {
      break;
    }

    history.push({ role: "user", content: query });
    const finalText = await agentLoop(history);
    if (finalText) {
      console.log(finalText);
    }
    console.log();
  }

  rl.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
