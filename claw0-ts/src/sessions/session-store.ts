import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import type { SessionIndex, SessionRecord } from "../types.js";

function randomId(length = 12): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, length);
}

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
    if (!existsSync(this.indexPath)) return {};
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
    const sessionId = randomId();
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

  listSessions(): Array<[string, SessionIndex[string]]> {
    return Object.entries(this.index).sort(
      ([, a], [, b]) =>
        new Date(b.last_active).getTime() - new Date(a.last_active).getTime(),
    );
  }

  matchByPrefix(prefix: string): string[] {
    return Object.keys(this.index).filter((id) => id.startsWith(prefix));
  }

  saveTurn(role: "user" | "assistant", content: unknown): void {
    if (!this.currentSessionId) return;

    this.appendRecord(this.currentSessionId, {
      type: role,
      content,
      ts: Date.now() / 1000,
    });
  }

  saveToolResult(
    toolUseId: string,
    name: string,
    input: Record<string, unknown>,
    result: unknown,
  ): void {
    if (!this.currentSessionId) return;

    const ts = Date.now() / 1000;
    this.appendRecord(this.currentSessionId, {
      type: "tool_use",
      tool_use_id: toolUseId,
      name,
      input,
      content: "",
      ts,
    });
    this.appendRecord(this.currentSessionId, {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: result,
      ts,
    });
  }

  private appendRecord(sessionId: string, record: SessionRecord): void {
    appendFileSync(
      this.sessionPath(sessionId),
      `${JSON.stringify(record)}\n`,
      "utf-8",
    );

    if (!this.index[sessionId]) return;
    this.index[sessionId].last_active = new Date().toISOString();
    this.index[sessionId].message_count += 1;
    this.saveIndex();
  }

  loadSession(sessionId: string): ModelMessage[] {
    const path = this.sessionPath(sessionId);
    if (!existsSync(path)) return [];

    this.currentSessionId = sessionId;
    return this.rebuildHistory(path);
  }

  private rebuildHistory(path: string): ModelMessage[] {
    const text = readFileSync(path, "utf-8");
    if (!text.trim()) return [];

    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    const messages: ModelMessage[] = [];

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
        const raw = record.content;
        if (typeof raw === "string") {
          messages.push({ role: "assistant", content: raw });
        } else {
          messages.push({ role: "assistant", content: raw as any });
        }
        continue;
      }

      if (record.type === "tool_result") {
        const toolMessage = {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: record.tool_use_id ?? "unknown",
              toolName: record.name ?? "unknown",
              result: record.content,
            },
          ],
        } as any;
        messages.push(toolMessage);
      }
    }

    return messages;
  }
}
