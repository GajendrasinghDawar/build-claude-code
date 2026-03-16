import { tool } from "ai";
import { z } from "zod";
import {
  toolBash,
  toolEditFile,
  toolReadFile,
  toolWriteFile,
} from "./base-tools.js";

export function buildS01Tools() {
  return {
    bash: tool({
      description: "Run a shell command.",
      inputSchema: z.object({
        command: z.string(),
        timeout: z.number().int().positive().optional(),
      }),
      execute: async ({ command, timeout }) => toolBash(command, timeout ?? 30),
    }),
  };
}

export function buildS02Tools() {
  return {
    ...buildS01Tools(),
    read_file: tool({
      description: "Read file contents.",
      inputSchema: z.object({
        file_path: z.string(),
      }),
      execute: async ({ file_path }) => toolReadFile(file_path),
    }),
    write_file: tool({
      description: "Write file contents.",
      inputSchema: z.object({
        file_path: z.string(),
        content: z.string(),
      }),
      execute: async ({ file_path, content }) =>
        toolWriteFile(file_path, content),
    }),
    edit_file: tool({
      description: "Edit a file by replacing old_string exactly once.",
      inputSchema: z.object({
        file_path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
      }),
      execute: async ({ file_path, old_string, new_string }) =>
        toolEditFile(file_path, old_string, new_string),
    }),
  };
}
