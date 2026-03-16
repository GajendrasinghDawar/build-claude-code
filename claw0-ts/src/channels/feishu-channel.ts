import type { ChannelAccount, InboundMessage } from "../types.js";
import type { Channel } from "./channel.js";

interface FeishuTokenResponse {
  code: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

export class FeishuChannel implements Channel {
  readonly name = "feishu";
  private readonly accountId: string;
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly apiBase: string;
  private tenantToken = "";
  private expiresAt = 0;

  constructor(account: ChannelAccount) {
    this.accountId = account.accountId;
    this.appId = String(account.config.app_id ?? "");
    this.appSecret = String(account.config.app_secret ?? "");
    const isLark = Boolean(account.config.is_lark);
    this.apiBase = isLark
      ? "https://open.larksuite.com/open-apis"
      : "https://open.feishu.cn/open-apis";
  }

  async receive(): Promise<InboundMessage | null> {
    return null;
  }

  async parseEvent(
    payload: Record<string, unknown>,
  ): Promise<InboundMessage | null> {
    const event = (payload.event ?? {}) as Record<string, unknown>;
    const message = (event.message ?? {}) as Record<string, unknown>;
    const sender = ((event.sender ?? {}) as Record<string, unknown>)
      .sender_id as Record<string, unknown> | undefined;

    const rawContent = message.content;
    let text = "";
    if (typeof rawContent === "string") {
      try {
        const parsed = JSON.parse(rawContent) as Record<string, unknown>;
        text = String(parsed.text ?? "").trim();
      } catch {
        text = "";
      }
    }
    if (!text) return null;

    const chatType = String(message.chat_type ?? "");
    const userId = String(sender?.open_id ?? sender?.user_id ?? "");
    const chatId = String(message.chat_id ?? "");

    return {
      text,
      senderId: userId,
      channel: "feishu",
      accountId: this.accountId,
      peerId: chatType === "p2p" ? userId : chatId,
      isGroup: chatType === "group",
      media: [],
      raw: payload,
    };
  }

  private async getToken(): Promise<string> {
    if (this.tenantToken && Date.now() < this.expiresAt) {
      return this.tenantToken;
    }

    const response = await fetch(
      `${this.apiBase}/auth/v3/tenant_access_token/internal`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          app_id: this.appId,
          app_secret: this.appSecret,
        }),
      },
    );

    const data = (await response.json()) as FeishuTokenResponse;
    if (data.code !== 0 || !data.tenant_access_token) {
      throw new Error(`Feishu token error: ${data.msg ?? "unknown"}`);
    }

    this.tenantToken = data.tenant_access_token;
    this.expiresAt = Date.now() + ((data.expire ?? 7200) - 300) * 1000;
    return this.tenantToken;
  }

  async send(to: string, text: string): Promise<boolean> {
    const token = await this.getToken();

    const response = await fetch(
      `${this.apiBase}/im/v1/messages?receive_id_type=chat_id`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          receive_id: to,
          msg_type: "text",
          content: JSON.stringify({ text }),
        }),
      },
    );

    const data = (await response.json()) as { code?: number };
    return data.code === 0;
  }

  close(): void {}
}
