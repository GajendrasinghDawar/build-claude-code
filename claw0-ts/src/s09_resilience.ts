import * as readline from "node:readline";
import type { ModelMessage } from "ai";
import { buildS02Tools } from "./core/tool-dispatch.js";
import { ContextGuard } from "./sessions/context-guard.js";
import { ProfileManager } from "./resilience/profile-manager.js";
import { ResilienceRunner } from "./resilience/runner.js";
import { SimulatedFailure } from "./resilience/simulated-failure.js";
import { type AuthProfile } from "./resilience/types.js";
import "dotenv/config";

const MODEL_ID = process.env.MODEL_ID ?? "openai/gpt-5.4";
const SYSTEM_PROMPT = [
  "You are a helpful AI assistant with access to tools.",
  "Use tools for shell and file operations when needed.",
  "Always read a file before editing it.",
  "For edit_file, old_string must match exactly once.",
].join("\n");

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const MAGENTA = "\x1b[35m";

function buildProfiles(): AuthProfile[] {
  const main = process.env.AI_GATEWAY_API_KEY ?? "";
  const backup = process.env.AI_GATEWAY_API_KEY_BACKUP ?? main;
  const emergency = process.env.AI_GATEWAY_API_KEY_EMERGENCY ?? backup;

  return [
    {
      name: "main-key",
      provider: "gateway",
      apiKey: main,
      cooldownUntil: 0,
      failureReason: null,
      lastGoodAt: 0,
    },
    {
      name: "backup-key",
      provider: "gateway",
      apiKey: backup,
      cooldownUntil: 0,
      failureReason: null,
      lastGoodAt: 0,
    },
    {
      name: "emergency-key",
      provider: "gateway",
      apiKey: emergency,
      cooldownUntil: 0,
      failureReason: null,
      lastGoodAt: 0,
    },
  ];
}

function parseFallbackModels(): string[] {
  const raw = process.env.FALLBACK_MODELS ?? "";
  return raw
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

function printHelp(): void {
  console.log(`${DIM}Commands:${RESET}`);
  console.log(`${DIM}  /profiles               Show all profiles${RESET}`);
  console.log(`${DIM}  /cooldowns              Show active cooldowns${RESET}`);
  console.log(`${DIM}  /simulate-failure <r>   Arm simulated failure${RESET}`);
  console.log(`${DIM}  /fallback               Show fallback chain${RESET}`);
  console.log(
    `${DIM}  /stats                  Show resilience statistics${RESET}`,
  );
  console.log(
    `${DIM}  /context                Show estimated context size${RESET}`,
  );
  console.log(`${DIM}  /help                   Show this help${RESET}`);
  console.log(`${DIM}  quit / exit             Exit${RESET}`);
}

async function main(): Promise<void> {
  if (!process.env.AI_GATEWAY_API_KEY) {
    console.error(
      "Error: AI_GATEWAY_API_KEY not set. Copy .env.example to .env.",
    );
    process.exit(1);
  }

  const profiles = buildProfiles();
  const profileManager = new ProfileManager(profiles);
  const guard = new ContextGuard();
  const simulatedFailure = new SimulatedFailure();
  const fallbackModels = parseFallbackModels();

  const runner = new ResilienceRunner(
    profileManager,
    MODEL_ID,
    fallbackModels,
    guard,
    simulatedFailure,
  );

  const tools = buildS02Tools();
  let messages: ModelMessage[] = [];

  console.log(`${DIM}${"=".repeat(64)}${RESET}`);
  console.log(`${DIM}  claw0-ts  |  Section 09: Resilience${RESET}`);
  console.log(`${DIM}  Model: ${MODEL_ID}${RESET}`);
  console.log(
    `${DIM}  Profiles: ${profiles.map((p) => p.name).join(", ")}${RESET}`,
  );
  console.log(
    `${DIM}  Fallback: ${fallbackModels.length ? fallbackModels.join(", ") : "none"}${RESET}`,
  );
  console.log(`${DIM}  Tools: bash, read_file, write_file, edit_file${RESET}`);
  console.log(`${DIM}  /help for commands. quit to exit.${RESET}`);
  console.log(`${DIM}${"=".repeat(64)}${RESET}`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  try {
    while (true) {
      let raw = "";
      try {
        raw = await ask(`${CYAN}${BOLD}You > ${RESET}`);
      } catch {
        break;
      }

      const input = raw.trim();
      if (!input) continue;

      const lower = input.toLowerCase();
      if (["q", "quit", "exit"].includes(lower)) break;

      if (input.startsWith("/")) {
        const [cmdRaw, ...rest] = input.split(/\s+/);
        const cmd = cmdRaw.toLowerCase();
        const arg = rest.join(" ").trim();

        if (cmd === "/help") {
          printHelp();
          continue;
        }

        if (cmd === "/profiles") {
          const list = profileManager.listProfiles();
          for (const p of list) {
            const on = p.status === "available" ? GREEN : YELLOW;
            const fail = p.failureReason ? `  failure=${p.failureReason}` : "";
            console.log(
              `${DIM}  ${p.name.padEnd(16)} ${on}${p.status}${RESET}${DIM}  last_good=${p.lastGood}${fail}${RESET}`,
            );
          }
          continue;
        }

        if (cmd === "/cooldowns") {
          const now = Date.now() / 1000;
          const active = profileManager.profiles.filter(
            (p) => p.cooldownUntil > now,
          );

          if (!active.length) {
            console.log(`${DIM}  No active cooldowns.${RESET}`);
            continue;
          }

          for (const p of active) {
            const remaining = Math.ceil(p.cooldownUntil - now);
            console.log(
              `${DIM}  ${p.name}: ${remaining}s remaining (reason=${p.failureReason ?? "unknown"})${RESET}`,
            );
          }
          continue;
        }

        if (cmd === "/simulate-failure") {
          if (!arg) {
            console.log(`${DIM}  Usage: /simulate-failure <reason>${RESET}`);
            console.log(
              `${DIM}  Valid: ${Object.keys(SimulatedFailure.TEMPLATES).join(", ")}${RESET}`,
            );
            if (simulatedFailure.isArmed()) {
              console.log(
                `${DIM}  Armed: ${simulatedFailure.getPendingReason() ?? "unknown"}${RESET}`,
              );
            }
            continue;
          }

          console.log(
            `${DIM}  ${MAGENTA}[resilience]${RESET}${DIM} ${simulatedFailure.arm(arg)}${RESET}`,
          );
          continue;
        }

        if (cmd === "/fallback") {
          console.log(`${DIM}  Primary model: ${MODEL_ID}${RESET}`);
          if (!fallbackModels.length) {
            console.log(`${DIM}  No fallback models configured.${RESET}`);
          } else {
            console.log(`${DIM}  Fallback model chain:${RESET}`);
            fallbackModels.forEach((m, i) => {
              console.log(`${DIM}    ${i + 1}. ${m}${RESET}`);
            });
          }
          continue;
        }

        if (cmd === "/stats") {
          const st = runner.getStats();
          console.log(`${DIM}  Attempts:    ${st.totalAttempts}${RESET}`);
          console.log(`${DIM}  Successes:   ${st.totalSuccesses}${RESET}`);
          console.log(`${DIM}  Failures:    ${st.totalFailures}${RESET}`);
          console.log(`${DIM}  Compactions: ${st.totalCompactions}${RESET}`);
          console.log(`${DIM}  Rotations:   ${st.totalRotations}${RESET}`);
          console.log(`${DIM}  Max iter:    ${st.maxIterations}${RESET}`);
          continue;
        }

        if (cmd === "/context") {
          const est = guard.estimateMessagesTokens(messages);
          console.log(`${DIM}  Estimated tokens: ~${est}${RESET}`);
          continue;
        }

        console.log(`${DIM}  Unknown command: ${input}${RESET}`);
        continue;
      }

      messages.push({ role: "user", content: input });

      try {
        const result = await runner.run({
          systemPrompt: SYSTEM_PROMPT,
          messages,
          tools,
          maxSteps: 30,
        });

        messages = result.messages;
        const text = result.text || `[finish_reason=${result.finishReason}]`;
        console.log(`\n${GREEN}${BOLD}Assistant:${RESET} ${text}\n`);
      } catch (error: unknown) {
        const err = error as { message?: string };
        console.log(
          `\n${YELLOW}API Error: ${err.message ?? "unknown"}${RESET}\n`,
        );

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
