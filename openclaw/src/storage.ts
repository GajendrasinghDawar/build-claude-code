import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelMessage } from "ai";

export function sessionPath(sessionsDir: string, sessionKey: string): string {
  const safe = sessionKey.replace(/[:/\\]/g, "_");
  return join(sessionsDir, `${safe}.jsonl`);
}

export async function loadSession(
  sessionsDir: string,
  sessionKey: string,
): Promise<ModelMessage[]> {
  const path = sessionPath(sessionsDir, sessionKey);

  let raw = "";
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return [];
  }

  const out: ModelMessage[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as ModelMessage);
    } catch {
      continue;
    }
  }

  return out;
}

export async function appendSessionMessage(
  sessionsDir: string,
  sessionKey: string,
  message: ModelMessage,
): Promise<void> {
  const path = sessionPath(sessionsDir, sessionKey);
  await appendFile(path, `${JSON.stringify(message)}\n`, "utf-8");
}

export async function saveSession(
  sessionsDir: string,
  sessionKey: string,
  messages: ModelMessage[],
): Promise<void> {
  const path = sessionPath(sessionsDir, sessionKey);
  const payload = messages.map((m) => JSON.stringify(m)).join("\n");
  await writeFile(path, `${payload}\n`, "utf-8");
}

export async function loadMemoryFile(memoryDir: string, key: string): Promise<string> {
  try {
    return await readFile(join(memoryDir, `${key}.md`), "utf-8");
  } catch {
    return "";
  }
}

export async function writeMemoryFile(
  memoryDir: string,
  key: string,
  content: string,
): Promise<void> {
  await writeFile(join(memoryDir, `${key}.md`), content, "utf-8");
}
