import * as readline from "node:readline";
import { join } from "node:path";
import { tool, type ModelMessage } from "ai";
import { z } from "zod";
import { runAgentLoop } from "./core/agent-loop.js";
import { BootstrapLoader } from "./intelligence/bootstrap-loader.js";
import { SkillsManager } from "./intelligence/skills-manager.js";
import { MemoryStore } from "./intelligence/memory-store.js";
import "dotenv/config";

const MODEL_ID = process.env.MODEL_ID ?? "openai/gpt-5.4";
const WORKSPACE_DIR = join(process.cwd(), "workspace");

const memoryStore = new MemoryStore(WORKSPACE_DIR);

function formatSearchResults(
  results: Array<{ path: string; score: number; snippet: string }>,
): string {
  if (!results.length) return "No relevant memories found.";
  return results
    .map((r) => `[${r.path}] (score: ${r.score}) ${r.snippet}`)
    .join("\n");
}

function buildTools() {
  return {
    memory_write: tool({
      description: "Save an important fact or observation to long-term memory.",
      inputSchema: z.object({
        content: z.string(),
        category: z.string().optional(),
      }),
      execute: async ({ content, category }) =>
        memoryStore.writeMemory(content, category ?? "general"),
    }),
    memory_search: tool({
      description: "Search stored memories for relevant information.",
      inputSchema: z.object({
        query: z.string(),
        top_k: z.number().int().positive().optional(),
      }),
      execute: async ({ query, top_k }) =>
        formatSearchResults(await memoryStore.searchMemory(query, top_k ?? 5)),
    }),
  };
}

function buildSystemPrompt(params: {
  bootstrap: Record<string, string>;
  skillsBlock: string;
  memoryContext: string;
  mode?: "full" | "minimal" | "none";
  agentId?: string;
  channel?: string;
}): string {
  const {
    bootstrap,
    skillsBlock,
    memoryContext,
    mode = "full",
    agentId = "main",
    channel = "terminal",
  } = params;

  const sections: string[] = [];

  const identity = bootstrap["IDENTITY.md"]?.trim();
  sections.push(identity || "You are a helpful personal AI assistant.");

  if (mode === "full" && bootstrap["SOUL.md"]?.trim()) {
    sections.push(`## Personality\n\n${bootstrap["SOUL.md"].trim()}`);
  }

  if (bootstrap["TOOLS.md"]?.trim()) {
    sections.push(
      `## Tool Usage Guidelines\n\n${bootstrap["TOOLS.md"].trim()}`,
    );
  }

  if (mode === "full" && skillsBlock.trim()) {
    sections.push(skillsBlock);
  }

  if (mode === "full") {
    const memoryParts: string[] = [];
    if (bootstrap["MEMORY.md"]?.trim()) {
      memoryParts.push(
        `### Evergreen Memory\n\n${bootstrap["MEMORY.md"].trim()}`,
      );
    }
    if (memoryContext.trim()) {
      memoryParts.push(
        `### Recalled Memories (auto-searched)\n\n${memoryContext}`,
      );
    }

    if (memoryParts.length) {
      sections.push(`## Memory\n\n${memoryParts.join("\n\n")}`);
    }

    sections.push(
      [
        "## Memory Instructions",
        "",
        "- Use memory_write to save important user facts and preferences.",
        "- Reference remembered facts naturally in conversation.",
        "- Use memory_search to recall specific past information.",
      ].join("\n"),
    );
  }

  if (mode === "full" || mode === "minimal") {
    for (const name of [
      "HEARTBEAT.md",
      "BOOTSTRAP.md",
      "AGENTS.md",
      "USER.md",
    ]) {
      const content = bootstrap[name]?.trim();
      if (content) {
        sections.push(`## ${name.replace(".md", "")}\n\n${content}`);
      }
    }
  }

  sections.push(
    [
      "## Runtime Context",
      "",
      `- Agent ID: ${agentId}`,
      `- Model: ${MODEL_ID}`,
      `- Channel: ${channel}`,
      `- Current time: ${new Date().toISOString().replace("T", " ").replace(".000Z", " UTC")}`,
      `- Prompt mode: ${mode}`,
    ].join("\n"),
  );

  const hints: Record<string, string> = {
    terminal: "You are responding via a terminal REPL. Markdown is supported.",
    telegram: "You are responding via Telegram. Keep messages concise.",
    discord:
      "You are responding via Discord. Keep messages under 2000 characters.",
    slack: "You are responding via Slack. Use Slack mrkdwn formatting.",
  };

  sections.push(
    `## Channel\n\n${hints[channel] ?? `You are responding via ${channel}.`}`,
  );

  return sections.join("\n\n");
}

async function autoRecall(userMessage: string): Promise<string> {
  const results = await memoryStore.searchMemory(userMessage, 3);
  if (!results.length) return "";
  return results.map((r) => `- [${r.path}] ${r.snippet}`).join("\n");
}

async function main(): Promise<void> {
  if (!process.env.AI_GATEWAY_API_KEY) {
    console.error(
      "Error: AI_GATEWAY_API_KEY not set. Copy .env.example to .env.",
    );
    process.exit(1);
  }

  const loader = new BootstrapLoader(WORKSPACE_DIR);
  const bootstrap = await loader.loadAll("full");

  const skills = new SkillsManager(WORKSPACE_DIR);
  await skills.discover();
  const skillsBlock = skills.formatPromptBlock();

  const stats = await memoryStore.getStats();
  const tools = buildTools();
  const messages: ModelMessage[] = [];

  console.log("=".repeat(60));
  console.log("  claw0-ts  |  Section 06: Intelligence");
  console.log(`  Model: ${MODEL_ID}`);
  console.log(`  Workspace: ${WORKSPACE_DIR}`);
  console.log(`  Bootstrap files: ${Object.keys(bootstrap).length}`);
  console.log(`  Skills discovered: ${skills.skills.length}`);
  console.log(
    `  Memory: evergreen ${stats.evergreenChars}ch, ${stats.dailyFiles} daily files, ${stats.dailyEntries} entries`,
  );
  console.log(
    "  Commands: /soul /skills /memory /search <q> /prompt /bootstrap",
  );
  console.log("=".repeat(60));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  try {
    while (true) {
      let rawInput = "";
      try {
        rawInput = await ask("\x1b[36m\x1b[1mYou > \x1b[0m");
      } catch {
        break;
      }

      const input = rawInput.trim();
      if (!input) continue;

      const lower = input.toLowerCase();
      if (["q", "quit", "exit"].includes(lower)) break;

      if (input.startsWith("/")) {
        const [cmd, ...rest] = input.split(/\s+/);
        const arg = rest.join(" ").trim();

        if (cmd === "/soul") {
          console.log("\n--- SOUL.md ---");
          console.log(bootstrap["SOUL.md"]?.trim() || "(No SOUL.md found)");
          continue;
        }

        if (cmd === "/skills") {
          console.log("\n--- Discovered Skills ---");
          if (!skills.skills.length) {
            console.log("(No skills found)");
          } else {
            for (const s of skills.skills) {
              console.log(`  ${s.invocation}  ${s.name} - ${s.description}`);
              console.log(`    path: ${s.path}`);
            }
          }
          continue;
        }

        if (cmd === "/memory") {
          const s = await memoryStore.getStats();
          console.log("\n--- Memory Stats ---");
          console.log(`  Evergreen (MEMORY.md): ${s.evergreenChars} chars`);
          console.log(`  Daily files: ${s.dailyFiles}`);
          console.log(`  Daily entries: ${s.dailyEntries}`);
          continue;
        }

        if (cmd === "/search") {
          if (!arg) {
            console.log("Usage: /search <query>");
            continue;
          }
          const results = await memoryStore.searchMemory(arg, 5);
          console.log(`\n--- Memory Search: ${arg} ---`);
          if (!results.length) {
            console.log("(No results)");
          } else {
            for (const r of results) {
              console.log(`  [${r.score.toFixed(4)}] ${r.path}`);
              console.log(`    ${r.snippet}`);
            }
          }
          continue;
        }

        if (cmd === "/bootstrap") {
          console.log("\n--- Bootstrap Files ---");
          const entries = Object.entries(bootstrap);
          if (!entries.length) {
            console.log("(No bootstrap files loaded)");
          } else {
            for (const [name, content] of entries) {
              console.log(`  ${name}: ${content.length} chars`);
            }
          }
          continue;
        }

        if (cmd === "/prompt") {
          const memoryContext = await autoRecall("show prompt");
          const prompt = buildSystemPrompt({
            bootstrap,
            skillsBlock,
            memoryContext,
            mode: "full",
            agentId: "main",
            channel: "terminal",
          });
          console.log("\n--- Full System Prompt ---");
          if (prompt.length > 3000) {
            console.log(prompt.slice(0, 3000));
            console.log(
              `\n... (${prompt.length - 3000} more chars, total ${prompt.length})`,
            );
          } else {
            console.log(prompt);
          }
          continue;
        }
      }

      const memoryContext = await autoRecall(input);
      if (memoryContext) {
        console.log("  [auto-recall] found relevant memories");
      }

      const systemPrompt = buildSystemPrompt({
        bootstrap,
        skillsBlock,
        memoryContext,
        mode: "full",
        agentId: "main",
        channel: "terminal",
      });

      messages.push({ role: "user", content: input });

      try {
        const result = await runAgentLoop({
          modelId: MODEL_ID,
          systemPrompt,
          messages,
          tools,
          maxSteps: 30,
        });

        const reply = result.text || `[finish_reason=${result.finishReason}]`;
        console.log(`\n\x1b[32m\x1b[1mAssistant:\x1b[0m ${reply}\n`);
      } catch (error: unknown) {
        const err = error as { message?: string };
        console.log(`\nAPI Error: ${err.message ?? "unknown"}\n`);
        while (
          messages.length &&
          messages[messages.length - 1]?.role !== "user"
        ) {
          messages.pop();
        }
        if (messages.length) messages.pop();
      }
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
