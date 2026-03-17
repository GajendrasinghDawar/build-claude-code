import type { ModelMessage } from "ai";

export interface AgentConfig {
  id: string;
  name: string;
  modelId: string;
  soul: string;
  sessionPrefix: string;
}

export interface RuntimeConfig {
  modelId: string;
  workspaceDir: string;
  sessionsDir: string;
  memoryDir: string;
  approvalsPath: string;
  httpPort: number;
  briefingTime: string;
}

export type SessionMessages = ModelMessage[];
