# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Jarvis is a coding agent for the company: a Linear issue gets assigned to Jarvis;
it clarifies, posts a plan, and on approval writes code, tests it in an E2B sandbox,
and opens a GitHub PR for a human to approve. Full design/rationale: [`BUILD_PLAN.md`](./BUILD_PLAN.md).

**Jarvis is glue, not an engine** — it does not reimplement a planner, debugger, or
review engine. It wires together the Claude Agent SDK (the autonomous loop), the
`superpowers` skills (methodology: brainstorming, writing-plans, systematic-debugging,
code review), E2B (sandboxing), and Linear (the agent surface). The code this repo
owns is: the webhook receiver, the session store, the orchestrator state machine, the
Linear ⇄ Agent-SDK adapters, and the system prompts.

## Commands

```bash
npm run dev          # server + file watcher, loads .env (node --watch)
npm start             # server, no watcher
npm run typecheck     # tsc --noEmit
npm test              # vitest run (whole suite, once)
npm run test:watch    # vitest (watch mode)
npm run report        # failure-pattern + economics report (console + jarvis-report.html dashboard)
```

Single test file: `npx vitest run tests/orchestrator/pipeline.test.ts`
Single test by name: `npx vitest run tests/orchestrator/pipeline.test.ts -t "name substring"`

Rebuilding the in-sandbox runner template (**required** any time `src/agent/runner.mjs`
changes — the host never uploads it at runtime, it's baked into the `jarvis-agent`
E2B template):

```bash
node --env-file-if-exists=.env e2b/build-template.ts
```

Until rebuilt, sandboxes run the old runner — in particular the durable-runs recovery
path (`reconcile()` reading `/tmp/jarvis-result.json`) is inert against an old-template
runner, and interrupted sessions fail loud instead of recovering.

## Runtime prerequisites

- Node.js ≥ 24.15.0 (uses `node:sqlite`, `--env-file-if-exists`)
- `.env` populated from `.env.example`: Linear OAuth app creds, `ANTHROPIC_API_KEY`,
  `E2B_API_KEY` + `E2B_TEMPLATE` (`jarvis-agent`), `GH_TOKEN`, `TARGET_REPO` (`owner/name`),
  `PUBLIC_BASE_URL`.
- Linear access token: renewed automatically via the `client_credentials` grant
  (a ~30-day app-actor token) by `LinearTokenManager` (`src/linear/token-manager.ts`)
  and persisted in SQLite (`oauth_tokens` table) — **not** `.env`. `LINEAR_ACCESS_TOKEN`
  is an optional bootstrap seed used only for the first run before a token row exists;
  the token manager renews a day before expiry, retries on a bounded backoff, and forces
  a refresh on any `401`. Visiting `/oauth/callback` (the registered app's authorize flow)
  persists the captured token straight to the store and it goes live with no `.env` edit
  or restart.

## Architecture

### Request flow — a Linear session, start to finish

```
Linear issue assigned to Jarvis
        │  AgentSessionEvent webhook: action="created"
        ▼
┌────────────────────────────────────────────────────────────────────┐
│ server.ts  — verifies webhook signature, acks with a `thought`      │
│              activity within 10s (Linear's responsiveness rule),    │
│              routes to Orchestrator, guards against duplicate/      │
│              re-entrant webhooks with an in-memory `inflight` set   │
└───────────────────────────┬──────────────────────────────────────┘
                             ▼
┌────────────────────────────────────────────────────────────────────┐
│ Orchestrator (src/orchestrator/pipeline.ts) — phase state machine   │
│                                                                      │
│  onCreated(ctx)                                                     │
│    ├─ store.upsert(session, "plan")                                 │
│    ├─ withSandbox: e2b sandbox up → cloneRepo(TARGET_REPO)          │
│    ├─ first time in repo? run mapTask() → cache in repo_maps table  │
│    ├─ run planTask(ctx, map)            ─┐                          │
│    └─ #finishPlan: store plan, post as   │  "tracked run":          │
│       an `elicitation` activity + footer │  createRun row, register │
│       → phase = await_approval           │  in #live map (steering),│
│                                           │  stream JarvisEvents,    │
│  onPrompted(ctx, reply)  [phase must be  │  finishRun row on exit   │
│  await_approval, else terminal reply]    │                          │
│    ├─ parseStop(reply)   → phase="done"  │                          │
│    ├─ !parseApproval(reply) → reviseTask │ (revision loops back     │
│    │    → #finishPlan again              │  into await_approval)    │
│    └─ parseApproval(reply)               │                          │
│         → phase="implement"              │                          │
│         → withSandbox: clone + implementTask(ctx, plan, map)        │
│         → #finishImplement: post PR link → phase="done", or         │
│           #failLoud → phase="error"                                 │
│                                                                      │
│  steer(ctx, reply)  [a comment arrives WHILE a run is live]         │
│    ├─ not live any more → apologize, no-op                          │
│    ├─ parseStop → kill the live sandbox, phase="done"               │
│    └─ else → injectMessage() appends to the sandbox's inbox file    │
│                                                                      │
│  reconcile()  [called once, at server boot]                        │
│    for every session row stuck in phase plan/implement:             │
│      reconnect to its sandboxId → watchDetached() polls             │
│      /tmp/jarvis-result.json → replay #finishPlan/#finishImplement, │
│      or fail loud if nothing recoverable (interrupted before the    │
│      sandboxId was even recorded, or the sandbox is gone)           │
└───────────────────────────┬──────────────────────────────────────┘
                             ▼
        GitHub PR opened  →  human reviews & merges (Jarvis never merges)
```

### Phase state machine (`src/store/sessions.ts` `Phase`)

```
clarify → plan → await_approval ⇄ plan (revision loop, feedback ≠ approve)
                        │
                        └─ approve → implement → done
                                          │
                                          └─ failure → error

done ⇄ review (reply on a finished session with a PR — report-only, always returns to done)
    └─ done ⇄ implement (reply parsed as a change request — updates the open PR in place on the existing work branch; questions/review requests take the report-only `review` path)
```
State lives in SQLite (`sessions` table), keyed by Linear's `agentSessionId`. A
restart loses nothing except live-steering ability for runs that were mid-flight
(`#live` is in-memory) — `reconcile()` picks those back up from `sandboxId` +
`/tmp/jarvis-result.json`.

Re-assigning an issue mints a **new** `agentSessionId`, so `onCreated` starts by
calling `findResumableByIssue(issueId, excludeSessionId)` to look up the latest
not-live prior session for the same issue and, if found, skips straight past
planning instead of starting over: prior with a `prUrl` (done, or the transient
`review` phase) → point the new session at the existing PR; prior `implement`/
`error` → `implement` again, resuming from the saved plan and the prior's pushed
work branch (no re-plan, no re-approval); prior `await_approval`/`plan` → reuse
the saved plan and re-post it for approval. A prior that's still live refuses the
new run outright rather than racing it. Every resumed-from prior is retired
(phase forced to `done`, `sandboxId` cleared) so `reconcile()` doesn't also try
to re-attach to its now-stale sandbox.

### Where code executes: one E2B sandbox per session

The target repo is cloned fresh into a new sandbox for **each** phase transition
that needs one (plan, revise, implement each get their own `withSandbox` call —
sandboxes are not reused across phases, only within one `#trackedRun`/mapping
combo). All agent file edits, tool calls, and verification (tests/lint/start/curl)
happen inside it — isolating untrusted generated code and giving the agent normal
tool-output-driven failure feedback instead of special plumbing.

`// ponytail:` one sandbox per session, recreated each run — no pooling/warm sandboxes.
Add only if spin-up latency measurably hurts.

Durable state is keyed by **issue**, not by session: `sessions.workBranch` pins a
deterministic `jarvis/<issueId>` branch (`#workBranchFor`), and `implementTask()`
checks it out with `git checkout -B <workBranch> origin/<workBranch> || git checkout
-b <workBranch>`, pushing after each meaningful step (and de-duping an already-open
PR) instead of pushing once at the end. The work branch is pushed to the remote host-side right after clone (via `#pushEmptyBranch`), before the implement agent runs, so a run that dies before its first agent-side push still leaves an assignable branch on the remote. Combined with `findResumableByIssue`, a run that dies mid-implementation — sandbox killed, host restarted, whatever — resumes on the next `created` webhook from the saved plan plus whatever was already pushed,
rather than re-planning or redoing finished work.

Serena MCP (`ide-assistant` context) is registered by `runner.mjs` when
`/usr/local/bin/serena` exists in the sandbox, and `indexRepo()` runs once right
after clone to warm its symbol index — this is advisory: if serena is absent or
indexing fails, tasks degrade to plain Grep/Glob. `vendor/ponytail-skills`
(ponytail + ponytail-review) is baked into the template alongside
`vendor/superpowers-skills`; see `vendor/ponytail-skills/README.md` to
re-populate it.

### The sandbox ⇄ host protocol (`src/sandbox/session.ts` + `src/agent/runner.mjs`)

`runner.mjs` is copied into the E2B template at `/opt/jarvis-agent/runner.mjs` (baked
at template-build time, **not** uploaded per-run) and executes the Claude Agent SDK
in streaming-input mode inside the sandbox. Host and sandbox talk over three channels:

| Channel | Direction | Purpose |
|---|---|---|
| stdout, newline-delimited JSON (`JarvisEvent`, parsed by `LineParser`) | sandbox → host | live telemetry: `assistant_text`, `tool_use`, `tool_result`, `ask_user`, `result`, `error` — relayed to Linear activities in real time |
| `/tmp/jarvis-result.json` (`RESULT_FILE`) | sandbox → host | **authoritative** final result/error — the stream can go half-open and hang, so this file (not the stream) is what `reconcile()` trusts after a restart |
| `/tmp/jarvis-inbox.jsonl` (`INBOX_FILE`), appended via base64-encoded `echo` | host → sandbox | mid-run steering messages / `ask_user` answers; the runner tails it every 2s and injects lines into the live agent turn |

`runAgent()` races the stdout stream against `watchDetached()` (which polls
`RESULT_FILE` + checks whether the `runner.mjs` process is still alive) so a
half-open stream can never hang the host. `reconcile()` reuses `watchDetached()`
standalone (no stream) to re-attach after a restart.

### Session memory (`src/history/history.ts`)

Every plan/revise/implement/review run (not the implement run's automatic
self-review, which reviews its own fresh diff) gets same-issue memory, assembled by
`prepareHistory()` right after `cloneRepo()`: (1) the visible Linear
conversation of every session on the issue (fetched via `makeThreadFetcher`,
capped at 20k chars keeping the newest) is appended to the task `goal` —
per-run content, so prompt-cache-safe; (2) the newest 10 prior runs' raw
`run_events` streams are exported into the sandbox at
`/home/user/jarvis-history/run-<id>-<taskType>.jsonl` and the goal tells the
agent to Grep them on demand. Advisory end-to-end: any failure logs
`[history]` and the run proceeds memory-less. `// ponytail:` same-issue scope
only; upgrade path for cross-issue memory is a host-side retrieval tool.

### Agent tasks (`src/agent/tasks.ts`)

Five task builders, each an `AgentTask` (goal / model / allowed tools / turn+budget
caps) fed to `runner.mjs`. `mapTask()` is deliberately the odd one out (Read/Glob/Grep
only — one-time, read-only repo survey); every other task shares the same
`ALL_REPO_TOOLS` list (Read/Glob/Grep/Bash/Edit/Write/Monitor/WebSearch/WebFetch/
`mcp__serena`/Skill/Agent/ask_user) so the agent never hits a tool wall mid-task — the
difference between plan/revise/review/implement is the goal text, model, and turn
cap, not the tool list:

| Task | Model | Max turns | Purpose |
|---|---|---|---|
| `mapTask()` | sonnet-5 | 20 | one-time per repo, cached in `repo_maps` table, injected into all later tasks for that repo |
| `planTask()` | sonnet-5 | 25 | read-only in practice; final message = the plan (returned verbatim to the human) |
| `reviseTask()` | sonnet-5 | 25 | plan + human feedback → revised plan |
| `implementTask()` | sonnet-5 **or** opus-4-8 (routed) | 120 | approved plan → code, tests, push, `gh pr create`; final message must be exactly the PR URL, or `PR_FAILED: <reason>`. Takes an optional `workBranch`: when set (a resumed run), it pins that branch (`git checkout -B <workBranch> origin/<workBranch> \|\| git checkout -b <workBranch>`) instead of branching fresh, and pushes after each meaningful step rather than once at the end, so a mid-run death leaves recoverable work on the remote |
| `reviewTask()` | sonnet-5 | 40 | self-review of big diffs + on-demand PR review; final message = the report |

Each task also carries an `effort` hint (`map`=low, `plan`/`revise`/`review`=medium,
`implement`=high) — the Agent SDK default is `high`; lowering it on bounded tasks cuts
thinking-token spend and, via fewer/faster turns, prompt-cache misses. `implementTask()`
routes its model from the plan's `Type:`/`Scope:` header (`routeImplement`): a small,
non-refactor change → sonnet-5 (near-Opus on coding, ~2.5× cheaper) at a $3 cap; large
work or any refactor → opus-4-8 at $8. A missing/garbled header defaults to opus-4-8
(no regression). `runner.mjs` sums per-turn usage into a **cumulative** `usage` on the
result (the SDK's own `result.usage` is only the final turn) and registers serena only
when a task's `allowedTools` include it.

`systemAppend` strings are **fixed, byte-stable text** (never interpolate per-run
content into them) so the Agent SDK's prompt cache hits across runs — per-run content
(issue body, repo map, plan) goes in `goal` instead. The plan's first two lines are the
fixed contract `Type: <…>` / `Scope: <small|large>`; `implementTask` parses them to route.

### Linear integration (`src/linear/`)

- `client.ts` — `LinearClient` (actor=app OAuth token, not a personal API key) +
  `makePlanFetcher`, a GraphQL fallback that recovers the last-posted plan straight
  from Linear's activity history when the local DB lost it (identified by
  `APPROVAL_FOOTER` in the elicitation body — this excludes non-plan elicitations).
- `activities.ts` — thin wrapper over `createAgentActivity` for the 5 activity types
  Linear's Agent Interaction API expects (`thought`, `action`, `response`, `error`,
  `elicitation`). `response`/`error`/`elicitation` retry (they gate phase transitions —
  a dropped post wedges the session); `thought`/`action` are one-shot telemetry.
- `context.ts` — payload → `IssueContext` extraction, and the approve/stop keyword
  parsers (`parseApproval`, `parseStop`) gating the state machine. These are
  intentionally a regex heuristic, not a classifier — see the `ponytail:` comment
  in the file for the known ceiling (sarcasm/edge phrasing) and upgrade path.

### Persistence (`src/store/sessions.ts`, SQLite via `node:sqlite`)

Five tables, no ORM: `sessions` (one row per Linear agent session — phase, plan,
sandboxId), `repo_maps` (one row per target repo, cached architecture map),
`runs` (one row per agent invocation — cost/tokens/outcome), `run_events` (raw
`JarvisEvent` stream per run, for `npm run report`'s failure-pattern mining),
`session_events` (phase transitions + host timings per session — approval dwell,
created→PR, and sandbox_create/clone/serena_index/history durations for the report).
Column migrations are hand-rolled (`ALTER TABLE ... ADD COLUMN` guarded by a
`pragma_table_info` check) since SQLite has no `ADD COLUMN IF NOT EXISTS`.

### Human gates (do not bypass in code)

1. **Plan approval** — Jarvis blocks in `await_approval` until a Linear reply parses
   as approval (`parseApproval`).
2. **PR approval** — Jarvis opens the PR; it never merges.

## Conventions specific to this repo

- `.ts` sources import each other with explicit `.ts` extensions (`moduleResolution: nodenext`,
  `rewriteRelativeImportExtensions: true`) — this is normal here, not a mistake.
- `src/agent/runner.mjs` is plain JS (not compiled, not type-checked) because it runs
  standalone inside the sandbox via `node runner.mjs`, copied verbatim by
  `e2b/build-template.ts` — keep its `INBOX_FILE`/`RESULT_FILE` path constants in sync
  with `src/sandbox/session.ts` by hand (no shared import between host and sandbox code).
- Every orchestrator error path both logs **and** posts a Linear activity — a webhook
  handler that throws silently leaves a session Linear marks unresponsive (10s rule).
- Tests fake the E2B `Sandbox`/`AgentSandbox` via the structural `AgentSandbox`
  interface in `sandbox/session.ts` — no real e2b/network calls in the suite.
- `// ponytail:` comments mark deliberate simplifications with a named ceiling and
  upgrade path (e.g. keyword-based approval parsing, retry-everything with no
  transient/permanent error split, no sandbox pooling) — read them before "fixing"
  what looks like missing robustness.
