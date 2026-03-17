import Anthropic from "@anthropic-ai/sdk";
import * as readline from "node:readline";
import { join } from "node:path";
import { ContextGuard } from "./sessions/context-guard.js";
import { SessionStore } from "./sessions/session-store.js";
import { toolReadFile } from "./core/base-tools.js";
import "dotenv/config";

const MODEL_ID = process.env.MODEL_ID ?? "claude-sonnet-4-20250514";
const WORKSPACE_DIR = join(process.cwd(), "workspace");

const SYSTEM_PROMPT = [
  "You are a helpful AI assistant with access to tools.",
  "Use tools for file and time queries.",
  "Be concise. If a session has prior context, use it.",
].join("\n");

const TOOLS: Anthropic.Tool[] = [
  {
    name: "read_file",
    description: "Read the contents of a file under the workspace directory.",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path relative to workspace directory.",
        },
      },
      required: ["file_path"],
    },
  },
  {
    name: "list_directory",
    description: "List files and subdirectories under the workspace directory.",
    input_schema: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description:
            "Path relative to workspace directory. Defaults to root.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_current_time",
    description: "Get the current date and time in UTC.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

async function listDirectory(directory = "."): Promise<string> {
  try {
    const { readdir, stat } = await import("node:fs/promises");
    const { resolve } = await import("node:path");

    const target = resolve(WORKSPACE_DIR, directory);
    if (!target.startsWith(resolve(WORKSPACE_DIR))) {
      return `Error: Path traversal blocked: ${directory}`;
    }

    const entries = await readdir(target);
    const lines: string[] = [];

    for (const name of entries.sort()) {
      const full = resolve(target, name);
      const info = await stat(full);
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

async function processToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<string> {
  if (toolName === "read_file") {
    const path = String(toolInput.file_path ?? "");
    if (!path) return "Error: file_path is required";
    return toolReadFile(join("workspace", path));
  }

  if (toolName === "list_directory") {
    return listDirectory(String(toolInput.directory ?? "."));
  }

  if (toolName === "get_current_time") {
    return getCurrentTime();
  }

  return `Error: Unknown tool '${toolName}'`;
}

function extractAssistantText(response: Anthropic.Message): string {
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

function serializeAssistantContent(response: Anthropic.Message): unknown[] {
  return response.content
    .filter((b) => b.type === "text" || b.type === "tool_use")
    .map((b) => {
      if (b.type === "text") {
        return { type: "text", text: b.text };
      }

      return {
        type: "tool_use",
        id: b.id,
        name: b.name,
        input: b.input,
      };
    });
}

async function runSessionLoop(
  client: Anthropic,
  guard: ContextGuard,
  store: SessionStore,
  messages: Anthropic.MessageParam[],
): Promise<string> {
  while (true) {
    const response = await guard.guardApiCall({
      client,
      model: MODEL_ID,
      system: SYSTEM_PROMPT,
      messages,
      tools: TOOLS,
    });

    messages.push({ role: "assistant", content: response.content });
    store.saveTurn("assistant", serializeAssistantContent(response));

    if (response.stop_reason !== "tool_use") {
      return extractAssistantText(response);
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const result = await processToolCall(
        block.name,
        block.input as Record<string, unknown>,
      );
      store.saveToolResult(
        block.id,
        block.name,
        block.input as Record<string, unknown>,
        result,
      );
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }
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
      `    ${id}${label} msgs=${meta.message_count} last=${meta.last_active.slice(0, 19)}${active}`,
    );
  }
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "Error: ANTHROPIC_API_KEY not set. Copy .env.example to .env.",
    );
    process.exit(1);
  }

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
  });

  const store = new SessionStore(WORKSPACE_DIR, "claw0");
  const guard = new ContextGuard();

  let messages: Anthropic.MessageParam[] = [];
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
  console.log("  claw0  |  Section 03: Sessions & Context Guard");
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
    if (lower === "quit" || lower === "exit") break;

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
      const reply = await runSessionLoop(client, guard, store, messages);
      if (reply) {
        console.log(`\n\x1b[32m\x1b[1mAssistant:\x1b[0m ${reply}\n`);
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
