import type Anthropic from "@anthropic-ai/sdk";
import {
  toolBash,
  toolEditFile,
  toolReadFile,
  toolWriteFile,
} from "./base-tools.js";

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "bash",
    description: "Run a shell command and return its output.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute.",
        },
        timeout: {
          type: "integer",
          description: "Timeout in seconds. Default 30.",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read the contents of a file.",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the file (relative to working directory).",
        },
      },
      required: ["file_path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write content to a file. Creates parent directories if needed and overwrites existing content.",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the file (relative to working directory).",
        },
        content: { type: "string", description: "The content to write." },
      },
      required: ["file_path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace an exact string in a file with a new string. old_string must appear exactly once.",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the file (relative to working directory).",
        },
        old_string: {
          type: "string",
          description: "The exact text to find and replace. Must be unique.",
        },
        new_string: { type: "string", description: "Replacement text." },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
];

export type ToolHandler = (
  toolInput: Record<string, unknown>,
) => Promise<string>;

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: async (toolInput) =>
    toolBash(String(toolInput.command), Number(toolInput.timeout ?? 30)),
  read_file: async (toolInput) => toolReadFile(String(toolInput.file_path)),
  write_file: async (toolInput) =>
    toolWriteFile(String(toolInput.file_path), String(toolInput.content ?? "")),
  edit_file: async (toolInput) =>
    toolEditFile(
      String(toolInput.file_path),
      String(toolInput.old_string ?? ""),
      String(toolInput.new_string ?? ""),
    ),
};

export async function processToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<string> {
  const handler = TOOL_HANDLERS[toolName];
  if (!handler) return `Error: Unknown tool '${toolName}'`;

  try {
    return await handler(toolInput);
  } catch (error: unknown) {
    const err = error as { message?: string };
    return `Error: ${toolName} failed: ${err.message ?? "unknown error"}`;
  }
}
