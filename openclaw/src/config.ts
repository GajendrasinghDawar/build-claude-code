import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RuntimeConfig } from "./types.js";

export function buildConfig(): RuntimeConfig {
  const workspaceRoot = resolve(
    process.cwd(),
    process.env.OPENCLAW_WORKSPACE ?? ".workspace",
  );

  return {
    modelId: process.env.MODEL_ID ?? "openai/gpt-5.4",
    workspaceDir: workspaceRoot,
    sessionsDir: join(workspaceRoot, "sessions"),
    memoryDir: join(workspaceRoot, "memory"),
    approvalsPath: join(workspaceRoot, "exec-approvals.json"),
    httpPort: Number(process.env.OPENCLAW_HTTP_PORT ?? "5050"),
    briefingTime: process.env.MORNING_BRIEFING_TIME ?? "07:30",
  };
}

export async function ensureWorkspace(config: RuntimeConfig): Promise<void> {
  await mkdir(config.workspaceDir, { recursive: true });
  await mkdir(config.sessionsDir, { recursive: true });
  await mkdir(config.memoryDir, { recursive: true });
}
