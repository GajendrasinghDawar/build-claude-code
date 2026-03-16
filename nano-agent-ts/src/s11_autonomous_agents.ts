import { anthropic } from "@ai-sdk/anthropic";
import { generateText, tool, type ModelMessage, stepCountIs } from "ai";
import { join } from "node:path";
import * as readline from "node:readline";
import { z } from "zod";
import { MessageBus, TeammateManager } from "./managers/team.js";
import { TaskManager } from "./managers/tasks.js";
import { runBash, runEdit, runRead, runWrite, WORKDIR } from "./tools/base.js";
import "dotenv/config";

const MODEL = process.env.MODEL_ID ?? "claude-sonnet-4-6";
const TEAM_DIR = join(WORKDIR, ".team");
const TASKS_DIR = join(WORKDIR, ".tasks");

const BUS = new MessageBus(TEAM_DIR);
const TEAM = new TeammateManager(TEAM_DIR, BUS, MODEL);
const TASKS = new TaskManager(TASKS_DIR);

const SYSTEM = `You are the lead autonomous coordinator at ${WORKDIR}.
Spawn autonomous teammates who can idle, watch inboxes, and auto-claim pending tasks.
Keep the task board updated and monitor teammate status.`;

async function injectLeadInbox(messages: ModelMessage[]): Promise<void> {
  const inbox = await BUS.readInbox("lead");
  if (!inbox.length) {
    return;
  }

  messages.push({
    role: "user",
    content: `<team-inbox>\n${JSON.stringify(inbox, null, 2)}\n</team-inbox>`,
  });
}

async function agentLoop(messages: ModelMessage[]): Promise<string> {
  while (true) {
    await injectLeadInbox(messages);

    const result = await generateText({
      model: anthropic(MODEL),
      system: SYSTEM,
      messages,
      stopWhen: stepCountIs(50),
      tools: {
        bash: tool({
          description: "Run a shell command.",
          inputSchema: z.object({ command: z.string() }),
          execute: async ({ command }) => runBash(command),
        }),
        read_file: tool({
          description: "Read file contents.",
          inputSchema: z.object({
            path: z.string(),
            limit: z.number().int().positive().optional(),
          }),
          execute: async ({ path, limit }) => runRead(path, limit),
        }),
        write_file: tool({
          description: "Write content to file.",
          inputSchema: z.object({ path: z.string(), content: z.string() }),
          execute: async ({ path, content }) => runWrite(path, content),
        }),
        edit_file: tool({
          description: "Replace exact text in file.",
          inputSchema: z.object({
            path: z.string(),
            old_text: z.string(),
            new_text: z.string(),
          }),
          execute: async ({ path, old_text, new_text }) =>
            runEdit(path, old_text, new_text),
        }),
        task_create: tool({
          description: "Create a task item on the board.",
          inputSchema: z.object({
            subject: z.string(),
            description: z.string().optional(),
          }),
          execute: async ({ subject, description }) =>
            TASKS.create(subject, description ?? ""),
        }),
        task_get: tool({
          description: "Get one task by ID.",
          inputSchema: z.object({ task_id: z.number().int().positive() }),
          execute: async ({ task_id }) => TASKS.get(task_id),
        }),
        task_list: tool({
          description: "List all tasks and dependencies.",
          inputSchema: z.object({}),
          execute: async () => TASKS.listAll(),
        }),
        task_update: tool({
          description: "Update task status and dependencies.",
          inputSchema: z.object({
            task_id: z.number().int().positive(),
            status: z.enum(["pending", "in_progress", "completed"]).optional(),
            addBlockedBy: z.array(z.number().int().positive()).optional(),
            addBlocks: z.array(z.number().int().positive()).optional(),
          }),
          execute: async ({ task_id, status, addBlockedBy, addBlocks }) =>
            TASKS.update(task_id, status, addBlockedBy, addBlocks),
        }),
        claim_task: tool({
          description: "Manually claim one task for an owner.",
          inputSchema: z.object({
            task_id: z.number().int().positive(),
            owner: z.string(),
          }),
          execute: async ({ task_id, owner }) =>
            TASKS.claimTask(task_id, owner),
        }),
        spawn_teammate: tool({
          description: "Spawn a standard teammate.",
          inputSchema: z.object({
            name: z.string(),
            role: z.string(),
            prompt: z.string(),
          }),
          execute: async ({ name, role, prompt }) =>
            TEAM.spawn(name, role, prompt),
        }),
        spawn_autonomous: tool({
          description:
            "Spawn an autonomous teammate with idle auto-claim behavior.",
          inputSchema: z.object({
            name: z.string(),
            role: z.string(),
            prompt: z.string(),
          }),
          execute: async ({ name, role, prompt }) =>
            TEAM.spawnAutonomous(name, role, prompt, TASKS),
        }),
        list_teammates: tool({
          description: "List teammate names, roles, statuses.",
          inputSchema: z.object({}),
          execute: async () => TEAM.listAll(),
        }),
        send_message: tool({
          description: "Send direct message as lead.",
          inputSchema: z.object({
            to: z.string(),
            content: z.string(),
            msg_type: z
              .enum([
                "message",
                "broadcast",
                "shutdown_request",
                "shutdown_response",
                "plan_approval_response",
              ])
              .optional(),
          }),
          execute: async ({ to, content, msg_type }) =>
            BUS.send("lead", to, content, msg_type ?? "message"),
        }),
        read_inbox: tool({
          description: "Read lead inbox.",
          inputSchema: z.object({}),
          execute: async () =>
            JSON.stringify(await BUS.readInbox("lead"), null, 2),
        }),
        broadcast: tool({
          description: "Broadcast to all teammates.",
          inputSchema: z.object({ content: z.string() }),
          execute: async ({ content }) =>
            BUS.broadcast("lead", content, TEAM.memberNames()),
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
  const teamStatus = await TEAM.init();
  console.log(`[s11] ${taskStatus} ${teamStatus}`);

  const history: ModelMessage[] = [];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  while (true) {
    const query = await ask("\x1b[36ms11 >> \x1b[0m");
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
