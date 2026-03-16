import { anthropic } from "@ai-sdk/anthropic";
import { generateText, tool, type ModelMessage, stepCountIs } from "ai";
import { join } from "node:path";
import * as readline from "node:readline";
import { SkillLoader } from "./managers/skills.js";
import { runBash, runEdit, runRead, runWrite, WORKDIR } from "./tools/base.js";
import { z } from "zod";
import "dotenv/config";

const MODEL = process.env.MODEL_ID ?? "claude-sonnet-4-6";
const SKILL_LOADER = new SkillLoader(join(WORKDIR, "skills"));

const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use load_skill before solving unfamiliar domains.

Skills available:
${SKILL_LOADER.getDescriptions()}`;

async function agentLoop(messages: ModelMessage[]): Promise<string> {
  const result = await generateText({
    model: anthropic(MODEL),
    system: SYSTEM,
    messages,
    stopWhen: stepCountIs(50),
    tools: {
      bash: tool({
        description: "Run a shell command.",
        inputSchema: z.object({ command: z.string() }),
        execute: async ({ command }) => runBash(command),
      }),
      read_file: tool({
        description: "Read file contents.",
        inputSchema: z.object({
          path: z.string(),
          limit: z.number().int().positive().optional(),
        }),
        execute: async ({ path, limit }) => runRead(path, limit),
      }),
      write_file: tool({
        description: "Write content to file.",
        inputSchema: z.object({ path: z.string(), content: z.string() }),
        execute: async ({ path, content }) => runWrite(path, content),
      }),
      edit_file: tool({
        description: "Replace exact text in file.",
        inputSchema: z.object({
          path: z.string(),
          old_text: z.string(),
          new_text: z.string(),
        }),
        execute: async ({ path, old_text, new_text }) =>
          runEdit(path, old_text, new_text),
      }),
      load_skill: tool({
        description: "Load full content of a specific skill.",
        inputSchema: z.object({ name: z.string() }),
        execute: async ({ name }) => SKILL_LOADER.getContent(name),
      }),
    },
  });

  messages.push(...result.response.messages);
  return result.text.trim();
}

async function main(): Promise<void> {
  const history: ModelMessage[] = [];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  while (true) {
    const query = await ask("\x1b[36ms05 >> \x1b[0m");
    const normalized = query.trim().toLowerCase();
    if (!query.trim() || normalized === "q" || normalized === "exit") {
      break;
    }

    history.push({ role: "user", content: query });
    const finalText = await agentLoop(history);
    if (finalText) {
      console.log(finalText);
    }
    console.log();
  }

  rl.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
