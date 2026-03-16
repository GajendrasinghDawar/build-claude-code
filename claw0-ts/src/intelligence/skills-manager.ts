import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface SkillMeta {
  name: string;
  description: string;
  invocation: string;
  body: string;
  path: string;
}

const MAX_SKILLS = 150;
const MAX_SKILLS_PROMPT = 30_000;

function parseFrontmatter(text: string): Record<string, string> {
  if (!text.startsWith("---")) return {};
  const parts = text.split("---", 3);
  if (parts.length < 3) return {};

  const meta: Record<string, string> = {};
  for (const line of parts[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) meta[key] = value;
  }
  return meta;
}

export class SkillsManager {
  skills: SkillMeta[] = [];

  constructor(private readonly workspaceDir: string) {}

  private async scanDir(baseDir: string): Promise<SkillMeta[]> {
    const found: SkillMeta[] = [];

    let entries: { name: string; isDirectory: () => boolean }[] = [];
    try {
      entries = await readdir(baseDir, { withFileTypes: true });
    } catch {
      return found;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(baseDir, entry.name);
      const skillPath = join(dir, "SKILL.md");

      let content = "";
      try {
        content = await readFile(skillPath, "utf-8");
      } catch {
        continue;
      }

      const meta = parseFrontmatter(content);
      if (!meta.name) continue;

      const body = content.startsWith("---")
        ? (content.split("---", 3)[2]?.trim() ?? "")
        : "";
      found.push({
        name: meta.name,
        description: meta.description ?? "",
        invocation: meta.invocation ?? "",
        body,
        path: dir,
      });
    }

    return found;
  }

  async discover(extraDirs: string[] = []): Promise<void> {
    const scanOrder = [
      ...extraDirs,
      join(this.workspaceDir, "skills"),
      join(this.workspaceDir, ".skills"),
      join(this.workspaceDir, ".agents", "skills"),
      join(process.cwd(), ".agents", "skills"),
      join(process.cwd(), "skills"),
    ];

    const byName = new Map<string, SkillMeta>();
    for (const dir of scanOrder) {
      const list = await this.scanDir(dir);
      for (const skill of list) {
        byName.set(skill.name, skill);
      }
    }

    this.skills = [...byName.values()].slice(0, MAX_SKILLS);
  }

  formatPromptBlock(): string {
    if (!this.skills.length) return "";

    const lines: string[] = ["## Available Skills", ""];
    let total = 0;

    for (const skill of this.skills) {
      let block = `### Skill: ${skill.name}\nDescription: ${skill.description}\nInvocation: ${skill.invocation}\n`;
      if (skill.body) block += `\n${skill.body}\n`;
      block += "\n";

      if (total + block.length > MAX_SKILLS_PROMPT) {
        lines.push("(... more skills truncated)");
        break;
      }

      lines.push(block);
      total += block.length;
    }

    return lines.join("\n");
  }
}
