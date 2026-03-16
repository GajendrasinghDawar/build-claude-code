import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChannelAccount, InboundMessage } from "../types.js";
import type { Channel } from "./channel.js";

const TELEGRAM_API = "https://api.telegram.org";

function chunkText(text: string, max = 4096): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const split = rest.lastIndexOf("\n", max);
    const cut = split > 0 ? split : max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export class TelegramChannel implements Channel {
  readonly name = "telegram";
  private readonly baseUrl: string;
  private readonly accountId: string;
  private readonly allowedChats: Set<string>;
  private readonly offsetPath: string;
  private offset = 0;

  constructor(account: ChannelAccount, stateRoot: string) {
    this.accountId = account.accountId;
    this.baseUrl = `${TELEGRAM_API}/bot${account.token}`;
    this.offsetPath = join(
      stateRoot,
      "telegram",
      `offset-${this.accountId}.txt`,
    );

    const configured = String(account.config.allowed_chats ?? "").trim();
    this.allowedChats = configured
      ? new Set(
          configured
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean),
        )
      : new Set<string>();
  }

  private async loadOffset(): Promise<void> {
    try {
      const raw = await readFile(this.offsetPath, "utf-8");
      this.offset = Number.parseInt(raw.trim(), 10) || 0;
    } catch {
      this.offset = 0;
    }
  }

  private async saveOffset(): Promise<void> {
    await mkdir(join(this.offsetPath, ".."), { recursive: true });
    await writeFile(this.offsetPath, String(this.offset), "utf-8");
  }

  private parseMessage(update: Record<string, unknown>): InboundMessage | null {
    const message = (update.message ?? null) as Record<string, unknown> | null;
    if (!message) return null;

    const chat = (message.chat ?? {}) as Record<string, unknown>;
    const from = (message.from ?? {}) as Record<string, unknown>;
    const text = String(message.text ?? message.caption ?? "").trim();
    if (!text) return null;

    const chatId = String(chat.id ?? "");
    const chatType = String(chat.type ?? "");
    const senderId = String(from.id ?? "");
    const isGroup = chatType === "group" || chatType === "supergroup";

    const inbound: InboundMessage = {
      text,
      senderId,
      channel: "telegram",
      accountId: this.accountId,
      peerId: chatType === "private" ? senderId : chatId,
      isGroup,
      media: [],
      raw: update,
    };

    if (this.allowedChats.size && !this.allowedChats.has(inbound.peerId)) {
      return null;
    }

    return inbound;
  }

  async poll(): Promise<InboundMessage[]> {
    if (this.offset === 0) {
      await this.loadOffset();
    }

    const url = new URL(`${this.baseUrl}/getUpdates`);
    url.searchParams.set("offset", String(this.offset));
    url.searchParams.set("timeout", "1");
    url.searchParams.set("allowed_updates", JSON.stringify(["message"]));

    const response = await fetch(url);
    const data = (await response.json()) as {
      ok?: boolean;
      result?: Array<Record<string, unknown>>;
    };

    if (!data.ok || !Array.isArray(data.result)) return [];

    const parsed: InboundMessage[] = [];
    for (const update of data.result) {
      const id = Number(update.update_id ?? 0);
      if (id >= this.offset) {
        this.offset = id + 1;
      }
      const msg = this.parseMessage(update);
      if (msg) parsed.push(msg);
    }

    await this.saveOffset();
    return parsed;
  }

  async receive(): Promise<InboundMessage | null> {
    const messages = await this.poll();
    return messages[0] ?? null;
  }

  async send(to: string, text: string): Promise<boolean> {
    for (const chunk of chunkText(text)) {
      const response = await fetch(`${this.baseUrl}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: to, text: chunk }),
      });
      const data = (await response.json()) as { ok?: boolean };
      if (!data.ok) return false;
    }
    return true;
  }

  async sendTyping(chatId: string): Promise<void> {
    await fetch(`${this.baseUrl}/sendChatAction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    });
  }

  close(): void {}
}
