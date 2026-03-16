import { anthropic } from "@ai-sdk/anthropic";
import { gateway } from "@ai-sdk/gateway";
import { google } from "@ai-sdk/google";
import { generateText, stepCountIs, tool, type ModelMessage } from "ai";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import * as readline from "node:readline";
import { z } from "zod";
import { BackgroundManager } from "./managers/background.js";
import {
  autoCompact,
  estimateTokens,
  microCompact,
} from "./managers/compression.js";
import { SkillLoader } from "./managers/skills.js";
import { TaskManager } from "./managers/tasks.js";
import { MessageBus, TeammateManager } from "./managers/team.js";
import { TodoManager } from "./managers/todo.js";
import { EventBus, WorktreeManager } from "./managers/worktree.js";
import { runBash, runEdit, runRead, runWrite, WORKDIR } from "./tools/base.js";
import type { PlanRequest, ShutdownRequest, TaskStatus } from "./types.js";
import "dotenv/config";

const PROVIDER =
  process.env.MODEL_PROVIDER?.toLowerCase() ??
  (process.env.AI_GATEWAY_API_KEY
    ? "gateway"
    : process.env.GOOGLE_GENERATIVE_AI_API_KEY
      ? "google"
      : process.env.ANTHROPIC_API_KEY
        ? "anthropic"
        : "gateway");
const MODEL =
  process.env.MODEL_ID ??
  (PROVIDER === "gateway"
    ? "google/gemini-2.0-flash"
    : PROVIDER === "google"
      ? "gemini-2.0-flash"
      : "claude-sonnet-4-6");
const TOKEN_THRESHOLD = 50_000;

const TEAM_DIR = join(WORKDIR, ".team");
const TASKS_DIR = join(WORKDIR, ".tasks");
const SKILLS_DIR = join(WORKDIR, "skills");
const EVENTS_PATH = join(WORKDIR, ".events", "worktree-events.jsonl");

const TODOS = new TodoManager();
const TASKS = new TaskManager(TASKS_DIR);
const SKILLS = new SkillLoader(SKILLS_DIR);
const BG = new BackgroundManager();
const BUS = new MessageBus(TEAM_DIR);
const TEAM = new TeammateManager(TEAM_DIR, BUS, MODEL);
const WT_EVENTS = new EventBus(EVENTS_PATH);
const WORKTREES = new WorktreeManager(WORKDIR, TASKS, WT_EVENTS);

const shutdownRequests = new Map<string, ShutdownRequest>();
const planRequests = new Map<string, PlanRequest>();

const SYSTEM = `You are the full-capability coding agent at ${WORKDIR}.
Capabilities include:
- Local coding tools (bash/read/write/edit)
- Todo tracking, task board management, and autonomous teammates
- Team protocols (shutdown and plan approval)
- Background task execution with notification draining
- Skills loading and context compaction
- Worktree-based task isolation

Policies:
- Prefer creating/updating tasks for substantial work.
- Delegate independent work to teammates or subagents when it helps.
- Use isolated worktrees for risky or parallel edits.
- Keep context concise using compact when needed.

Available skills:
${SKILLS.getDescriptions()}`;

function modelForProvider() {
  if (PROVIDER === "gateway") {
    return gateway(MODEL);
  }

  return PROVIDER === "google" ? google(MODEL) : anthropic(MODEL);
}

function protocolSnapshot(): string {
  const shutdown = [...shutdownRequests.entries()].map(([id, req]) => ({
    request_id: id,
    target: req.target,
    status: req.status,
  }));
  const plans = [...planRequests.entries()].map(([id, req]) => ({
    request_id: id,
    from: req.from,
    status: req.status,
  }));

  return JSON.stringify(
    { shutdown_requests: shutdown, plan_requests: plans },
    null,
    2,
  );
}

async function requestShutdown(
  target: string,
  reason?: string,
): Promise<string> {
  const requestId = randomUUID().slice(0, 8);
  shutdownRequests.set(requestId, { target, status: "pending" });

  const content = reason
    ? `Please shut down gracefully. Reason: ${reason}`
    : "Please shut down gracefully.";

  await BUS.send("lead", target, content, "shutdown_request", {
    request_id: requestId,
  });

  return `Shutdown request ${requestId} sent to '${target}'`;
}

async function reviewPlan(
  requestId: string,
  approve: boolean,
  feedback?: string,
): Promise<string> {
  const req = planRequests.get(requestId);
  if (!req) {
    return `Error: Unknown plan request_id '${requestId}'`;
  }

  req.status = approve ? "approved" : "rejected";
  await BUS.send("lead", req.from, feedback ?? "", "plan_approval_response", {
    request_id: requestId,
    approve,
    feedback,
  });

  return `Plan ${req.status} for '${req.from}'`;
}

function injectBackgroundNotifications(messages: ModelMessage[]): void {
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

async function injectLeadInbox(messages: ModelMessage[]): Promise<void> {
  const inbox = await BUS.readInbox("lead");
  if (!inbox.length) {
    return;
  }

  for (const msg of inbox) {
    if (msg.type === "shutdown_response" && msg.request_id) {
      const req = shutdownRequests.get(msg.request_id);
      if (req) {
        req.status = msg.approve === false ? "rejected" : "approved";
      }
    }

    if (msg.type === "message" && msg.request_id && msg.plan) {
      planRequests.set(msg.request_id, {
        from: msg.from,
        plan: msg.plan,
        status: "pending",
      });
    }
  }

  messages.push({
    role: "user",
    content: `<team-inbox>\n${JSON.stringify(inbox, null, 2)}\n</team-inbox>`,
  });
}

function baseTools() {
  return {
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
  };
}

async function runSubagent(prompt: string): Promise<string> {
  const result = await generateText({
    model: modelForProvider(),
    system: `You are a coding subagent at ${WORKDIR}. Complete the delegated task and return a concise summary.`,
    messages: [{ role: "user", content: prompt }],
    stopWhen: stepCountIs(30),
    tools: baseTools(),
  });

  return result.text.trim() || "(no summary)";
}

async function agentLoop(messages: ModelMessage[]): Promise<string> {
  while (true) {
    microCompact(messages, 3);
    if (estimateTokens(messages) > TOKEN_THRESHOLD) {
      console.log("[auto_compact triggered]");
      const compressed = await autoCompact(messages, MODEL);
      messages.length = 0;
      messages.push(...compressed);
    }

    injectBackgroundNotifications(messages);
    await injectLeadInbox(messages);

    let manualCompact = false;

    const result = await generateText({
      model: modelForProvider(),
      system: SYSTEM,
      messages,
      stopWhen: stepCountIs(60),
      tools: {
        ...baseTools(),
        todo_write: tool({
          description: "Replace entire todo list.",
          inputSchema: z.object({
            items: z.array(
              z.object({
                id: z.string().optional(),
                text: z.string(),
                status: z.enum(["pending", "in_progress", "completed"]),
              }),
            ),
          }),
          execute: async ({ items }) => TODOS.update(items),
        }),
        task: tool({
          description: "Delegate a focused subtask to a subagent.",
          inputSchema: z.object({ prompt: z.string() }),
          execute: async ({ prompt }) => runSubagent(prompt),
        }),
        load_skill: tool({
          description: "Load full content of a specific skill.",
          inputSchema: z.object({ name: z.string() }),
          execute: async ({ name }) => SKILLS.getContent(name),
        }),
        compact: tool({
          description: "Force context compaction now.",
          inputSchema: z.object({ reason: z.string().optional() }),
          execute: async () => {
            manualCompact = true;
            return "Compaction requested.";
          },
        }),
        background_run: tool({
          description: "Run command asynchronously in background.",
          inputSchema: z.object({ command: z.string() }),
          execute: async ({ command }) => BG.run(command),
        }),
        check_background: tool({
          description: "Check one background task or all tasks.",
          inputSchema: z.object({ task_id: z.string().optional() }),
          execute: async ({ task_id }) => BG.check(task_id),
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
          description: "List all tasks.",
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
            TASKS.update(
              task_id,
              status as TaskStatus | undefined,
              addBlockedBy,
              addBlocks,
            ),
        }),
        claim_task: tool({
          description: "Claim a task for an owner.",
          inputSchema: z.object({
            task_id: z.number().int().positive(),
            owner: z.string(),
          }),
          execute: async ({ task_id, owner }) =>
            TASKS.claimTask(task_id, owner),
        }),
        spawn_teammate: tool({
          description: "Spawn or resume a teammate worker.",
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
            "Spawn autonomous teammate with idle auto-claim behavior.",
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
            request_id: z.string().optional(),
            approve: z.boolean().optional(),
            feedback: z.string().optional(),
            plan: z.string().optional(),
          }),
          execute: async ({
            to,
            content,
            msg_type,
            request_id,
            approve,
            feedback,
            plan,
          }) =>
            BUS.send("lead", to, content, msg_type ?? "message", {
              request_id,
              approve,
              feedback,
              plan,
            }),
        }),
        read_inbox: tool({
          description: "Read lead inbox messages.",
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
        shutdown_request: tool({
          description: "Initiate graceful shutdown protocol for one teammate.",
          inputSchema: z.object({
            target: z.string(),
            reason: z.string().optional(),
          }),
          execute: async ({ target, reason }) =>
            requestShutdown(target, reason),
        }),
        plan_approval: tool({
          description: "Approve or reject a pending plan request.",
          inputSchema: z.object({
            request_id: z.string(),
            approve: z.boolean(),
            feedback: z.string().optional(),
          }),
          execute: async ({ request_id, approve, feedback }) =>
            reviewPlan(request_id, approve, feedback),
        }),
        protocol_status: tool({
          description: "View protocol request states.",
          inputSchema: z.object({}),
          execute: async () => protocolSnapshot(),
        }),
        worktree_create: tool({
          description: "Create a git worktree bound to an optional task.",
          inputSchema: z.object({
            name: z.string(),
            task_id: z.number().int().positive().optional(),
            base_ref: z.string().optional(),
          }),
          execute: async ({ name, task_id, base_ref }) =>
            WORKTREES.create(name, task_id, base_ref ?? "HEAD"),
        }),
        worktree_run: tool({
          description: "Run command inside a named worktree.",
          inputSchema: z.object({ name: z.string(), command: z.string() }),
          execute: async ({ name, command }) => WORKTREES.run(name, command),
        }),
        worktree_list: tool({
          description: "List tracked worktrees.",
          inputSchema: z.object({}),
          execute: async () => WORKTREES.listAll(),
        }),
        worktree_status: tool({
          description: "Inspect one worktree or all statuses.",
          inputSchema: z.object({ name: z.string().optional() }),
          execute: async ({ name }) => WORKTREES.status(name),
        }),
        worktree_remove: tool({
          description: "Remove an active worktree.",
          inputSchema: z.object({ name: z.string() }),
          execute: async ({ name }) => WORKTREES.remove(name),
        }),
        worktree_keep: tool({
          description: "Mark a worktree as kept.",
          inputSchema: z.object({ name: z.string() }),
          execute: async ({ name }) => WORKTREES.keep(name),
        }),
        event_log_recent: tool({
          description: "View recent worktree lifecycle events.",
          inputSchema: z.object({
            limit: z.number().int().positive().optional(),
          }),
          execute: async ({ limit }) => WT_EVENTS.listRecent(limit ?? 20),
        }),
      },
    });

    messages.push(...result.response.messages);

    if (manualCompact) {
      console.log("[manual compact]");
      const compressed = await autoCompact(messages, MODEL);
      messages.length = 0;
      messages.push(...compressed);
      continue;
    }

    if (result.finishReason !== "tool-calls") {
      return result.text.trim();
    }
  }
}

async function main(): Promise<void> {
  const taskStatus = await TASKS.init();
  const teamStatus = await TEAM.init();
  console.log(
    `[s_full] provider=${PROVIDER} model=${MODEL} ${taskStatus} ${teamStatus}`,
  );

  const history: ModelMessage[] = [];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => {
      const state = rl as readline.Interface & { closed?: boolean };
      if (state.closed) {
        resolve("exit");
        return;
      }

      try {
        rl.question(prompt, resolve);
      } catch {
        resolve("exit");
      }
    });

  while (true) {
    const query = await ask("\x1b[36ms_full >> \x1b[0m");
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
