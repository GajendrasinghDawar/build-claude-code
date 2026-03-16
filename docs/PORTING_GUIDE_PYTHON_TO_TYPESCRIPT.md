# Porting Guide: Python Nano-Agent → TypeScript/Node.js

> **Purpose:** This document is a complete specification for GitHub Copilot (or any AI assistant) to port the `agents/` directory from Python to TypeScript/Node.js. It covers every session (s01–s12 + s_full), all types, all patterns, and exact 1:1 mappings.

---

## Table of Contents

0. [Preference-Aligned Foundation (Vercel + Turso + Ink)](#0-preference-aligned-foundation-vercel--turso--ink)
1. [Architecture Overview](#1-architecture-overview)
2. [Project Setup & Dependencies](#2-project-setup--dependencies)
3. [TypeScript Types & Interfaces](#3-typescript-types--interfaces)
4. [S01 — The Agent Loop](#4-s01--the-agent-loop)
5. [S02 — Tool Use & Dispatch Map](#5-s02--tool-use--dispatch-map)
6. [S03 — TodoWrite (Planning)](#6-s03--todowrite-planning)
7. [S04 — Subagents](#7-s04--subagents)
8. [S05 — Skill Loading](#8-s05--skill-loading)
9. [S06 — Context Compaction](#9-s06--context-compaction)
10. [S07 — Task System (File-Based)](#10-s07--task-system-file-based)
11. [S08 — Background Tasks](#11-s08--background-tasks)
12. [S09 — Agent Teams](#12-s09--agent-teams)
13. [S10 — Team Protocols](#13-s10--team-protocols)
14. [S11 — Autonomous Agents](#14-s11--autonomous-agents)
15. [S12 — Worktree + Task Isolation](#15-s12--worktree--task-isolation)
16. [S_Full — Capstone Reference](#16-s_full--capstone-reference)
17. [Python → TypeScript Mapping Cheat Sheet](#17-python--typescript-mapping-cheat-sheet)
18. [File Structure for the TypeScript Port](#18-file-structure-for-the-typescript-port)

---

## 0. Preference-Aligned Foundation (Vercel + Turso + Ink)

This chapter overrides defaults to match user preferences for this port.

### Runtime/SDK baseline

- Use **Vercel AI SDK** (`ai` + `@ai-sdk/anthropic`) as the primary LLM integration.
- Prefer `generateText` with explicit tool definitions and `maxSteps` for session chapters s01-s12.
- Keep strong typing through `zod` schemas for each tool's arguments.

### Database baseline

- If persistence beyond flat files is required, use **Turso/libSQL** via `@libsql/client`.
- Keep schema local-first and SQLite-compatible.
- Use env vars:
  - `TURSO_DATABASE_URL`
  - `TURSO_AUTH_TOKEN`

### CLI baseline

- Keep current REPL scripts minimal and deterministic for chapter parity.
- For richer interactive experiences (status panes, streaming, dashboards), use **Ink + React**.

### Node.js / TypeScript baseline

- Use latest Node-compatible TS settings (`module: NodeNext`, `target: ESNext`, strict mode on).
- Prefer native Node modules (`node:fs/promises`, `node:path`, `node:crypto`) and ESM imports.
- Keep files extension-aware for NodeNext (`.js` import suffixes in TS source when required).

### Session mapping under this preference profile

- s01-s02: Vercel AI SDK tools with local filesystem/shell handlers.
- s03+: continue same architecture while preserving behavior parity with Python sessions.
- s07+ (optional): move task persistence from JSON files to Turso if/when cross-process coordination is needed.

---

## 1. Architecture Overview

The entire agent architecture is a **single pattern** repeated across 12 sessions, each adding one mechanism:

```
    User --> messages[] --> LLM --> response
                                      |
                            stop_reason == "tool_use"?
                           /                          \
                         yes                           no
                          |                             |
                    execute tools                    return text
                    append results
                    loop back -----------------> messages[]
```

### Key Principle

The **loop never changes**. Each session adds tools, managers, or pre/post-processing around the same `while(true)` loop.

### Session Dependency Graph

```
s01 (loop) → s02 (tools) → s03 (todo) → s04 (subagent) → s05 (skills)
                                                              ↓
s06 (compact) → s07 (tasks) → s08 (background) → s09 (teams)
                                                       ↓
                                              s10 (protocols) → s11 (autonomous) → s12 (worktree)
```

### Python Libraries → Node.js Equivalents

| Python                      | Node.js/TypeScript                                                           |
| --------------------------- | ---------------------------------------------------------------------------- |
| `anthropic` (Anthropic SDK) | `@anthropic-ai/sdk` **or** Vercel AI SDK (`ai` + `@ai-sdk/anthropic`)        |
| `subprocess.run()`          | `child_process.exec()` / `child_process.execSync()`                          |
| `pathlib.Path`              | `node:path` + `node:fs/promises`                                             |
| `threading.Thread`          | Worker threads (`node:worker_threads`) or simple `Promise`-based concurrency |
| `json`                      | Built-in `JSON`                                                              |
| `dotenv`                    | `dotenv` npm package                                                         |
| `time.time()`               | `Date.now() / 1000`                                                          |
| `uuid.uuid4()`              | `crypto.randomUUID()`                                                        |
| `queue.Queue`               | Array-based queue or `async-queue` pattern                                   |
| `threading.Lock`            | Not needed in single-threaded Node.js (use mutex for worker threads)         |

---

## 2. Project Setup & Dependencies

### Recommended `package.json`

```json
{
  "name": "nano-agent-ts",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "s01": "tsx src/s01_agent_loop.ts",
    "s02": "tsx src/s02_tool_use.ts",
    "s03": "tsx src/s03_todo_write.ts",
    "s04": "tsx src/s04_subagent.ts",
    "s05": "tsx src/s05_skill_loading.ts",
    "s06": "tsx src/s06_context_compact.ts",
    "s07": "tsx src/s07_task_system.ts",
    "s08": "tsx src/s08_background_tasks.ts",
    "s09": "tsx src/s09_agent_teams.ts",
    "s10": "tsx src/s10_team_protocols.ts",
    "s11": "tsx src/s11_autonomous_agents.ts",
    "s12": "tsx src/s12_worktree_task_isolation.ts",
    "full": "tsx src/s_full.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@ai-sdk/anthropic": "^1.2.12",
    "@libsql/client": "^0.15.15",
    "ai": "^4.3.16",
    "dotenv": "^16.6.1",
    "ink": "^5.1.0",
    "react": "^18.3.1",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "@types/node": "^22.13.9",
    "@types/react": "^18.3.12",
    "tsx": "^4.20.3",
    "typescript": "^5.8.2"
  }
}
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "jsx": "react-jsx",
    "resolveJsonModule": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

### `.env` (same as Python version)

```env
ANTHROPIC_API_KEY=sk-ant-...
MODEL_ID=claude-sonnet-4-6
# ANTHROPIC_BASE_URL=https://api.anthropic.com  (optional)
TURSO_DATABASE_URL=libsql://your-db-name.turso.io
TURSO_AUTH_TOKEN=
```

---

## 3. TypeScript Types & Interfaces

These types should live in `src/types.ts` and be shared across all sessions.

```typescript
// src/types.ts

// ─── Anthropic API types ───

/** A text content block from the LLM */
export interface TextBlock {
  type: "text";
  text: string;
}

/** A tool_use content block from the LLM */
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, any>;
}

/** Union of content blocks the LLM can return */
export type ContentBlock = TextBlock | ToolUseBlock;

/** A tool_result block we send back to the LLM */
export interface ToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

/** A text injection block (e.g. nag reminders) */
export interface TextInjection {
  type: "text";
  text: string;
}

/** A message in the conversation history */
export interface Message {
  role: "user" | "assistant";
  content: string | (ToolResult | TextInjection)[] | ContentBlock[];
}

/** Tool definition matching Anthropic's schema */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
}

/** The handler function signature for a tool */
export type ToolHandler = (
  args: Record<string, any>,
) => string | Promise<string>;

/** Tool dispatch map: tool_name → handler function */
export type ToolDispatchMap = Record<string, ToolHandler>;

// ─── Todo types (s03) ───

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
}

// ─── Task types (s07) ───

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface Task {
  id: number;
  subject: string;
  description: string;
  status: TaskStatus;
  owner: string;
  blockedBy: number[];
  blocks: number[];
  worktree?: string;
  created_at?: number;
  updated_at?: number;
}

// ─── Team types (s09) ───

export type MemberStatus = "working" | "idle" | "shutdown";

export interface TeamMember {
  name: string;
  role: string;
  status: MemberStatus;
}

export interface TeamConfig {
  team_name: string;
  members: TeamMember[];
}

export type MessageType =
  | "message"
  | "broadcast"
  | "shutdown_request"
  | "shutdown_response"
  | "plan_approval_response";

export interface InboxMessage {
  type: MessageType;
  from: string;
  content: string;
  timestamp: number;
  request_id?: string;
  approve?: boolean;
  feedback?: string;
  plan?: string;
}

// ─── Background types (s08) ───

export interface BackgroundTask {
  status: "running" | "completed" | "error" | "timeout";
  command: string;
  result: string | null;
}

export interface BackgroundNotification {
  task_id: string;
  status: string;
  command: string;
  result: string;
}

// ─── Worktree types (s12) ───

export type WorktreeStatus = "active" | "kept" | "removed";

export interface WorktreeEntry {
  name: string;
  path: string;
  branch: string;
  task_id: number | null;
  status: WorktreeStatus;
  created_at: number;
  removed_at?: number;
  kept_at?: number;
}

export interface WorktreeIndex {
  worktrees: WorktreeEntry[];
}

// ─── Shutdown/Plan tracking (s10) ───

export interface ShutdownRequest {
  target: string;
  status: "pending" | "approved" | "rejected";
}

export interface PlanRequest {
  from: string;
  plan: string;
  status: "pending" | "approved" | "rejected";
}
```

---

## 4. S01 — The Agent Loop

**Motto:** _"One loop & Bash is all you need"_

**What it does:** The simplest possible agent — one tool (`bash`), one `while(true)` loop.

### Python Source Pattern

```python
def agent_loop(messages: list):
    while True:
        response = client.messages.create(
            model=MODEL, system=SYSTEM, messages=messages,
            tools=TOOLS, max_tokens=8000,
        )
        messages.append({"role": "assistant", "content": response.content})
        if response.stop_reason != "tool_use":
            return
        results = []
        for block in response.content:
            if block.type == "tool_use":
                output = run_bash(block.input["command"])
                results.append({"type": "tool_result", "tool_use_id": block.id, "content": output})
        messages.append({"role": "user", "content": results})
```

### TypeScript Implementation Guide

```typescript
// src/s01_agent_loop.ts
import Anthropic from "@anthropic-ai/sdk";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as readline from "node:readline";
import "dotenv/config";

const execAsync = promisify(exec);

const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
});
const MODEL = process.env.MODEL_ID!;
const WORKDIR = process.cwd();

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use bash to solve tasks. Act, don't explain.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object" as const,
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];

async function runBash(command: string): Promise<string> {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: WORKDIR,
      timeout: 120_000,
    });
    const out = (stdout + stderr).trim();
    return out ? out.slice(0, 50000) : "(no output)";
  } catch (err: any) {
    if (err.killed) return "Error: Timeout (120s)";
    const out = ((err.stdout || "") + (err.stderr || "")).trim();
    return out ? out.slice(0, 50000) : `Error: ${err.message}`;
  }
}

// -- The core pattern: identical to Python, but with await --
async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS,
      max_tokens: 8000,
    });

    // Append assistant turn
    messages.push({ role: "assistant", content: response.content });

    // If the model didn't call a tool, we're done
    if (response.stop_reason !== "tool_use") return;

    // Execute each tool call, collect results
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        console.log(`\x1b[33m$ ${(block.input as any).command}\x1b[0m`);
        const output = await runBash((block.input as any).command);
        console.log(output.slice(0, 200));
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
    }
    messages.push({ role: "user", content: results });
  }
}

// -- REPL --
async function main() {
  const history: Anthropic.MessageParam[] = [];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  while (true) {
    const query = await ask("\x1b[36ms01 >> \x1b[0m");
    if (!query.trim() || ["q", "exit"].includes(query.trim().toLowerCase()))
      break;

    history.push({ role: "user", content: query });
    await agentLoop(history);

    // Print final assistant text
    const last = history[history.length - 1];
    if (Array.isArray(last.content)) {
      for (const block of last.content as any[]) {
        if (block.type === "text") console.log(block.text);
      }
    }
    console.log();
  }
  rl.close();
}

main();
```

### Key Differences from Python

| Python                                               | TypeScript                                             |
| ---------------------------------------------------- | ------------------------------------------------------ |
| `while True:`                                        | `while (true) {`                                       |
| `client.messages.create(...)` synchronous            | `await client.messages.create(...)` async              |
| `subprocess.run(command, shell=True, ...)`           | `execAsync(command, { cwd, timeout })`                 |
| `response.content` is a list of objects with `.type` | Same — `response.content` is `ContentBlock[]`          |
| `block.input["command"]`                             | `(block.input as any).command` (or use type narrowing) |
| `input("prompt")` (blocking)                         | `readline.createInterface` + promise wrapper           |

---

## 5. S02 — Tool Use & Dispatch Map

**Motto:** _"Adding a tool means adding one handler"_

**What it adds:** Three more tools (`read_file`, `write_file`, `edit_file`) + a dispatch map pattern.

### Dispatch Map Pattern

**Python:**

```python
TOOL_HANDLERS = {
    "bash":       lambda **kw: run_bash(kw["command"]),
    "read_file":  lambda **kw: run_read(kw["path"], kw.get("limit")),
    "write_file": lambda **kw: run_write(kw["path"], kw["content"]),
    "edit_file":  lambda **kw: run_edit(kw["path"], kw["old_text"], kw["new_text"]),
}

# In the loop:
handler = TOOL_HANDLERS.get(block.name)
output = handler(**block.input) if handler else f"Unknown tool: {block.name}"
```

**TypeScript:**

```typescript
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";

function safePath(p: string): string {
  const resolved = resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

async function runRead(path: string, limit?: number): Promise<string> {
  try {
    const text = await readFile(safePath(path), "utf-8");
    let lines = text.split("\n");
    if (limit && limit < lines.length) {
      lines = [
        ...lines.slice(0, limit),
        `... (${lines.length - limit} more lines)`,
      ];
    }
    return lines.join("\n").slice(0, 50000);
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}

async function runWrite(path: string, content: string): Promise<string> {
  try {
    const fp = safePath(path);
    await mkdir(dirname(fp), { recursive: true });
    await writeFile(fp, content);
    return `Wrote ${content.length} bytes to ${path}`;
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}

async function runEdit(
  path: string,
  oldText: string,
  newText: string,
): Promise<string> {
  try {
    const fp = safePath(path);
    const content = await readFile(fp, "utf-8");
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${path}`;
    }
    await writeFile(fp, content.replace(oldText, newText));
    return `Edited ${path}`;
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}

// The dispatch map — tool_name → async handler
const TOOL_HANDLERS: Record<
  string,
  (args: Record<string, any>) => Promise<string>
> = {
  bash: (args) => runBash(args.command),
  read_file: (args) => runRead(args.path, args.limit),
  write_file: (args) => runWrite(args.path, args.content),
  edit_file: (args) => runEdit(args.path, args.old_text, args.new_text),
};

// In the loop — note the `await`:
for (const block of response.content) {
  if (block.type === "tool_use") {
    const handler = TOOL_HANDLERS[block.name];
    const output = handler
      ? await handler(block.input as Record<string, any>)
      : `Unknown tool: ${block.name}`;
    results.push({
      type: "tool_result",
      tool_use_id: block.id,
      content: output,
    });
  }
}
```

### Tool Definitions (TOOLS array)

The TOOLS array is identical in structure. TypeScript version:

```typescript
const TOOLS: Anthropic.Tool[] = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object" as const,
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read file contents.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to file.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace exact text in file.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
];
```

---

## 6. S03 — TodoWrite (Planning)

**Motto:** _"An agent without a plan drifts"_

**What it adds:** A `TodoManager` class + a nag reminder system that injects `<reminder>` when the agent hasn't updated its todos in 3 rounds.

### TodoManager Class

```typescript
// src/todo_manager.ts

interface TodoItem {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed";
}

class TodoManager {
  items: TodoItem[] = [];

  update(items: Array<{ id?: string; text: string; status: string }>): string {
    if (items.length > 20) throw new Error("Max 20 todos allowed");

    let inProgressCount = 0;
    const validated: TodoItem[] = [];

    for (let i = 0; i < items.length; i++) {
      const text = (items[i].text || "").trim();
      const status = (
        items[i].status || "pending"
      ).toLowerCase() as TodoItem["status"];
      const id = items[i].id || String(i + 1);

      if (!text) throw new Error(`Item ${id}: text required`);
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Item ${id}: invalid status '${status}'`);
      }
      if (status === "in_progress") inProgressCount++;
      validated.push({ id, text, status });
    }

    if (inProgressCount > 1)
      throw new Error("Only one task can be in_progress at a time");
    this.items = validated;
    return this.render();
  }

  render(): string {
    if (!this.items.length) return "No todos.";
    const markers = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
    const lines = this.items.map(
      (item) => `${markers[item.status]} #${item.id}: ${item.text}`,
    );
    const done = this.items.filter((t) => t.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);
    return lines.join("\n");
  }
}
```

### Nag Reminder Injection

```typescript
// Inside the agent loop:
let roundsSinceTodo = 0;

// After processing tool calls:
let usedTodo = false;
for (const block of response.content) {
  if (block.type === "tool_use") {
    // ... execute tool ...
    if (block.name === "todo") usedTodo = true;
  }
}

roundsSinceTodo = usedTodo ? 0 : roundsSinceTodo + 1;

// Inject nag reminder if needed
if (roundsSinceTodo >= 3) {
  results.unshift({
    type: "text",
    text: "<reminder>Update your todos.</reminder>",
  });
}
messages.push({ role: "user", content: results });
```

---

## 7. S04 — Subagents

**Motto:** _"Break big tasks down; each subtask gets a clean context"_

**What it adds:** A `task` tool that spawns a subagent with `messages = []` (fresh context). The subagent runs the same loop with filtered tools (no `task` tool to prevent recursion), then returns only a summary.

### Key Pattern

```typescript
async function runSubagent(prompt: string): Promise<string> {
  // Fresh context — this is the key insight
  const subMessages: Anthropic.MessageParam[] = [
    { role: "user", content: prompt },
  ];

  const SUBAGENT_SYSTEM = `You are a coding subagent at ${WORKDIR}. Complete the task, then summarize.`;

  // Child gets all tools except "task" (prevents recursive spawning)
  const CHILD_TOOLS = TOOLS.filter((t) => t.name !== "task");

  let response: Anthropic.Message | undefined;

  for (let i = 0; i < 30; i++) {
    // safety limit
    response = await client.messages.create({
      model: MODEL,
      system: SUBAGENT_SYSTEM,
      messages: subMessages,
      tools: CHILD_TOOLS,
      max_tokens: 8000,
    });

    subMessages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") break;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        const output = handler
          ? await handler(block.input as Record<string, any>)
          : `Unknown tool: ${block.name}`;
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: String(output).slice(0, 50000),
        });
      }
    }
    subMessages.push({ role: "user", content: results });
  }

  // Only the final text returns to the parent
  if (!response) return "(subagent failed)";
  const texts = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text);
  return texts.join("") || "(no summary)";
}
```

### Add to dispatch:

```typescript
TOOL_HANDLERS["task"] = (args) => runSubagent(args.prompt);
```

---

## 8. S05 — Skill Loading

**Motto:** _"Load knowledge when you need it, not upfront"_

**What it adds:** Two-layer skill injection:

- **Layer 1:** Skill names/descriptions in the system prompt (~100 tokens each).
- **Layer 2:** Full skill body returned via `tool_result` when the model calls `load_skill`.

### Skill File Format

Skills live in `skills/<name>/SKILL.md` with YAML frontmatter:

```markdown
---
name: pdf
description: Process PDF files with best practices
tags: document
---

Step 1: Install pdf-parse...
Step 2: ...
```

### SkillLoader Class

```typescript
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { globSync } from "node:fs"; // or use a tiny glob lib

class SkillLoader {
  private skills: Map<string, { meta: Record<string, string>; body: string }> =
    new Map();

  constructor(skillsDir: string) {
    if (!existsSync(skillsDir)) return;
    this.loadAll(skillsDir);
  }

  private loadAll(dir: string) {
    // Recursively find SKILL.md files
    const findSkills = (d: string): string[] => {
      const entries = readdirSync(d, { withFileTypes: true });
      let files: string[] = [];
      for (const entry of entries) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) files.push(...findSkills(full));
        else if (entry.name === "SKILL.md") files.push(full);
      }
      return files;
    };

    for (const file of findSkills(dir).sort()) {
      const text = readFileSync(file, "utf-8");
      const { meta, body } = this.parseFrontmatter(text);
      const name = meta.name || basename(dirname(file));
      this.skills.set(name, { meta, body });
    }
  }

  private parseFrontmatter(text: string): {
    meta: Record<string, string>;
    body: string;
  } {
    const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)/);
    if (!match) return { meta: {}, body: text };
    const meta: Record<string, string> = {};
    for (const line of match[1].trim().split("\n")) {
      const idx = line.indexOf(":");
      if (idx !== -1) {
        meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
    return { meta, body: match[2].trim() };
  }

  /** Layer 1: short descriptions for system prompt */
  getDescriptions(): string {
    if (!this.skills.size) return "(no skills available)";
    const lines: string[] = [];
    for (const [name, skill] of this.skills) {
      const desc = skill.meta.description || "No description";
      const tags = skill.meta.tags ? ` [${skill.meta.tags}]` : "";
      lines.push(`  - ${name}: ${desc}${tags}`);
    }
    return lines.join("\n");
  }

  /** Layer 2: full body returned in tool_result */
  getContent(name: string): string {
    const skill = this.skills.get(name);
    if (!skill) {
      return `Error: Unknown skill '${name}'. Available: ${[...this.skills.keys()].join(", ")}`;
    }
    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  }
}
```

### Wire into system prompt:

```typescript
const SKILL_LOADER = new SkillLoader(join(WORKDIR, "skills"));

const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use load_skill to access specialized knowledge before tackling unfamiliar topics.

Skills available:
${SKILL_LOADER.getDescriptions()}`;

// Add to dispatch:
TOOL_HANDLERS["load_skill"] = async (args) =>
  SKILL_LOADER.getContent(args.name);
```

---

## 9. S06 — Context Compaction

**Motto:** _"Context will fill up; you need a way to make room"_

**What it adds:** Three-layer compression pipeline:

1. **micro_compact** (every turn) — Replace old `tool_result` content with `[Previous: used {tool_name}]`
2. **auto_compact** (when tokens > threshold) — Save transcript to disk, LLM-summarize, replace messages
3. **compact tool** (manual) — Model calls `compact` to trigger immediate summarization

### Token Estimation

```typescript
function estimateTokens(messages: Anthropic.MessageParam[]): number {
  return JSON.stringify(messages).length / 4; // ~4 chars per token
}
```

### Layer 1: micro_compact

```typescript
const KEEP_RECENT = 3;

function microCompact(messages: Anthropic.MessageParam[]): void {
  // Collect all tool_result parts across messages
  const toolResults: Array<{ content: any }> = [];

  for (const msg of messages) {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const part of msg.content as any[]) {
        if (part.type === "tool_result") {
          toolResults.push(part);
        }
      }
    }
  }

  if (toolResults.length <= KEEP_RECENT) return;

  // Clear old results (keep last KEEP_RECENT)
  const toClear = toolResults.slice(0, -KEEP_RECENT);
  for (const part of toClear) {
    if (typeof part.content === "string" && part.content.length > 100) {
      part.content = "[Previous: used tool]";
    }
  }
}
```

### Layer 2: auto_compact

```typescript
import { writeFileSync, mkdirSync } from "node:fs";

const TRANSCRIPT_DIR = join(WORKDIR, ".transcripts");
const THRESHOLD = 50000;

async function autoCompact(
  messages: Anthropic.MessageParam[],
): Promise<Anthropic.MessageParam[]> {
  // Save full transcript
  mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const transcriptPath = join(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
  const lines = messages.map((m) => JSON.stringify(m)).join("\n");
  writeFileSync(transcriptPath, lines);

  // Ask LLM to summarize
  const convText = JSON.stringify(messages).slice(0, 80000);
  const response = await client.messages.create({
    model: MODEL,
    messages: [
      {
        role: "user",
        content:
          "Summarize this conversation for continuity. Include: " +
          "1) What was accomplished, 2) Current state, 3) Key decisions. " +
          "Be concise but preserve critical details.\n\n" +
          convText,
      },
    ],
    max_tokens: 2000,
  });

  const summary = (response.content[0] as Anthropic.TextBlock).text;

  return [
    {
      role: "user",
      content: `[Conversation compressed. Transcript: ${transcriptPath}]\n\n${summary}`,
    },
    {
      role: "assistant",
      content: "Understood. I have the context from the summary. Continuing.",
    },
  ];
}
```

### Modified Agent Loop

```typescript
async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    // Layer 1
    microCompact(messages);

    // Layer 2
    if (estimateTokens(messages) > THRESHOLD) {
      console.log("[auto_compact triggered]");
      const compressed = await autoCompact(messages);
      messages.length = 0;
      messages.push(...compressed);
    }

    const response = await client.messages.create({
      /* ... */
    });
    // ... rest of loop ...

    // Layer 3: manual compact
    let manualCompact = false;
    for (const block of response.content) {
      if (block.type === "tool_use" && block.name === "compact") {
        manualCompact = true;
      }
    }
    if (manualCompact) {
      console.log("[manual compact]");
      const compressed = await autoCompact(messages);
      messages.length = 0;
      messages.push(...compressed);
    }
  }
}
```

---

## 10. S07 — Task System (File-Based)

**Motto:** _"Break big goals into small tasks, order them, persist to disk"_

**What it adds:** A `TaskManager` class that persists tasks as JSON files in `.tasks/` with a dependency graph (`blockedBy`/`blocks`).

### TaskManager Class

```typescript
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";

class TaskManager {
  private dir: string;
  private nextId: number;

  constructor(tasksDir: string) {
    this.dir = tasksDir;
    mkdirSync(this.dir, { recursive: true });
    this.nextId = this.maxId() + 1;
  }

  private maxId(): number {
    const files = readdirSync(this.dir).filter(
      (f) => f.startsWith("task_") && f.endsWith(".json"),
    );
    const ids = files.map((f) =>
      parseInt(f.replace("task_", "").replace(".json", "")),
    );
    return ids.length ? Math.max(...ids) : 0;
  }

  private taskPath(id: number): string {
    return join(this.dir, `task_${id}.json`);
  }

  private load(id: number): Task {
    const path = this.taskPath(id);
    if (!existsSync(path)) throw new Error(`Task ${id} not found`);
    return JSON.parse(readFileSync(path, "utf-8"));
  }

  private save(task: Task): void {
    writeFileSync(this.taskPath(task.id), JSON.stringify(task, null, 2));
  }

  create(subject: string, description = ""): string {
    const task: Task = {
      id: this.nextId++,
      subject,
      description,
      status: "pending",
      owner: "",
      blockedBy: [],
      blocks: [],
    };
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  get(id: number): string {
    return JSON.stringify(this.load(id), null, 2);
  }

  update(
    id: number,
    status?: string,
    addBlockedBy?: number[],
    addBlocks?: number[],
  ): string {
    const task = this.load(id);
    if (status) {
      task.status = status as TaskStatus;
      if (status === "completed") this.clearDependency(id);
    }
    if (addBlockedBy) {
      task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
    }
    if (addBlocks) {
      task.blocks = [...new Set([...task.blocks, ...addBlocks])];
      for (const blockedId of addBlocks) {
        try {
          const blocked = this.load(blockedId);
          if (!blocked.blockedBy.includes(id)) {
            blocked.blockedBy.push(id);
            this.save(blocked);
          }
        } catch {}
      }
    }
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  private clearDependency(completedId: number): void {
    const files = readdirSync(this.dir).filter(
      (f) => f.startsWith("task_") && f.endsWith(".json"),
    );
    for (const file of files) {
      const task: Task = JSON.parse(
        readFileSync(join(this.dir, file), "utf-8"),
      );
      if (task.blockedBy.includes(completedId)) {
        task.blockedBy = task.blockedBy.filter((id) => id !== completedId);
        this.save(task);
      }
    }
  }

  listAll(): string {
    const files = readdirSync(this.dir)
      .filter((f) => f.startsWith("task_") && f.endsWith(".json"))
      .sort();
    if (!files.length) return "No tasks.";
    const lines = files.map((f) => {
      const t: Task = JSON.parse(readFileSync(join(this.dir, f), "utf-8"));
      const marker =
        { pending: "[ ]", in_progress: "[>]", completed: "[x]" }[t.status] ||
        "[?]";
      const blocked = t.blockedBy.length
        ? ` (blocked by: ${JSON.stringify(t.blockedBy)})`
        : "";
      return `${marker} #${t.id}: ${t.subject}${blocked}`;
    });
    return lines.join("\n");
  }
}
```

### Tool dispatch additions:

```typescript
const TASKS = new TaskManager(join(WORKDIR, ".tasks"));

TOOL_HANDLERS["task_create"] = async (args) =>
  TASKS.create(args.subject, args.description || "");
TOOL_HANDLERS["task_update"] = async (args) =>
  TASKS.update(args.task_id, args.status, args.addBlockedBy, args.addBlocks);
TOOL_HANDLERS["task_list"] = async () => TASKS.listAll();
TOOL_HANDLERS["task_get"] = async (args) => TASKS.get(args.task_id);
```

---

## 11. S08 — Background Tasks

**Motto:** _"Run slow operations in the background; the agent keeps thinking"_

**What it adds:** A `BackgroundManager` that runs commands concurrently. A notification queue is drained before each LLM call.

### Key Difference from Python

Python uses `threading.Thread`. In Node.js, since `exec` is already async, you can simply use **unresolved Promises** (fire-and-forget with result capture).

```typescript
import { randomUUID } from "node:crypto";

class BackgroundManager {
  private tasks: Map<string, BackgroundTask> = new Map();
  private notifications: BackgroundNotification[] = [];

  run(command: string): string {
    const taskId = randomUUID().slice(0, 8);
    this.tasks.set(taskId, { status: "running", command, result: null });

    // Fire and forget — execAsync returns a Promise that resolves later
    execAsync(command, { cwd: WORKDIR, timeout: 300_000 })
      .then(({ stdout, stderr }) => {
        const output =
          (stdout + stderr).trim().slice(0, 50000) || "(no output)";
        this.tasks.set(taskId, {
          status: "completed",
          command,
          result: output,
        });
        this.notifications.push({
          task_id: taskId,
          status: "completed",
          command: command.slice(0, 80),
          result: output.slice(0, 500),
        });
      })
      .catch((err) => {
        const output = err.killed
          ? "Error: Timeout (300s)"
          : `Error: ${err.message}`;
        this.tasks.set(taskId, { status: "error", command, result: output });
        this.notifications.push({
          task_id: taskId,
          status: "error",
          command: command.slice(0, 80),
          result: output.slice(0, 500),
        });
      });

    return `Background task ${taskId} started: ${command.slice(0, 80)}`;
  }

  check(taskId?: string): string {
    if (taskId) {
      const t = this.tasks.get(taskId);
      if (!t) return `Error: Unknown task ${taskId}`;
      return `[${t.status}] ${t.command.slice(0, 60)}\n${t.result || "(running)"}`;
    }
    const lines: string[] = [];
    for (const [id, t] of this.tasks) {
      lines.push(`${id}: [${t.status}] ${t.command.slice(0, 60)}`);
    }
    return lines.join("\n") || "No background tasks.";
  }

  drainNotifications(): BackgroundNotification[] {
    const notifs = [...this.notifications];
    this.notifications = [];
    return notifs;
  }
}
```

### Inject before LLM call:

```typescript
const notifs = BG.drainNotifications();
if (notifs.length && messages.length) {
  const notifText = notifs
    .map((n) => `[bg:${n.task_id}] ${n.status}: ${n.result}`)
    .join("\n");
  messages.push({
    role: "user",
    content: `<background-results>\n${notifText}\n</background-results>`,
  });
  messages.push({ role: "assistant", content: "Noted background results." });
}
```

---

## 12. S09 — Agent Teams

**Motto:** _"When the task is too big for one, delegate to teammates"_

**What it adds:**

- **Persistent named agents** (vs. disposable subagents from s04)
- **JSONL inbox per teammate** for communication
- **TeammateManager** with config.json

### MessageBus Class

```typescript
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";

class MessageBus {
  private dir: string;

  constructor(inboxDir: string) {
    this.dir = inboxDir;
    mkdirSync(this.dir, { recursive: true });
  }

  send(
    sender: string,
    to: string,
    content: string,
    msgType: MessageType = "message",
    extra?: Record<string, any>,
  ): string {
    const msg: InboxMessage = {
      type: msgType,
      from: sender,
      content,
      timestamp: Date.now() / 1000,
      ...extra,
    };
    appendFileSync(join(this.dir, `${to}.jsonl`), JSON.stringify(msg) + "\n");
    return `Sent ${msgType} to ${to}`;
  }

  readInbox(name: string): InboxMessage[] {
    const path = join(this.dir, `${name}.jsonl`);
    if (!existsSync(path)) return [];
    const text = readFileSync(path, "utf-8").trim();
    if (!text) return [];
    const messages = text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    writeFileSync(path, ""); // drain
    return messages;
  }

  broadcast(sender: string, content: string, teammates: string[]): string {
    let count = 0;
    for (const name of teammates) {
      if (name !== sender) {
        this.send(sender, name, content, "broadcast");
        count++;
      }
    }
    return `Broadcast to ${count} teammates`;
  }
}
```

### TeammateManager (Simplified for Node.js)

Since Node.js is single-threaded, teammate loops run as **concurrent async functions** (not threads). Each teammate's loop is an `async function` invoked without awaiting, running concurrently via the event loop.

```typescript
class TeammateManager {
  private config: TeamConfig;
  private configPath: string;

  constructor(
    private teamDir: string,
    private bus: MessageBus,
  ) {
    mkdirSync(teamDir, { recursive: true });
    this.configPath = join(teamDir, "config.json");
    this.config = this.loadConfig();
  }

  private loadConfig(): TeamConfig {
    if (existsSync(this.configPath)) {
      return JSON.parse(readFileSync(this.configPath, "utf-8"));
    }
    return { team_name: "default", members: [] };
  }

  private saveConfig(): void {
    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  spawn(name: string, role: string, prompt: string): string {
    let member = this.config.members.find((m) => m.name === name);
    if (member) {
      if (!["idle", "shutdown"].includes(member.status)) {
        return `Error: '${name}' is currently ${member.status}`;
      }
      member.status = "working";
      member.role = role;
    } else {
      member = { name, role, status: "working" };
      this.config.members.push(member);
    }
    this.saveConfig();

    // Fire and forget — runs concurrently via event loop
    this.teammateLoop(name, role, prompt).catch(console.error);

    return `Spawned '${name}' (role: ${role})`;
  }

  private async teammateLoop(
    name: string,
    role: string,
    prompt: string,
  ): Promise<void> {
    const sysPrompt = `You are '${name}', role: ${role}, at ${WORKDIR}. Use send_message to communicate.`;
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: prompt },
    ];
    const tools = this.teammateTools();

    for (let i = 0; i < 50; i++) {
      // Check inbox
      const inbox = this.bus.readInbox(name);
      for (const msg of inbox) {
        messages.push({ role: "user", content: JSON.stringify(msg) });
      }

      const response = await client.messages.create({
        model: MODEL,
        system: sysPrompt,
        messages,
        tools,
        max_tokens: 8000,
      });

      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason !== "tool_use") break;

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          const output = await this.execTool(
            name,
            block.name,
            block.input as Record<string, any>,
          );
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: String(output),
          });
        }
      }
      messages.push({ role: "user", content: results });
    }

    // Set status to idle when done
    const member = this.config.members.find((m) => m.name === name);
    if (member && member.status !== "shutdown") {
      member.status = "idle";
      this.saveConfig();
    }
  }

  private async execTool(
    sender: string,
    toolName: string,
    args: Record<string, any>,
  ): Promise<string> {
    switch (toolName) {
      case "bash":
        return runBash(args.command);
      case "read_file":
        return runRead(args.path);
      case "write_file":
        return runWrite(args.path, args.content);
      case "edit_file":
        return runEdit(args.path, args.old_text, args.new_text);
      case "send_message":
        return this.bus.send(
          sender,
          args.to,
          args.content,
          args.msg_type || "message",
        );
      case "read_inbox":
        return JSON.stringify(this.bus.readInbox(sender), null, 2);
      default:
        return `Unknown tool: ${toolName}`;
    }
  }

  private teammateTools(): Anthropic.Tool[] {
    // Base tools + send_message + read_inbox (no spawn_teammate)
    return [
      /* ... same tool defs as s02 + messaging tools ... */
    ];
  }

  listAll(): string {
    if (!this.config.members.length) return "No teammates.";
    const lines = [`Team: ${this.config.team_name}`];
    for (const m of this.config.members) {
      lines.push(`  ${m.name} (${m.role}): ${m.status}`);
    }
    return lines.join("\n");
  }

  memberNames(): string[] {
    return this.config.members.map((m) => m.name);
  }
}
```

---

## 13. S10 — Team Protocols

**Motto:** _"Teammates need shared communication rules"_

**What it adds:** Two FSM protocols using `request_id` correlation:

1. **Shutdown protocol:** Lead sends `shutdown_request` → teammate responds with `shutdown_response`
2. **Plan approval:** Teammate submits plan → lead approves/rejects

### Protocol Handlers

```typescript
const shutdownRequests: Map<string, ShutdownRequest> = new Map();
const planRequests: Map<string, PlanRequest> = new Map();

function handleShutdownRequest(teammate: string): string {
  const reqId = randomUUID().slice(0, 8);
  shutdownRequests.set(reqId, { target: teammate, status: "pending" });
  BUS.send(
    "lead",
    teammate,
    "Please shut down gracefully.",
    "shutdown_request",
    { request_id: reqId },
  );
  return `Shutdown request ${reqId} sent to '${teammate}' (status: pending)`;
}

function handlePlanReview(
  requestId: string,
  approve: boolean,
  feedback = "",
): string {
  const req = planRequests.get(requestId);
  if (!req) return `Error: Unknown plan request_id '${requestId}'`;
  req.status = approve ? "approved" : "rejected";
  BUS.send("lead", req.from, feedback, "plan_approval_response", {
    request_id: requestId,
    approve,
    feedback,
  });
  return `Plan ${req.status} for '${req.from}'`;
}
```

---

## 14. S11 — Autonomous Agents

**Motto:** _"Teammates scan the board and claim tasks themselves"_

**What it adds:**

- **Idle cycle:** After work phase, agent polls every 5s for inbox messages or unclaimed tasks
- **Auto-claim:** Agent scans `.tasks/` for unclaimed pending tasks and claims them
- **Identity re-injection:** After context compression, re-inject agent identity

### Idle Phase Pattern

```typescript
// After work phase breaks (stop_reason !== "tool_use"):
private async idlePhase(name: string, role: string, messages: Anthropic.MessageParam[]): Promise<boolean> {
  this.setStatus(name, "idle");
  const polls = Math.floor(IDLE_TIMEOUT / POLL_INTERVAL);

  for (let i = 0; i < polls; i++) {
    await sleep(POLL_INTERVAL * 1000);

    // Check inbox
    const inbox = this.bus.readInbox(name);
    if (inbox.length) {
      for (const msg of inbox) {
        if (msg.type === "shutdown_request") {
          this.setStatus(name, "shutdown");
          return false; // signal exit
        }
        messages.push({ role: "user", content: JSON.stringify(msg) });
      }
      return true; // resume work
    }

    // Scan task board for unclaimed tasks
    const unclaimed = this.scanUnclaimedTasks();
    if (unclaimed.length) {
      const task = unclaimed[0];
      this.claimTask(task.id, name);

      // Identity re-injection for compressed contexts
      if (messages.length <= 3) {
        messages.unshift(
          { role: "user", content: `<identity>You are '${name}', role: ${role}. Continue your work.</identity>` },
          { role: "assistant", content: `I am ${name}. Continuing.` } as any
        );
      }

      messages.push(
        { role: "user", content: `<auto-claimed>Task #${task.id}: ${task.subject}\n${task.description || ""}</auto-claimed>` },
        { role: "assistant", content: `Claimed task #${task.id}. Working on it.` } as any
      );
      return true; // resume work
    }
  }

  this.setStatus(name, "shutdown");
  return false; // timeout → shutdown
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

---

## 15. S12 — Worktree + Task Isolation

**Motto:** _"Each works in its own directory, no interference"_

**What it adds:**

- **WorktreeManager:** Creates/manages git worktrees linked to tasks
- **EventBus:** Append-only JSONL lifecycle events
- **Task ↔ Worktree binding:** `task.worktree = "auth-refactor"`, `worktree.task_id = 12`

### EventBus

```typescript
class EventBus {
  constructor(private logPath: string) {
    mkdirSync(dirname(logPath), { recursive: true });
    if (!existsSync(logPath)) writeFileSync(logPath, "");
  }

  emit(
    event: string,
    task?: Partial<Task>,
    worktree?: Record<string, any>,
    error?: string,
  ): void {
    const payload = {
      event,
      ts: Date.now() / 1000,
      task: task || {},
      worktree: worktree || {},
      ...(error ? { error } : {}),
    };
    appendFileSync(this.logPath, JSON.stringify(payload) + "\n");
  }

  listRecent(limit = 20): string {
    const lines = readFileSync(this.logPath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean);
    const recent = lines.slice(-Math.min(limit, 200));
    return JSON.stringify(
      recent.map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { event: "parse_error", raw: l };
        }
      }),
      null,
      2,
    );
  }
}
```

### WorktreeManager

```typescript
class WorktreeManager {
  private indexPath: string;
  private gitAvailable: boolean;

  constructor(
    private repoRoot: string,
    private tasks: TaskManager,
    private events: EventBus,
  ) {
    const wtDir = join(repoRoot, ".worktrees");
    mkdirSync(wtDir, { recursive: true });
    this.indexPath = join(wtDir, "index.json");
    if (!existsSync(this.indexPath)) {
      writeFileSync(this.indexPath, JSON.stringify({ worktrees: [] }, null, 2));
    }
    this.gitAvailable = this.isGitRepo();
  }

  private isGitRepo(): boolean {
    try {
      const { status } = require("child_process").spawnSync(
        "git",
        ["rev-parse", "--is-inside-work-tree"],
        { cwd: this.repoRoot, timeout: 10000 },
      );
      return status === 0;
    } catch {
      return false;
    }
  }

  private runGit(args: string[]): string {
    if (!this.gitAvailable) throw new Error("Not in a git repo.");
    const { execSync } = require("child_process");
    return execSync(`git ${args.join(" ")}`, {
      cwd: this.repoRoot,
      timeout: 120_000,
      encoding: "utf-8",
    }).trim();
  }

  async create(
    name: string,
    taskId?: number,
    baseRef = "HEAD",
  ): Promise<string> {
    // Validate name
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(name)) {
      throw new Error("Invalid worktree name");
    }

    const wtPath = join(this.repoRoot, ".worktrees", name);
    const branch = `wt/${name}`;

    this.events.emit(
      "worktree.create.before",
      taskId != null ? { id: taskId } : undefined,
      { name, base_ref: baseRef },
    );

    this.runGit(["worktree", "add", "-b", branch, wtPath, baseRef]);

    const entry: WorktreeEntry = {
      name,
      path: wtPath,
      branch,
      task_id: taskId ?? null,
      status: "active",
      created_at: Date.now() / 1000,
    };

    const index = this.loadIndex();
    index.worktrees.push(entry);
    this.saveIndex(index);

    if (taskId != null) {
      this.tasks.bindWorktree(taskId, name);
    }

    this.events.emit(
      "worktree.create.after",
      taskId != null ? { id: taskId } : undefined,
      { name, path: wtPath, branch, status: "active" },
    );

    return JSON.stringify(entry, null, 2);
  }

  run(name: string, command: string): string {
    const wt = this.find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;

    const { execSync } = require("child_process");
    try {
      return (
        execSync(command, {
          cwd: wt.path,
          timeout: 300_000,
          encoding: "utf-8",
        }).trim() || "(no output)"
      );
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  }

  // ... remove(), keep(), listAll(), status() follow the same pattern
  private loadIndex(): WorktreeIndex {
    return JSON.parse(readFileSync(this.indexPath, "utf-8"));
  }
  private saveIndex(data: WorktreeIndex): void {
    writeFileSync(this.indexPath, JSON.stringify(data, null, 2));
  }
  private find(name: string): WorktreeEntry | undefined {
    return this.loadIndex().worktrees.find((w) => w.name === name);
  }
}
```

---

## 16. S_Full — Capstone Reference

**Motto:** All mechanisms combined.

The `s_full.ts` should combine everything from s01–s11 into a single file. The architecture is:

```
Before each LLM call:
  1. microCompact(messages)          — s06
  2. autoCompact if tokens > 100k   — s06
  3. drain BG notifications         — s08
  4. check lead inbox               — s09

Tool dispatch (22+ tools):
  bash, read_file, write_file, edit_file,     — s02
  TodoWrite,                                  — s03
  task (subagent),                            — s04
  load_skill,                                 — s05
  compress,                                   — s06
  background_run, check_background,           — s08
  task_create, task_get, task_update, task_list, — s07
  spawn_teammate, list_teammates,             — s09
  send_message, read_inbox, broadcast,        — s09
  shutdown_request, plan_approval,            — s10
  idle, claim_task                            — s11

After tool execution:
  - nag reminder if rounds_without_todo >= 3  — s03
  - manual compact if compress tool was called — s06
```

### Recommended File Structure for s_full:

```typescript
// src/s_full.ts
// Import everything from shared modules:
import { runBash, runRead, runWrite, runEdit, safePath } from "./tools/base";
import { TodoManager } from "./managers/todo";
import { SkillLoader } from "./managers/skills";
import { TaskManager } from "./managers/tasks";
import { BackgroundManager } from "./managers/background";
import { MessageBus, TeammateManager } from "./managers/team";
import { microCompact, autoCompact, estimateTokens } from "./compression";
// ... wire everything together ...
```

---

## 17. Python → TypeScript Mapping Cheat Sheet

| Python Pattern                                                                 | TypeScript Equivalent                                |
| ------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `from pathlib import Path`                                                     | `import { join, resolve, dirname } from "node:path"` |
| `Path.cwd()`                                                                   | `process.cwd()`                                      |
| `Path(p).read_text()`                                                          | `await readFile(p, "utf-8")`                         |
| `Path(p).write_text(content)`                                                  | `await writeFile(p, content)`                        |
| `fp.parent.mkdir(parents=True, exist_ok=True)`                                 | `await mkdir(dirname(fp), { recursive: true })`      |
| `path.is_relative_to(WORKDIR)`                                                 | `resolved.startsWith(WORKDIR)`                       |
| `subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=120)` | `await execAsync(cmd, { cwd, timeout: 120_000 })`    |
| `threading.Thread(target=fn, daemon=True).start()`                             | `fn().catch(console.error)` (fire-and-forget async)  |
| `threading.Lock()` / `with lock:`                                              | Not needed in single-threaded Node.js                |
| `queue.Queue()`                                                                | `const queue: T[] = []`                              |
| `json.dumps(obj, indent=2)`                                                    | `JSON.stringify(obj, null, 2)`                       |
| `json.loads(text)`                                                             | `JSON.parse(text)`                                   |
| `time.time()`                                                                  | `Date.now() / 1000`                                  |
| `uuid.uuid4()`                                                                 | `crypto.randomUUID()`                                |
| `os.environ["KEY"]`                                                            | `process.env.KEY!`                                   |
| `os.getenv("KEY")`                                                             | `process.env.KEY`                                    |
| `f"string {var}"`                                                              | `` `string ${var}` ``                                |
| `input("prompt")`                                                              | `readline.createInterface(...)` + promise            |
| `for block in response.content:`                                               | `for (const block of response.content) {`            |
| `if block.type == "tool_use":`                                                 | `if (block.type === "tool_use") {`                   |
| `block.input["command"]`                                                       | `(block.input as any).command`                       |
| `hasattr(block, "text")`                                                       | `block.type === "text"` / `"text" in block`          |
| `isinstance(content, list)`                                                    | `Array.isArray(content)`                             |
| `list[:] = new_list` (in-place replace)                                        | `arr.length = 0; arr.push(...newArr)`                |
| `results.insert(0, item)`                                                      | `results.unshift(item)`                              |
| `"\n".join(lines)`                                                             | `lines.join("\n")`                                   |
| `str[:50000]`                                                                  | `str.slice(0, 50000)`                                |
| `lambda **kw: fn(kw["arg"])`                                                   | `(args) => fn(args.arg)`                             |
| `dict.get(key, default)`                                                       | `map.get(key) ?? default` or `obj[key] ?? default`   |
| `load_dotenv(override=True)`                                                   | `import "dotenv/config"` (at top of file)            |
| `try: ... except Exception as e:`                                              | `try { ... } catch (err: any) {`                     |

---

## 18. File Structure for the TypeScript Port

```
nano-agent-ts/
├── src/
│   ├── types.ts                     # All shared interfaces (Section 3)
│   │
│   ├── tools/
│   │   └── base.ts                  # runBash, runRead, runWrite, runEdit, safePath
│   │
│   ├── managers/
│   │   ├── todo.ts                  # TodoManager (s03)
│   │   ├── skills.ts                # SkillLoader (s05)
│   │   ├── tasks.ts                 # TaskManager (s07)
│   │   ├── background.ts            # BackgroundManager (s08)
│   │   ├── team.ts                  # MessageBus + TeammateManager (s09)
│   │   ├── worktree.ts              # WorktreeManager + EventBus (s12)
│   │   └── compression.ts           # microCompact, autoCompact, estimateTokens (s06)
│   │
│   ├── s01_agent_loop.ts            # Minimal: 1 tool, 1 loop
│   ├── s02_tool_use.ts              # + dispatch map, 4 tools
│   ├── s03_todo_write.ts            # + TodoManager, nag reminder
│   ├── s04_subagent.ts              # + subagent spawning
│   ├── s05_skill_loading.ts         # + SkillLoader, 2-layer injection
│   ├── s06_context_compact.ts       # + 3-layer compression
│   ├── s07_task_system.ts           # + file-based task CRUD
│   ├── s08_background_tasks.ts      # + background execution
│   ├── s09_agent_teams.ts           # + teams + JSONL inboxes
│   ├── s10_team_protocols.ts        # + shutdown + plan approval FSMs
│   ├── s11_autonomous_agents.ts     # + idle cycle + auto-claim
│   ├── s12_worktree_task_isolation.ts # + git worktrees
│   └── s_full.ts                    # Capstone: everything combined
│
├── skills/                          # Skill files (copied from Python repo)
│   ├── pdf/SKILL.md
│   ├── code-review/SKILL.md
│   ├── agent-builder/SKILL.md
│   └── mcp-builder/SKILL.md
│
├── package.json
├── tsconfig.json
├── .env
└── .gitignore
```

---

## Implementation Order (Recommended)

1. **Set up the project** (`package.json`, `tsconfig.json`, `.env`)
2. **`src/types.ts`** — All shared interfaces
3. **`src/tools/base.ts`** — The 4 base tool handlers
4. **`src/s01_agent_loop.ts`** — Get the basic loop working first
5. **`src/s02_tool_use.ts`** — Add dispatch map pattern
6. **`src/s03_todo_write.ts`** — Add TodoManager
7. **Continue sequentially** through s04–s12
8. **`src/s_full.ts`** — Combine everything

### Verification Checklist per Session

- [ ] Agent starts and accepts user input via REPL
- [ ] LLM is called successfully with Anthropic SDK
- [ ] Tools execute and return results
- [ ] Tool results are appended correctly to `messages`
- [ ] Loop continues until `stop_reason !== "tool_use"`
- [ ] Output is printed to console

---

## Alternative: Using Vercel AI SDK

If you prefer the Vercel AI SDK instead of the raw Anthropic SDK, the loop pattern changes:

```typescript
import { generateText, tool } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

const result = await generateText({
  model: anthropic("claude-sonnet-4-6"),
  tools: {
    bash: tool({
      description: "Run a shell command.",
      parameters: z.object({ command: z.string() }),
      execute: async ({ command }) => runBash(command),
    }),
    // ... more tools ...
  },
  maxSteps: 50, // Vercel AI SDK handles the tool loop internally!
  prompt: userQuery,
});
```

**Key difference:** Vercel AI SDK handles the `while(true)` loop internally via `maxSteps`. The Python architecture's explicit loop gives you more control (for nag reminders, compression, inbox draining), so the raw Anthropic SDK is closer to the original design.

---

## See Also

- **[PORTING_GUIDE_GUFAN_CLAW0_TO_TYPESCRIPT.md](./PORTING_GUIDE_GUFAN_CLAW0_TO_TYPESCRIPT.md)** — Companion guide for porting the `gufan/` (claw0) gateway layer: sessions, channels (Telegram/Feishu/WebSocket), routing, soul/memory/skills, heartbeat/cron, delivery queue, resilience (auth rotation + 3-layer retry), and named concurrency lanes. The two guides share s01–s02 as a common foundation. `agents/` = brain. `gufan/` = gateway.

---

_This document was generated from a complete analysis of all 13 Python files in `agents/` (s01–s12 + s_full.py). Every class, function, and pattern has been mapped to its TypeScript equivalent._
