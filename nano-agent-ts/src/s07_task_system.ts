import { anthropic } from "@ai-sdk/anthropic";
import { generateText, tool, type CoreMessage } from "ai";
import { join } from "node:path";
import * as readline from "node:readline";
import { z } from "zod";
import { TaskManager } from "./managers/tasks.js";
import { runBash, runEdit, runRead, runWrite, WORKDIR } from "./tools/base.js";
import type { TaskStatus } from "./types.js";
import "dotenv/config";

const MODEL = process.env.MODEL_ID ?? "claude-sonnet-4-6";
const TASKS = new TaskManager(join(WORKDIR, ".tasks"));

const SYSTEM = `You are a coding agent at ${WORKDIR}.
Break larger goals into explicit tasks with task_create and track progress with task_update.
Always consult task_list before/after significant milestones.`;

async function agentLoop(messages: CoreMessage[]): Promise<string> {
  while (true) {
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
        task_create: tool({
          description: "Create a task item on the task board.",
          parameters: z.object({
            subject: z.string(),
            description: z.string().optional(),
          }),
          execute: async ({ subject, description }) =>
            TASKS.create(subject, description ?? ""),
        }),
        task_get: tool({
          description: "Get one task by ID.",
          parameters: z.object({ task_id: z.number().int().positive() }),
          execute: async ({ task_id }) => TASKS.get(task_id),
        }),
        task_list: tool({
          description: "List all tasks and dependency status.",
          parameters: z.object({}),
          execute: async () => TASKS.listAll(),
        }),
        task_update: tool({
          description: "Update task status and dependencies.",
          parameters: z.object({
            task_id: z.number().int().positive(),
            status: z.enum(["pending", "in_progress", "completed"]).optional(),
            addBlockedBy: z.array(z.number().int().positive()).optional(),
            addBlocks: z.array(z.number().int().positive()).optional(),
          }),
          execute: async ({ task_id, status, addBlockedBy, addBlocks }) =>
            TASKS.update(
              task_id,
              status as TaskStatus | undefined,
              addBlockedBy,
              addBlocks,
            ),
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
  const initStatus = await TASKS.init();
  console.log(`[s07] ${initStatus}`);

  const history: CoreMessage[] = [];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  while (true) {
    const query = await ask("\x1b[36ms07 >> \x1b[0m");
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
