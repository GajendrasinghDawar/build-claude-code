import type Anthropic from "@anthropic-ai/sdk";

function serializeForSummary(messages: Anthropic.MessageParam[]): string {
  const lines: string[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      lines.push(`[${msg.role}] ${msg.content}`);
      continue;
    }

    if (!Array.isArray(msg.content)) {
      continue;
    }

    for (const block of msg.content as unknown[]) {
      if (typeof block !== "object" || block == null) {
        continue;
      }

      const data = block as unknown as Record<string, unknown>;
      if (data.type === "text") {
        lines.push(`[${msg.role}] ${String(data.text ?? "")}`);
      } else if (data.type === "tool_use") {
        lines.push(
          `[${msg.role} tool_use:${String(data.name ?? "unknown")}] ${JSON.stringify(data.input ?? {})}`,
        );
      } else if (data.type === "tool_result") {
        lines.push(`[tool_result] ${String(data.content ?? "").slice(0, 500)}`);
      }
    }
  }

  return lines.join("\n");
}

export class ContextGuard {
  constructor(private readonly maxTokens = 180_000) {}

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  estimateMessagesTokens(messages: Anthropic.MessageParam[]): number {
    return this.estimateTokens(JSON.stringify(messages));
  }

  private isOverflowError(error: unknown): boolean {
    const msg = String(error).toLowerCase();
    return (
      msg.includes("context") ||
      msg.includes("token") ||
      msg.includes("overflow")
    );
  }

  private truncateToolResults(
    messages: Anthropic.MessageParam[],
  ): Anthropic.MessageParam[] {
    return messages.map((msg) => {
      if (msg.role !== "user" || !Array.isArray(msg.content)) {
        return msg;
      }

      const mapped = (msg.content as unknown[]).map((part) => {
        if (typeof part !== "object" || part == null) {
          return part;
        }

        const block = { ...(part as unknown as Record<string, unknown>) };
        if (
          block.type === "tool_result" &&
          typeof block.content === "string" &&
          block.content.length > 500
        ) {
          block.content = `${block.content.slice(0, 500)}\n[truncated]`;
        }

        return block;
      });

      return { ...msg, content: mapped as Anthropic.ContentBlockParam[] };
    });
  }

  async compactHistory(
    messages: Anthropic.MessageParam[],
    client: Anthropic,
    model: string,
  ): Promise<Anthropic.MessageParam[]> {
    const half = Math.floor(messages.length / 2);
    const oldPart = messages.slice(0, half);
    const recentPart = messages.slice(half);

    const summaryResp = await client.messages.create({
      model,
      max_tokens: 1500,
      messages: [
        {
          role: "user",
          content: `Summarize this conversation for continuity:\n${serializeForSummary(oldPart).slice(0, 80_000)}`,
        },
      ],
    });

    const summary = summaryResp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    return [
      {
        role: "user",
        content: `[Previous conversation summary]\n${summary || "(summary unavailable)"}`,
      },
      {
        role: "assistant",
        content: "Understood. I have the context. Continuing.",
      },
      ...recentPart,
    ];
  }

  async guardApiCall(params: {
    client: Anthropic;
    model: string;
    system: string;
    messages: Anthropic.MessageParam[];
    tools?: Anthropic.Tool[];
  }): Promise<Anthropic.Message> {
    const { client, model, system, messages, tools } = params;

    try {
      return await client.messages.create({
        model,
        system,
        messages,
        max_tokens: 8096,
        ...(tools?.length ? { tools } : {}),
      });
    } catch (error) {
      if (!this.isOverflowError(error)) {
        throw error;
      }
    }

    const truncated = this.truncateToolResults(messages);
    try {
      const res = await client.messages.create({
        model,
        system,
        messages: truncated,
        max_tokens: 8096,
        ...(tools?.length ? { tools } : {}),
      });
      messages.length = 0;
      messages.push(...truncated);
      return res;
    } catch (error) {
      if (!this.isOverflowError(error)) {
        throw error;
      }
    }

    const compacted = await this.compactHistory(messages, client, model);
    const final = await client.messages.create({
      model,
      system,
      messages: compacted,
      max_tokens: 8096,
      ...(tools?.length ? { tools } : {}),
    });

    messages.length = 0;
    messages.push(...compacted);
    return final;
  }
}
