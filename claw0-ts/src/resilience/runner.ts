import { gateway } from "@ai-sdk/gateway";
import { generateText, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import { ContextGuard } from "../sessions/context-guard.js";
import { classifyFailure } from "./failure.js";
import { ProfileManager } from "./profile-manager.js";
import { SimulatedFailure } from "./simulated-failure.js";
import { FailoverReason, type ResilienceStats } from "./types.js";

const BASE_RETRY = 24;
const PER_PROFILE = 8;
const MAX_OVERFLOW_COMPACTION = 3;

export interface ResilienceRunOptions {
  systemPrompt: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  maxSteps?: number;
}

export interface ResilienceRunResult {
  text: string;
  finishReason: string;
  messages: ModelMessage[];
}

function truncateToolResults(
  messages: ModelMessage[],
  maxChars = 6000,
): ModelMessage[] {
  return messages.map((msg) => {
    if ((msg as { role?: string }).role !== "tool") return msg;

    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) return msg;

    const next = content.map((part) => {
      if (!part || typeof part !== "object") return part;
      const p = { ...(part as Record<string, unknown>) };
      if (String(p.type ?? "") !== "tool-result") return p;

      const result = p.result;
      if (typeof result === "string" && result.length > maxChars) {
        p.result = `${result.slice(0, maxChars)}\n[truncated]`;
      }

      return p;
    });

    return { ...(msg as object), content: next } as ModelMessage;
  });
}

function cooldownFor(reason: FailoverReason): number {
  if (reason === FailoverReason.Timeout) return 60;
  if (reason === FailoverReason.RateLimit) return 120;
  if (reason === FailoverReason.Overflow) return 600;
  if (reason === FailoverReason.Auth || reason === FailoverReason.Billing) {
    return 300;
  }
  return 120;
}

export class ResilienceRunner {
  private readonly maxIterations: number;

  private totalAttempts = 0;
  private totalSuccesses = 0;
  private totalFailures = 0;
  private totalCompactions = 0;
  private totalRotations = 0;

  constructor(
    private readonly profileManager: ProfileManager,
    private readonly modelId: string,
    private readonly fallbackModels: string[] = [],
    private readonly contextGuard = new ContextGuard(),
    private readonly simulatedFailure = new SimulatedFailure(),
  ) {
    const profileCount = this.profileManager.profiles.length;
    this.maxIterations = Math.min(
      Math.max(BASE_RETRY + PER_PROFILE * profileCount, 32),
      160,
    );
  }

  async run(options: ResilienceRunOptions): Promise<ResilienceRunResult> {
    const {
      systemPrompt,
      messages,
      tools,
      maxSteps = this.maxIterations,
    } = options;

    let currentMessages = [...messages];
    const tried = new Set<string>();

    for (let i = 0; i < this.profileManager.profiles.length; i += 1) {
      const profile = this.profileManager.selectProfile();
      if (!profile) break;
      if (tried.has(profile.name)) break;
      tried.add(profile.name);

      if (tried.size > 1) {
        this.totalRotations += 1;
      }

      process.env.AI_GATEWAY_API_KEY = profile.apiKey;

      let layerMessages = [...currentMessages];
      for (
        let compactAttempt = 0;
        compactAttempt < MAX_OVERFLOW_COMPACTION;
        compactAttempt += 1
      ) {
        try {
          this.totalAttempts += 1;
          this.simulatedFailure.checkAndFire();

          const result = await this.runAttempt({
            modelId: this.modelId,
            systemPrompt,
            messages: layerMessages,
            tools,
            maxSteps,
          });

          this.profileManager.markSuccess(profile);
          this.totalSuccesses += 1;
          return result;
        } catch (error) {
          const reason = classifyFailure(error);
          this.totalFailures += 1;

          if (reason === FailoverReason.Overflow) {
            if (compactAttempt < MAX_OVERFLOW_COMPACTION - 1) {
              this.totalCompactions += 1;
              layerMessages = truncateToolResults(layerMessages);
              layerMessages = await this.contextGuard.compactHistory(
                layerMessages,
                this.modelId,
              );
              continue;
            }
          }

          this.profileManager.markFailure(profile, reason, cooldownFor(reason));
          break;
        }
      }

      currentMessages = layerMessages;
    }

    if (this.fallbackModels.length) {
      for (const fallbackModel of this.fallbackModels) {
        let profile = this.profileManager.selectProfile();
        if (!profile) {
          this.profileManager.clearTransientCooldowns();
          profile = this.profileManager.selectProfile();
        }
        if (!profile) continue;

        process.env.AI_GATEWAY_API_KEY = profile.apiKey;

        try {
          this.totalAttempts += 1;
          this.simulatedFailure.checkAndFire();

          const result = await this.runAttempt({
            modelId: fallbackModel,
            systemPrompt,
            messages: currentMessages,
            tools,
            maxSteps,
          });
          this.profileManager.markSuccess(profile);
          this.totalSuccesses += 1;
          return result;
        } catch {
          this.totalFailures += 1;
          continue;
        }
      }
    }

    throw new Error(
      `All profiles and fallback models exhausted. Tried ${tried.size} profiles, ${this.fallbackModels.length} fallback models.`,
    );
  }

  getStats(): ResilienceStats {
    return {
      totalAttempts: this.totalAttempts,
      totalSuccesses: this.totalSuccesses,
      totalFailures: this.totalFailures,
      totalCompactions: this.totalCompactions,
      totalRotations: this.totalRotations,
      maxIterations: this.maxIterations,
    };
  }

  private async runAttempt(options: {
    modelId: string;
    systemPrompt: string;
    messages: ModelMessage[];
    tools?: ToolSet;
    maxSteps: number;
  }): Promise<ResilienceRunResult> {
    const { modelId, systemPrompt, messages, tools, maxSteps } = options;

    const result = await generateText({
      model: gateway(modelId),
      system: systemPrompt,
      messages,
      ...(tools ? { tools } : {}),
      stopWhen: stepCountIs(maxSteps),
    });

    const nextMessages = [...messages, ...result.response.messages];
    return {
      text: result.text.trim(),
      finishReason: result.finishReason,
      messages: nextMessages,
    };
  }
}
