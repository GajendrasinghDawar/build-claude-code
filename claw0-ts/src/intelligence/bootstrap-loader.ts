import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const BOOTSTRAP_FILES = [
  "SOUL.md",
  "IDENTITY.md",
  "TOOLS.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
  "AGENTS.md",
  "MEMORY.md",
] as const;

const MAX_FILE_CHARS = 20_000;
const MAX_TOTAL_CHARS = 150_000;

export type BootstrapMode = "full" | "minimal" | "none";

function truncate(content: string, maxChars = MAX_FILE_CHARS): string {
  if (content.length <= maxChars) return content;
  const cut = content.lastIndexOf("\n", maxChars);
  const idx = cut > 0 ? cut : maxChars;
  return `${content.slice(0, idx)}\n\n[... truncated (${content.length} chars total, showing first ${idx}) ...]`;
}

export class BootstrapLoader {
  constructor(private readonly workspaceDir: string) {}

  private async loadFile(name: string): Promise<string> {
    const path = join(this.workspaceDir, name);
    try {
      return await readFile(path, "utf-8");
    } catch {
      return "";
    }
  }

  async loadAll(mode: BootstrapMode = "full"): Promise<Record<string, string>> {
    if (mode === "none") return {};

    const names =
      mode === "minimal" ? ["AGENTS.md", "TOOLS.md"] : [...BOOTSTRAP_FILES];

    const result: Record<string, string> = {};
    let total = 0;

    for (const name of names) {
      const raw = await this.loadFile(name);
      if (!raw) continue;

      let content = truncate(raw);
      if (total + content.length > MAX_TOTAL_CHARS) {
        const remaining = MAX_TOTAL_CHARS - total;
        if (remaining <= 0) break;
        content = truncate(raw, remaining);
      }

      result[name] = content;
      total += content.length;
    }

    return result;
  }
}
