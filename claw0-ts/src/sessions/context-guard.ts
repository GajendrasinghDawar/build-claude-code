import { gateway } from "@ai-sdk/gateway";
import { generateText, stepCountIs, type ModelMessage, type ToolSet } from "ai";

function estimateTokensFromMessages(messages: ModelMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

function serializeMessagesForSummary(messages: ModelMessage[]): string {
  const lines: string[] = [];

  for (const msg of messages) {
    const content = (msg as any).content;
    if (typeof content === "string") {
      lines.push(`[${msg.role}] ${content}`);
      continue;
    }

    if (!Array.isArray(content)) continue;

    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      const type = String(p.type ?? "");

      if (type === "text") {
        lines.push(`[${msg.role}] ${String(p.text ?? "")}`);
      } else if (type === "tool-call") {
        lines.push(
          `[${msg.role} tool_call:${String(p.toolName ?? "unknown")}] ${JSON.stringify(p.input ?? {})}`,
        );
      } else if (type === "tool-result") {
        const preview = JSON.stringify(p.result ?? "").slice(0, 600);
        lines.push(`[tool_result] ${preview}`);
      }
    }
  }

  return lines.join("\n");
}

function isOverflowError(error: unknown): boolean {
  const msg = String(error).toLowerCase();
  return (
    msg.includes("context") || msg.includes("token") || msg.includes("overflow")
  );
}

function truncateToolResults(
  messages: ModelMessage[],
  maxChars = 6000,
): ModelMessage[] {
  return messages.map((msg) => {
    if ((msg as any).role !== "tool") return msg;
    const content = (msg as any).content;
    if (!Array.isArray(content)) return msg;

    const next = content.map((part: unknown) => {
      if (!part || typeof part !== "object") return part;
      const p = { ...(part as Record<string, unknown>) };
      if (String(p.type ?? "") !== "tool-result") return p;

      const result = p.result;
      if (typeof result === "string" && result.length > maxChars) {
        p.result = `${result.slice(0, maxChars)}\n[truncated]`;
      }
      return p;
    });

    return { ...(msg as any), content: next } as ModelMessage;
  });
}

export interface GuardedGenerateParams {
  modelId: string;
  systemPrompt: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  maxSteps?: number;
}

export class ContextGuard {
  constructor(private readonly maxTokens = 180_000) {}

  estimateMessagesTokens(messages: ModelMessage[]): number {
    return estimateTokensFromMessages(messages);
  }

  async compactHistory(
    messages: ModelMessage[],
    modelId: string,
  ): Promise<ModelMessage[]> {
    if (messages.length <= 4) return messages;

    const keepCount = Math.max(4, Math.floor(messages.length * 0.2));
    const compressCount = Math.min(
      Math.max(2, Math.floor(messages.length * 0.5)),
      messages.length - keepCount,
    );
    if (compressCount < 2) return messages;

    const oldPart = messages.slice(0, compressCount);
    const recentPart = messages.slice(compressCount);

    const summaryPrompt = [
      "Summarize the following conversation concisely, preserving key facts and decisions.",
      "Output only the summary, no preamble.",
      "",
      serializeMessagesForSummary(oldPart).slice(0, 90_000),
    ].join("\n");

    const summaryResult = await generateText({
      model: gateway(modelId),
      system: "You are a conversation summarizer. Be concise and factual.",
      messages: [{ role: "user", content: summaryPrompt }],
      stopWhen: stepCountIs(1),
    });

    const summary = summaryResult.text.trim() || "(summary unavailable)";

    return [
      { role: "user", content: `[Previous conversation summary]\n${summary}` },
      {
        role: "assistant",
        content: "Understood, I have context from our previous conversation.",
      },
      ...recentPart,
    ];
  }

  async guardGenerate(
    params: GuardedGenerateParams,
  ): Promise<{ result: any; effectiveMessages: ModelMessage[] }> {
    const { modelId, systemPrompt, tools, maxSteps = 30, messages } = params;

    if (this.estimateMessagesTokens(messages) > this.maxTokens) {
      // We still attempt calls below because models may handle some overhead differently,
      // but this is a cheap indicator for /context reporting and future heuristics.
    }

    let activeMessages = messages;

    const run = async (candidate: ModelMessage[]) =>
      generateText({
        model: gateway(modelId),
        system: systemPrompt,
        messages: candidate,
        ...(tools ? { tools } : {}),
        stopWhen: stepCountIs(maxSteps),
      });

    try {
      const result = await run(activeMessages);
      return { result, effectiveMessages: activeMessages };
    } catch (error) {
      if (!isOverflowError(error)) throw error;
    }

    activeMessages = truncateToolResults(activeMessages);
    try {
      const result = await run(activeMessages);
      return { result, effectiveMessages: activeMessages };
    } catch (error) {
      if (!isOverflowError(error)) throw error;
    }

    activeMessages = await this.compactHistory(activeMessages, modelId);
    const result = await run(activeMessages);
    return { result, effectiveMessages: activeMessages };
  }
}
