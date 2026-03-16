import { anthropic } from "@ai-sdk/anthropic";
import { generateText, type ModelMessage, stepCountIs } from "ai";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WORKDIR } from "../tools/base.js";

const TRANSCRIPT_DIR = join(WORKDIR, ".transcripts");
const DEFAULT_SUMMARY_LIMIT = 80_000;

export function estimateTokens(messages: ModelMessage[]): number {
  return JSON.stringify(messages).length / 4;
}

export function microCompact(messages: ModelMessage[], keepRecent = 3): void {
  const toolMessageIndexes = messages
    .map((msg, index) => ({ msg, index }))
    .filter(({ msg }) => msg.role === "tool")
    .map(({ index }) => index);

  if (toolMessageIndexes.length <= keepRecent) {
    return;
  }

  const staleIndexes = toolMessageIndexes.slice(0, -keepRecent);
  for (const idx of staleIndexes) {
    const msg = messages[idx] as ModelMessage & { content?: unknown };
    if (typeof msg.content === "string" && msg.content.length > 100) {
      msg.content = "[Previous: used tool]";
      continue;
    }

    if (Array.isArray(msg.content)) {
      msg.content = "[Previous: used tool]";
    }
  }
}

function createTranscript(messages: ModelMessage[]): string {
  mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const transcriptPath = join(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
  const lines = messages.map((msg) => JSON.stringify(msg)).join("\n");
  writeFileSync(transcriptPath, lines, "utf-8");
  return transcriptPath;
}

export async function autoCompact(
  messages: ModelMessage[],
  modelId: string,
  summaryCharacterLimit = DEFAULT_SUMMARY_LIMIT,
): Promise<ModelMessage[]> {
  const transcriptPath = createTranscript(messages);
  const convText = JSON.stringify(messages).slice(0, summaryCharacterLimit);

  const summaryResult = await generateText({
    model: anthropic(modelId),
    stopWhen: stepCountIs(1),
    messages: [
      {
        role: "user",
        content:
          "Summarize this conversation for continuity. Include: " +
          "1) What was accomplished, 2) Current state, 3) Key decisions. " +
          "Be concise but preserve critical details.\n\n" +
          convText,
      },
    ],
  });

  const summary = summaryResult.text.trim();

  return [
    {
      role: "user",
      content: `[Conversation compressed. Transcript: ${transcriptPath}]\n\n${summary}`,
    },
    {
      role: "assistant",
      content: "Understood. I have the context from the summary. Continuing.",
    },
  ];
}
