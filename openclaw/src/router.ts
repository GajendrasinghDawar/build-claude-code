export function resolveAgent(input: string): {
  agentId: "main" | "researcher";
  text: string;
} {
  if (input.startsWith("/research ")) {
    return {
      agentId: "researcher",
      text: input.slice("/research ".length).trim(),
    };
  }

  return {
    agentId: "main",
    text: input,
  };
}
