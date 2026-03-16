import { mkdir, readFile, readdir, appendFile } from "node:fs/promises";
import { join } from "node:path";

interface Chunk {
  path: string;
  text: string;
}

function tokenize(text: string): string[] {
  const tokens = text.toLowerCase().match(/[a-z0-9\u4e00-\u9fff]+/g) ?? [];
  return tokens.filter((t) => t.length > 1 || /[\u4e00-\u9fff]/.test(t));
}

function cosine(a: Record<string, number>, b: Record<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;

  for (const [k, v] of Object.entries(a)) {
    na += v * v;
    dot += v * (b[k] ?? 0);
  }
  for (const v of Object.values(b)) {
    nb += v * v;
  }

  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function hashVector(text: string, dim = 64): number[] {
  const vec = new Array<number>(dim).fill(0);
  for (const token of tokenize(text)) {
    const h = [...token].reduce(
      (acc, ch) => (acc * 33 + ch.charCodeAt(0)) | 0,
      5381,
    );
    for (let i = 0; i < dim; i += 1) {
      const bit = (h >> (i % 30)) & 1;
      vec[i] += bit ? 1 : -1;
    }
  }

  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
  return vec.map((x) => x / norm);
}

function vectorCosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export class MemoryStore {
  private readonly dailyDir: string;

  constructor(private readonly workspaceDir: string) {
    this.dailyDir = join(workspaceDir, "memory", "daily");
  }

  async writeMemory(content: string, category = "general"): Promise<string> {
    await mkdir(this.dailyDir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const path = join(this.dailyDir, `${day}.jsonl`);
    const entry = {
      ts: new Date().toISOString(),
      category,
      content,
    };

    await appendFile(path, `${JSON.stringify(entry)}\n`, "utf-8");
    return `Memory saved to ${day}.jsonl (${category})`;
  }

  async loadEvergreen(): Promise<string> {
    try {
      return (
        await readFile(join(this.workspaceDir, "MEMORY.md"), "utf-8")
      ).trim();
    } catch {
      return "";
    }
  }

  private async loadAllChunks(): Promise<Chunk[]> {
    const chunks: Chunk[] = [];

    const evergreen = await this.loadEvergreen();
    if (evergreen) {
      for (const para of evergreen.split(/\n\n+/)) {
        const trimmed = para.trim();
        if (trimmed) chunks.push({ path: "MEMORY.md", text: trimmed });
      }
    }

    let files: string[] = [];
    try {
      files = (await readdir(this.dailyDir)).filter((f) =>
        f.endsWith(".jsonl"),
      );
    } catch {
      return chunks;
    }

    for (const file of files.sort()) {
      let raw = "";
      try {
        raw = await readFile(join(this.dailyDir, file), "utf-8");
      } catch {
        continue;
      }

      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed) as {
            content?: string;
            category?: string;
          };
          if (!obj.content) continue;
          const label = obj.category ? `${file} [${obj.category}]` : file;
          chunks.push({ path: label, text: obj.content });
        } catch {
          // ignore broken lines
        }
      }
    }

    return chunks;
  }

  async searchMemory(
    query: string,
    topK = 5,
  ): Promise<Array<{ path: string; score: number; snippet: string }>> {
    const chunks = await this.loadAllChunks();
    if (!chunks.length) return [];

    const tokenizedChunks = chunks.map((c) => tokenize(c.text));
    const queryTokens = tokenize(query);
    if (!queryTokens.length) return [];

    const df: Record<string, number> = {};
    for (const tokens of tokenizedChunks) {
      for (const t of new Set(tokens)) {
        df[t] = (df[t] ?? 0) + 1;
      }
    }

    const n = tokenizedChunks.length;
    const tfidf = (tokens: string[]): Record<string, number> => {
      const tf: Record<string, number> = {};
      for (const t of tokens) tf[t] = (tf[t] ?? 0) + 1;
      const out: Record<string, number> = {};
      for (const [t, c] of Object.entries(tf)) {
        out[t] = c * (Math.log((n + 1) / ((df[t] ?? 0) + 1)) + 1);
      }
      return out;
    };

    const qtfidf = tfidf(queryTokens);
    const qvec = hashVector(query);

    const scored: Array<{ path: string; score: number; snippet: string }> = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const kScore = cosine(qtfidf, tfidf(tokenizedChunks[i]));
      const vScore = vectorCosine(qvec, hashVector(chunks[i].text));
      const score = 0.3 * kScore + 0.7 * Math.max(0, vScore);
      if (score <= 0) continue;

      let snippet = chunks[i].text;
      if (snippet.length > 200) snippet = `${snippet.slice(0, 200)}...`;

      scored.push({
        path: chunks[i].path,
        score: Math.round(score * 10_000) / 10_000,
        snippet,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  async getStats(): Promise<{
    evergreenChars: number;
    dailyFiles: number;
    dailyEntries: number;
  }> {
    const evergreen = await this.loadEvergreen();

    let files: string[] = [];
    try {
      files = (await readdir(this.dailyDir)).filter((f) =>
        f.endsWith(".jsonl"),
      );
    } catch {
      return {
        evergreenChars: evergreen.length,
        dailyFiles: 0,
        dailyEntries: 0,
      };
    }

    let dailyEntries = 0;
    for (const file of files) {
      try {
        const raw = await readFile(join(this.dailyDir, file), "utf-8");
        dailyEntries += raw.split("\n").filter((l) => l.trim()).length;
      } catch {
        // ignore
      }
    }

    return {
      evergreenChars: evergreen.length,
      dailyFiles: files.length,
      dailyEntries,
    };
  }
}
