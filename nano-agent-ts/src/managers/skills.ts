import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

interface SkillRecord {
  meta: Record<string, string>;
  body: string;
}

export class SkillLoader {
  private readonly skills = new Map<string, SkillRecord>();

  constructor(private readonly skillsDir: string) {
    if (existsSync(skillsDir)) {
      this.loadAll(skillsDir);
    }
  }

  private parseFrontmatter(text: string): SkillRecord {
    const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)/);
    if (!match) {
      return { meta: {}, body: text.trim() };
    }

    const meta: Record<string, string> = {};
    for (const line of match[1].trim().split("\n")) {
      const sep = line.indexOf(":");
      if (sep !== -1) {
        meta[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
      }
    }

    return { meta, body: match[2].trim() };
  }

  private findSkillFiles(dirPath: string): string[] {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    const out: string[] = [];

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        out.push(...this.findSkillFiles(fullPath));
      } else if (entry.name === "SKILL.md") {
        out.push(fullPath);
      }
    }

    return out;
  }

  private loadAll(dirPath: string): void {
    for (const filePath of this.findSkillFiles(dirPath).sort()) {
      const parsed = this.parseFrontmatter(readFileSync(filePath, "utf-8"));
      const name = parsed.meta.name || basename(dirname(filePath));
      this.skills.set(name, parsed);
    }
  }

  getDescriptions(): string {
    if (!this.skills.size) {
      return "(no skills available)";
    }

    const lines: string[] = [];
    for (const [name, skill] of this.skills) {
      const description = skill.meta.description || "No description";
      const tags = skill.meta.tags ? ` [${skill.meta.tags}]` : "";
      lines.push(`- ${name}: ${description}${tags}`);
    }

    return lines.join("\n");
  }

  getContent(name: string): string {
    const skill = this.skills.get(name);
    if (!skill) {
      return `Error: Unknown skill '${name}'. Available: ${[...this.skills.keys()].join(", ")}`;
    }

    return `<skill name=\"${name}\">\n${skill.body}\n</skill>`;
  }
}
