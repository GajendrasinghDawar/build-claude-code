import { gateway } from "@ai-sdk/gateway";
import { generateText, stepCountIs, type ModelMessage, type ToolSet } from "ai";

export interface AgentLoopResult {
  text: string;
  finishReason: string;
}

export interface AgentLoopOptions {
  modelId: string;
  systemPrompt: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  maxSteps?: number;
}

export async function runAgentLoop({
  modelId,
  systemPrompt,
  messages,
  tools,
  maxSteps = 20,
}: AgentLoopOptions): Promise<AgentLoopResult> {
  const result = await generateText({
    model: gateway(modelId),
    system: systemPrompt,
    messages,
    stopWhen: stepCountIs(maxSteps),
    ...(tools ? { tools } : {}),
  });

  messages.push(...result.response.messages);

  return {
    text: result.text.trim(),
    finishReason: result.finishReason,
  };
}
