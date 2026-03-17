import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { loadMemoryFile, writeMemoryFile } from "./storage.js";
import type { RuntimeConfig } from "./types.js";

const execAsync = promisify(exec);

const SAFE_COMMANDS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "date",
  "whoami",
  "echo",
  "pwd",
  "which",
  "git",
  "python",
  "node",
  "npm",
]);

interface ApprovalState {
  allowed: string[];
  denied: string[];
}

async function loadApprovals(config: RuntimeConfig): Promise<ApprovalState> {
  try {
    const raw = await import("node:fs/promises").then(({ readFile }) =>
      readFile(config.approvalsPath, "utf-8"),
    );
    const parsed = JSON.parse(raw) as Partial<ApprovalState>;
    return {
      allowed: Array.isArray(parsed.allowed) ? parsed.allowed : [],
      denied: Array.isArray(parsed.denied) ? parsed.denied : [],
    };
  } catch {
    return { allowed: [], denied: [] };
  }
}

async function saveApprovals(
  config: RuntimeConfig,
  approvals: ApprovalState,
): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(config.approvalsPath, JSON.stringify(approvals, null, 2), "utf-8");
}

async function isApprovedCommand(
  config: RuntimeConfig,
  command: string,
): Promise<boolean> {
  const base = command.trim().split(/\s+/)[0] ?? "";
  if (SAFE_COMMANDS.has(base)) return true;

  const approvals = await loadApprovals(config);
  if (approvals.allowed.includes(command)) return true;
  if (approvals.denied.includes(command)) return false;

  // non-safe and non-preapproved commands are denied by default in this minimal port
  approvals.denied.push(command);
  await saveApprovals(config, approvals);
  return false;
}

function safePath(workspaceDir: string, requestedPath: string): string {
  const full = resolve(requestedPath);
  const workspace = resolve(workspaceDir);
  if (!full.startsWith(workspace)) {
    throw new Error(`Path denied outside workspace: ${requestedPath}`);
  }
  return full;
}

export function buildTools(config: RuntimeConfig): ToolSet {
  return {
    run_command: tool({
      description: "Run a shell command with safety checks.",
      inputSchema: z.object({ command: z.string() }),
      execute: async ({ command }) => {
        if (!(await isApprovedCommand(config, command))) {
          return "Permission denied. Command requires explicit approval in approvals file.";
        }

        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd: config.workspaceDir,
            timeout: 30_000,
          });
          const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
          return output || "(no output)";
        } catch (error: unknown) {
          const err = error as { stdout?: string; stderr?: string; message?: string };
          const output = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
          return output || `Error: ${err.message ?? "command failed"}`;
        }
      },
    }),

    read_file: tool({
      description: "Read a UTF-8 file.",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        try {
          const p = safePath(config.workspaceDir, path);
          const { readFile } = await import("node:fs/promises");
          return (await readFile(p, "utf-8")).slice(0, 20_000);
        } catch (error: unknown) {
          return `Error: ${String(error)}`;
        }
      },
    }),

    write_file: tool({
      description: "Write UTF-8 content to file.",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }) => {
        try {
          const p = safePath(config.workspaceDir, path);
          const { mkdir, writeFile } = await import("node:fs/promises");
          const { dirname } = await import("node:path");
          await mkdir(dirname(p), { recursive: true });
          await writeFile(p, content, "utf-8");
          return `Wrote ${content.length} chars to ${p}`;
        } catch (error: unknown) {
          return `Error: ${String(error)}`;
        }
      },
    }),

    save_memory: tool({
      description: "Save long-term memory note.",
      inputSchema: z.object({ key: z.string(), content: z.string() }),
      execute: async ({ key, content }) => {
        await writeMemoryFile(config.memoryDir, key, content);
        return `Saved to memory: ${key}`;
      },
    }),

    memory_search: tool({
      description: "Keyword search over memory markdown files.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const files = (await readdir(config.memoryDir)).filter((f) => f.endsWith(".md"));
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

        const chunks: string[] = [];
        for (const file of files) {
          const key = file.replace(/\.md$/i, "");
          const content = await loadMemoryFile(config.memoryDir, key);
          const lc = content.toLowerCase();
          if (terms.some((t) => lc.includes(t))) {
            chunks.push(`--- ${file} ---\n${content}`);
          }
        }

        return chunks.length ? chunks.join("\n\n") : "No matching memories found.";
      },
    }),

    web_search: tool({
      description: "Web search placeholder. Replace with real provider.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => `Search results placeholder for: ${query}`,
    }),
  };
}
