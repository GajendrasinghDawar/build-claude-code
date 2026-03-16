import { anthropic } from "@ai-sdk/anthropic";
import { generateText, tool, type CoreMessage } from "ai";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import * as readline from "node:readline";
import { z } from "zod";
import { MessageBus, TeammateManager } from "./managers/team.js";
import { runBash, runEdit, runRead, runWrite, WORKDIR } from "./tools/base.js";
import type { PlanRequest, ShutdownRequest } from "./types.js";
import "dotenv/config";

const MODEL = process.env.MODEL_ID ?? "claude-sonnet-4-6";
const TEAM_DIR = join(WORKDIR, ".team");
const BUS = new MessageBus(TEAM_DIR);
const TEAM = new TeammateManager(TEAM_DIR, BUS, MODEL);

const shutdownRequests = new Map<string, ShutdownRequest>();
const planRequests = new Map<string, PlanRequest>();

const SYSTEM = `You are the lead coding agent at ${WORKDIR}.
Enforce team communication protocols:
- Use shutdown_request to stop teammates gracefully.
- Use plan_approval to approve/reject proposed plans.
- Track request IDs and statuses carefully.`;

async function processProtocolMessages(messages: CoreMessage[]): Promise<void> {
  const inbox = await BUS.readInbox("lead");
  if (!inbox.length) {
    return;
  }

  for (const msg of inbox) {
    if (msg.type === "shutdown_response" && msg.request_id) {
      const req = shutdownRequests.get(msg.request_id);
      if (req) {
        req.status = "approved";
      }
    }

    if (msg.request_id && msg.plan && msg.type === "message") {
      planRequests.set(msg.request_id, {
        from: msg.from,
        plan: msg.plan,
        status: "pending",
      });
    }
  }

  messages.push({
    role: "user",
    content: `<team-protocol-inbox>\n${JSON.stringify(inbox, null, 2)}\n</team-protocol-inbox>`,
  });
}

function renderProtocolState(): string {
  const shutdownState = [...shutdownRequests.entries()].map(([id, req]) => ({
    request_id: id,
    target: req.target,
    status: req.status,
  }));

  const planState = [...planRequests.entries()].map(([id, req]) => ({
    request_id: id,
    from: req.from,
    status: req.status,
  }));

  return JSON.stringify(
    {
      shutdown_requests: shutdownState,
      plan_requests: planState,
    },
    null,
    2,
  );
}

async function requestShutdown(target: string, reason?: string): Promise<string> {
  const requestId = randomUUID().slice(0, 8);
  shutdownRequests.set(requestId, { target, status: "pending" });

  const content = reason
    ? `Please shut down gracefully. Reason: ${reason}`
    : "Please shut down gracefully.";

  await BUS.send("lead", target, content, "shutdown_request", {
    request_id: requestId,
  });

  return `Shutdown request ${requestId} sent to '${target}' (status: pending)`;
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

async function agentLoop(messages: CoreMessage[]): Promise<string> {
  while (true) {
    await processProtocolMessages(messages);

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
        spawn_teammate: tool({
          description: "Spawn or resume a named teammate worker.",
          parameters: z.object({
            name: z.string(),
            role: z.string(),
            prompt: z.string(),
          }),
          execute: async ({ name, role, prompt }) =>
            TEAM.spawn(name, role, prompt),
        }),
        list_teammates: tool({
          description: "List teammate names, roles, and statuses.",
          parameters: z.object({}),
          execute: async () => TEAM.listAll(),
        }),
        send_message: tool({
          description: "Send a direct message as lead.",
          parameters: z.object({
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
          parameters: z.object({}),
          execute: async () => JSON.stringify(await BUS.readInbox("lead"), null, 2),
        }),
        broadcast: tool({
          description: "Broadcast to all teammates.",
          parameters: z.object({ content: z.string() }),
          execute: async ({ content }) =>
            BUS.broadcast("lead", content, TEAM.memberNames()),
        }),
        shutdown_request: tool({
          description: "Initiate graceful shutdown protocol for one teammate.",
          parameters: z.object({
            target: z.string(),
            reason: z.string().optional(),
          }),
          execute: async ({ target, reason }) => requestShutdown(target, reason),
        }),
        plan_approval: tool({
          description: "Approve or reject a pending plan request.",
          parameters: z.object({
            request_id: z.string(),
            approve: z.boolean(),
            feedback: z.string().optional(),
          }),
          execute: async ({ request_id, approve, feedback }) =>
            reviewPlan(request_id, approve, feedback),
        }),
        protocol_status: tool({
          description: "View current protocol request states.",
          parameters: z.object({}),
          execute: async () => renderProtocolState(),
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
  const initStatus = await TEAM.init();
  console.log(`[s10] ${initStatus}`);

  const history: CoreMessage[] = [];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  while (true) {
    const query = await ask("\x1b[36ms10 >> \x1b[0m");
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
