# Copilot Kickoff Prompt for gufan (claw0) Port

---

## Prompt

```
@workspace

Read `docs/PORTING_GUIDE_GUFAN_CLAW0_TO_TYPESCRIPT.md` completely. This is a detailed porting specification for converting the Python project in `gufan/` (a.k.a. "claw0") to TypeScript/Node.js.

**Context:**
- `gufan/sessions/en/` contains 10 Python files (s01–s10) — each is a self-contained, runnable session that builds an AI agent gateway progressively.
- `gufan/workspace/` contains runtime config files (SOUL.md, MEMORY.md, CRON.json, etc.) that the agent loads at runtime. Copy these as-is.
- The porting guide has complete TypeScript implementations for every class and pattern.
- The target directory is `nano-agent-ts/` (create it at the repo root if it doesn't exist). Use the file structure from Section 17 of the guide.

**Do this in order:**

1. **Setup:** Create `nano-agent-ts/package.json`, `tsconfig.json`, and `.gitignore`. Install deps: `@anthropic-ai/sdk`, `dotenv`, `ws`, `cron-parser`. Dev deps: `tsx`, `typescript`, `@types/node`, `@types/ws`.

2. **Shared core (s01+s02):** Create `src/types.ts`, `src/core/agent-loop.ts`, `src/core/tool-dispatch.ts`, `src/core/base-tools.ts`. These are the shared foundation. Port from `gufan/sessions/en/s01_agent_loop.py` and `s02_tool_use.py`. Make all tool handlers async. Verify it runs: `npx tsx src/s01_agent_loop.ts`.

3. **Then port each session one at a time in order:** s03 → s04 → s05 → s06 → s07 → s08 → s09 → s10. For each:
   - Read the corresponding Python file in `gufan/sessions/en/`
   - Read the corresponding section in the porting guide
   - Create the module files AND the standalone session entry point
   - Each session file should be independently runnable

**Key rules:**
- Use `@anthropic-ai/sdk` (NOT Vercel AI SDK) — we need the explicit loop control
- All tool handlers must be `async` functions
- Use Node.js built-ins: `fs/promises`, `child_process.exec` (promisified), `path`, `crypto.randomUUID()`
- Use `fetch()` (built into Node 18+) for HTTP calls — no axios
- Copy `gufan/workspace/` files to `nano-agent-ts/workspace/` unchanged
- Follow the types defined in Section 4 of the porting guide exactly

Start with step 1 and 2. After each step, tell me what you created and what to verify.
```

---

## Follow-up Prompts (use after each step completes)

### After s01+s02 work:

```
Good. Now port s03 (Sessions & Context Guard). Read `gufan/sessions/en/s03_sessions.py` and Section 7 of the porting guide. Create `src/sessions/session-store.ts`, `src/sessions/context-guard.ts`, and `src/s03_sessions.ts`. The session store uses JSONL files — append on write, rebuild messages[] on read. The context guard has 3 stages: try normal → truncate tool results → compact history.
```

### After s03:

```
Now port s04 (Channels). Read `gufan/sessions/en/s04_channels.py` and Section 8 of the porting guide. Create the abstract Channel class, CLIChannel, TelegramChannel (use raw fetch, not a library), and ChannelManager. The key pattern: every platform normalizes into InboundMessage so the agent loop never changes.
```

### After s04:

```
Now port s05 (Gateway & Routing). Read `gufan/sessions/en/s05_gateway_routing.py` and Section 9. Create the 5-tier RoutingTable and the WebSocket gateway using the `ws` package. The binding resolution order is: peer > guild > account > channel > default.
```

### After s05:

```
Now port s06 (Intelligence). Read `gufan/sessions/en/s06_intelligence.py` and Section 10. Create BootstrapLoader, MemoryStore, SkillsManager. The system prompt is assembled from 8 files on disk (SOUL.md first = highest priority). Copy workspace/*.md files to nano-agent-ts/workspace/.
```

### After s06:

```
Now port s07 (Heartbeat & Cron). Read `gufan/sessions/en/s07_heartbeat_cron.py` and Section 11. HeartbeatService uses setInterval. CronService parses CRON.json and supports 3 schedule kinds: "cron" (expression), "at" (one-shot datetime), "every" (interval with anchor). Use cron-parser package.
```

### After s07:

```
Now port s08 (Delivery Queue). Read `gufan/sessions/en/s08_delivery.py` and Section 12. Create DeliveryQueue (write-ahead to disk) and DeliveryRunner (background retry with exponential backoff: 5s, 25s, 2min, 10min). Max 5 retries then move to failed/.
```

### After s08:

```
Now port s09 (Resilience). Read `gufan/sessions/en/s09_resilience.py` and Section 13. Create the 3-layer retry onion: Layer 1 = auth profile rotation, Layer 2 = overflow compaction, Layer 3 = standard tool-use loop. Create ProfileManager and ResilientRunner.
```

### After s09:

```
Now port s10 (Concurrency). Read `gufan/sessions/en/s10_concurrency.py` and Section 14. Create CommandQueue with named FIFO lanes. Each lane has configurable maxConcurrency. User messages go to "main" lane, heartbeat/cron get their own lanes. This replaces threading.Lock from Python — Node.js is single-threaded so the queue pattern serializes access naturally.
```
