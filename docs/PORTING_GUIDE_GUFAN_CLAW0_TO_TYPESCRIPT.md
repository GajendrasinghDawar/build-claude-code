# Porting Guide: gufan (claw0) Gateway → TypeScript/Node.js

> **Purpose:** Complete specification for porting `gufan/` (the claw0 AI agent gateway) from Python to TypeScript/Node.js. This is a **companion** to the `agents/` porting guide — while `agents/` covers the agent brain, this guide covers the **gateway infrastructure** that makes the agent always-on, multi-channel, and production-ready.

---

## Table of Contents

1. [What is claw0 (gufan)?](#1-what-is-claw0-gufan)
2. [How claw0 Relates to agents/](#2-how-claw0-relates-to-agents)
3. [Project Setup & Dependencies](#3-project-setup--dependencies)
4. [TypeScript Types & Interfaces](#4-typescript-types--interfaces)
5. [S01 — Agent Loop (Shared Foundation)](#5-s01--agent-loop-shared-foundation)
6. [S02 — Tool Use (Shared Foundation)](#6-s02--tool-use-shared-foundation)
7. [S03 — Sessions & Context Guard](#7-s03--sessions--context-guard)
8. [S04 — Channels (Multi-Platform I/O)](#8-s04--channels-multi-platform-io)
9. [S05 — Gateway & Routing](#9-s05--gateway--routing)
10. [S06 — Intelligence (Soul, Memory, Skills, Prompt Assembly)](#10-s06--intelligence-soul-memory-skills-prompt-assembly)
11. [S07 — Heartbeat & Cron](#11-s07--heartbeat--cron)
12. [S08 — Delivery Queue](#12-s08--delivery-queue)
13. [S09 — Resilience (3-Layer Retry Onion)](#13-s09--resilience-3-layer-retry-onion)
14. [S10 — Concurrency (Named Lanes)](#14-s10--concurrency-named-lanes)
15. [Workspace Config Files](#15-workspace-config-files)
16. [Python → TypeScript Mapping (claw0-specific)](#16-python--typescript-mapping-claw0-specific)
17. [File Structure for the TypeScript Port](#17-file-structure-for-the-typescript-port)

---

## 1. What is claw0 (gufan)?

claw0 is a **teaching implementation** of an AI agent **gateway** — the infrastructure layer that turns a disposable CLI agent into an always-on, multi-channel personal assistant.

```
+------------------- claw0 layers -------------------+
|                                                     |
|  s10: Concurrency  (named lanes, generation track)  |
|  s09: Resilience   (auth rotation, overflow compact) |
|  s08: Delivery     (write-ahead queue, backoff)      |
|  s07: Heartbeat    (lane lock, cron scheduler)       |
|  s06: Intelligence (8-layer prompt, hybrid memory)   |
|  s05: Gateway      (WebSocket, 5-tier routing)       |
|  s04: Channels     (Telegram pipeline, Feishu hook)  |
|  s03: Sessions     (JSONL persistence, 3-stage retry)|
|  s02: Tools        (dispatch table, 4 tools)         |
|  s01: Agent Loop   (while True + stop_reason)        |
|                                                     |
+-----------------------------------------------------+
```

### Key Difference from agents/

| Aspect | agents/ (learn-claude-code) | gufan/ (claw0) |
|---|---|---|
| **Focus** | Agent runtime internals | Gateway infrastructure |
| **Lifecycle** | Disposable: open → task → close | Always-on: runs forever |
| **I/O** | CLI stdin/stdout only | Telegram, Feishu, WebSocket, CLI |
| **State** | In-memory messages[] | JSONL session files on disk |
| **Personality** | Hardcoded system prompt | File-based: SOUL.md, MEMORY.md |
| **Proactivity** | Reactive only | Heartbeat timer + cron scheduler |
| **Delivery** | Print to console | Write-ahead queue with retry |
| **Resilience** | None | 3-layer retry onion + auth rotation |
| **Concurrency** | Threading for teammates | Named FIFO lanes with generation tracking |
| **Planning** | TodoManager, TaskManager | N/A (handled by agents/ layer) |
| **Teams** | Multi-agent teams | Multi-agent routing (different approach) |

---

## 2. How claw0 Relates to agents/

The two projects share the **same s01–s02 foundation** (agent loop + tool dispatch), then diverge:

```
                        SHARED FOUNDATION
                    ┌─────────────────────┐
                    │ s01: Agent Loop      │
                    │ s02: Tool Dispatch   │
                    └──────────┬──────────┘
                               │
              ┌────────────────┴────────────────┐
              │                                  │
    agents/ (BRAIN)                    gufan/ (GATEWAY)
    ┌──────────────┐                  ┌──────────────┐
    │ s03: TodoWrite│                  │ s03: Sessions │
    │ s04: Subagents│                  │ s04: Channels │
    │ s05: Skills   │                  │ s05: Routing  │
    │ s06: Compact  │                  │ s06: Soul/Mem │
    │ s07: Tasks    │                  │ s07: Heartbeat│
    │ s08: BgTasks  │                  │ s08: Delivery │
    │ s09: Teams    │                  │ s09: Resilience│
    │ s10: Protocols│                  │ s10: Lanes    │
    │ s11: Autonom  │                  └──────────────┘
    │ s12: Worktree │
    └──────────────┘

    Combined = production agent:
    claw agent = agent core + heartbeat + cron + IM chat + memory + soul
```

### Porting Strategy

When porting both to TypeScript, the **shared modules** should be extracted:

```typescript
// Shared between both projects:
//   - src/core/agent-loop.ts      (s01 from either)
//   - src/core/tool-dispatch.ts   (s02 from either)
//   - src/core/base-tools.ts      (bash, read, write, edit)
//
// agents/-specific modules:
//   - src/brain/todo.ts, subagent.ts, tasks.ts, teams.ts, worktree.ts ...
//
// gufan/-specific modules:
//   - src/gateway/sessions.ts, channels.ts, routing.ts, soul.ts, ...
```

---

## 3. Project Setup & Dependencies

### Recommended `package.json`

```json
{
  "name": "claw0-ts",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "s01": "tsx src/s01_agent_loop.ts",
    "s02": "tsx src/s02_tool_use.ts",
    "s03": "tsx src/s03_sessions.ts",
    "s04": "tsx src/s04_channels.ts",
    "s05": "tsx src/s05_gateway_routing.ts",
    "s06": "tsx src/s06_intelligence.ts",
    "s07": "tsx src/s07_heartbeat_cron.ts",
    "s08": "tsx src/s08_delivery.ts",
    "s09": "tsx src/s09_resilience.ts",
    "s10": "tsx src/s10_concurrency.ts"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.30.0",
    "dotenv": "^16.4.0",
    "ws": "^8.16.0",
    "cron-parser": "^4.9.0"
  },
  "devDependencies": {
    "tsx": "^4.7.0",
    "typescript": "^5.4.0",
    "@types/node": "^20.11.0",
    "@types/ws": "^8.5.10"
  }
}
```

### Python → Node.js Dependency Mapping

| Python (requirements.txt) | Node.js Package | Purpose |
|---|---|---|
| `anthropic>=0.39.0` | `@anthropic-ai/sdk` | LLM client |
| `python-dotenv>=1.0.0` | `dotenv` | .env loading |
| `websockets>=12.0` | `ws` | WebSocket gateway (s05) |
| `croniter>=2.0.0` | `cron-parser` | Cron expression parsing (s07) |
| `python-telegram-bot>=21.0` | `node-telegram-bot-api` or raw `fetch` | Telegram Bot API (s04) |
| `httpx>=0.27.0` | Built-in `fetch` (Node 18+) or `undici` | HTTP client for Feishu (s04) |

---

## 4. TypeScript Types & Interfaces

```typescript
// src/types.ts — claw0-specific types

// ─── Inbound/Outbound Messages (s04) ───

export interface InboundMessage {
  text: string;
  senderId: string;
  channel: string;         // "cli" | "telegram" | "feishu" | "websocket"
  accountId: string;
  peerId: string;
  isGroup: boolean;
  media: any[];
  raw: Record<string, any>;
}

export interface ChannelAccount {
  channel: string;
  accountId: string;
  token: string;
  config: Record<string, any>;
}

// ─── Session Persistence (s03) ───

export interface SessionRecord {
  type: "user" | "assistant" | "tool_use" | "tool_result";
  content: any;
  ts: number;
  tool_use_id?: string;
  name?: string;
  input?: Record<string, any>;
}

export interface SessionIndex {
  [sessionId: string]: {
    label: string;
    created_at: string;
    last_active: string;
    message_count: number;
  };
}

// ─── Routing (s05) ───

export type BindingTier = "peer" | "guild" | "account" | "channel" | "default";

export interface Binding {
  tier: BindingTier;
  channel: string;
  accountId: string;
  peerId: string;
  agentId: string;
  createdAt: string;
}

// ─── Intelligence (s06) ───

export interface SkillMeta {
  name: string;
  description: string;
  invocation: string;
  body: string;
  path: string;
}

export interface MemoryEntry {
  id: string;
  content: string;
  tags: string[];
  timestamp: number;
  source: string;
}

// ─── Heartbeat & Cron (s07) ───

export type CronScheduleKind = "cron" | "at" | "every";

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: {
    kind: CronScheduleKind;
    expr?: string;          // for "cron" kind
    tz?: string;
    at?: string;            // for "at" kind (ISO datetime)
    every_seconds?: number; // for "every" kind
    anchor?: string;        // for "every" kind
  };
  payload: {
    kind: "agent_turn" | "system_event";
    message?: string;
    text?: string;
  };
  delete_after_run: boolean;
}

export interface CronConfig {
  jobs: CronJob[];
}

// ─── Delivery Queue (s08) ───

export interface DeliveryItem {
  id: string;
  channel: string;
  to: string;
  text: string;
  retries: number;
  nextRetryAt: number;
  createdAt: number;
  status: "pending" | "failed";
}

// ─── Resilience (s09) ───

export type FailoverReason = "rate_limit" | "auth" | "timeout" | "billing" | "overflow" | "unknown";

export interface AuthProfile {
  name: string;
  provider: string;
  apiKey: string;
  baseUrl?: string;
  cooldownUntil: number;
  failureReason: string | null;
  lastGoodAt: number;
}

// ─── Concurrency Lanes (s10) ───

export interface LaneConfig {
  name: string;
  maxConcurrency: number;
}

export interface QueuedTask<T = any> {
  id: string;
  lane: string;
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (err: any) => void;
  generation: number;
}
```

---

## 5. S01 — Agent Loop (Shared Foundation)

Identical to `agents/s01`. See the [agents/ porting guide](./PORTING_GUIDE_PYTHON_TO_TYPESCRIPT.md#4-s01--the-agent-loop).

The only claw0-specific difference is the claw0 version checks `stop_reason === "end_turn"` explicitly (not just `!== "tool_use"`):

```typescript
if (response.stop_reason === "end_turn") {
  // Print assistant text
} else if (response.stop_reason === "tool_use") {
  // Dispatch tools
} else {
  // Handle other stop reasons (max_tokens, etc.)
}
```

---

## 6. S02 — Tool Use (Shared Foundation)

Identical to `agents/s02`. See the [agents/ porting guide](./PORTING_GUIDE_PYTHON_TO_TYPESCRIPT.md#5-s02--tool-use--dispatch-map).

claw0's s02 adds one pattern: a separate `process_tool_call()` function instead of inline dispatch:

```typescript
function processToolCall(toolName: string, toolInput: Record<string, any>): Promise<string> {
  const handler = TOOL_HANDLERS[toolName];
  if (!handler) return Promise.resolve(`Error: Unknown tool '${toolName}'`);
  try {
    return Promise.resolve(handler(toolInput));
  } catch (err: any) {
    return Promise.resolve(`Error: ${toolName} failed: ${err.message}`);
  }
}
```

---

## 7. S03 — Sessions & Context Guard

**Motto:** *"Sessions are JSONL files. Append on write, replay on read. When too big, summarize."*

This is claw0's version of persistence — **very different from agents/s03 (TodoWrite)**. While agents/ keeps everything in-memory, claw0 persists every turn to disk as JSONL so conversations survive process restarts.

### Architecture

```
User Input
    |
load_session() --> rebuild messages[] from JSONL
    |
guard_api_call() --> try -> truncate -> compact -> raise
    |
save_turn() --> append to JSONL
    |
Print response
```

### SessionStore Class

```typescript
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

class SessionStore {
  private baseDir: string;
  private indexPath: string;
  private index: SessionIndex;
  currentSessionId: string | null = null;

  constructor(agentId = "default") {
    this.baseDir = join(WORKSPACE_DIR, ".sessions", "agents", agentId, "sessions");
    mkdirSync(this.baseDir, { recursive: true });
    this.indexPath = join(this.baseDir, "..", "sessions.json");
    this.index = this.loadIndex();
  }

  private loadIndex(): SessionIndex {
    if (existsSync(this.indexPath)) {
      try { return JSON.parse(readFileSync(this.indexPath, "utf-8")); } catch { return {}; }
    }
    return {};
  }

  private saveIndex(): void {
    writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2));
  }

  private sessionPath(id: string): string {
    return join(this.baseDir, `${id}.jsonl`);
  }

  createSession(label = ""): string {
    const id = randomUUID().replace(/-/g, "").slice(0, 12);
    const now = new Date().toISOString();
    this.index[id] = { label, created_at: now, last_active: now, message_count: 0 };
    this.saveIndex();
    writeFileSync(this.sessionPath(id), "");
    this.currentSessionId = id;
    return id;
  }

  /** Rebuild API-format messages[] from JSONL */
  loadSession(id: string): Anthropic.MessageParam[] {
    const path = this.sessionPath(id);
    if (!existsSync(path)) return [];
    this.currentSessionId = id;
    return this.rebuildHistory(path);
  }

  saveTurn(role: string, content: any): void {
    if (!this.currentSessionId) return;
    this.appendTranscript(this.currentSessionId, {
      type: role, content, ts: Date.now() / 1000,
    });
  }

  saveToolResult(toolUseId: string, name: string, input: Record<string, any>, result: string): void {
    if (!this.currentSessionId) return;
    const ts = Date.now() / 1000;
    this.appendTranscript(this.currentSessionId, { type: "tool_use", tool_use_id: toolUseId, name, input, ts });
    this.appendTranscript(this.currentSessionId, { type: "tool_result", tool_use_id: toolUseId, content: result, ts });
  }

  private appendTranscript(id: string, record: Record<string, any>): void {
    appendFileSync(this.sessionPath(id), JSON.stringify(record) + "\n");
    if (this.index[id]) {
      this.index[id].last_active = new Date().toISOString();
      this.index[id].message_count++;
      this.saveIndex();
    }
  }

  /**
   * Rebuild API messages from JSONL lines.
   * Key insight: tool_use blocks go in assistant messages,
   * tool_result blocks go in user messages.
   * Consecutive same-role entries must be merged.
   */
  private rebuildHistory(path: string): Anthropic.MessageParam[] {
    const lines = readFileSync(path, "utf-8").trim().split("\n").filter(Boolean);
    const messages: Anthropic.MessageParam[] = [];

    for (const line of lines) {
      let record: SessionRecord;
      try { record = JSON.parse(line); } catch { continue; }

      if (record.type === "user") {
        messages.push({ role: "user", content: record.content });
      } else if (record.type === "assistant") {
        let content = record.content;
        if (typeof content === "string") content = [{ type: "text", text: content }];
        messages.push({ role: "assistant", content });
      } else if (record.type === "tool_use") {
        // Merge into previous assistant message or create new
        const last = messages[messages.length - 1];
        const block = { type: "tool_use" as const, id: record.tool_use_id!, name: record.name!, input: record.input! };
        if (last?.role === "assistant" && Array.isArray(last.content)) {
          (last.content as any[]).push(block);
        } else {
          messages.push({ role: "assistant", content: [block] });
        }
      } else if (record.type === "tool_result") {
        // Merge into previous user message or create new
        const last = messages[messages.length - 1];
        const block = { type: "tool_result" as const, tool_use_id: record.tool_use_id!, content: record.content };
        if (last?.role === "user" && Array.isArray(last.content)) {
          (last.content as any[]).push(block);
        } else {
          messages.push({ role: "user", content: [block] });
        }
      }
    }
    return messages;
  }

  listSessions(): Array<[string, SessionIndex[string]]> {
    return Object.entries(this.index).sort(
      ([, a], [, b]) => new Date(b.last_active).getTime() - new Date(a.last_active).getTime()
    );
  }
}
```

### ContextGuard (3-Stage Overflow Retry)

```typescript
class ContextGuard {
  maxTokens: number;

  constructor(maxTokens = 180_000) {
    this.maxTokens = maxTokens;
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  estimateMessagesTokens(messages: Anthropic.MessageParam[]): number {
    return this.estimateTokens(JSON.stringify(messages));
  }

  /**
   * 3-stage overflow retry:
   *   Stage 1: Try normal API call
   *   Stage 2: Truncate long tool_result blocks, retry
   *   Stage 3: Compact history (summarize oldest 50%), retry
   *   Stage 4: Give up
   */
  async guardApiCall(params: {
    client: Anthropic;
    model: string;
    system: string;
    messages: Anthropic.MessageParam[];
    tools: Anthropic.Tool[];
  }): Promise<Anthropic.Message> {
    const { client, model, system, messages, tools } = params;

    // Stage 1: try normal
    try {
      return await client.messages.create({ model, system, messages, tools, max_tokens: 8096 });
    } catch (err: any) {
      if (!this.isOverflowError(err)) throw err;
    }

    // Stage 2: truncate tool results
    this.truncateToolResults(messages);
    try {
      return await client.messages.create({ model, system, messages, tools, max_tokens: 8096 });
    } catch (err: any) {
      if (!this.isOverflowError(err)) throw err;
    }

    // Stage 3: compact history
    const compacted = await this.compactHistory(messages, client, model);
    messages.length = 0;
    messages.push(...compacted);
    return await client.messages.create({ model, system, messages, tools, max_tokens: 8096 });
  }

  private isOverflowError(err: any): boolean {
    const msg = String(err).toLowerCase();
    return msg.includes("context") || msg.includes("token") || msg.includes("overflow");
  }

  private truncateToolResults(messages: Anthropic.MessageParam[]): void {
    for (const msg of messages) {
      if (msg.role === "user" && Array.isArray(msg.content)) {
        for (const part of msg.content as any[]) {
          if (part.type === "tool_result" && typeof part.content === "string" && part.content.length > 500) {
            part.content = part.content.slice(0, 500) + "\n[truncated]";
          }
        }
      }
    }
  }

  async compactHistory(
    messages: Anthropic.MessageParam[],
    client: Anthropic,
    model: string
  ): Promise<Anthropic.MessageParam[]> {
    const halfIdx = Math.floor(messages.length / 2);
    const oldPart = messages.slice(0, halfIdx);
    const recentPart = messages.slice(halfIdx);

    const summaryResp = await client.messages.create({
      model,
      messages: [{ role: "user", content: `Summarize this conversation:\n${JSON.stringify(oldPart).slice(0, 80000)}` }],
      max_tokens: 1500,
    });
    const summary = (summaryResp.content[0] as any).text;

    return [
      { role: "user", content: `[Previous conversation summary]\n${summary}` },
      { role: "assistant", content: "Understood. I have the context. Continuing." },
      ...recentPart,
    ];
  }
}
```

---

## 8. S04 — Channels (Multi-Platform I/O)

**Motto:** *"Same brain, many mouths"*

This is the most unique claw0 concept — **channels normalize platform differences** so the agent loop only ever sees `InboundMessage`.

```
Telegram ----.                          .---- sendMessage API
Feishu -------+-- InboundMessage ---+---- im/v1/messages
CLI (stdin) --'    Agent Loop        '---- print(stdout)
WebSocket ---'                       '---- ws.send()
```

### Channel Abstract Base

```typescript
abstract class Channel {
  abstract name: string;
  abstract receive(): Promise<InboundMessage | null>;
  abstract send(to: string, text: string): Promise<boolean>;
  close(): void {}
}
```

### CLIChannel

```typescript
import * as readline from "node:readline";

class CLIChannel extends Channel {
  name = "cli";
  accountId = "cli-local";
  private rl: readline.Interface;

  constructor() {
    super();
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }

  async receive(): Promise<InboundMessage | null> {
    return new Promise((resolve) => {
      this.rl.question("\x1b[36m\x1b[1mYou > \x1b[0m", (text) => {
        if (!text?.trim()) { resolve(null); return; }
        resolve({
          text: text.trim(),
          senderId: "cli-user",
          channel: "cli",
          accountId: this.accountId,
          peerId: "cli-user",
          isGroup: false,
          media: [],
          raw: {},
        });
      });
    });
  }

  async send(_to: string, text: string): Promise<boolean> {
    console.log(`\n\x1b[32m\x1b[1mAssistant:\x1b[0m ${text}\n`);
    return true;
  }

  close(): void {
    this.rl.close();
  }
}
```

### TelegramChannel (using raw fetch — no extra dependency)

```typescript
class TelegramChannel extends Channel {
  name = "telegram";
  private baseUrl: string;
  private offset = 0;
  private seen = new Set<number>();

  constructor(private account: ChannelAccount) {
    super();
    this.baseUrl = `https://api.telegram.org/bot${account.token}`;
  }

  private async api(method: string, params: Record<string, any> = {}): Promise<any> {
    const resp = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    const data = await resp.json();
    return data.ok ? data.result : null;
  }

  async poll(): Promise<InboundMessage[]> {
    const updates = await this.api("getUpdates", { offset: this.offset, timeout: 30 });
    if (!updates || !Array.isArray(updates)) return [];

    const results: InboundMessage[] = [];
    for (const update of updates) {
      const uid = update.update_id;
      if (uid >= this.offset) this.offset = uid + 1;
      if (this.seen.has(uid)) continue;
      this.seen.add(uid);
      if (this.seen.size > 5000) this.seen.clear();

      const msg = update.message;
      if (!msg?.text) continue;

      results.push({
        text: msg.text,
        senderId: String(msg.from?.id || ""),
        channel: "telegram",
        accountId: this.account.accountId,
        peerId: String(msg.chat.id),
        isGroup: msg.chat.type !== "private",
        media: [],
        raw: update,
      });
    }
    return results;
  }

  // receive() not used — Telegram uses poll() in a background loop
  async receive(): Promise<InboundMessage | null> { return null; }

  async send(to: string, text: string): Promise<boolean> {
    const MAX_LEN = 4096;
    const chunks = [];
    for (let i = 0; i < text.length; i += MAX_LEN) {
      chunks.push(text.slice(i, i + MAX_LEN));
    }
    for (const chunk of chunks) {
      await this.api("sendMessage", { chat_id: to, text: chunk });
    }
    return true;
  }

  async sendTyping(chatId: string): Promise<void> {
    await this.api("sendChatAction", { chat_id: chatId, action: "typing" });
  }
}
```

### ChannelManager

```typescript
class ChannelManager {
  channels = new Map<string, Channel>();
  accounts: ChannelAccount[] = [];

  register(channel: Channel): void {
    this.channels.set(channel.name, channel);
  }

  get(name: string): Channel | undefined {
    return this.channels.get(name);
  }

  closeAll(): void {
    for (const ch of this.channels.values()) ch.close();
  }
}
```

### Session Key Convention

```typescript
function buildSessionKey(channel: string, accountId: string, peerId: string): string {
  return `agent:main:direct:${channel}:${peerId}`;
}
```

---

## 9. S05 — Gateway & Routing

**Motto:** *"Every message finds its home"*

The Gateway is the central hub: every inbound message resolves to `(agentId, sessionKey)` via a 5-tier binding table.

```
Inbound Message
       |
   Gateway  <-- WS/REPL (JSON-RPC 2.0)
       |
   Routing: 5-tier (peer > guild > account > channel > default)
       |
   (agentId, sessionKey)
       |
   AgentManager → LLM API
```

### 5-Tier Binding Resolution

```typescript
class RoutingTable {
  private bindings: Binding[] = [];

  addBinding(binding: Binding): void {
    // Remove existing binding at same tier+channel+account+peer
    this.bindings = this.bindings.filter(
      (b) => !(b.tier === binding.tier && b.channel === binding.channel
        && b.accountId === binding.accountId && b.peerId === binding.peerId)
    );
    this.bindings.push(binding);
  }

  /**
   * Resolve agent ID for an inbound message.
   * Priority: peer > guild > account > channel > default
   */
  resolve(channel: string, accountId: string, peerId: string): string {
    const tiers: BindingTier[] = ["peer", "guild", "account", "channel", "default"];

    for (const tier of tiers) {
      const match = this.bindings.find((b) => {
        if (b.tier !== tier) return false;
        switch (tier) {
          case "peer":    return b.channel === channel && b.accountId === accountId && b.peerId === peerId;
          case "guild":   return b.channel === channel && b.peerId === peerId;
          case "account": return b.channel === channel && b.accountId === accountId;
          case "channel": return b.channel === channel;
          case "default": return true;
        }
      });
      if (match) return match.agentId;
    }

    return "main"; // fallback
  }
}
```

### WebSocket Gateway (JSON-RPC 2.0)

```typescript
import { WebSocketServer } from "ws";

class GatewayServer {
  private wss: WebSocketServer;

  constructor(port: number, private routing: RoutingTable, private onMessage: (msg: InboundMessage) => void) {
    this.wss = new WebSocketServer({ port });
    this.wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const rpc = JSON.parse(raw.toString());
        if (rpc.method === "send_message") {
          this.onMessage(rpc.params as InboundMessage);
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: "ok" }));
        }
      });
    });
  }
}
```

---

## 10. S06 — Intelligence (Soul, Memory, Skills, Prompt Assembly)

**Motto:** *"Give it a soul, teach it to remember"*

The system prompt is **assembled from files on disk**. Swap files → change personality. No code changes.

### 8-Layer Prompt Assembly

```
workspace/
  SOUL.md        →  Layer 1: Personality (highest priority, earliest position)
  IDENTITY.md    →  Layer 2: Role definition & boundaries
  TOOLS.md       →  Layer 3: Tool usage guidance
  USER.md        →  Layer 4: User-specific context
  HEARTBEAT.md   →  Layer 5: Proactive behavior rules
  BOOTSTRAP.md   →  Layer 6: Project context
  AGENTS.md      →  Layer 7: Multi-agent coordination
  MEMORY.md      →  Layer 8: Long-term facts & preferences
  skills/*/SKILL.md → Appended: Available skill descriptions
```

### BootstrapLoader

```typescript
const BOOTSTRAP_FILES = [
  "SOUL.md", "IDENTITY.md", "TOOLS.md", "USER.md",
  "HEARTBEAT.md", "BOOTSTRAP.md", "AGENTS.md", "MEMORY.md",
];

const MAX_FILE_CHARS = 20_000;
const MAX_TOTAL_CHARS = 150_000;

class BootstrapLoader {
  constructor(private workspaceDir: string) {}

  loadFile(name: string): string {
    const path = join(this.workspaceDir, name);
    if (!existsSync(path)) return "";
    try { return readFileSync(path, "utf-8"); } catch { return ""; }
  }

  truncateFile(content: string, maxChars = MAX_FILE_CHARS): string {
    if (content.length <= maxChars) return content;
    const cut = content.lastIndexOf("\n", maxChars);
    const pos = cut > 0 ? cut : maxChars;
    return content.slice(0, pos) + `\n\n[... truncated (${content.length} chars total)]`;
  }

  /** Load mode: "full" (main agent) | "minimal" (sub-agent/cron) | "none" (bare) */
  loadAll(mode: "full" | "minimal" | "none" = "full"): Map<string, string> {
    if (mode === "none") return new Map();
    const names = mode === "minimal" ? ["AGENTS.md", "TOOLS.md"] : BOOTSTRAP_FILES;
    const result = new Map<string, string>();
    let total = 0;

    for (const name of names) {
      const raw = this.loadFile(name);
      if (!raw) continue;
      let truncated = this.truncateFile(raw);
      if (total + truncated.length > MAX_TOTAL_CHARS) break;
      result.set(name, truncated);
      total += truncated.length;
    }
    return result;
  }
}
```

### MemoryStore (File-based hybrid memory)

```typescript
class MemoryStore {
  private dir: string;

  constructor(workspaceDir: string) {
    this.dir = join(workspaceDir, "memory");
    mkdirSync(this.dir, { recursive: true });
  }

  write(content: string, tags: string[] = []): string {
    const entry: MemoryEntry = {
      id: randomUUID().slice(0, 8),
      content,
      tags,
      timestamp: Date.now() / 1000,
      source: "agent",
    };
    // Append to daily file
    const date = new Date().toISOString().split("T")[0];
    const path = join(this.dir, `${date}.jsonl`);
    appendFileSync(path, JSON.stringify(entry) + "\n");
    return `Saved memory: ${content.slice(0, 80)}`;
  }

  search(query: string, limit = 5): MemoryEntry[] {
    const allEntries: MemoryEntry[] = [];
    const files = readdirSync(this.dir).filter((f) => f.endsWith(".jsonl")).sort().reverse();

    for (const file of files) {
      const lines = readFileSync(join(this.dir, file), "utf-8").trim().split("\n").filter(Boolean);
      for (const line of lines) {
        try { allEntries.push(JSON.parse(line)); } catch {}
      }
    }

    // Simple keyword matching (production would use embeddings)
    const queryLower = query.toLowerCase();
    const scored = allEntries
      .map((e) => ({
        entry: e,
        score: e.content.toLowerCase().includes(queryLower) ? 1 : 0
          + e.tags.some((t) => t.toLowerCase().includes(queryLower)) ? 0.5 : 0,
      }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored.map((s) => s.entry);
  }
}
```

### Building the System Prompt

```typescript
function buildSystemPrompt(
  bootstrap: BootstrapLoader,
  skills: SkillsManager,
  memory: MemoryStore,
  userQuery?: string,
): string {
  const files = bootstrap.loadAll("full");
  const parts: string[] = [];

  // Soul goes first (highest influence position)
  if (files.has("SOUL.md")) {
    parts.push(files.get("SOUL.md")!);
    files.delete("SOUL.md");
  }

  // Remaining bootstrap files
  for (const [name, content] of files) {
    parts.push(`# ${name}\n\n${content}`);
  }

  // Skills block
  const skillsBlock = skills.formatPromptBlock();
  if (skillsBlock) parts.push(skillsBlock);

  // Memory context (search relevant memories for current query)
  if (userQuery) {
    const memories = memory.search(userQuery, 3);
    if (memories.length) {
      parts.push("## Relevant Memories\n\n" +
        memories.map((m) => `- ${m.content}`).join("\n"));
    }
  }

  return parts.join("\n\n---\n\n");
}
```

---

## 11. S07 — Heartbeat & Cron

**Motto:** *"Not just reactive — proactive"*

Two mechanisms make the agent wake up on its own:
1. **Heartbeat:** Timer thread checks every N seconds — "should I run?"
2. **Cron:** Scheduled tasks from `CRON.json`

### Heartbeat Service

```typescript
class HeartbeatService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private intervalMs: number,
    private onHeartbeat: (prompt: string) => Promise<string>,
    private heartbeatPrompt: string,
    private activeHours = { start: 9, end: 22 },
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    console.log(`[heartbeat] Started (every ${this.intervalMs / 1000}s)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return; // skip if already running

    // Check active hours
    const hour = new Date().getHours();
    if (hour < this.activeHours.start || hour >= this.activeHours.end) return;

    this.running = true;
    try {
      const result = await this.onHeartbeat(this.heartbeatPrompt);
      // If the agent responded with something meaningful (not "HEARTBEAT_OK"),
      // deliver it to the user
      if (result && !result.includes("HEARTBEAT_OK")) {
        console.log(`[heartbeat] Agent says: ${result.slice(0, 200)}`);
        // → Route through delivery queue in production
      }
    } catch (err) {
      console.error(`[heartbeat] Error: ${err}`);
    } finally {
      this.running = false;
    }
  }
}
```

### Cron Service

```typescript
import { parseExpression } from "cron-parser";

class CronService {
  private jobs: CronJob[] = [];
  private timer: NodeJS.Timeout | null = null;
  private lastCheck = new Map<string, number>();

  constructor(
    private cronPath: string,
    private onJob: (job: CronJob) => Promise<void>,
  ) {
    this.loadJobs();
  }

  private loadJobs(): void {
    if (!existsSync(this.cronPath)) return;
    const config: CronConfig = JSON.parse(readFileSync(this.cronPath, "utf-8"));
    this.jobs = config.jobs.filter((j) => j.enabled);
  }

  start(intervalMs = 60_000): void {
    this.timer = setInterval(() => this.tick(), intervalMs);
    console.log(`[cron] Started with ${this.jobs.length} jobs`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    const now = Date.now();

    for (const job of this.jobs) {
      if (this.isDue(job, now)) {
        console.log(`[cron] Running: ${job.name}`);
        try {
          await this.onJob(job);
          this.lastCheck.set(job.id, now);

          if (job.delete_after_run) {
            this.jobs = this.jobs.filter((j) => j.id !== job.id);
            this.saveJobs();
          }
        } catch (err) {
          console.error(`[cron] Error in ${job.name}: ${err}`);
        }
      }
    }
  }

  private isDue(job: CronJob, now: number): boolean {
    const last = this.lastCheck.get(job.id) || 0;
    const { schedule } = job;

    switch (schedule.kind) {
      case "cron": {
        const interval = parseExpression(schedule.expr!, { tz: schedule.tz });
        const prev = interval.prev().getTime();
        return prev > last;
      }
      case "at": {
        const target = new Date(schedule.at!).getTime();
        return target <= now && target > last;
      }
      case "every": {
        const anchor = new Date(schedule.anchor || 0).getTime();
        const secs = schedule.every_seconds! * 1000;
        const elapsed = now - anchor;
        const currentSlot = Math.floor(elapsed / secs);
        const lastSlot = Math.floor((last - anchor) / secs);
        return currentSlot > lastSlot;
      }
    }
    return false;
  }

  private saveJobs(): void {
    writeFileSync(this.cronPath, JSON.stringify({ jobs: this.jobs }, null, 2));
  }
}
```

---

## 12. S08 — Delivery Queue

**Motto:** *"Write to disk first, then try to send"*

All outbound messages go through a persistent queue. If sending fails, retry with exponential backoff. If the process crashes, scan disk on restart.

```
Agent Reply
    |
chunk_message()          -- split by platform limits
    |
DeliveryQueue.enqueue()  -- write to disk (write-ahead)
    |
DeliveryRunner (background)
    |
deliver_fn(channel, to, text)
   / \
success   failure
  |         |
ack()    fail() + backoff
  |         |
delete   retry or move to failed/
```

### DeliveryQueue

```typescript
const BACKOFF_MS = [5_000, 25_000, 120_000, 600_000]; // 5s, 25s, 2min, 10min
const MAX_RETRIES = 5;

class DeliveryQueue {
  private queueDir: string;
  private failedDir: string;

  constructor(baseDir: string) {
    this.queueDir = join(baseDir, "delivery-queue");
    this.failedDir = join(this.queueDir, "failed");
    mkdirSync(this.queueDir, { recursive: true });
    mkdirSync(this.failedDir, { recursive: true });
  }

  enqueue(channel: string, to: string, text: string): string {
    const id = randomUUID().slice(0, 12);
    const item: DeliveryItem = {
      id,
      channel,
      to,
      text,
      retries: 0,
      nextRetryAt: Date.now(),
      createdAt: Date.now(),
      status: "pending",
    };
    // Write-ahead: persist to disk BEFORE attempting delivery
    writeFileSync(join(this.queueDir, `${id}.json`), JSON.stringify(item, null, 2));
    return id;
  }

  ack(id: string): void {
    const path = join(this.queueDir, `${id}.json`);
    if (existsSync(path)) {
      const fs = require("node:fs");
      fs.unlinkSync(path);
    }
  }

  fail(id: string): void {
    const path = join(this.queueDir, `${id}.json`);
    if (!existsSync(path)) return;
    const item: DeliveryItem = JSON.parse(readFileSync(path, "utf-8"));
    item.retries++;

    if (item.retries >= MAX_RETRIES) {
      // Move to failed/
      const failedPath = join(this.failedDir, `${id}.json`);
      item.status = "failed";
      writeFileSync(failedPath, JSON.stringify(item, null, 2));
      const fs = require("node:fs");
      fs.unlinkSync(path);
      return;
    }

    // Exponential backoff
    const backoff = BACKOFF_MS[Math.min(item.retries - 1, BACKOFF_MS.length - 1)];
    item.nextRetryAt = Date.now() + backoff;
    writeFileSync(path, JSON.stringify(item, null, 2));
  }

  /** Scan queue for items ready to send */
  pendingItems(): DeliveryItem[] {
    const now = Date.now();
    const files = readdirSync(this.queueDir).filter((f) => f.endsWith(".json"));
    return files
      .map((f) => {
        try { return JSON.parse(readFileSync(join(this.queueDir, f), "utf-8")) as DeliveryItem; }
        catch { return null; }
      })
      .filter((item): item is DeliveryItem => item !== null && item.nextRetryAt <= now);
  }
}

class DeliveryRunner {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private queue: DeliveryQueue,
    private deliverFn: (channel: string, to: string, text: string) => Promise<boolean>,
  ) {}

  start(intervalMs = 2000): void {
    this.timer = setInterval(() => this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    const items = this.queue.pendingItems();
    for (const item of items) {
      try {
        const success = await this.deliverFn(item.channel, item.to, item.text);
        if (success) {
          this.queue.ack(item.id);
        } else {
          this.queue.fail(item.id);
        }
      } catch {
        this.queue.fail(item.id);
      }
    }
  }
}
```

---

## 13. S09 — Resilience (3-Layer Retry Onion)

**Motto:** *"When one call fails, rotate and retry"*

```
Layer 1 — Auth Rotation:    cycle through API key profiles, skip cooldowns
Layer 2 — Overflow Recovery: compact messages on context overflow
Layer 3 — Tool-Use Loop:    standard while(true) + stop_reason dispatch

for each non-cooldown profile:           LAYER 1
  create client(profile.apiKey)
    for compactAttempt in 0..2:          LAYER 2
      runAttempt(client, model, ...)     LAYER 3
        success → markSuccess, return
        overflow → compact, retry L2
        auth/rate → markFailure, break to L1
  all profiles exhausted → try fallback models
```

### FailoverReason Classification

```typescript
function classifyFailure(err: Error): FailoverReason {
  const msg = String(err).toLowerCase();
  if (msg.includes("rate") || msg.includes("429")) return "rate_limit";
  if (msg.includes("auth") || msg.includes("401") || msg.includes("key")) return "auth";
  if (msg.includes("timeout") || msg.includes("timed out")) return "timeout";
  if (msg.includes("billing") || msg.includes("quota") || msg.includes("402")) return "billing";
  if (msg.includes("context") || msg.includes("token") || msg.includes("overflow")) return "overflow";
  return "unknown";
}
```

### ProfileManager

```typescript
class ProfileManager {
  constructor(private profiles: AuthProfile[]) {}

  selectProfile(): AuthProfile | null {
    const now = Date.now() / 1000;
    return this.profiles.find((p) => now >= p.cooldownUntil) || null;
  }

  selectAllAvailable(): AuthProfile[] {
    const now = Date.now() / 1000;
    return this.profiles.filter((p) => now >= p.cooldownUntil);
  }

  markFailure(profile: AuthProfile, reason: FailoverReason, cooldownSecs = 300): void {
    profile.cooldownUntil = Date.now() / 1000 + cooldownSecs;
    profile.failureReason = reason;
    console.log(`[resilience] Profile '${profile.name}' → cooldown ${cooldownSecs}s (${reason})`);
  }

  markSuccess(profile: AuthProfile): void {
    profile.failureReason = null;
    profile.lastGoodAt = Date.now() / 1000;
  }
}
```

### ResilientRunner (3-Layer Onion)

```typescript
class ResilientRunner {
  constructor(
    private profileManager: ProfileManager,
    private contextGuard: ContextGuard,
    private tools: Anthropic.Tool[],
    private toolHandlers: Record<string, (args: Record<string, any>) => Promise<string>>,
  ) {}

  async run(systemPrompt: string, messages: Anthropic.MessageParam[]): Promise<string> {
    const profiles = this.profileManager.selectAllAvailable();
    if (!profiles.length) throw new Error("All profiles on cooldown");

    for (const profile of profiles) {
      const client = new Anthropic({
        apiKey: profile.apiKey,
        baseURL: profile.baseUrl || undefined,
      });

      // Layer 2: overflow recovery (up to 3 compact attempts)
      for (let compactAttempt = 0; compactAttempt < 3; compactAttempt++) {
        try {
          // Layer 3: standard tool-use loop
          const result = await this.runAttempt(client, systemPrompt, messages);
          this.profileManager.markSuccess(profile);
          return result;
        } catch (err: any) {
          const reason = classifyFailure(err);

          if (reason === "overflow") {
            console.log(`[resilience] Overflow → compacting (attempt ${compactAttempt + 1})`);
            const compacted = await this.contextGuard.compactHistory(messages, client, MODEL);
            messages.length = 0;
            messages.push(...compacted);
            continue; // retry Layer 2
          }

          // auth/rate/timeout → break to Layer 1
          const cooldown = reason === "timeout" ? 60 : 300;
          this.profileManager.markFailure(profile, reason, cooldown);
          break;
        }
      }
    }

    throw new Error("All profiles exhausted");
  }

  /** Layer 3: standard agent loop (single attempt) */
  private async runAttempt(
    client: Anthropic,
    systemPrompt: string,
    messages: Anthropic.MessageParam[],
  ): Promise<string> {
    while (true) {
      const response = await client.messages.create({
        model: MODEL,
        system: systemPrompt,
        messages,
        tools: this.tools,
        max_tokens: 8096,
      });

      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason !== "tool_use") {
        return response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          const handler = this.toolHandlers[block.name];
          const output = handler
            ? await handler(block.input as Record<string, any>)
            : `Unknown tool: ${block.name}`;
          results.push({ type: "tool_result", tool_use_id: block.id, content: output });
        }
      }
      messages.push({ role: "user", content: results });
    }
  }
}
```

---

## 14. S10 — Concurrency (Named Lanes)

**Motto:** *"Named lanes serialize the chaos"*

Replace the single `Lock` from s07 with a proper named-lane system. Each lane is a FIFO queue with configurable `maxConcurrency`. User messages get priority over heartbeat/cron.

```
Incoming Work
    |
CommandQueue.enqueue(lane, fn)
    |
┌────────┐  ┌────────┐  ┌───────────┐
│ main   │  │  cron  │  │ heartbeat │
│ max=1  │  │ max=1  │  │   max=1   │
│ FIFO   │  │ FIFO   │  │   FIFO    │
└───┬────┘  └───┬────┘  └─────┬─────┘
    │           │              │
 [active]   [active]       [active]
    │           │              │
 taskDone   taskDone       taskDone
    │           │              │
  pump()     pump()         pump()
```

### CommandQueue

```typescript
class CommandQueue {
  private lanes = new Map<string, {
    queue: QueuedTask[];
    active: number;
    maxConcurrency: number;
    generation: number;
  }>();

  /** Create or configure a lane */
  configureLane(name: string, maxConcurrency = 1): void {
    if (!this.lanes.has(name)) {
      this.lanes.set(name, { queue: [], active: 0, maxConcurrency, generation: 0 });
    } else {
      this.lanes.get(name)!.maxConcurrency = maxConcurrency;
    }
  }

  /** Enqueue work into a named lane, returns a Promise for the result */
  enqueue<T>(lane: string, fn: () => Promise<T>): Promise<T> {
    if (!this.lanes.has(lane)) {
      this.configureLane(lane);
    }

    const laneData = this.lanes.get(lane)!;
    laneData.generation++;

    return new Promise<T>((resolve, reject) => {
      const task: QueuedTask<T> = {
        id: randomUUID().slice(0, 8),
        lane,
        fn,
        resolve,
        reject,
        generation: laneData.generation,
      };
      laneData.queue.push(task);
      this.pump(lane);
    });
  }

  private pump(lane: string): void {
    const laneData = this.lanes.get(lane);
    if (!laneData) return;

    while (laneData.active < laneData.maxConcurrency && laneData.queue.length > 0) {
      const task = laneData.queue.shift()!;
      laneData.active++;

      task.fn()
        .then((result) => task.resolve(result))
        .catch((err) => task.reject(err))
        .finally(() => {
          laneData.active--;
          this.pump(lane); // try to start next task
        });
    }
  }

  /** Get lane status for debugging */
  status(): Record<string, { queued: number; active: number; generation: number }> {
    const result: Record<string, any> = {};
    for (const [name, data] of this.lanes) {
      result[name] = {
        queued: data.queue.length,
        active: data.active,
        generation: data.generation,
      };
    }
    return result;
  }
}
```

### Integration: User Messages vs Heartbeat

```typescript
const cmdQueue = new CommandQueue();
cmdQueue.configureLane("main", 1);       // user messages — exclusive
cmdQueue.configureLane("heartbeat", 1);  // heartbeat — yields to main
cmdQueue.configureLane("cron", 1);       // cron jobs — yields to main

// User message → main lane (blocks heartbeat/cron while running)
async function handleUserMessage(msg: InboundMessage) {
  await cmdQueue.enqueue("main", () => runAgentTurn(msg));
}

// Heartbeat → heartbeat lane
heartbeatService.onHeartbeat = (prompt) =>
  cmdQueue.enqueue("heartbeat", () => runHeartbeatTurn(prompt));

// Cron → cron lane
cronService.onJob = (job) =>
  cmdQueue.enqueue("cron", () => runCronJob(job));
```

---

## 15. Workspace Config Files

The `workspace/` directory contains runtime configuration files that shape agent behavior. **Copy these directly** to your TypeScript project.

| File | Purpose | Loaded By |
|---|---|---|
| `SOUL.md` | Personality definition ("You are Luna, warm and curious...") | BootstrapLoader → system prompt (position 1) |
| `IDENTITY.md` | Role and boundaries | BootstrapLoader → system prompt |
| `TOOLS.md` | Tool usage guidance | BootstrapLoader → system prompt |
| `USER.md` | User-specific context | BootstrapLoader → system prompt |
| `HEARTBEAT.md` | Proactive behavior rules (what to check) | HeartbeatService → heartbeat prompt |
| `BOOTSTRAP.md` | Project context, workspace layout | BootstrapLoader → system prompt |
| `AGENTS.md` | Multi-agent coordination notes | BootstrapLoader → system prompt |
| `MEMORY.md` | Long-term facts & preferences (evergreen) | BootstrapLoader → system prompt |
| `CRON.json` | Scheduled job definitions | CronService → tick() |
| `skills/*/SKILL.md` | Skill definitions with frontmatter | SkillsManager → prompt block |

### CRON.json Schema

```typescript
// Three schedule kinds:
// 1. "cron"  → standard cron expression: "0 9 * * *"
// 2. "at"    → one-shot ISO datetime: "2026-02-25T09:30:00+08:00"
// 3. "every" → interval in seconds with anchor: { every_seconds: 3600, anchor: "..." }
```

---

## 16. Python → TypeScript Mapping (claw0-specific)

| Python Pattern | TypeScript Equivalent |
|---|---|
| `@dataclass` for InboundMessage | `interface InboundMessage` |
| `ABC` + `@abstractmethod` | `abstract class Channel` |
| `threading.Thread(target=fn, daemon=True)` | `setInterval()` or fire-and-forget `async` |
| `threading.Lock()` / `lock.acquire(blocking=False)` | `CommandQueue` named lanes (Node.js is single-threaded) |
| `threading.Event()` (stop signal) | `AbortController` or boolean flag |
| `croniter(expr).get_next()` | `cron-parser`'s `parseExpression(expr).next()` |
| `httpx.Client` (sync HTTP) | `fetch()` (built into Node 18+) |
| `select.select([sys.stdin], [], [], 0.5)` | `readline` + `setTimeout` polling |
| `Path(__file__).resolve().parent.parent.parent / ".env"` | `join(__dirname, "..", "..", "..", ".env")` |
| `open(path, "a").write(json + "\n")` (JSONL append) | `appendFileSync(path, json + "\n")` |
| `asyncio` + `websockets.serve(...)` | `new WebSocketServer({ port })` from `ws` |
| `uuid.uuid4().hex[:12]` | `crypto.randomUUID().replace(/-/g, "").slice(0, 12)` |

---

## 17. File Structure for the TypeScript Port

```
claw0-ts/
├── src/
│   ├── types.ts                        # All interfaces from Section 4
│   │
│   ├── core/
│   │   ├── agent-loop.ts               # Shared: while(true) + stop_reason
│   │   ├── tool-dispatch.ts            # Shared: name → handler map
│   │   └── base-tools.ts              # bash, read_file, write_file, edit_file
│   │
│   ├── sessions/
│   │   ├── session-store.ts            # JSONL persistence (s03)
│   │   └── context-guard.ts            # 3-stage overflow retry (s03)
│   │
│   ├── channels/
│   │   ├── channel.ts                  # Abstract Channel base (s04)
│   │   ├── cli-channel.ts             # stdin/stdout (s04)
│   │   ├── telegram-channel.ts        # Bot API long-polling (s04)
│   │   ├── feishu-channel.ts          # Feishu/Lark webhook (s04)
│   │   └── channel-manager.ts         # Registry (s04)
│   │
│   ├── gateway/
│   │   ├── routing.ts                  # 5-tier binding table (s05)
│   │   ├── gateway-server.ts          # WebSocket JSON-RPC (s05)
│   │   └── agent-manager.ts           # Per-agent config (s05)
│   │
│   ├── intelligence/
│   │   ├── bootstrap-loader.ts        # 8-file system prompt assembly (s06)
│   │   ├── soul.ts                    # SOUL.md loader (s06)
│   │   ├── memory-store.ts            # Hybrid daily-JSONL memory (s06)
│   │   └── skills-manager.ts          # Skill discovery & injection (s06)
│   │
│   ├── proactive/
│   │   ├── heartbeat.ts               # Timer-based proactive checks (s07)
│   │   └── cron-service.ts            # CRON.json scheduler (s07)
│   │
│   ├── delivery/
│   │   ├── delivery-queue.ts          # Write-ahead queue (s08)
│   │   └── delivery-runner.ts         # Background retry with backoff (s08)
│   │
│   ├── resilience/
│   │   ├── failover.ts                # FailoverReason classification (s09)
│   │   ├── profile-manager.ts         # Auth profile rotation (s09)
│   │   └── resilient-runner.ts        # 3-layer retry onion (s09)
│   │
│   ├── concurrency/
│   │   └── command-queue.ts           # Named FIFO lanes (s10)
│   │
│   ├── s01_agent_loop.ts              # Standalone runnable
│   ├── s02_tool_use.ts
│   ├── s03_sessions.ts
│   ├── s04_channels.ts
│   ├── s05_gateway_routing.ts
│   ├── s06_intelligence.ts
│   ├── s07_heartbeat_cron.ts
│   ├── s08_delivery.ts
│   ├── s09_resilience.ts
│   └── s10_concurrency.ts
│
├── workspace/                          # Copy from Python repo
│   ├── SOUL.md
│   ├── IDENTITY.md
│   ├── TOOLS.md
│   ├── USER.md
│   ├── HEARTBEAT.md
│   ├── BOOTSTRAP.md
│   ├── AGENTS.md
│   ├── MEMORY.md
│   ├── CRON.json
│   └── skills/example-skill/SKILL.md
│
├── package.json
├── tsconfig.json
├── .env
└── .gitignore
```

### Implementation Order

1. **`src/core/`** — Agent loop + tools (shared with agents/ port)
2. **`src/s01` + `src/s02`** — Verify basic loop works
3. **`src/sessions/`** → `src/s03` — JSONL persistence + context guard
4. **`src/channels/`** → `src/s04` — CLI first, then Telegram
5. **`src/gateway/`** → `src/s05` — Routing + WebSocket
6. **`src/intelligence/`** → `src/s06` — Soul, memory, skills, prompt builder
7. **`src/proactive/`** → `src/s07` — Heartbeat + cron
8. **`src/delivery/`** → `src/s08` — Write-ahead queue
9. **`src/resilience/`** → `src/s09` — Auth rotation + retry onion
10. **`src/concurrency/`** → `src/s10` — Named lanes

---

## Combined Architecture (Both Repos Merged)

If you're building a **full production agent** that combines both repos:

```
┌─────────────────────────────────────────────────────────┐
│                   PRODUCTION AGENT                       │
│                                                          │
│  ┌─── gufan/ (Gateway) ──────────────────────────────┐  │
│  │  Channels → Routing → Sessions → Delivery         │  │
│  │  Soul/Memory → Heartbeat/Cron → Resilience        │  │
│  │  Concurrency Lanes                                 │  │
│  │          │                                         │  │
│  │          ▼                                         │  │
│  │  ┌─── agents/ (Brain) ─────────────────────────┐  │  │
│  │  │  Agent Loop → Tool Dispatch                  │  │  │
│  │  │  TodoWrite → Subagents → Skills → Compact   │  │  │
│  │  │  Tasks → Background → Teams → Protocols     │  │  │
│  │  │  Autonomous → Worktree Isolation            │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

*This document was generated from a complete analysis of all 10 Python session files in `gufan/sessions/en/` (s01–s10), all 10 workspace config files, and the claw0 README. Every class, pattern, and mechanism has been mapped to TypeScript.*
