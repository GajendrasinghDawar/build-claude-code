import { exec } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const WORKDIR = process.cwd();
const OUTPUT_LIMIT = 50_000;

function truncate(text: string): string {
  return text.length <= OUTPUT_LIMIT
    ? text
    : `${text.slice(0, OUTPUT_LIMIT)}\n... [truncated, ${text.length} total chars]`;
}

function safePath(rawPath: string): string {
  const target = resolve(WORKDIR, rawPath);
  const base = resolve(WORKDIR);
  if (!target.startsWith(base)) {
    throw new Error(`Path traversal blocked: ${rawPath}`);
  }
  return target;
}

export async function toolBash(command: string, timeout = 30): Promise<string> {
  const dangerous = ["rm -rf /", "mkfs", "> /dev/sd", "dd if="];
  if (dangerous.some((pattern) => command.includes(pattern))) {
    return "Error: Dangerous command blocked";
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: WORKDIR,
      timeout: timeout * 1000,
    });
    const out = `${stdout ?? ""}${stderr ?? ""}`.trim();
    return out ? truncate(out) : "(no output)";
  } catch (error: unknown) {
    const err = error as {
      killed?: boolean;
      stdout?: string;
      stderr?: string;
      message?: string;
    };

    if (err.killed) return `Error: Timeout (${timeout}s)`;
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
    return out ? truncate(out) : `Error: ${err.message ?? "command failed"}`;
  }
}

export async function toolReadFile(filePath: string): Promise<string> {
  try {
    const content = await readFile(safePath(filePath), "utf-8");
    return truncate(content);
  } catch (error: unknown) {
    const err = error as { message?: string };
    return `Error: ${err.message ?? "read failed"}`;
  }
}

export async function toolWriteFile(
  filePath: string,
  content: string,
): Promise<string> {
  try {
    const target = safePath(filePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf-8");
    return `Wrote ${content.length} chars to ${filePath}`;
  } catch (error: unknown) {
    const err = error as { message?: string };
    return `Error: ${err.message ?? "write failed"}`;
  }
}

export async function toolEditFile(
  filePath: string,
  oldString: string,
  newString: string,
): Promise<string> {
  try {
    const target = safePath(filePath);
    const content = await readFile(target, "utf-8");
    const count = content.split(oldString).length - 1;

    if (count === 0) {
      return "Error: old_string not found in file. Make sure it matches exactly.";
    }
    if (count > 1) {
      return `Error: old_string found ${count} times. It must be unique.`;
    }

    await writeFile(target, content.replace(oldString, newString), "utf-8");
    return `Edited ${filePath}`;
  } catch (error: unknown) {
    const err = error as { message?: string };
    return `Error: ${err.message ?? "edit failed"}`;
  }
}
