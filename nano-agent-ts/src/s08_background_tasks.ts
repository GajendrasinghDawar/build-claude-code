import { anthropic } from "@ai-sdk/anthropic";
import { generateText, tool, type CoreMessage } from "ai";
import * as readline from "node:readline";
import { z } from "zod";
import { BackgroundManager } from "./managers/background.js";
import { runBash, runEdit, runRead, runWrite, WORKDIR } from "./tools/base.js";
import "dotenv/config";

const MODEL = process.env.MODEL_ID ?? "claude-sonnet-4-6";
const BG = new BackgroundManager();

const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use background_run for long operations and continue working while they execute.
Before making decisions, consider any drained background results.`;

function injectBackgroundNotifications(messages: CoreMessage[]): void {
  const notifications = BG.drainNotifications();
  if (!notifications.length) {
    return;
  }

  const text = notifications
    .map((n) => `[bg:${n.task_id}] ${n.status}: ${n.result}`)
    .join("\n");

  messages.push({
    role: "user",
    content: `<background-results>\n${text}\n</background-results>`,
  });
}

async function agentLoop(messages: CoreMessage[]): Promise<string> {
  while (true) {
    injectBackgroundNotifications(messages);

    const result = await generateText({
      model: anthropic(MODEL),
      system: SYSTEM,
      messages,
      maxSteps: 50,
      tools: {
        bash: tool({
          description: "Run a shell command.",
          parameters: z.object({ command: z.string() }),
          execute: async ({ command }) => runBash(command),
        }),
        read_file: tool({
          description: "Read file contents.",
          parameters: z.object({
            path: z.string(),
            limit: z.number().int().positive().optional(),
          }),
          execute: async ({ path, limit }) => runRead(path, limit),
        }),
        write_file: tool({
          description: "Write content to file.",
          parameters: z.object({ path: z.string(), content: z.string() }),
          execute: async ({ path, content }) => runWrite(path, content),
        }),
        edit_file: tool({
          description: "Replace exact text in file.",
          parameters: z.object({
            path: z.string(),
            old_text: z.string(),
            new_text: z.string(),
          }),
          execute: async ({ path, old_text, new_text }) =>
            runEdit(path, old_text, new_text),
        }),
        background_run: tool({
          description: "Run a command asynchronously in background.",
          parameters: z.object({ command: z.string() }),
          execute: async ({ command }) => BG.run(command),
        }),
        check_background: tool({
          description: "Check one background task or all current tasks.",
          parameters: z.object({ task_id: z.string().optional() }),
          execute: async ({ task_id }) => BG.check(task_id),
        }),
      },
    });

    messages.push(...result.response.messages);

    if (result.finishReason !== "tool-calls") {
      return result.text.trim();
    }
  }
}

async function main(): Promise<void> {
  const history: CoreMessage[] = [];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  while (true) {
    const query = await ask("\x1b[36ms08 >> \x1b[0m");
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
