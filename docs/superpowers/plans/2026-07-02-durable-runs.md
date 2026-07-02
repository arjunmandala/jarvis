# Durable Agent Runs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.
> Spec: `docs/superpowers/specs/2026-07-02-durable-runs-design.md`. Steps use checkbox syntax.

**Goal:** No agent run outcome is ever lost to a dead stream, a host restart, or a lost DB.
The result file in the sandbox is authoritative; Linear is the durable store for plans.

**Verification for every task:** `npm run typecheck && npm test` green before commit.

**Task order:** 1–4 are independent (parallel-safe). 5 needs 2+4. 6 needs 2+3+5.

---

## Task 1: runner.mjs writes the authoritative result file

**Files:** `src/agent/runner.mjs`

- [ ] Add `import { writeFileSync } from "node:fs"` (readFileSync already imported).
- [ ] Add `const RESULT_FILE = "/tmp/jarvis-result.json";`
- [ ] In the `message.type === "result"` branch: build the result event object once,
      `writeFileSync(RESULT_FILE, JSON.stringify(ev))` **before** `emit(ev)`.
- [ ] In the catch: build the error event object once, write it to `RESULT_FILE`
      (wrap the write in its own try/catch — a write failure must not mask the emit),
      then `emit(ev)` and `process.exit(1)`.
- [ ] No test (runs only inside the sandbox; exercised via Task 3's contract and acceptance).
      Note in the commit message that the template must be rebuilt
      (`node --env-file-if-exists=.env e2b/build-template.ts`) before this takes effect.
- [ ] Commit: `feat: runner writes authoritative result file before emitting`

---

## Task 2: session store — sandbox_id column + listByPhase

**Files:** `src/store/sessions.ts`, `tests/store/sessions.test.ts`

- [ ] TDD: failing tests first — `setSandbox`/`sandboxId` round-trip (including back to
      null), `listByPhase("plan", "implement")` returns only matching rows, and
      migration: a store opened twice on the same path doesn't throw.
- [ ] Add `sandbox_id TEXT` via the same column-migration pattern used for `plan`.
- [ ] `SessionRow` gains `sandboxId: string | null`; `get()` maps it.
- [ ] `setSandbox(agentSessionId: string, sandboxId: string | null): void` — UPDATE + updated_at.
- [ ] `listByPhase(...phases: Phase[]): SessionRow[]` — `WHERE phase IN (...)`, parameterized.
- [ ] Commit: `feat: persist sandbox id per session; list sessions by phase`

---

## Task 3: supervised runAgent — result file beats the stream

**Files:** `src/sandbox/session.ts`, `tests/sandbox/session.test.ts` (new)

Interfaces (exact):

```ts
export const RESULT_FILE = "/tmp/jarvis-result.json";

// Narrow structural type so tests can fake a sandbox without e2b.
export interface AgentSandbox {
  files: { read(path: string): Promise<string>; write(path: string, data: string): Promise<void> };
  commands: {
    run(cmd: string, opts: object): Promise<{ exitCode: number }>;
    list(): Promise<{ cmd: string; args: string[] }[]>;
  };
}

export async function readResultFile(sbx: AgentSandbox): Promise<JarvisEvent | null>;
// null unless the file parses to a JarvisEvent of kind result|error.

export interface WatchOpts { pollMs?: number; deadlineMs?: number; signal?: AbortSignal }
export async function watchDetached(sbx: AgentSandbox, opts?: WatchOpts): Promise<JarvisEvent | null>;
```

`watchDetached` loop (defaults pollMs=30_000, deadlineMs=55*60_000):
1. `readResultFile` → non-null? return it.
2. `commands.list()` → no entry whose `cmd`/`args` mention `runner.mjs`? The runner is
   gone: grace-wait one pollMs tick, one final `readResultFile`, return it (may be null).
3. Sleep pollMs (abortable — check `signal.aborted` and resolve null promptly).
4. Deadline exceeded → return null. Transient errors: tolerate 3 consecutive, then null.

`runAgent` changes (same public signature):
- Start the streaming run as today but don't await it directly; wrap so
  `CommandExitError` resolves (exitCode) instead of throwing.
- `Promise.race([streamEnd, watchDetached(sbx, { signal })])`.
- After the race: abort the loser (AbortController; attach `.catch(() => {})` to the
  abandoned stream promise so nothing rejects unhandled).
- Result precedence: last result/error event from the stream (after `parser.flush()`),
  else one `readResultFile`, else the watcher's event, else null. exitCode −1 when the
  stream never finished.
- `runCommand` keeps `timeoutMs: 0` (clone/tests); only `runAgent` gets supervision.

- [ ] TDD with a fake `AgentSandbox` and pollMs≈10ms:
      (a) stream delivers result → returned, watcher aborted (no stray timers);
      (b) stream never settles, process list empty, file present → file result returned;
      (c) stream never settles, file never appears, deadline → `{ result: null }`;
      (d) `readResultFile` rejects non-event JSON and unreadable files → null.
- [ ] Commit: `feat: runAgent supervised by result-file watcher; dead streams cannot hang runs`

---

## Task 4: retried terminal activity posts

**Files:** `src/linear/activities.ts`, `tests/linear/activities.test.ts`

- [ ] TDD: fake client failing twice then succeeding → `response` resolves, 3 calls made;
      failing persistently → rejects after 3 attempts; `action`/`thought` do not retry.
- [ ] Internal `withRetry(fn)` — 3 attempts, waits 1s then 5s (injectable `sleep` or
      vitest fake timers so tests don't actually wait).
- [ ] Apply to `response`, `error`, `elicitation` only.
- [ ] Commit: `feat: retry terminal Linear activity posts (response/error/elicitation)`

---

## Task 5: pipeline — sandbox tracking, cost lines, plan recovery from Linear

**Files:** `src/orchestrator/pipeline.ts`, `src/linear/context.ts`, `src/linear/client.ts`,
`tests/orchestrator/pipeline.test.ts`, `tests/linear/client.test.ts` (new)

- [ ] Move the approval footer to `src/linear/context.ts`:
      `export const APPROVAL_FOOTER = '\n\n---\n**Reply "approve" to have me implement this**, or tell me what to change.';`
      Pipeline imports it (elicitation body becomes `plan + APPROVAL_FOOTER`).
- [ ] `src/linear/client.ts`: add
      `export function makePlanFetcher(accessToken: string, fetchImpl: typeof fetch = fetch): (agentSessionId: string) => Promise<string | null>`
      — POST `https://api.linear.app/graphql` (`authorization: Bearer <token>`), query:
      `query($id: String!) { agentSession(id: $id) { activities(first: 250) { nodes { content { __typename ... on AgentActivityElicitationContent { body } } } } } }`
      Among elicitation nodes whose body **contains** `APPROVAL_FOOTER` (this excludes
      the "not implementing yet" re-elicitations), take the last, strip the footer,
      return trimmed text; null on no match, HTTP failure, or GraphQL errors.
- [ ] TDD `makePlanFetcher` with a fake `fetchImpl`: happy path, multiple elicitations
      (picks the footer-bearing one), no sessions/activities → null, HTTP 500 → null.
- [ ] `Orchestrator` constructor gains optional 4th param
      `fetchPlan?: (agentSessionId: string) => Promise<string | null>` (existing tests unchanged).
- [ ] onCreated/onPrompted: first line inside the `withSandbox` callback:
      `this.#store.setSandbox(ctx.agentSessionId, sbx.sandboxId)`.
- [ ] onPrompted approved path: if `row.plan` is empty and `fetchPlan` is set, await it;
      on success `setPlan` + log `[recover]`, then proceed; only then the existing
      missing-plan error path. TDD: fetchPlan returning null still errors (no sandbox
      call); recovered-plan persistence observable via `store.get().plan`.
- [ ] Cost lines (Phase 4.1): plan elicitation and final PR response append
      `\n\n_Cost: $X.XXXX_` when the run result carries `costUsd` (helper `costLine(result)`).
      Keep `APPROVAL_FOOTER` the **last** thing in the elicitation body (recovery strips
      from the footer on; cost line sits before it and is stripped along with nothing —
      place cost line **after** the footer instead so the recovered plan stays clean:
      body = `plan + APPROVAL_FOOTER + costLine`).
- [ ] `server.ts`: pass `makePlanFetcher(config.linear.accessToken)` as the 4th arg.
- [ ] Commit: `feat: plan recovery from Linear elicitation; sandbox tracking; cost lines`

---

## Task 6: boot reconciliation — no session left hanging

**Files:** `src/orchestrator/pipeline.ts`, `src/server.ts`, `tests/orchestrator/pipeline.test.ts`

- [ ] Refactor the post-run tails into private methods (pure moves, no behaviour change):
      `#finishPlan(agentSessionId, acts, result)` — everything after the plan run in onCreated;
      `#finishImplement(agentSessionId, acts, result)` — everything after the implement run.
- [ ] `async reconcile(): Promise<void>` on Orchestrator:
      for each `store.listByPhase("plan", "implement")` row (Promise.allSettled, per-row try/catch):
      - No `sandboxId` → `acts.error("A restart interrupted this run before its sandbox was recorded — re-assign the issue to retry.")`, phase `error`.
      - Else `Sandbox.connect(row.sandboxId, { apiKey: config.e2bApiKey })`;
        `watchDetached(sbx)` → result event? `#finishPlan`/`#finishImplement` by phase.
        Connect failure or null result → `acts.error("A restart interrupted this run — re-assign the issue to retry.")`, phase `error`.
      - Always `sbx.kill().catch(() => undefined)` when connected. Log `[reconcile]` per session.
- [ ] `server.ts`: after constructing the orchestrator,
      `void orchestrator.reconcile().catch((e) => console.error("[reconcile]", e))`.
- [ ] TDD (in-memory store, fake acts; inject sandbox connection as an optional ctor/opts
      seam so tests don't touch e2b):
      (a) stuck `plan` row without sandboxId → error activity + phase `error`;
      (b) stuck `plan` row whose injected connector yields a result-file event →
          elicitation posted + phase `await_approval` + plan persisted;
      (c) `done` rows untouched.
- [ ] Commit: `feat: boot reconciliation recovers or fails-loud every in-flight session`

---

## Acceptance (manual, after template rebuild)

1. Rebuild the template so the new runner lands; assign a test issue → plan arrives (with cost line).
2. Mid-plan-run, kill the dev server; restart → reconcile recovers the plan and posts the elicitation.
3. Wipe `plan` from the DB row, reply "approve" → plan recovered from Linear, implement proceeds.
4. `npm run typecheck && npm test` green.
