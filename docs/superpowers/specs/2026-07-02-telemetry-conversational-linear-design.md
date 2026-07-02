# Telemetry + Conversational Linear — Design

Date: 2026-07-02
Status: approved

## Goals

1. **Discover Jarvis's environment/capability issues** (like the known venv/test failure) by persisting full run telemetry and making it queryable.
2. **Make Jarvis conversational in Linear**: any user comment during planning or implementation reaches the live agent and steers it; the agent can ask the user questions and gets answers from Linear.
3. **Fix the known Python gap** in the E2B template.

## 1. Run telemetry

### Schema (new tables in `jarvis.db`, defined in `src/store/sessions.ts`)

```sql
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_session_id TEXT NOT NULL,
  task_type TEXT NOT NULL,          -- map | plan | revise | implement
  repo TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  outcome TEXT,                     -- success | error_max_turns | error_budget | error | pr_failed
  cost_usd REAL,
  num_turns INTEGER,
  tokens_in INTEGER,
  tokens_out INTEGER,
  tokens_cache_read INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  ts TEXT NOT NULL,
  type TEXT NOT NULL,               -- tool_use | tool_result | error | user_message | ask_user
  payload TEXT NOT NULL             -- JSON
);
```

### Wiring

- `runner.mjs` gains a `tool_result` JarvisEvent: `{ type: "tool_result", tool, isError, content }` with content truncated to ~2KB. Failure text (e.g. `externally-managed-environment`) lives in results, not calls.
- `pipeline.ts` creates the `runs` row when a task starts; `#relay` appends every event to `run_events`; `#logUsage` finalizes the `runs` row (outcome, cost, tokens) in addition to its console.log.
- Injected user comments and `ask_user` questions are stored as events, so conversations are auditable.
- All telemetry writes are best-effort: wrapped in try/catch, never fail a run over logging.

### Mining

`npm run report` → small script (`src/report.ts` or similar) printing:
- runs grouped by outcome
- failed tool results (Bash `isError`) grouped by first line of stderr
- error runs with their last few events

This is the ongoing answer to "what issues does Jarvis face."

## 2. Conversational core: streaming inbox

`runner.mjs` switches `query()` from a fixed prompt string to an async-generator prompt (Agent SDK streaming-input mode):

- Yields the initial task prompt, then stays open.
- Watches `/tmp/jarvis-inbox.jsonl` (append-only JSONL, runner tracks byte offset — no read/write races). Each appended line (a user comment from Linear) is yielded as the next user message; the SDK injects it at the next turn boundary.
- The run still ends when the agent produces its final result; the `/tmp/jarvis-result.json` contract is unchanged.

Host side (`src/sandbox/session.ts`): new `injectMessage(sandbox, text)` — appends to the inbox via `commands.run` echo-append (avoids the known e2b `files.write` overwrite bug).

## 3. Webhook routing changes (`pipeline.ts` / `server.ts`)

`onPrompted` behavior by phase:

| Phase | Behavior |
|---|---|
| any | `stop/cancel/abort` keywords checked first → kill session (unchanged) |
| `plan` / `implement`, live run | `injectMessage` into the sandbox; post a brief `thought` acknowledging receipt |
| `await_approval` | unchanged approval/revision flow, except `reviseTask` passes `resume: <sessionId>` so revisions keep context instead of cold-starting. Session id comes from the result event (already captured) and is persisted on the session row. |
| anything else / dead run | today's canned status message |

The `inflight` dedupe set in `server.ts` must stop swallowing comments for running sessions: it now only guards against concurrent processing of the *same* webhook delivery, not new user comments.

## 4. `ask_user` tool + wait policy

Runner defines one in-process MCP tool `ask_user(question: string)`:

- Emits an `ask_user` JarvisEvent on stdout → host posts it to Linear as an **elicitation**.
- Blocks polling the inbox for up to **10 minutes** (capped at remaining sandbox deadline). Reply arrives → returned as the tool result. Timeout → returns: "No answer within 10 minutes — proceed with your best judgment and state your assumption in your final output."
- Prompt directive added to plan and implement templates: use `ask_user` only when genuinely blocked on a decision only the user can make; don't ask what can be inferred.

### Agent replies become visible

Today per-block `assistant_text` is deliberately not relayed (noise). Change: after a `user_message` injection or an `ask_user` answer, the **next** assistant text block is posted to Linear as a `response`, so the user gets a conversational reply. Normal work narration stays quiet.

## 5. E2B template fix (`e2b/build-template.ts`)

Add to the apt install line: `python3 python3-venv python3-pip`. Requires a template rebuild (runner.mjs changes require one anyway).

## 6. Error handling & edges

- Comment arrives after run finished / sandbox dead → status message (or revision flow in `await_approval`).
- `ask_user` near the 55-min deadline → wait capped at remaining time.
- Host restart mid-run: reconciliation is unchanged; inbox injection simply fails gracefully if the sandbox is gone.
- Empty-body `prompted` webhooks are still ignored (echo-loop guard).

## Out of scope

- Resuming a dead session in a fresh sandbox when an answer arrives hours later ("block until I answer" was not chosen; late comments in `await_approval` still work via revision).
- Acting on telemetry findings beyond the Python fix — first collect data, then fix what it shows.
