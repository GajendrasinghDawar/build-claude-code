import { anthropic } from "@ai-sdk/anthropic";
import { generateText, tool, type ModelMessage, stepCountIs } from "ai";
import * as readline from "node:readline";
import { z } from "zod";
import { runBash, runEdit, runRead, runWrite, WORKDIR } from "./tools/base.js";
import "dotenv/config";

const MODEL = process.env.MODEL_ID ?? "claude-sonnet-4-6";

function buildTools(withTask: boolean) {
  const baseTools = {
    bash: tool({
      description: "Run a shell command.",
      inputSchema: z.object({ command: z.string() }),
      execute: async ({ command }: { command: string }) => runBash(command),
    }),
    read_file: tool({
      description: "Read file contents.",
      inputSchema: z.object({
        path: z.string(),
        limit: z.number().int().positive().optional(),
      }),
      execute: async ({ path, limit }: { path: string; limit?: number }) =>
        runRead(path, limit),
    }),
    write_file: tool({
      description: "Write content to file.",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }: { path: string; content: string }) =>
        runWrite(path, content),
    }),
    edit_file: tool({
      description: "Replace exact text in file.",
      inputSchema: z.object({
        path: z.string(),
        old_text: z.string(),
        new_text: z.string(),
      }),
      execute: async ({
        path,
        old_text,
        new_text,
      }: {
        path: string;
        old_text: string;
        new_text: string;
      }) => runEdit(path, old_text, new_text),
    }),
  };

  if (!withTask) {
    return baseTools;
  }

  return {
    ...baseTools,
    task: tool({
      description: "Run a delegated subtask in a fresh subagent context.",
      inputSchema: z.object({ prompt: z.string() }),
      execute: async ({ prompt }: { prompt: string }) => runSubagent(prompt),
    }),
  };
}

async function runSubagent(prompt: string): Promise<string> {
  const subMessages: ModelMessage[] = [{ role: "user", content: prompt }];
  const subSystem = `You are a coding subagent at ${WORKDIR}. Complete the delegated task and return a concise summary.`;

  const result = await generateText({
    model: anthropic(MODEL),
    system: subSystem,
    messages: subMessages,
    stopWhen: stepCountIs(30),
    tools: buildTools(false),
  });

  return result.text.trim() || "(no summary)";
}

async function agentLoop(messages: ModelMessage[]): Promise<string> {
  const system = `You are a coding agent at ${WORKDIR}. Use task tool for decomposition when useful.`;

  const result = await generateText({
    model: anthropic(MODEL),
    system,
    messages,
    stopWhen: stepCountIs(50),
    tools: buildTools(true),
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
    const query = await ask("\x1b[36ms04 >> \x1b[0m");
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
