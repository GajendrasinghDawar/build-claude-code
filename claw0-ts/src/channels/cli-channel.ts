import type { Channel } from "./channel.js";
import type { InboundMessage } from "../types.js";

export class CLIChannel implements Channel {
  readonly name = "cli";
  readonly accountId = "cli-local";

  async receive(): Promise<InboundMessage | null> {
    return null;
  }

  async send(to: string, text: string): Promise<boolean> {
    const prefix = to && to !== "cli-user" ? `[to:${to}] ` : "";
    console.log(`\n\x1b[32m\x1b[1mAssistant:\x1b[0m ${prefix}${text}\n`);
    return true;
  }

  close(): void {}
}
