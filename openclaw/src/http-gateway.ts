import express from "express";
import type { AgentConfig, RuntimeConfig } from "./types.js";
import { resolveAgent } from "./router.js";
import { SessionCommandQueue } from "./queue.js";

export function startHttpGateway(params: {
  config: RuntimeConfig;
  agents: Record<string, AgentConfig>;
  queue: SessionCommandQueue;
  runTurn: (sessionKey: string, text: string, agent: AgentConfig) => Promise<string>;
}): { close: () => Promise<void> } {
  const { config, agents, queue, runTurn } = params;

  const app = express();
  app.use(express.json());

  app.post("/chat", async (req, res) => {
    const sessionId = String(req.body?.session_id ?? "http-user");
    const input = String(req.body?.message ?? "").trim();

    if (!input) {
      res.status(400).json({ error: "message is required" });
      return;
    }

    const { agentId, text } = resolveAgent(input);
    const agent = agents[agentId] ?? agents.main;
    const sessionKey = `${agent.sessionPrefix}:${sessionId}`;

    try {
      const reply = await queue.enqueue(sessionKey, () =>
        runTurn(sessionKey, text, agent),
      );
      res.json({ agent: agent.name, response: reply });
    } catch (error: unknown) {
      res.status(500).json({ error: String(error) });
    }
  });

  const server = app.listen(config.httpPort, () => {
    console.log(`[gateway] HTTP listening on http://127.0.0.1:${config.httpPort}`);
  });

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
