# OpenClaw (TypeScript + Node.js + AI SDK)

OpenClaw is a working educational port of the article's assistant architecture into TypeScript.
It demonstrates:

- AI SDK tool loop with AI Gateway models
- Persistent JSONL sessions
- Basic context compaction
- Memory save/search tools
- Per-session command queue for concurrency safety
- Multi-agent routing (`main` + `researcher`)
- REPL and HTTP channels sharing the same runtime
- Morning heartbeat scheduler

## 1) Setup

```bash
cd openclaw
cp .env.example .env
npm install
```

Required in `.env`:

- `AI_GATEWAY_API_KEY=...`

## 2) Run

```bash
npm run dev
```

You get:

- REPL in terminal
- HTTP endpoint at `POST /chat` on `OPENCLAW_HTTP_PORT` (default `5050`)

Example HTTP request:

```bash
curl -s -X POST http://127.0.0.1:5050/chat \
  -H "Content-Type: application/json" \
  -d '{"session_id":"u1","message":"/research latest papers on tool calling"}'
```

## 3) Commands

- `/research <query>` routes to the `researcher` agent
- `/new` starts a fresh main REPL session
- `/quit` exits

## 4) Project Structure

- `src/index.ts` app entrypoint, REPL, startup wiring
- `src/agent.ts` AI loop + compaction + persistence
- `src/tools.ts` tool catalog (command/file/memory/web)
- `src/http-gateway.ts` HTTP channel
- `src/heartbeat.ts` scheduled daily turn
- `src/storage.ts` JSONL sessions + memory file storage
- `src/queue.ts` per-session serialization queue
- `src/router.ts` input-to-agent routing

## 5) Notes

- `run_command` defaults to deny unknown commands for safety.
- `web_search` is a placeholder tool; plug in a real provider.
- This code is intentionally compact for learning and extension.

See docs:

- `docs/LEARN.md`
- `docs/PORTING_MAP.md`
