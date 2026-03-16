import type { Channel } from "./channel.js";
import type { ChannelAccount } from "../types.js";

export class ChannelManager {
  private readonly channels = new Map<string, Channel>();
  readonly accounts: ChannelAccount[] = [];

  register(channel: Channel): void {
    this.channels.set(channel.name, channel);
  }

  get(name: string): Channel | undefined {
    return this.channels.get(name);
  }

  listChannels(): string[] {
    return [...this.channels.keys()];
  }

  async closeAll(): Promise<void> {
    for (const channel of this.channels.values()) {
      await channel.close();
    }
  }
}
