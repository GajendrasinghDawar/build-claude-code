import { exec } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export const WORKDIR = process.cwd();
const OUTPUT_LIMIT = 50_000;

function trimOutput(text: string): string {
  const out = text.trim();
  return out ? out.slice(0, OUTPUT_LIMIT) : "(no output)";
}

export function safePath(pathInput: string): string {
  const resolved = resolve(WORKDIR, pathInput);
  const rel = relative(WORKDIR, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${pathInput}`);
  }
  return resolved;
}

export async function runBash(command: string): Promise<string> {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((pattern) => command.includes(pattern))) {
    return "Error: Dangerous command blocked";
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: WORKDIR,
      timeout: 120_000,
    });
    return trimOutput(stdout + stderr);
  } catch (error: unknown) {
    const err = error as {
      killed?: boolean;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    if (err.killed) {
      return "Error: Timeout (120s)";
    }
    const captured = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    return captured.trim()
      ? trimOutput(captured)
      : `Error: ${err.message ?? "Unknown failure"}`;
  }
}

export async function runRead(
  pathInput: string,
  limit?: number,
): Promise<string> {
  try {
    const text = await readFile(safePath(pathInput), "utf-8");
    let lines = text.split("\n");
    if (typeof limit === "number" && limit > 0 && limit < lines.length) {
      lines = [
        ...lines.slice(0, limit),
        `... (${lines.length - limit} more lines)`,
      ];
    }
    return lines.join("\n").slice(0, OUTPUT_LIMIT);
  } catch (error: unknown) {
    const err = error as { message?: string };
    return `Error: ${err.message ?? "read failed"}`;
  }
}

export async function runWrite(
  pathInput: string,
  content: string,
): Promise<string> {
  try {
    const filePath = safePath(pathInput);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf-8");
    return `Wrote ${content.length} bytes to ${pathInput}`;
  } catch (error: unknown) {
    const err = error as { message?: string };
    return `Error: ${err.message ?? "write failed"}`;
  }
}

export async function runEdit(
  pathInput: string,
  oldText: string,
  newText: string,
): Promise<string> {
  try {
    const filePath = safePath(pathInput);
    const content = await readFile(filePath, "utf-8");
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${pathInput}`;
    }
    await writeFile(filePath, content.replace(oldText, newText), "utf-8");
    return `Edited ${pathInput}`;
  } catch (error: unknown) {
    const err = error as { message?: string };
    return `Error: ${err.message ?? "edit failed"}`;
  }
}
