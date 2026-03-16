import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const BACKOFF_MS = [5_000, 25_000, 120_000, 600_000] as const;
export const MAX_RETRIES = 5;

export interface QueuedDelivery {
  id: string;
  channel: string;
  to: string;
  text: string;
  retry_count: number;
  last_error: string | null;
  enqueued_at: number;
  next_retry_at: number;
}

function randomId(length = 12): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, length);
}

export function computeBackoffMs(retryCount: number): number {
  if (retryCount <= 0) return 0;
  const idx = Math.min(retryCount - 1, BACKOFF_MS.length - 1);
  const base = BACKOFF_MS[idx];
  const jitter =
    Math.floor(Math.random() * (base * 0.4 + 1)) - Math.floor(base * 0.2);
  return Math.max(0, base + jitter);
}

export const CHANNEL_LIMITS: Record<string, number> = {
  telegram: 4096,
  telegram_caption: 1024,
  discord: 2000,
  whatsapp: 4096,
  default: 4096,
};

export function chunkMessage(text: string, channel = "default"): string[] {
  if (!text) return [];
  const limit = CHANNEL_LIMITS[channel] ?? CHANNEL_LIMITS.default;
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  for (const paraRaw of text.split("\n\n")) {
    let para = paraRaw;

    if (
      chunks.length &&
      chunks[chunks.length - 1].length + para.length + 2 <= limit
    ) {
      chunks[chunks.length - 1] += `\n\n${para}`;
      continue;
    }

    while (para.length > limit) {
      chunks.push(para.slice(0, limit));
      para = para.slice(limit);
    }
    if (para) chunks.push(para);
  }

  return chunks.length ? chunks : [text.slice(0, limit)];
}

export class DeliveryQueue {
  readonly queueDir: string;
  readonly failedDir: string;

  constructor(queueDir: string) {
    this.queueDir = queueDir;
    this.failedDir = join(queueDir, "failed");
  }

  private entryPath(id: string): string {
    return join(this.queueDir, `${id}.json`);
  }

  async init(): Promise<void> {
    await mkdir(this.queueDir, { recursive: true });
    await mkdir(this.failedDir, { recursive: true });
  }

  async enqueue(channel: string, to: string, text: string): Promise<string> {
    await this.init();

    const entry: QueuedDelivery = {
      id: randomId(),
      channel,
      to,
      text,
      retry_count: 0,
      last_error: null,
      enqueued_at: Date.now() / 1000,
      next_retry_at: 0,
    };

    await this.writeEntry(entry);
    return entry.id;
  }

  private async writeEntry(entry: QueuedDelivery): Promise<void> {
    const finalPath = this.entryPath(entry.id);
    const tmpPath = join(this.queueDir, `.tmp.${process.pid}.${entry.id}.json`);
    const payload = JSON.stringify(entry, null, 2);

    await writeFile(tmpPath, payload, "utf-8");
    await rename(tmpPath, finalPath);
  }

  private async readEntry(path: string): Promise<QueuedDelivery | null> {
    try {
      const raw = await readFile(path, "utf-8");
      return JSON.parse(raw) as QueuedDelivery;
    } catch {
      return null;
    }
  }

  async ack(id: string): Promise<void> {
    try {
      await rm(this.entryPath(id));
    } catch {
      // ignore missing file
    }
  }

  async fail(id: string, error: string): Promise<void> {
    const path = this.entryPath(id);
    const entry = await this.readEntry(path);
    if (!entry) return;

    entry.retry_count += 1;
    entry.last_error = error;

    if (entry.retry_count >= MAX_RETRIES) {
      await this.moveToFailed(id);
      return;
    }

    const backoffMs = computeBackoffMs(entry.retry_count);
    entry.next_retry_at = Date.now() / 1000 + backoffMs / 1000;
    await this.writeEntry(entry);
  }

  async moveToFailed(id: string): Promise<void> {
    const src = this.entryPath(id);
    const dst = join(this.failedDir, `${id}.json`);
    try {
      await rename(src, dst);
    } catch {
      // ignore missing file
    }
  }

  async loadPending(): Promise<QueuedDelivery[]> {
    await this.init();

    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(this.queueDir)).filter(
      (f) => f.endsWith(".json") && f !== "failed",
    );

    const out: QueuedDelivery[] = [];
    for (const file of files) {
      const entry = await this.readEntry(join(this.queueDir, file));
      if (entry) out.push(entry);
    }

    out.sort((a, b) => a.enqueued_at - b.enqueued_at);
    return out;
  }

  async loadFailed(): Promise<QueuedDelivery[]> {
    await this.init();

    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(this.failedDir)).filter((f) =>
      f.endsWith(".json"),
    );

    const out: QueuedDelivery[] = [];
    for (const file of files) {
      const entry = await this.readEntry(join(this.failedDir, file));
      if (entry) out.push(entry);
    }

    out.sort((a, b) => a.enqueued_at - b.enqueued_at);
    return out;
  }

  async retryFailed(): Promise<number> {
    const failed = await this.loadFailed();
    let moved = 0;

    for (const entry of failed) {
      entry.retry_count = 0;
      entry.last_error = null;
      entry.next_retry_at = 0;
      await this.writeEntry(entry);
      try {
        await rm(join(this.failedDir, `${entry.id}.json`));
      } catch {
        // ignore
      }
      moved += 1;
    }

    return moved;
  }
}
