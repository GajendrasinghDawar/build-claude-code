export type MatchKey =
  | "peer_id"
  | "guild_id"
  | "account_id"
  | "channel"
  | "default";

export interface Binding {
  agentId: string;
  tier: 1 | 2 | 3 | 4 | 5;
  matchKey: MatchKey;
  matchValue: string;
  priority: number;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export class BindingTable {
  private readonly bindings: Binding[] = [];

  add(binding: Binding): void {
    this.bindings.push({
      ...binding,
      agentId: normalize(binding.agentId),
      matchValue: binding.matchValue.trim(),
      priority: binding.priority ?? 0,
    });
    this.bindings.sort((a, b) => a.tier - b.tier || b.priority - a.priority);
  }

  listAll(): Binding[] {
    return [...this.bindings];
  }

  remove(agentId: string, matchKey: MatchKey, matchValue: string): boolean {
    const before = this.bindings.length;
    const normalizedId = normalize(agentId);
    const normalizedValue = matchValue.trim();

    for (let i = this.bindings.length - 1; i >= 0; i -= 1) {
      const b = this.bindings[i];
      if (
        b.agentId === normalizedId &&
        b.matchKey === matchKey &&
        b.matchValue === normalizedValue
      ) {
        this.bindings.splice(i, 1);
      }
    }

    return this.bindings.length < before;
  }

  resolve(input: {
    channel?: string;
    accountId?: string;
    guildId?: string;
    peerId?: string;
  }): { agentId: string | null; binding: Binding | null } {
    const channel = input.channel ?? "";
    const accountId = input.accountId ?? "";
    const guildId = input.guildId ?? "";
    const peerId = input.peerId ?? "";

    for (const b of this.bindings) {
      if (b.tier === 1 && b.matchKey === "peer_id") {
        if (b.matchValue.includes(":")) {
          if (b.matchValue === `${channel}:${peerId}`) {
            return { agentId: b.agentId, binding: b };
          }
        } else if (b.matchValue === peerId) {
          return { agentId: b.agentId, binding: b };
        }
      }

      if (
        b.tier === 2 &&
        b.matchKey === "guild_id" &&
        b.matchValue === guildId
      ) {
        return { agentId: b.agentId, binding: b };
      }

      if (
        b.tier === 3 &&
        b.matchKey === "account_id" &&
        b.matchValue === accountId
      ) {
        return { agentId: b.agentId, binding: b };
      }

      if (
        b.tier === 4 &&
        b.matchKey === "channel" &&
        b.matchValue === channel
      ) {
        return { agentId: b.agentId, binding: b };
      }

      if (b.tier === 5 && b.matchKey === "default") {
        return { agentId: b.agentId, binding: b };
      }
    }

    return { agentId: null, binding: null };
  }
}

export function bindingDisplay(binding: Binding): string {
  const tierName = {
    1: "peer",
    2: "guild",
    3: "account",
    4: "channel",
    5: "default",
  }[binding.tier];

  return `[${tierName}] ${binding.matchKey}=${binding.matchValue} -> agent:${binding.agentId} (pri=${binding.priority})`;
}
