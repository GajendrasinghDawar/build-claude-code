export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ContentBlock = TextBlock | ToolUseBlock;

export interface ToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

export interface TextInjection {
  type: "text";
  text: string;
}

export interface Message {
  role: "user" | "assistant";
  content: string | (ToolResult | TextInjection)[] | ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export type ToolHandler = (
  args: Record<string, unknown>,
) => string | Promise<string>;

export type ToolDispatchMap = Record<string, ToolHandler>;

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
}

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface Task {
  id: number;
  subject: string;
  description: string;
  status: TaskStatus;
  owner: string;
  blockedBy: number[];
  blocks: number[];
  worktree?: string;
  created_at?: number;
  updated_at?: number;
}

export type MemberStatus = "working" | "idle" | "shutdown";

export interface TeamMember {
  name: string;
  role: string;
  status: MemberStatus;
}

export interface TeamConfig {
  team_name: string;
  members: TeamMember[];
}

export type MessageType =
  | "message"
  | "broadcast"
  | "shutdown_request"
  | "shutdown_response"
  | "plan_approval_response";

export interface InboxMessage {
  type: MessageType;
  from: string;
  content: string;
  timestamp: number;
  request_id?: string;
  approve?: boolean;
  feedback?: string;
  plan?: string;
}

export interface BackgroundTask {
  status: "running" | "completed" | "error" | "timeout";
  command: string;
  result: string | null;
}

export interface BackgroundNotification {
  task_id: string;
  status: string;
  command: string;
  result: string;
}

export type WorktreeStatus = "active" | "kept" | "removed";

export interface WorktreeEntry {
  name: string;
  path: string;
  branch: string;
  task_id: number | null;
  status: WorktreeStatus;
  created_at: number;
  removed_at?: number;
  kept_at?: number;
}

export interface WorktreeIndex {
  worktrees: WorktreeEntry[];
}

export interface ShutdownRequest {
  target: string;
  status: "pending" | "approved" | "rejected";
}

export interface PlanRequest {
  from: string;
  plan: string;
  status: "pending" | "approved" | "rejected";
}
