import type { AgentConfig, RuntimeConfig } from "./types.js";

export function startMorningHeartbeat(params: {
  config: RuntimeConfig;
  mainAgent: AgentConfig;
  runTurn: (sessionKey: string, text: string, agent: AgentConfig) => Promise<string>;
}): () => void {
  const { config, mainAgent, runTurn } = params;
  let lastRunDay = "";

  const timer = setInterval(() => {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const day = now.toISOString().slice(0, 10);

    if (`${hh}:${mm}` !== config.briefingTime) return;
    if (lastRunDay === day) return;

    lastRunDay = day;
    void runTurn(
      "cron:morning-briefing",
      "Good morning. Check today's date and give me a motivational quote.",
      mainAgent,
    ).then((reply) => {
      console.log(`\n[heartbeat] ${reply}\n`);
    });
  }, 30_000);

  return () => clearInterval(timer);
}
