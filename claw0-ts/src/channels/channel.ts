import type { InboundMessage } from "../types.js";

export interface Channel {
  name: string;
  receive(): Promise<InboundMessage | null>;
  send(
    to: string,
    text: string,
    extra?: Record<string, unknown>,
  ): Promise<boolean>;
  close(): Promise<void> | void;
}

export function buildSessionKey(
  channel: string,
  accountId: string,
  peerId: string,
): string {
  return `agent:main:direct:${channel}:${accountId}:${peerId}`;
}
