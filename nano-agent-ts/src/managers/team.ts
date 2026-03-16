import { anthropic } from "@ai-sdk/anthropic";
import { generateText, tool, type ModelMessage, stepCountIs } from "ai";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { getTursoClient } from "../lib/turso.js";
import { runBash, runEdit, runRead, runWrite, WORKDIR } from "../tools/base.js";
import type {
  InboxMessage,
  MessageType,
  Task,
  TeamConfig,
  TeamMember,
} from "../types.js";

interface MessageExtra {
  request_id?: string;
  approve?: boolean;
  feedback?: string;
  plan?: string;
}

export interface AutonomousTaskBoard {
  listUnclaimedPending(): Promise<Task[]>;
  claimTask(id: number, owner: string): Promise<string>;
}

export class MessageBus {
  private readonly inboxDir: string;
  private useTurso = false;

  constructor(private readonly teamDir: string) {
    this.inboxDir = join(teamDir, "inbox");
    mkdirSync(this.inboxDir, { recursive: true });
  }

  async init(): Promise<string> {
    const client = getTursoClient();
    if (!client) {
      this.useTurso = false;
      return "MessageBus using JSONL inboxes.";
    }

    await client.execute(`
      CREATE TABLE IF NOT EXISTS inbox_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recipient TEXT NOT NULL,
        sender TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp REAL NOT NULL,
        request_id TEXT,
        approve INTEGER,
        feedback TEXT,
        plan TEXT
      )
    `);

    this.useTurso = true;
    return "MessageBus using Turso inbox table.";
  }

  async send(
    sender: string,
    to: string,
    content: string,
    msgType: MessageType = "message",
    extra: MessageExtra = {},
  ): Promise<string> {
    const payload: InboxMessage = {
      type: msgType,
      from: sender,
      content,
      timestamp: Date.now() / 1000,
      ...extra,
    };

    if (this.useTurso) {
      const client = getTursoClient();
      if (!client) {
        return "Error: Turso unavailable";
      }

      await client.execute({
        sql: `
          INSERT INTO inbox_messages (recipient, sender, type, content, timestamp, request_id, approve, feedback, plan)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          to,
          payload.from,
          payload.type,
          payload.content,
          payload.timestamp,
          payload.request_id ?? null,
          payload.approve == null ? null : payload.approve ? 1 : 0,
          payload.feedback ?? null,
          payload.plan ?? null,
        ],
      });

      return `Sent ${msgType} to ${to}`;
    }

    appendFileSync(
      join(this.inboxDir, `${to}.jsonl`),
      `${JSON.stringify(payload)}\n`,
      "utf-8",
    );
    return `Sent ${msgType} to ${to}`;
  }

  async readInbox(recipient: string): Promise<InboxMessage[]> {
    if (this.useTurso) {
      const client = getTursoClient();
      if (!client) {
        return [];
      }

      const rows = await client.execute({
        sql: "SELECT * FROM inbox_messages WHERE recipient = ? ORDER BY id ASC LIMIT 500",
        args: [recipient],
      });

      if (!rows.rows.length) {
        return [];
      }

      const ids: number[] = [];
      const messages: InboxMessage[] = [];

      for (const row of rows.rows as Record<string, unknown>[]) {
        ids.push(Number(row.id));
        messages.push({
          type: String(row.type) as MessageType,
          from: String(row.sender),
          content: String(row.content),
          timestamp: Number(row.timestamp),
          request_id:
            row.request_id == null ? undefined : String(row.request_id),
          approve: row.approve == null ? undefined : Number(row.approve) === 1,
          feedback: row.feedback == null ? undefined : String(row.feedback),
          plan: row.plan == null ? undefined : String(row.plan),
        });
      }

      const placeholders = ids.map(() => "?").join(", ");
      await client.execute({
        sql: `DELETE FROM inbox_messages WHERE id IN (${placeholders})`,
        args: ids,
      });

      return messages;
    }

    const inboxPath = join(this.inboxDir, `${recipient}.jsonl`);
    if (!existsSync(inboxPath)) {
      return [];
    }

    const raw = readFileSync(inboxPath, "utf-8").trim();
    if (!raw) {
      return [];
    }

    const messages = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as InboxMessage);

    writeFileSync(inboxPath, "", "utf-8");
    return messages;
  }

  async broadcast(
    sender: string,
    content: string,
    teammates: string[],
  ): Promise<string> {
    let count = 0;
    for (const teammate of teammates) {
      if (teammate === sender) {
        continue;
      }
      await this.send(sender, teammate, content, "broadcast");
      count += 1;
    }
    return `Broadcast to ${count} teammates`;
  }
}

export class TeammateManager {
  private readonly configPath: string;
  private config: TeamConfig;
  private useTurso = false;

  constructor(
    private readonly teamDir: string,
    private readonly bus: MessageBus,
    private readonly modelId: string,
  ) {
    mkdirSync(teamDir, { recursive: true });
    this.configPath = join(teamDir, "config.json");
    this.config = this.loadConfig();
  }

  private loadConfig(): TeamConfig {
    if (existsSync(this.configPath)) {
      return JSON.parse(readFileSync(this.configPath, "utf-8")) as TeamConfig;
    }

    return {
      team_name: "default",
      members: [],
    };
  }

  private saveConfig(): void {
    writeFileSync(
      this.configPath,
      JSON.stringify(this.config, null, 2),
      "utf-8",
    );
  }

  private async ensureTursoTeamTables(): Promise<void> {
    const client = getTursoClient();
    if (!client) {
      this.useTurso = false;
      return;
    }

    await client.execute(`
      CREATE TABLE IF NOT EXISTS team_members (
        name TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at REAL NOT NULL
      )
    `);
    this.useTurso = true;
  }

  private async syncMembersToTurso(): Promise<void> {
    if (!this.useTurso) {
      return;
    }

    const client = getTursoClient();
    if (!client) {
      return;
    }

    for (const member of this.config.members) {
      await client.execute({
        sql: `
          INSERT INTO team_members (name, role, status, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET
            role = excluded.role,
            status = excluded.status,
            updated_at = excluded.updated_at
        `,
        args: [member.name, member.role, member.status, Date.now() / 1000],
      });
    }
  }

  private async setStatus(
    name: string,
    status: TeamMember["status"],
  ): Promise<void> {
    const member = this.config.members.find((item) => item.name === name);
    if (!member) {
      return;
    }

    member.status = status;
    this.saveConfig();
    await this.syncMembersToTurso();
  }

  async init(): Promise<string> {
    const busStatus = await this.bus.init();
    await this.ensureTursoTeamTables();
    await this.syncMembersToTurso();

    return this.useTurso
      ? `${busStatus} Team metadata also synced to Turso.`
      : busStatus;
  }

  async spawn(name: string, role: string, prompt: string): Promise<string> {
    let member = this.config.members.find((item) => item.name === name);
    if (member) {
      if (member.status === "working") {
        return `Error: '${name}' is currently working`;
      }
      member.role = role;
      member.status = "working";
    } else {
      member = { name, role, status: "working" };
      this.config.members.push(member);
    }

    this.saveConfig();
    await this.syncMembersToTurso();

    this.teammateLoop(name, role, prompt).catch((error) => {
      console.error(`[teammate:${name}]`, error);
    });

    return `Spawned '${name}' (role: ${role})`;
  }

  async spawnAutonomous(
    name: string,
    role: string,
    prompt: string,
    taskBoard: AutonomousTaskBoard,
  ): Promise<string> {
    let member = this.config.members.find((item) => item.name === name);
    if (member) {
      if (member.status === "working") {
        return `Error: '${name}' is currently working`;
      }
      member.role = role;
      member.status = "working";
    } else {
      member = { name, role, status: "working" };
      this.config.members.push(member);
    }

    this.saveConfig();
    await this.syncMembersToTurso();

    this.teammateLoop(name, role, prompt, taskBoard).catch((error) => {
      console.error(`[autonomous:${name}]`, error);
    });

    return `Spawned autonomous '${name}' (role: ${role})`;
  }

  async listAll(): Promise<string> {
    if (!this.config.members.length) {
      return "No teammates.";
    }

    const lines = [`Team: ${this.config.team_name}`];
    for (const member of this.config.members) {
      lines.push(`- ${member.name} (${member.role}): ${member.status}`);
    }

    return lines.join("\n");
  }

  memberNames(): string[] {
    return this.config.members.map((member) => member.name);
  }

  private teammateTools(name: string) {
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
      send_message: tool({
        description: "Send a direct message to a teammate.",
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
          this.bus.send(name, to, content, msg_type ?? "message"),
      }),
      read_inbox: tool({
        description: "Read all messages in your inbox.",
        inputSchema: z.object({}),
        execute: async () =>
          JSON.stringify(await this.bus.readInbox(name), null, 2),
      }),
      broadcast: tool({
        description: "Broadcast message to teammates.",
        inputSchema: z.object({ content: z.string() }),
        execute: async ({ content }) =>
          this.bus.broadcast(name, content, this.memberNames()),
      }),
    };
  }

  private async teammateLoop(
    name: string,
    role: string,
    prompt: string,
    taskBoard?: AutonomousTaskBoard,
  ): Promise<void> {
    const system = `You are '${name}', role: ${role}, working in ${WORKDIR}.
Use send_message/read_inbox/broadcast to collaborate with teammates.`;

    const messages: ModelMessage[] = [{ role: "user", content: prompt }];
    let shutdownRequested = false;

    for (let turn = 0; turn < 30; turn += 1) {
      const inbox = await this.bus.readInbox(name);
      for (const message of inbox) {
        if (message.type === "shutdown_request") {
          await this.bus.send(
            name,
            message.from,
            "Shutdown acknowledged. Stopping work now.",
            "shutdown_response",
            { request_id: message.request_id },
          );
          shutdownRequested = true;
          continue;
        }
        messages.push({ role: "user", content: JSON.stringify(message) });
      }

      if (shutdownRequested) {
        await this.setStatus(name, "shutdown");
        return;
      }

      const result = await generateText({
        model: anthropic(this.modelId),
        system,
        messages,
        stopWhen: stepCountIs(20),
        tools: this.teammateTools(name),
      });

      messages.push(...result.response.messages);

      if (result.finishReason !== "tool-calls") {
        if (!taskBoard) {
          break;
        }

        const shouldResume = await this.autonomousIdlePhase(
          name,
          role,
          messages,
          taskBoard,
        );
        if (!shouldResume) {
          return;
        }
      }
    }

    await this.setStatus(name, "idle");
  }

  private async autonomousIdlePhase(
    name: string,
    role: string,
    messages: ModelMessage[],
    taskBoard: AutonomousTaskBoard,
  ): Promise<boolean> {
    const pollIntervalMs = 5_000;
    const maxPolls = 12;

    await this.setStatus(name, "idle");

    for (let poll = 0; poll < maxPolls; poll += 1) {
      await this.sleep(pollIntervalMs);

      const inbox = await this.bus.readInbox(name);
      for (const message of inbox) {
        if (message.type === "shutdown_request") {
          await this.bus.send(
            name,
            message.from,
            "Shutdown acknowledged. Stopping work now.",
            "shutdown_response",
            { request_id: message.request_id },
          );
          await this.setStatus(name, "shutdown");
          return false;
        }

        messages.push({ role: "user", content: JSON.stringify(message) });
      }

      if (inbox.length) {
        await this.setStatus(name, "working");
        return true;
      }

      const unclaimed = await taskBoard.listUnclaimedPending();
      if (unclaimed.length) {
        const chosen = unclaimed[0];
        await taskBoard.claimTask(chosen.id, name);

        if (messages.length <= 3) {
          messages.unshift(
            {
              role: "assistant",
              content: `I am ${name}, role: ${role}. Continuing autonomous execution.`,
            },
            {
              role: "user",
              content: `<identity>You are '${name}', role: ${role}. Continue your work.</identity>`,
            },
          );
        }

        messages.push(
          {
            role: "assistant",
            content: `Claimed task #${chosen.id}. Working on it now.`,
          },
          {
            role: "user",
            content: `<auto-claimed>Task #${chosen.id}: ${chosen.subject}\n${chosen.description || ""}</auto-claimed>`,
          },
        );
        await this.setStatus(name, "working");
        return true;
      }
    }

    await this.setStatus(name, "shutdown");
    return false;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
