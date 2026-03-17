# Porting Map (Article Concepts -> OpenClaw Files)

This file maps major concepts from the original architecture to this TypeScript project.

## Agent Loop

- Concept: iterative model/tool execution
- Port: `src/agent.ts` (`runAgentTurn` with `generateText` + tools)

## Tool Use

- Concept: model calls typed tools with validation
- Port: `src/tools.ts` (`tool(...)` + `zod` input schemas)

## Todo/Task Durability

- Concept: durable conversational/task state
- Port: session JSONL persistence in `src/storage.ts`

## Subagents / Team Roles

- Concept: specialized workers
- Port: `main` and `researcher` agent configs in `src/index.ts`; routing in `src/router.ts`

## Context Compaction

- Concept: summarize old context to fit token budgets
- Port: `compactSessionIfNeeded` in `src/agent.ts`

## Background Tasks / Heartbeats

- Concept: autonomous periodic behavior
- Port: `startMorningHeartbeat` in `src/heartbeat.ts`

## Task System / Queueing

- Concept: safely handle concurrent commands
- Port: `SessionCommandQueue` in `src/queue.ts`

## Channel Protocols

- Concept: same assistant logic across channels
- Port: REPL in `src/index.ts` + HTTP in `src/http-gateway.ts`

## Environment / Runtime Config

- Concept: externalized runtime settings
- Port: `.env.example` + `src/config.ts`

## Safety / Approvals

- Concept: constrained side effects and explicit permission
- Port: `run_command` checks in `src/tools.ts` + `exec-approvals.json`
