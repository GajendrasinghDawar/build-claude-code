export interface ToolResultPart {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

export interface SessionRecord {
  type: "user" | "assistant" | "tool_use" | "tool_result";
  content: unknown;
  ts: number;
  tool_use_id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface SessionIndex {
  [sessionId: string]: {
    label: string;
    created_at: string;
    last_active: string;
    message_count: number;
  };
}

export interface InboundMessage {
  text: string;
  senderId: string;
  channel: string;
  accountId: string;
  peerId: string;
  isGroup: boolean;
  media: unknown[];
  raw: Record<string, unknown>;
}

export interface ChannelAccount {
  channel: string;
  accountId: string;
  token: string;
  config: Record<string, unknown>;
}
