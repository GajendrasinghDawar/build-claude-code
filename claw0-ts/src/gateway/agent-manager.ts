import type { ModelMessage } from "ai";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;

export interface AgentConfig {
  id: string;
  name: string;
  personality?: string;
  model?: string;
  dmScope?:
    | "main"
    | "per-peer"
    | "per-channel-peer"
    | "per-account-channel-peer";
}

export function normalizeAgentId(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "main";
  if (VALID_ID_RE.test(trimmed)) return trimmed;
  const cleaned = trimmed
    .replace(INVALID_CHARS_RE, "-")
    .replace(/^-+|-+$/g, "");
  return (cleaned || "main").slice(0, 64);
}

export function buildSessionKey(params: {
  agentId: string;
  channel?: string;
  accountId?: string;
  peerId?: string;
  dmScope?: AgentConfig["dmScope"];
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const channel = (params.channel ?? "unknown").trim().toLowerCase();
  const accountId = (params.accountId ?? "default").trim().toLowerCase();
  const peerId = (params.peerId ?? "").trim().toLowerCase();
  const dmScope = params.dmScope ?? "per-peer";

  if (dmScope === "per-account-channel-peer" && peerId) {
    return `agent:${agentId}:${channel}:${accountId}:direct:${peerId}`;
  }
  if (dmScope === "per-channel-peer" && peerId) {
    return `agent:${agentId}:${channel}:direct:${peerId}`;
  }
  if (dmScope === "per-peer" && peerId) {
    return `agent:${agentId}:direct:${peerId}`;
  }
  return `agent:${agentId}:main`;
}

export class AgentManager {
  private readonly agents = new Map<string, AgentConfig>();
  private readonly sessions = new Map<string, ModelMessage[]>();

  constructor(private readonly workspaceDir: string) {}

  register(config: AgentConfig): AgentConfig {
    const id = normalizeAgentId(config.id);
    const normalized: AgentConfig = {
      ...config,
      id,
      dmScope: config.dmScope ?? "per-peer",
    };

    this.agents.set(id, normalized);

    const agentDir = join(this.workspaceDir, ".agents", id, "sessions");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(this.workspaceDir, `workspace-${id}`), { recursive: true });

    return normalized;
  }

  getAgent(id: string): AgentConfig | undefined {
    return this.agents.get(normalizeAgentId(id));
  }

  listAgents(): AgentConfig[] {
    return [...this.agents.values()];
  }

  getSession(sessionKey: string): ModelMessage[] {
    if (!this.sessions.has(sessionKey)) {
      this.sessions.set(sessionKey, []);
    }
    return this.sessions.get(sessionKey)!;
  }

  listSessions(agentId = ""): Record<string, number> {
    const out: Record<string, number> = {};
    const normalizedAgent = agentId ? normalizeAgentId(agentId) : "";

    for (const [key, messages] of this.sessions.entries()) {
      if (!normalizedAgent || key.startsWith(`agent:${normalizedAgent}:`)) {
        out[key] = messages.length;
      }
    }

    return out;
  }
}
