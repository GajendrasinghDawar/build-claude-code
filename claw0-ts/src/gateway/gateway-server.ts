import { WebSocketServer, type WebSocket } from "ws";
import type { ToolSet } from "ai";
import { runAgentLoop } from "../core/agent-loop.js";
import {
  AgentManager,
  buildSessionKey,
  normalizeAgentId,
} from "./agent-manager.js";
import {
  BindingTable,
  bindingDisplay,
  type Binding,
  type MatchKey,
} from "./routing-table.js";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export class GatewayServer {
  private readonly clients = new Set<WebSocket>();
  private readonly startedAt = Date.now();
  private server: WebSocketServer | null = null;

  constructor(
    private readonly manager: AgentManager,
    private readonly bindings: BindingTable,
    private readonly modelId: string,
    private readonly buildTools: () => ToolSet,
    private readonly systemPromptFor: (agentId: string) => string,
  ) {}

  isRunning(): boolean {
    return this.server !== null;
  }

  async start(port = 8765, host = "127.0.0.1"): Promise<void> {
    if (this.server) return;

    this.server = new WebSocketServer({ port, host });

    this.server.on("connection", (ws) => {
      this.clients.add(ws);
      ws.on("message", async (raw) => {
        const reply = await this.dispatchRaw(String(raw));
        if (reply) ws.send(JSON.stringify(reply));
      });
      ws.on("close", () => this.clients.delete(ws));
      ws.on("error", () => this.clients.delete(ws));
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    for (const ws of this.clients) {
      try {
        ws.close();
      } catch {
        // ignore close failures
      }
    }
    this.clients.clear();

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private notifyTyping(agentId: string, typing: boolean): void {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method: "typing",
      params: { agent_id: agentId, typing },
    });

    for (const ws of [...this.clients]) {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
      }
    }
  }

  private async runRoutedTurn(params: {
    text: string;
    channel: string;
    peerId: string;
    accountId?: string;
    guildId?: string;
    forceAgentId?: string;
  }): Promise<{ agentId: string; sessionKey: string; reply: string }> {
    const channel = params.channel;
    const peerId = params.peerId;
    const accountId = params.accountId ?? "";
    const guildId = params.guildId ?? "";

    let agentId = "";
    if (params.forceAgentId) {
      agentId = normalizeAgentId(params.forceAgentId);
    } else {
      const resolved = this.bindings.resolve({
        channel,
        accountId,
        guildId,
        peerId,
      });
      agentId = resolved.agentId ?? "main";
    }

    const agent = this.manager.getAgent(agentId);
    const dmScope = agent?.dmScope ?? "per-peer";
    const sessionKey = buildSessionKey({
      agentId,
      channel,
      accountId,
      peerId,
      dmScope,
    });

    const messages = this.manager.getSession(sessionKey);
    messages.push({ role: "user", content: params.text });

    this.notifyTyping(agentId, true);
    let loopResult: Awaited<ReturnType<typeof runAgentLoop>>;
    try {
      loopResult = await runAgentLoop({
        modelId: this.modelId,
        systemPrompt: this.systemPromptFor(agentId),
        messages,
        tools: this.buildTools(),
        maxSteps: 30,
      });
    } finally {
      this.notifyTyping(agentId, false);
    }

    return {
      agentId,
      sessionKey,
      reply: loopResult.text || `[finish_reason=${loopResult.finishReason}]`,
    };
  }

  private async dispatchRaw(
    raw: string,
  ): Promise<Record<string, unknown> | null> {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(raw) as JsonRpcRequest;
    } catch {
      return {
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
        id: null,
      };
    }

    const id = request.id ?? null;
    const method = request.method ?? "";
    const params = request.params ?? {};

    try {
      if (method === "send") {
        const text = String(params.text ?? "").trim();
        if (!text) throw new Error("text is required");

        const result = await this.runRoutedTurn({
          text,
          channel: String(params.channel ?? "websocket"),
          peerId: String(params.peer_id ?? "ws-client"),
          accountId: String(params.account_id ?? ""),
          guildId: String(params.guild_id ?? ""),
          forceAgentId: params.agent_id ? String(params.agent_id) : undefined,
        });

        return { jsonrpc: "2.0", result, id };
      }

      if (method === "bindings.set") {
        const binding: Binding = {
          agentId: normalizeAgentId(String(params.agent_id ?? "main")),
          tier: Number(params.tier ?? 5) as Binding["tier"],
          matchKey: String(params.match_key ?? "default") as MatchKey,
          matchValue: String(params.match_value ?? "*"),
          priority: Number(params.priority ?? 0),
        };
        this.bindings.add(binding);
        return {
          jsonrpc: "2.0",
          result: { ok: true, binding: bindingDisplay(binding) },
          id,
        };
      }

      if (method === "bindings.list") {
        return {
          jsonrpc: "2.0",
          result: this.bindings.listAll(),
          id,
        };
      }

      if (method === "agents.list") {
        return {
          jsonrpc: "2.0",
          result: this.manager.listAgents(),
          id,
        };
      }

      if (method === "sessions.list") {
        return {
          jsonrpc: "2.0",
          result: this.manager.listSessions(String(params.agent_id ?? "")),
          id,
        };
      }

      if (method === "status") {
        return {
          jsonrpc: "2.0",
          result: {
            running: this.isRunning(),
            uptime_seconds:
              Math.round((Date.now() - this.startedAt) / 100) / 10,
            connected_clients: this.clients.size,
            agent_count: this.manager.listAgents().length,
            binding_count: this.bindings.listAll().length,
          },
          id,
        };
      }

      return {
        jsonrpc: "2.0",
        error: { code: -32601, message: `Unknown method: ${method}` },
        id,
      };
    } catch (error: unknown) {
      const err = error as { message?: string };
      return {
        jsonrpc: "2.0",
        error: { code: -32000, message: err.message ?? "Internal error" },
        id,
      };
    }
  }
}
