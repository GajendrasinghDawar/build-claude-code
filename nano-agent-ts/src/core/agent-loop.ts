import type Anthropic from "@anthropic-ai/sdk";
import { processToolCall } from "./tool-dispatch.js";

export interface AgentLoopOptions {
  client: Anthropic;
  modelId: string;
  systemPrompt: string;
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  maxTokens?: number;
}

export interface AgentLoopResult {
  text: string;
  stopReason: string | null;
}

function extractText(response: Anthropic.Message): string {
  let text = "";
  for (const block of response.content) {
    if (block.type === "text") text += block.text;
  }
  return text;
}

export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const {
    client,
    modelId,
    systemPrompt,
    messages,
    tools = [],
    maxTokens = 8096,
  } = options;

  while (true) {
    const response = await client.messages.create({
      model: modelId,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
      ...(tools.length ? { tools } : {}),
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      return {
        text: extractText(response),
        stopReason: response.stop_reason,
      };
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const result = await processToolCall(
        block.name,
        block.input as Record<string, unknown>,
      );
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }
}
