import { tool, type ModelMessage } from "ai";
import { z } from "zod";
import { join, resolve } from "node:path";
import { readdir, stat } from "node:fs/promises";
import * as readline from "node:readline";
import { toolReadFile } from "./core/base-tools.js";
import { ContextGuard } from "./sessions/context-guard.js";
import { SessionStore } from "./sessions/session-store.js";
import "dotenv/config";

const MODEL_ID = process.env.MODEL_ID ?? "openai/gpt-5.4";
const WORKSPACE_DIR = join(process.cwd(), "workspace");

const SYSTEM_PROMPT = [
  "You are a helpful AI assistant with access to tools.",
  "Use tools for file and time queries.",
  "Be concise. If a session has prior context, use it.",
].join("\n");

function safeWorkspacePath(rawPath: string): string {
  const target = resolve(WORKSPACE_DIR, rawPath);
  const base = resolve(WORKSPACE_DIR);
  if (!target.startsWith(base)) {
    throw new Error(`Path traversal blocked: ${rawPath}`);
  }
  return target;
}

async function listDirectory(directory = "."): Promise<string> {
  try {
    const target = safeWorkspacePath(directory);
    const entries = await readdir(target);
    const lines: string[] = [];

    for (const name of entries.sort()) {
      const info = await stat(resolve(target, name));
      lines.push(`${info.isDirectory() ? "[dir]  " : "[file] "}${name}`);
    }

    return lines.length ? lines.join("\n") : "[empty directory]";
  } catch (error: unknown) {
    const err = error as { message?: string };
    return `Error: ${err.message ?? "list failed"}`;
  }
}

async function getCurrentTime(): Promise<string> {
  return new Date().toISOString().replace("T", " ").replace(".000Z", " UTC");
}

function buildS03Tools() {
  return {
    read_file: tool({
      description: "Read file contents under workspace directory.",
      inputSchema: z.object({ file_path: z.string() }),
      execute: async ({ file_path }) =>
        toolReadFile(join("workspace", file_path)),
    }),
    list_directory: tool({
      description: "List files and subdirectories under workspace directory.",
      inputSchema: z.object({ directory: z.string().optional() }),
      execute: async ({ directory }) => listDirectory(directory ?? "."),
    }),
    get_current_time: tool({
      description: "Get current UTC datetime.",
      inputSchema: z.object({}),
      execute: async () => getCurrentTime(),
    }),
  };
}

function printSessions(store: SessionStore): void {
  const sessions = store.listSessions();
  if (!sessions.length) {
    console.log("  No sessions found.");
    return;
  }

  console.log("  Sessions:");
  for (const [id, meta] of sessions) {
    const active = id === store.currentSessionId ? " <-- current" : "";
    const label = meta.label ? ` (${meta.label})` : "";
    console.log(
      `    ${id}${label}  msgs=${meta.message_count}  last=${meta.last_active.slice(0, 19)}${active}`,
    );
  }
}

function saveToolEventsFromMessages(
  store: SessionStore,
  newMessages: ModelMessage[],
): void {
  for (const msg of newMessages as any[]) {
    if (msg.role !== "tool") continue;
    if (!Array.isArray(msg.content)) continue;

    for (const part of msg.content as any[]) {
      if (!part || part.type !== "tool-result") continue;
      store.saveToolResult(
        String(part.toolCallId ?? "unknown"),
        String(part.toolName ?? "unknown"),
        (part.input ?? {}) as Record<string, unknown>,
        part.result,
      );
    }
  }
}

async function main(): Promise<void> {
  if (!process.env.AI_GATEWAY_API_KEY) {
    console.error(
      "Error: AI_GATEWAY_API_KEY not set. Copy .env.example to .env.",
    );
    process.exit(1);
  }

  const store = new SessionStore(WORKSPACE_DIR, "claw0");
  const guard = new ContextGuard();
  const tools = buildS03Tools();

  let messages: ModelMessage[] = [];
  const existing = store.listSessions();
  if (existing.length) {
    const sid = existing[0][0];
    messages = store.loadSession(sid);
    console.log(`  Resumed session: ${sid} (${messages.length} messages)`);
  } else {
    const sid = store.createSession("initial");
    console.log(`  Created initial session: ${sid}`);
  }

  console.log("=".repeat(60));
  console.log("  claw0-ts  |  Section 03: Sessions & Context Guard");
  console.log(`  Model: ${MODEL_ID}`);
  console.log(`  Session: ${store.currentSessionId}`);
  console.log("  Tools: read_file, list_directory, get_current_time");
  console.log(
    "  Commands: /new [label], /list, /switch <id-prefix>, /context, /help",
  );
  console.log("=".repeat(60));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  while (true) {
    const input = (await ask("\x1b[36m\x1b[1mYou > \x1b[0m")).trim();
    if (!input) continue;

    const lower = input.toLowerCase();
    if (lower === "q" || lower === "quit" || lower === "exit") break;

    if (input.startsWith("/")) {
      const [cmd, arg = ""] = input.split(/\s+/, 2);

      if (cmd === "/new") {
        const sid = store.createSession(arg.trim());
        messages = [];
        console.log(
          `  Created new session: ${sid}${arg ? ` (${arg.trim()})` : ""}`,
        );
        continue;
      }

      if (cmd === "/list") {
        printSessions(store);
        continue;
      }

      if (cmd === "/switch") {
        const prefix = arg.trim();
        if (!prefix) {
          console.log("  Usage: /switch <session_id_prefix>");
          continue;
        }

        const matches = store.matchByPrefix(prefix);
        if (!matches.length) {
          console.log(`  Session not found: ${prefix}`);
          continue;
        }
        if (matches.length > 1) {
          console.log(`  Ambiguous prefix, matches: ${matches.join(", ")}`);
          continue;
        }

        messages = store.loadSession(matches[0]);
        console.log(
          `  Switched to session: ${matches[0]} (${messages.length} messages)`,
        );
        continue;
      }

      if (cmd === "/context") {
        const est = guard.estimateMessagesTokens(messages);
        const pct = (est / 180_000) * 100;
        console.log(
          `  Context usage: ~${est.toLocaleString()} / 180,000 tokens (${pct.toFixed(1)}%)`,
        );
        continue;
      }

      if (cmd === "/help") {
        console.log(
          "  Commands: /new [label], /list, /switch <id-prefix>, /context, /help, quit",
        );
        continue;
      }
    }

    messages.push({ role: "user", content: input });
    store.saveTurn("user", input);

    try {
      const before = messages.length;
      const { result, effectiveMessages } = await guard.guardGenerate({
        modelId: MODEL_ID,
        systemPrompt: SYSTEM_PROMPT,
        messages,
        tools,
        maxSteps: 30,
      });

      if (effectiveMessages !== messages) {
        messages = [...effectiveMessages];
      }

      const newMessages = (result.response?.messages ?? []) as ModelMessage[];
      messages.push(...newMessages);

      for (const msg of newMessages) {
        if (msg.role === "assistant") {
          store.saveTurn("assistant", (msg as any).content);
        }
      }
      saveToolEventsFromMessages(store, newMessages);

      const reply = String(result.text ?? "").trim();
      console.log(
        `\n\x1b[32m\x1b[1mAssistant:\x1b[0m ${reply || `[finish_reason=${result.finishReason}]`}\n`,
      );

      if (before === messages.length) {
        // Guard for unexpected no-message responses from provider adapters.
        messages.push({ role: "assistant", content: reply || "" } as any);
        store.saveTurn("assistant", reply || "");
      }
    } catch (error: unknown) {
      const err = error as { message?: string };
      console.log(`\nAPI Error: ${err.message ?? "unknown"}\n`);
      while (
        messages.length &&
        messages[messages.length - 1]?.role !== "user"
      ) {
        messages.pop();
      }
      if (messages.length) messages.pop();
    }
  }

  rl.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
