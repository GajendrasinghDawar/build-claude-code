import { anthropic } from "@ai-sdk/anthropic";
import { generateText, tool, type CoreMessage } from "ai";
import { join } from "node:path";
import * as readline from "node:readline";
import { z } from "zod";
import { TaskManager } from "./managers/tasks.js";
import { EventBus, WorktreeManager } from "./managers/worktree.js";
import { runBash, runEdit, runRead, runWrite, WORKDIR } from "./tools/base.js";
import type { TaskStatus } from "./types.js";
import "dotenv/config";

const MODEL = process.env.MODEL_ID ?? "claude-sonnet-4-6";
const TASKS = new TaskManager(join(WORKDIR, ".tasks"));
const EVENTS = new EventBus(join(WORKDIR, ".events", "worktree-events.jsonl"));
const WORKTREES = new WorktreeManager(WORKDIR, TASKS, EVENTS);

const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use isolated git worktrees per task when parallel implementation may conflict.
Maintain task and worktree bindings and inspect event logs when diagnosing lifecycle issues.`;

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
          description: "Create a task item.",
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
          description: "List tasks.",
          parameters: z.object({}),
          execute: async () => TASKS.listAll(),
        }),
        task_update: tool({
          description: "Update task status/dependencies.",
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
        worktree_create: tool({
          description: "Create a git worktree, optionally bound to a task.",
          parameters: z.object({
            name: z.string(),
            task_id: z.number().int().positive().optional(),
            base_ref: z.string().optional(),
          }),
          execute: async ({ name, task_id, base_ref }) =>
            WORKTREES.create(name, task_id, base_ref ?? "HEAD"),
        }),
        worktree_run: tool({
          description: "Run command within a named worktree.",
          parameters: z.object({ name: z.string(), command: z.string() }),
          execute: async ({ name, command }) => WORKTREES.run(name, command),
        }),
        worktree_list: tool({
          description: "List all tracked worktrees.",
          parameters: z.object({}),
          execute: async () => WORKTREES.listAll(),
        }),
        worktree_status: tool({
          description: "Inspect one worktree or all statuses.",
          parameters: z.object({ name: z.string().optional() }),
          execute: async ({ name }) => WORKTREES.status(name),
        }),
        worktree_remove: tool({
          description: "Remove an active worktree.",
          parameters: z.object({ name: z.string() }),
          execute: async ({ name }) => WORKTREES.remove(name),
        }),
        worktree_keep: tool({
          description: "Mark a worktree as kept for future reuse.",
          parameters: z.object({ name: z.string() }),
          execute: async ({ name }) => WORKTREES.keep(name),
        }),
        event_log_recent: tool({
          description: "View recent worktree lifecycle events.",
          parameters: z.object({
            limit: z.number().int().positive().optional(),
          }),
          execute: async ({ limit }) => EVENTS.listRecent(limit ?? 20),
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
  const taskStatus = await TASKS.init();
  console.log(`[s12] ${taskStatus}`);

  const history: CoreMessage[] = [];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  while (true) {
    const query = await ask("\x1b[36ms12 >> \x1b[0m");
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
