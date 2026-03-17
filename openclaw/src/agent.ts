import { gateway } from "@ai-sdk/gateway";
import { generateText, stepCountIs, type ModelMessage } from "ai";
import { buildTools } from "./tools.js";
import { appendSessionMessage, loadSession, saveSession } from "./storage.js";
import type { AgentConfig, RuntimeConfig } from "./types.js";

function estimateTokens(messages: ModelMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

async function compactSessionIfNeeded(
  config: RuntimeConfig,
  agent: AgentConfig,
  sessionKey: string,
  messages: ModelMessage[],
): Promise<ModelMessage[]> {
  if (estimateTokens(messages) < 100_000 || messages.length < 8) {
    return messages;
  }

  const split = Math.floor(messages.length / 2);
  const old = messages.slice(0, split);
  const recent = messages.slice(split);

  const summaryPrompt = [
    "Summarize this conversation concisely.",
    "Preserve: key user facts, important decisions, open tasks.",
    "Output only the summary.",
    JSON.stringify(old),
  ].join("\n\n");

  const summary = await generateText({
    model: gateway(agent.modelId),
    messages: [{ role: "user", content: summaryPrompt }],
    stopWhen: stepCountIs(1),
  });

  const compacted: ModelMessage[] = [
    {
      role: "user",
      content: `[Conversation summary]\n${summary.text.trim()}`,
    },
    ...recent,
  ];

  await saveSession(config.sessionsDir, sessionKey, compacted);
  return compacted;
}

export async function runAgentTurn(params: {
  config: RuntimeConfig;
  agent: AgentConfig;
  sessionKey: string;
  userText: string;
}): Promise<string> {
  const { config, agent, sessionKey, userText } = params;

  let messages = await loadSession(config.sessionsDir, sessionKey);
  messages = await compactSessionIfNeeded(config, agent, sessionKey, messages);

  const userMessage: ModelMessage = { role: "user", content: userText };
  messages.push(userMessage);
  await appendSessionMessage(config.sessionsDir, sessionKey, userMessage);

  const result = await generateText({
    model: gateway(agent.modelId),
    system: agent.soul,
    tools: buildTools(config),
    messages,
    stopWhen: stepCountIs(20),
  });

  const responseMessages = result.response.messages as ModelMessage[];
  for (const msg of responseMessages) {
    messages.push(msg);
    await appendSessionMessage(config.sessionsDir, sessionKey, msg);
  }

  return result.text.trim() || `[finish_reason=${result.finishReason}]`;
}
