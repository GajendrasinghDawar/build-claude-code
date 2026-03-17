import type Anthropic from "@anthropic-ai/sdk";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { SessionIndex, SessionRecord } from "../types.js";

export class SessionStore {
  private readonly baseDir: string;
  private readonly indexPath: string;
  private index: SessionIndex;
  currentSessionId: string | null = null;

  constructor(workspaceDir: string, agentId = "default") {
    this.baseDir = join(
      workspaceDir,
      ".sessions",
      "agents",
      agentId,
      "sessions",
    );
    mkdirSync(this.baseDir, { recursive: true });
    this.indexPath = join(this.baseDir, "..", "sessions.json");
    this.index = this.loadIndex();
  }

  private loadIndex(): SessionIndex {
    if (!existsSync(this.indexPath)) {
      return {};
    }

    try {
      return JSON.parse(readFileSync(this.indexPath, "utf-8")) as SessionIndex;
    } catch {
      return {};
    }
  }

  private saveIndex(): void {
    writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2), "utf-8");
  }

  private sessionPath(sessionId: string): string {
    return join(this.baseDir, `${sessionId}.jsonl`);
  }

  createSession(label = ""): string {
    const sessionId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const now = new Date().toISOString();

    this.index[sessionId] = {
      label,
      created_at: now,
      last_active: now,
      message_count: 0,
    };
    this.saveIndex();

    writeFileSync(this.sessionPath(sessionId), "", "utf-8");
    this.currentSessionId = sessionId;
    return sessionId;
  }

  loadSession(sessionId: string): Anthropic.MessageParam[] {
    const path = this.sessionPath(sessionId);
    if (!existsSync(path)) {
      return [];
    }

    this.currentSessionId = sessionId;
    return this.rebuildHistory(path);
  }

  saveTurn(role: "user" | "assistant", content: unknown): void {
    if (!this.currentSessionId) {
      return;
    }

    this.appendTranscript(this.currentSessionId, {
      type: role,
      content,
      ts: Date.now() / 1000,
    });
  }

  saveToolResult(
    toolUseId: string,
    name: string,
    input: Record<string, unknown>,
    result: string,
  ): void {
    if (!this.currentSessionId) {
      return;
    }

    const ts = Date.now() / 1000;
    this.appendTranscript(this.currentSessionId, {
      type: "tool_use",
      content: "",
      tool_use_id: toolUseId,
      name,
      input,
      ts,
    });
    this.appendTranscript(this.currentSessionId, {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: result,
      ts,
    });
  }

  private appendTranscript(sessionId: string, record: SessionRecord): void {
    appendFileSync(
      this.sessionPath(sessionId),
      `${JSON.stringify(record)}\n`,
      "utf-8",
    );

    if (!this.index[sessionId]) {
      return;
    }

    this.index[sessionId].last_active = new Date().toISOString();
    this.index[sessionId].message_count += 1;
    this.saveIndex();
  }

  private rebuildHistory(path: string): Anthropic.MessageParam[] {
    const lines = readFileSync(path, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean);
    const messages: Anthropic.MessageParam[] = [];

    for (const line of lines) {
      let record: SessionRecord;
      try {
        record = JSON.parse(line) as SessionRecord;
      } catch {
        continue;
      }

      if (record.type === "user") {
        messages.push({ role: "user", content: String(record.content ?? "") });
        continue;
      }

      if (record.type === "assistant") {
        if (typeof record.content === "string") {
          messages.push({
            role: "assistant",
            content: [{ type: "text", text: record.content }],
          });
        } else {
          messages.push({
            role: "assistant",
            content: Array.isArray(record.content)
              ? (record.content as Anthropic.MessageParam["content"])
              : [{ type: "text", text: String(record.content ?? "") }],
          });
        }
        continue;
      }

      if (record.type === "tool_use") {
        const last = messages[messages.length - 1];
        const block = {
          type: "tool_use" as const,
          id: record.tool_use_id ?? "unknown_tool_use",
          name: record.name ?? "unknown",
          input: record.input ?? {},
        };

        if (last?.role === "assistant" && Array.isArray(last.content)) {
          (last.content as unknown[]).push(block);
        } else {
          messages.push({ role: "assistant", content: [block] });
        }
        continue;
      }

      if (record.type === "tool_result") {
        const last = messages[messages.length - 1];
        const block = {
          type: "tool_result" as const,
          tool_use_id: record.tool_use_id ?? "unknown_tool_use",
          content: String(record.content ?? ""),
        };

        if (last?.role === "user" && Array.isArray(last.content)) {
          (last.content as unknown[]).push(block);
        } else {
          messages.push({ role: "user", content: [block] });
        }
      }
    }

    return messages;
  }

  listSessions(): Array<[string, SessionIndex[string]]> {
    return Object.entries(this.index).sort(
      ([, a], [, b]) =>
        new Date(b.last_active).getTime() - new Date(a.last_active).getTime(),
    );
  }

  matchByPrefix(prefix: string): string[] {
    return Object.keys(this.index).filter((id) => id.startsWith(prefix));
  }
}
