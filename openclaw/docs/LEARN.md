# Learn OpenClaw (Concept by Concept)

This guide teaches the architecture and how each part maps to runtime behavior.

## 1) Identity and SOUL

Each agent has a stable identity (`id`, `name`) and a system prompt (`soul`).

- Defined in `buildAgents()` in `src/index.ts`
- Passed to AI SDK via `system` in `src/agent.ts`

Why it matters: agent behavior stays consistent across turns and channels.

## 2) Session-Scoped Memory (Short-Term)

Conversation turns are persisted as JSONL messages per session key.

- `src/storage.ts` handles `loadSession`, `appendSessionMessage`, `saveSession`
- File path is derived from session key and sanitized

Why JSONL: append-only writes are simple and resilient.

## 3) Long-Term Memory

Long-term memory is explicit via tools.

- `save_memory` writes markdown files
- `memory_search` keyword-searches markdown memory notes

Tradeoff: simple and transparent, but not semantic vector search.

## 4) Tool Loop

The AI loop uses AI SDK `generateText` with tools.

- Tools are declared via `tool(...)` and Zod schemas in `src/tools.ts`
- `runAgentTurn` executes model + tools and persists returned messages

This mirrors an "agent loop" while keeping code compact.

## 5) Safety and Approvals

`run_command` allows known-safe binaries and denies unknown commands by default.

- Allowed baseline commands in `SAFE_COMMANDS`
- Denials tracked in `exec-approvals.json`

This is a minimal, conservative approval model.

## 6) Context Compaction

When session context grows, old messages are summarized.

- `compactSessionIfNeeded` in `src/agent.ts`
- Keeps a summary + recent messages

Goal: keep token usage bounded without losing key context.

## 7) Concurrency Model

A per-session queue serializes work.

- `SessionCommandQueue` in `src/queue.ts`
- Each session key is a promise chain

Benefit: avoids races from concurrent turns in the same session.

## 8) Multi-Agent Routing

Input prefix chooses agent role.

- `/research ...` -> `researcher`
- default -> `main`

Implemented in `src/router.ts` and used by both REPL and HTTP.

## 9) Multi-Channel Runtime

Both channels share same core runtime:

- REPL channel: `src/index.ts`
- HTTP channel: `src/http-gateway.ts`

Because both call `runTurn(...)`, behavior stays consistent.

## 10) Autonomous Scheduling

A heartbeat checks local time every 30s and triggers a daily briefing turn.

- `src/heartbeat.ts`

This is a simple cron-like background behavior.

## 11) Extension Paths

Practical next upgrades:

1. Replace `web_search` placeholder with a real API.
2. Add a stronger approval workflow (interactive pending approvals).
3. Add vector memory retrieval.
4. Add role-based tool permissions per agent.
5. Expose streaming responses over HTTP.
