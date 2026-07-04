# Telemetry Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make run telemetry answer the roadmap's Phase-1 questions — durations, model/route success rates, host-phase timings, human-gate latency — and surface it in `npm run report` (console) plus a self-contained HTML dashboard.

**Architecture:** All additive: two new columns on `runs` (`model`, `effort`), one new `session_events` table (phase transitions + host timings), indexes, and fixes at existing write seams (`#trackedRun`, `reconcile`, `setPhase`/`upsert`, `withSandbox`/`cloneRepo`). The report splits into a data layer (`src/report/data.ts`), an HTML renderer (`src/report/html.ts`), and the entry (`src/report.ts`).

**Tech Stack:** Node ≥ 24.15 (`node:sqlite`), TypeScript, vitest. No new dependencies.

Spec: `docs/superpowers/specs/2026-07-04-telemetry-foundation-design.md`

## Global Constraints

- `.ts` sources import each other with explicit `.ts` extensions (repo convention).
- SQLite tables are `STRICT`; migrations are hand-rolled `ALTER TABLE` guarded by `pragma_table_info` checks (no `ADD COLUMN IF NOT EXISTS` in SQLite).
- All new telemetry writes are advisory: wrap in try/catch, log `[telemetry] …` via `console.error`, never fail the run.
- Tests never touch e2b/network — fake sandboxes via the structural `AgentSandbox` interface.
- Do NOT touch `systemAppend` strings in `src/agent/tasks.ts` (prompt-cache byte-stability).
- The report must degrade gracefully against an old, not-yet-migrated DB (pragma-guard missing columns/tables) — it opens read-only and migrations only run when the server starts.
- HTML dashboard is fully self-contained: inline CSS/SVG/JS, zero external requests.
- Run the full suite with `npx vitest run`; typecheck with `npm run typecheck`.

---

### Task 1: `runs.model` / `runs.effort` columns + indexes

**Files:**
- Modify: `src/store/sessions.ts` (constructor migration block ~line 96–110; `createRun` ~line 131)
- Test: `tests/store/sessions.test.ts`

**Interfaces:**
- Produces: `createRun(agentSessionId: string, taskType: string, repo: string | null, model?: string | null, effort?: string | null): number` — existing 3-arg callers keep working (new params default to `null`).

- [ ] **Step 1: Write the failing test**

Append to `tests/store/sessions.test.ts` (imports `DatabaseSync` — add `import { DatabaseSync } from "node:sqlite";` at the top of the file):

```ts
describe("runs model/effort columns", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("records model and effort when provided, null otherwise", () => {
    dir = mkdtempSync(join(tmpdir(), "sessions-test-"));
    const path = join(dir, "runs.db");
    const s = new SessionStore(path);
    const withModel = s.createRun("as_me", "implement", "o/r", "claude-opus-4-8", "high");
    const without = s.createRun("as_me", "map", "o/r");
    s.close();
    // the store has no per-run getter — the report reads SQL directly, so verify the same way
    const db = new DatabaseSync(path, { readOnly: true });
    const rows = db.prepare(`SELECT id, model, effort FROM runs ORDER BY id`).all() as
      { id: number; model: string | null; effort: string | null }[];
    db.close();
    expect(rows.find((r) => r.id === withModel)).toMatchObject({ model: "claude-opus-4-8", effort: "high" });
    expect(rows.find((r) => r.id === without)).toMatchObject({ model: null, effort: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/sessions.test.ts -t "records model and effort"`
Expected: FAIL with `no such column: model`

- [ ] **Step 3: Implement**

In `src/store/sessions.ts`, extend the existing `runCols` migration block (directly after the `tokens_cache_write` guard):

```ts
    if (!runCols.some((c) => c.name === "model")) {
      this.#db.exec(`ALTER TABLE runs ADD COLUMN model TEXT`);
    }
    if (!runCols.some((c) => c.name === "effort")) {
      this.#db.exec(`ALTER TABLE runs ADD COLUMN effort TEXT`);
    }
```

Directly after the `run_events` `CREATE TABLE`, add the indexes:

```ts
    // Read paths: run_events by run (report, history export), runs by session
    // (history export, finishOpenRun). IF NOT EXISTS keeps re-open safe.
    this.#db.exec(`CREATE INDEX IF NOT EXISTS idx_run_events_run_id ON run_events(run_id)`);
    this.#db.exec(`CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(agent_session_id)`);
```

Replace `createRun` with:

```ts
  createRun(
    agentSessionId: string,
    taskType: string,
    repo: string | null,
    model: string | null = null,
    effort: string | null = null,
  ): number {
    const r = this.#db
      .prepare(
        `INSERT INTO runs (agent_session_id, task_type, repo, started_at, model, effort) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(agentSessionId, taskType, repo, new Date().toISOString(), model, effort);
    return Number(r.lastInsertRowid);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/store/sessions.test.ts`
Expected: PASS (all — including the pre-existing migration test proving double-open doesn't throw)

- [ ] **Step 5: Commit**

```bash
git add src/store/sessions.ts tests/store/sessions.test.ts
git commit -m "feat(telemetry): record model/effort per run; index runs and run_events"
```

---

### Task 2: `session_events` table — phase transitions + host timings

**Files:**
- Modify: `src/store/sessions.ts` (constructor; `upsert` ~line 157; `setPhase` ~line 170; new methods)
- Test: `tests/store/sessions.test.ts`

**Interfaces:**
- Produces:
  - `interface SessionEvent { ts: string; kind: "phase" | "timing"; label: string; ms: number | null }` (exported)
  - `addTiming(agentSessionId: string, label: string, ms: number): void`
  - `listSessionEvents(agentSessionId: string): SessionEvent[]`
  - `upsert`/`setPhase` now write a `kind='phase'` event **only when the phase actually changes**.

- [ ] **Step 1: Write the failing tests**

Append to `tests/store/sessions.test.ts`:

```ts
describe("session events", () => {
  it("records a phase event only on actual phase changes", () => {
    const s = new SessionStore(":memory:");
    s.upsert("as_e1", "plan", "iss"); // change (new row)
    s.upsert("as_e1", "plan", "iss"); // duplicate webhook — no change
    s.setPhase("as_e1", "await_approval"); // change
    s.setPhase("as_e1", "await_approval"); // no change
    s.setPhase("as_e1", "implement"); // change
    const evs = s.listSessionEvents("as_e1");
    expect(evs.map((e) => [e.kind, e.label])).toEqual([
      ["phase", "plan"],
      ["phase", "await_approval"],
      ["phase", "implement"],
    ]);
    expect(evs.every((e) => e.ms === null)).toBe(true);
    s.close();
  });

  it("setPhase on an unknown session records nothing", () => {
    const s = new SessionStore(":memory:");
    s.setPhase("missing", "done");
    expect(s.listSessionEvents("missing")).toEqual([]);
    s.close();
  });

  it("addTiming records rounded timing events in order", () => {
    const s = new SessionStore(":memory:");
    s.upsert("as_e2", "plan", "iss");
    s.addTiming("as_e2", "sandbox_create", 1234.6);
    s.addTiming("as_e2", "clone", 900);
    const evs = s.listSessionEvents("as_e2").filter((e) => e.kind === "timing");
    expect(evs.map((e) => [e.label, e.ms])).toEqual([
      ["sandbox_create", 1235],
      ["clone", 900],
    ]);
    s.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/store/sessions.test.ts -t "session events"`
Expected: FAIL with `listSessionEvents is not a function`

- [ ] **Step 3: Implement**

In `src/store/sessions.ts`, add the exported type next to `RunLog`:

```ts
// One session_events row: a phase transition (ms NULL) or a host-side timing
// (sandbox_create / clone / serena_index / history) in elapsed milliseconds.
export interface SessionEvent {
  ts: string;
  kind: "phase" | "timing";
  label: string;
  ms: number | null;
}
```

In the constructor, after the `run_events` table + indexes:

```ts
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS session_events (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_session_id TEXT NOT NULL,
        ts               TEXT NOT NULL,
        kind             TEXT NOT NULL,
        label            TEXT NOT NULL,
        ms               INTEGER
      ) STRICT
    `);
    this.#db.exec(`CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(agent_session_id)`);
```

Add the methods (near `addRunEvent`):

```ts
  #addSessionEvent(agentSessionId: string, kind: "phase" | "timing", label: string, ms: number | null): void {
    this.#db
      .prepare(`INSERT INTO session_events (agent_session_id, ts, kind, label, ms) VALUES (?, ?, ?, ?, ?)`)
      .run(agentSessionId, new Date().toISOString(), kind, label, ms);
  }

  // Host-side wall-clock telemetry (sandbox_create / clone / serena_index / history).
  addTiming(agentSessionId: string, label: string, ms: number): void {
    this.#addSessionEvent(agentSessionId, "timing", label, Math.round(ms));
  }

  listSessionEvents(agentSessionId: string): SessionEvent[] {
    return this.#db
      .prepare(`SELECT ts, kind, label, ms FROM session_events WHERE agent_session_id = ? ORDER BY id ASC`)
      .all(agentSessionId) as unknown as SessionEvent[];
  }

  #currentPhase(agentSessionId: string): Phase | undefined {
    const row = this.#db.prepare(`SELECT phase FROM sessions WHERE agent_session_id = ?`).get(agentSessionId) as
      | { phase: Phase }
      | undefined;
    return row?.phase;
  }
```

Modify `upsert` — read the previous phase first, record an event only on change:

```ts
  upsert(agentSessionId: string, phase: Phase, issueId: string | null = null): void {
    const prev = this.#currentPhase(agentSessionId);
    this.#db
      .prepare(
        `INSERT INTO sessions (agent_session_id, phase, issue_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_session_id)
         DO UPDATE SET phase = excluded.phase,
                       issue_id = COALESCE(excluded.issue_id, sessions.issue_id),
                       updated_at = excluded.updated_at`,
      )
      .run(agentSessionId, phase, issueId, new Date().toISOString());
    // Phase history feeds the report's latency metrics (approval dwell,
    // created→PR). Only actual transitions — duplicate webhooks re-upsert
    // the same phase and must not spam events.
    if (prev !== phase) this.#addSessionEvent(agentSessionId, "phase", phase, null);
  }
```

Modify `setPhase` the same way (unknown session stays a no-op — no event):

```ts
  setPhase(agentSessionId: string, phase: Phase): void {
    const prev = this.#currentPhase(agentSessionId);
    this.#db
      .prepare(`UPDATE sessions SET phase = ?, updated_at = ? WHERE agent_session_id = ?`)
      .run(phase, new Date().toISOString(), agentSessionId);
    if (prev !== undefined && prev !== phase) this.#addSessionEvent(agentSessionId, "phase", phase, null);
  }
```

- [ ] **Step 4: Run the store suite**

Run: `npx vitest run tests/store/sessions.test.ts`
Expected: PASS. Note: pre-existing tests calling `upsert`/`setPhase` now also write phase events — none of them assert on `session_events`, so they stay green.

- [ ] **Step 5: Run the WHOLE suite (pipeline/history tests call setPhase heavily)**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/store/sessions.ts tests/store/sessions.test.ts
git commit -m "feat(telemetry): session_events table — phase transitions and host timings"
```

---

### Task 3: `finishOpenRun` + `markInterruptedRuns`

**Files:**
- Modify: `src/store/sessions.ts` (new methods near `finishRun`)
- Test: `tests/store/sessions.test.ts`

**Interfaces:**
- Consumes: `finishRun(runId, f: RunFinish)` (existing), `RunFinish` (existing).
- Produces:
  - `finishOpenRun(agentSessionId: string, f: RunFinish): number | null` — closes the session's latest run with `ended_at IS NULL`, returns its id or `null`.
  - `markInterruptedRuns(beforeIso: string): number` — stamps `outcome='interrupted'`, `ended_at=now` on every open run with `started_at <= beforeIso`, returns the count.

- [ ] **Step 1: Write the failing tests**

Append to `tests/store/sessions.test.ts`:

```ts
describe("finishOpenRun and markInterruptedRuns", () => {
  const FINISH = {
    outcome: "success", costUsd: 0.1, numTurns: 3,
    tokensIn: 10, tokensOut: 20, tokensCacheRead: 5, tokensCacheWrite: 2, error: null,
  };

  it("finishOpenRun closes the latest open run and returns its id", () => {
    const s = new SessionStore(":memory:");
    const closed = s.createRun("as_o1", "map", "o/r");
    s.finishRun(closed, FINISH);
    const open = s.createRun("as_o1", "plan", "o/r");
    expect(s.finishOpenRun("as_o1", FINISH)).toBe(open);
    expect(s.finishOpenRun("as_o1", FINISH)).toBeNull(); // nothing left open
    expect(s.getRunLogsBySession("as_o1").map((l) => l.outcome)).toEqual(["success", "success"]);
    s.close();
  });

  it("finishOpenRun returns null for a session with no runs", () => {
    const s = new SessionStore(":memory:");
    expect(s.finishOpenRun("as_none", FINISH)).toBeNull();
    s.close();
  });

  it("markInterruptedRuns sweeps only still-open runs started at or before the cutoff", () => {
    const s = new SessionStore(":memory:");
    const open = s.createRun("as_s1", "implement", "o/r");
    const closed = s.createRun("as_s1", "plan", "o/r");
    s.finishRun(closed, FINISH);
    expect(s.markInterruptedRuns(new Date().toISOString())).toBe(1);
    const logs = s.getRunLogsBySession("as_s1");
    expect(logs.find((l) => l.runId === open)?.outcome).toBe("interrupted");
    expect(logs.find((l) => l.runId === closed)?.outcome).toBe("success");
    expect(s.markInterruptedRuns(new Date().toISOString())).toBe(0); // idempotent
    s.close();
  });

  it("does not sweep runs started after the cutoff", () => {
    const s = new SessionStore(":memory:");
    const cutoff = new Date(Date.now() - 60_000).toISOString(); // one minute ago
    s.createRun("as_s2", "plan", "o/r");
    expect(s.markInterruptedRuns(cutoff)).toBe(0);
    s.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/store/sessions.test.ts -t "finishOpenRun"`
Expected: FAIL with `finishOpenRun is not a function`

- [ ] **Step 3: Implement**

Add to `src/store/sessions.ts`, directly after `finishRun`:

```ts
  // Reconcile's seam: a restart loses the in-memory runId, so the recovered run
  // is found as "latest still-open run for this session". Returns the closed
  // run's id, or null when the session has no open run.
  finishOpenRun(agentSessionId: string, f: RunFinish): number | null {
    const row = this.#db
      .prepare(`SELECT id FROM runs WHERE agent_session_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1`)
      .get(agentSessionId) as { id: number } | undefined;
    if (!row) return null;
    this.finishRun(row.id, f);
    return row.id;
  }

  // Boot sweep: any run still open from before boot died with its host. `<=` not
  // `<`: a run created in the same millisecond the cutoff was captured is
  // pre-boot by construction (the sweep runs after reconciliation completes).
  markInterruptedRuns(beforeIso: string): number {
    const r = this.#db
      .prepare(`UPDATE runs SET outcome = 'interrupted', ended_at = ? WHERE ended_at IS NULL AND started_at <= ?`)
      .run(new Date().toISOString(), beforeIso);
    return Number(r.changes);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/store/sessions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/sessions.ts tests/store/sessions.test.ts
git commit -m "feat(telemetry): finishOpenRun + markInterruptedRuns store methods"
```

---

### Task 4: Pipeline — record model/effort, `runFinishFrom`, reconcile closes orphaned runs, boot sweep

**Files:**
- Modify: `src/orchestrator/pipeline.ts` (imports; new exported fn after `recoverPlan` ~line 78; `#logUsage` ~line 144; `#trackedRun` ~line 226; `reconcile` ~line 670)
- Test: `tests/orchestrator/pipeline.test.ts`

**Interfaces:**
- Consumes: `createRun(sessionId, taskType, repo, model, effort)` (Task 1), `finishOpenRun` / `markInterruptedRuns` (Task 3), `RunFinish` from `../store/sessions.ts`, `AgentTask.model` / `AgentTask.effort` (existing).
- Produces: `export function runFinishFrom(result: JarvisEvent | null): RunFinish` — used by `#logUsage`, `reconcile`, and Task 4's tests.

- [ ] **Step 1: Write the failing tests**

Append to `tests/orchestrator/pipeline.test.ts`. Add `runFinishFrom` to the existing import from `../../src/orchestrator/pipeline.ts`.

```ts
describe("runFinishFrom", () => {
  it("maps a success result with usage", () => {
    expect(
      runFinishFrom({
        kind: "result", subtype: "success", text: "https://github.com/o/r/pull/1",
        costUsd: 1.25, sessionId: null, numTurns: 7,
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
      }),
    ).toEqual({
      outcome: "success", costUsd: 1.25, numTurns: 7,
      tokensIn: 10, tokensOut: 20, tokensCacheRead: 30, tokensCacheWrite: 40, error: null,
    });
  });

  it("maps PR_FAILED text to the pr_failed outcome", () => {
    const f = runFinishFrom({ kind: "result", subtype: "success", text: "PR_FAILED: no permission", costUsd: null, sessionId: null });
    expect(f.outcome).toBe("pr_failed");
  });

  it("maps error events and null results", () => {
    expect(runFinishFrom({ kind: "error", message: "boom" })).toMatchObject({ outcome: "error", error: "boom" });
    expect(runFinishFrom(null)).toMatchObject({ outcome: "no_result", costUsd: null });
  });
});

describe("reconcile telemetry", () => {
  const RESULT_JSON = JSON.stringify({
    kind: "result", subtype: "success", text: "Type: chore\nScope: small\n\n- do it",
    costUsd: 0.4, sessionId: null, numTurns: 3,
    usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
  });

  // Minimal Reconnected fake: watchDetached reads RESULT_FILE on its first poll,
  // so a resolving files.read returns immediately — no timers involved.
  function fakeConnect(resultJson: string | null) {
    return async () => ({
      files: {
        read: async () => {
          if (resultJson == null) throw new Error("ENOENT");
          return resultJson;
        },
        write: async () => ({}),
      },
      commands: { run: async () => ({ exitCode: 0 }), list: async () => [] },
      kill: async () => undefined,
    });
  }

  it("closes the orphaned runs row with the recovered result", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_rc1", "plan", "iss");
    store.setSandbox("as_rc1", "sbx_1");
    store.createRun("as_rc1", "plan", "o/r"); // left open by the dead host
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log), undefined, fakeConnect(RESULT_JSON));
    await orch.reconcile();
    expect(store.getRunLogsBySession("as_rc1").map((l) => l.outcome)).toEqual(["success"]);
    expect(store.get("as_rc1")?.phase).toBe("await_approval"); // #finishPlan replayed
    expect(log.some((l) => l.startsWith("elicitation:"))).toBe(true);
    store.close();
  });

  it("sweeps unrecoverable open runs as interrupted", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_rc2", "plan", "iss"); // no sandboxId — reconcile fails it loud
    store.createRun("as_rc2", "plan", "o/r");
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log), undefined, fakeConnect(null));
    await orch.reconcile();
    expect(store.getRunLogsBySession("as_rc2").map((l) => l.outcome)).toEqual(["interrupted"]);
    expect(store.get("as_rc2")?.phase).toBe("error");
    store.close();
  });

  it("sweeps orphans even when no sessions are in a run phase", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_rc3", "done", "iss"); // session moved on; run row left open
    store.createRun("as_rc3", "review", "o/r");
    const orch = new Orchestrator({} as Config, store, () => fakeActs([]));
    await orch.reconcile();
    expect(store.getRunLogsBySession("as_rc3").map((l) => l.outcome)).toEqual(["interrupted"]);
    store.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/orchestrator/pipeline.test.ts -t "runFinishFrom"`
Expected: FAIL — `runFinishFrom` is not exported.

- [ ] **Step 3: Implement**

In `src/orchestrator/pipeline.ts`:

(a) Extend the store type import:

```ts
import type { SessionStore, Phase, SessionRow, RunFinish } from "../store/sessions.ts";
```

(b) Add after `recoverPlan` (module scope):

```ts
// Result → runs-row mapping, shared by the live path (#logUsage) and reconcile
// (which lost the in-memory runId across the restart and closes the row via
// finishOpenRun instead).
export function runFinishFrom(result: JarvisEvent | null): RunFinish {
  const outcome =
    result == null ? "no_result"
    : result.kind === "error" ? "error"
    : result.kind !== "result" ? "no_result"
    : result.text?.trim().startsWith("PR_FAILED:") ? "pr_failed"
    : result.subtype;
  const u = result?.kind === "result" ? result.usage ?? {} : {};
  return {
    outcome,
    costUsd: result?.kind === "result" ? result.costUsd : null,
    numTurns: result?.kind === "result" ? (result.numTurns ?? null) : null,
    tokensIn: u.input_tokens ?? 0, // uncached input; cache tokens tracked separately
    tokensOut: u.output_tokens ?? 0,
    tokensCacheRead: u.cache_read_input_tokens ?? 0,
    tokensCacheWrite: u.cache_creation_input_tokens ?? 0,
    error: result?.kind === "error" ? result.message : null,
  };
}
```

(c) `#logUsage`: keep the `console.log` half verbatim; replace everything from `if (runId == null) return;` down with:

```ts
    if (runId == null) return;
    try {
      this.#store.finishRun(runId, runFinishFrom(result));
    } catch (err) {
      console.error(`[telemetry] finishRun failed: ${err instanceof Error ? err.message : String(err)}`);
    }
```

(d) `#trackedRun`: replace the `createRun` call with:

```ts
      // effort defaults to "high" in the runner when unset — record the effective value
      runId = this.#store.createRun(sessionId, taskType, this.#config.targetRepo, task.model, task.effort ?? "high");
```

(e) `reconcile()`: two changes. First, right after `this.#logUsage(\`reconcile ${id}\`, result);` add:

```ts
            // The restart lost the in-memory runId — close the orphaned runs row
            // with the recovered result so the sweep below doesn't mislabel it.
            try {
              const closed = this.#store.finishOpenRun(id, runFinishFrom(result));
              if (closed != null) console.log(`[reconcile] ${id} closed orphaned run ${closed}`);
            } catch (err) {
              console.error(`[telemetry] finishOpenRun failed: ${err instanceof Error ? err.message : String(err)}`);
            }
```

Second, restructure the method body so the sweep always runs (note the early-return on zero rows is replaced by an `if` so the `finally` still executes):

```ts
  async reconcile(): Promise<void> {
    const bootIso = new Date().toISOString();
    try {
      const rows = this.#store.listByPhase("plan", "implement", "review");
      if (rows.length > 0) {
        console.log(`[reconcile] ${rows.length} in-flight session(s) to reconcile`);
        await Promise.allSettled(
          rows.map(async (row) => {
            // … existing per-row body, unchanged except the (e) insertion above …
          }),
        );
      }
    } finally {
      // Whatever recovery didn't close above died with the previous host — stamp
      // it so aggregates stay honest. Runs started after boot are untouched.
      try {
        const n = this.#store.markInterruptedRuns(bootIso);
        if (n > 0) console.log(`[reconcile] marked ${n} orphaned run(s) interrupted`);
      } catch (err) {
        console.error(`[telemetry] markInterruptedRuns failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/orchestrator/pipeline.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck + full suite**

Run: `npm run typecheck && npx vitest run`
Expected: both clean

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/pipeline.ts tests/orchestrator/pipeline.test.ts
git commit -m "fix(telemetry): reconcile closes orphaned runs; boot sweep marks the rest interrupted; record model/effort"
```

---

### Task 5: Host timing seams — `onTiming` in `SandboxConfig`, timed clone/index/create/history

**Files:**
- Modify: `src/sandbox/session.ts` (`SandboxConfig` ~line 5; `withSandbox` ~line 36; `cloneRepo` ~line 57)
- Modify: `src/orchestrator/pipeline.ts` (`#sbxCfg` ~line 118; new `#timed` helper; the 4 `prepareHistory` call sites and every `this.#sbxCfg()` call site)
- Test: `tests/sandbox/session.test.ts`

**Interfaces:**
- Consumes: `store.addTiming(sessionId, label, ms)` (Task 2).
- Produces: `SandboxConfig.onTiming?: (label: string, ms: number) => void`; labels emitted: `sandbox_create`, `clone`, `serena_index`, `history`.

- [ ] **Step 1: Write the failing test**

In `tests/sandbox/session.test.ts`, inside the existing `describe("cloneRepo", …)` block (it already has a `cfg` const and the `makeFake` helper):

```ts
  it("emits clone and serena_index timings via cfg.onTiming", async () => {
    const f = makeFake({});
    f.sbx.commands.run = async (cmd: string) => {
      f.commandLog.push(cmd);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const seen: string[] = [];
    const timed: SandboxConfig = { ...cfg, onTiming: (label, ms) => seen.push(`${label}:${ms >= 0}`) };
    await cloneRepo(f.sbx as never, timed);
    expect(seen).toEqual(["clone:true", "serena_index:true"]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sandbox/session.test.ts -t "onTiming"`
Expected: FAIL — `onTiming` is not a known property of `SandboxConfig` (typecheck) / `seen` stays empty.

- [ ] **Step 3: Implement session.ts**

Extend `SandboxConfig`:

```ts
export interface SandboxConfig {
  apiKey: string;
  template: string;
  ghToken: string;
  targetRepo: string; // "owner/name"
  // Host-side wall-clock telemetry: called with (label, elapsedMs) for
  // sandbox_create / clone / serena_index. Callers supply a non-throwing callback.
  onTiming?: (label: string, ms: number) => void;
}
```

In `withSandbox`, time the create:

```ts
export async function withSandbox<T>(cfg: SandboxConfig, fn: (sbx: Sandbox) => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const sbx = await withRetries("sandbox.create", () =>
    Sandbox.create(cfg.template, {
      apiKey: cfg.apiKey,
      timeoutMs: 60 * 60 * 1000, // 1h; one sandbox per agent run
      metadata: { app: "jarvis" },
      envs: { GH_TOKEN: cfg.ghToken },
    }),
  );
  cfg.onTiming?.("sandbox_create", Date.now() - t0);
  try {
    return await fn(sbx);
  } finally {
    await sbx.kill().catch(() => undefined);
  }
}
```

In `cloneRepo`, time the clone and the index separately:

```ts
  const cloneStart = Date.now();
  await withRetries("git clone", async () => {
    const res = await runCommand(sbx, `git clone ${branchFlag}${url} ${REPO_DIR}`);
    if (res.exitCode !== 0) {
      throw new Error(redactSecret(`git clone failed (${res.exitCode}): ${res.stderr}`, cfg.ghToken));
    }
  });
  cfg.onTiming?.("clone", Date.now() - cloneStart);
  const indexStart = Date.now();
  await indexRepo(sbx, cfg.ghToken);
  cfg.onTiming?.("serena_index", Date.now() - indexStart);
```

- [ ] **Step 4: Implement pipeline.ts wiring**

Replace `#sbxCfg` with:

```ts
  // sessionId opts the sandbox lifecycle into timing telemetry (session_events);
  // omitted (tests, no-session contexts) → no callback, same behavior as before.
  #sbxCfg(sessionId?: string) {
    return {
      apiKey: this.#config.e2bApiKey, template: this.#config.e2bTemplate,
      ghToken: this.#config.ghToken, targetRepo: this.#config.targetRepo,
      onTiming: sessionId === undefined ? undefined : (label: string, ms: number) => {
        try {
          this.#store.addTiming(sessionId, label, ms);
        } catch (err) {
          console.error(`[telemetry] addTiming failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    };
  }
```

Add the `#timed` helper (near `#record`):

```ts
  // Times an awaited step into session_events. Advisory: a failed write logs
  // and the step's own result/throw passes through untouched.
  async #timed<T>(sessionId: string, label: string, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      try {
        this.#store.addTiming(sessionId, label, Date.now() - t0);
      } catch (err) {
        console.error(`[telemetry] addTiming failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
```

Update every `this.#sbxCfg()` call to pass the session id — there are 8, all inside methods that have `ctx.agentSessionId` in scope: `#runPlan` (the `withSandbox` arg and both `cloneRepo` args — the outer `this.#sbxCfg()` passed to `withSandbox` and the one passed to `cloneRepo`), `onPrompted`'s revise block (2), `#runImplement` (2), `#onDoneFollowUp` (2). Each becomes `this.#sbxCfg(ctx.agentSessionId)`.

Wrap all 4 `prepareHistory` call sites (in `#runPlan`, `onPrompted` revise block, `#runImplement`, `#onDoneFollowUp`):

```ts
        const history = await this.#timed(ctx.agentSessionId, "history", () =>
          prepareHistory(this.#store, sbx, ctx.issueId, this.#fetchThread),
        );
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS / clean. (`withSandbox` timing itself is e2b-bound → live acceptance, per repo convention.)

- [ ] **Step 6: Commit**

```bash
git add src/sandbox/session.ts src/orchestrator/pipeline.ts tests/sandbox/session.test.ts
git commit -m "feat(telemetry): time sandbox_create/clone/serena_index/history into session_events"
```

---

### Task 6: Report data layer — `src/report/data.ts`

**Files:**
- Create: `src/report/data.ts`
- Test: `tests/report/data.test.ts` (new directory)

**Interfaces:**
- Consumes: the SQLite schema (Tasks 1–3); `SessionStore` only in tests (seeding).
- Produces (all exported, consumed by Task 7):
  - `interface RunRow { id; taskType; startedAt; endedAt; outcome; costUsd; numTurns; tokensOut; cacheRead; cacheWrite; model; effort; error; durationMs }`
  - `interface PhaseEvent { sessionId: string; ts: string; label: string }`
  - `interface TimingRow { label: string; ms: number }`
  - `interface FailureGroup { key: string; n: number }`
  - `interface FailedRun { id; taskType; outcome; error; lastEvents: { ts; type; payload }[] }`
  - `interface ReportData { generatedAt; runs; timings; phaseEvents; sessionsWithPr; failureGroups; failedRuns }`
  - `gatherReport(db: DatabaseSync): ReportData`
  - `percentile(values: number[], p: number): number | null` (nearest-rank)
  - `cacheHitRate(cacheRead: number, cacheWrite: number): number | null`
  - `approvalDwellsMs(events: PhaseEvent[]): number[]`
  - `createdToPrMs(events: PhaseEvent[], sessionsWithPr: string[]): number[]`

- [ ] **Step 1: Write the failing tests**

Create `tests/report/data.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionStore } from "../../src/store/sessions.ts";
import {
  gatherReport, percentile, cacheHitRate, approvalDwellsMs, createdToPrMs,
  type PhaseEvent,
} from "../../src/report/data.ts";

describe("pure aggregates", () => {
  it("percentile uses nearest-rank and handles edges", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([10], 50)).toBe(10);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 90)).toBe(4);
    expect(percentile([3, 1, 2], 100)).toBe(3); // unsorted input is fine
  });

  it("cacheHitRate is read/(read+write), null with no cache traffic", () => {
    expect(cacheHitRate(0, 0)).toBeNull();
    expect(cacheHitRate(300, 100)).toBe(0.75);
  });

  it("approvalDwellsMs measures each await_approval entry until the next transition", () => {
    const t = (s: number) => new Date(s * 1000).toISOString();
    const events: PhaseEvent[] = [
      { sessionId: "a", ts: t(0), label: "plan" },
      { sessionId: "a", ts: t(10), label: "await_approval" },
      { sessionId: "a", ts: t(70), label: "plan" }, // revision loop
      { sessionId: "a", ts: t(80), label: "await_approval" },
      { sessionId: "a", ts: t(200), label: "implement" },
      { sessionId: "b", ts: t(0), label: "await_approval" }, // still waiting — no dwell
    ];
    expect(approvalDwellsMs(events)).toEqual([60_000, 120_000]);
  });

  it("createdToPrMs measures first event → done for PR sessions, skipping inherited-PR resumes", () => {
    const t = (s: number) => new Date(s * 1000).toISOString();
    const events: PhaseEvent[] = [
      { sessionId: "a", ts: t(0), label: "plan" },
      { sessionId: "a", ts: t(500), label: "done" },
      { sessionId: "resume", ts: t(0), label: "done" }, // born done — excluded
      { sessionId: "nopr", ts: t(0), label: "plan" },
      { sessionId: "nopr", ts: t(30), label: "done" }, // no PR — excluded
    ];
    expect(createdToPrMs(events, ["a", "resume"])).toEqual([500_000]);
  });
});

describe("gatherReport", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reads runs, timings, phase events, and failure groups from a seeded DB", () => {
    dir = mkdtempSync(join(tmpdir(), "report-test-"));
    const path = join(dir, "jarvis.db");
    const s = new SessionStore(path);
    s.upsert("as_g1", "plan", "iss");
    s.setPhase("as_g1", "await_approval");
    s.setPhase("as_g1", "done");
    s.setPrUrl("as_g1", "https://github.com/o/r/pull/1");
    s.addTiming("as_g1", "clone", 900);
    const runId = s.createRun("as_g1", "implement", "o/r", "claude-sonnet-5", "high");
    s.addRunEvent(runId, "tool_result", { tool: "Bash", isError: true, content: "npm ERR! boom\nstack" });
    s.finishRun(runId, {
      outcome: "success", costUsd: 2.5, numTurns: 40,
      tokensIn: 100, tokensOut: 200, tokensCacheRead: 3000, tokensCacheWrite: 1000, error: null,
    });
    s.close();

    const db = new DatabaseSync(path, { readOnly: true });
    const data = gatherReport(db);
    db.close();

    expect(data.runs).toHaveLength(1);
    expect(data.runs[0]).toMatchObject({ taskType: "implement", model: "claude-sonnet-5", outcome: "success" });
    expect(data.runs[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(data.timings).toEqual([{ label: "clone", ms: 900 }]);
    expect(data.phaseEvents.map((e) => e.label)).toEqual(["plan", "await_approval", "done"]);
    expect(data.sessionsWithPr).toEqual(["as_g1"]);
    expect(data.failureGroups).toEqual([{ key: "Bash: npm ERR! boom", n: 1 }]);
    expect(data.failedRuns).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/report/data.test.ts`
Expected: FAIL — cannot resolve `../../src/report/data.ts`.

- [ ] **Step 3: Implement `src/report/data.ts`**

```ts
// Report data layer: read-only queries + pure aggregate helpers. Every query
// tolerates an old DB (missing columns/tables) — the report must degrade, not
// throw, against a not-yet-migrated jarvis.db (migrations only run when the
// server's SessionStore starts).
import type { DatabaseSync } from "node:sqlite";

export interface RunRow {
  id: number;
  taskType: string;
  startedAt: string;
  endedAt: string | null;
  outcome: string | null;
  costUsd: number | null;
  numTurns: number | null;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  model: string | null;
  effort: string | null;
  error: string | null;
  durationMs: number | null;
}

export interface PhaseEvent {
  sessionId: string;
  ts: string;
  label: string;
}

export interface TimingRow {
  label: string;
  ms: number;
}

export interface FailureGroup {
  key: string;
  n: number;
}

export interface FailedRun {
  id: number;
  taskType: string;
  outcome: string;
  error: string | null;
  lastEvents: { ts: string; type: string; payload: string }[];
}

export interface ReportData {
  generatedAt: string;
  runs: RunRow[];
  timings: TimingRow[];
  phaseEvents: PhaseEvent[];
  sessionsWithPr: string[];
  failureGroups: FailureGroup[];
  failedRuns: FailedRun[];
}

// Table names are our own literals, never user input.
function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function hasTable(db: DatabaseSync, table: string): boolean {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) != null;
}

export function gatherReport(db: DatabaseSync): ReportData {
  const runCols = tableColumns(db, "runs");
  const col = (name: string, fallback: string) => (runCols.has(name) ? name : fallback);
  const runs = (
    db
      .prepare(
        `SELECT id, task_type, started_at, ended_at, outcome, cost_usd, num_turns,
                COALESCE(tokens_out, 0) AS tokens_out,
                COALESCE(tokens_cache_read, 0) AS cache_read,
                COALESCE(${col("tokens_cache_write", "0")}, 0) AS cache_write,
                ${col("model", "NULL")} AS model,
                ${col("effort", "NULL")} AS effort,
                error
         FROM runs ORDER BY id ASC`,
      )
      .all() as {
      id: number; task_type: string; started_at: string; ended_at: string | null;
      outcome: string | null; cost_usd: number | null; num_turns: number | null;
      tokens_out: number; cache_read: number; cache_write: number;
      model: string | null; effort: string | null; error: string | null;
    }[]
  ).map((r) => ({
    id: r.id, taskType: r.task_type, startedAt: r.started_at, endedAt: r.ended_at,
    outcome: r.outcome, costUsd: r.cost_usd, numTurns: r.num_turns,
    tokensOut: r.tokens_out, cacheRead: r.cache_read, cacheWrite: r.cache_write,
    model: r.model, effort: r.effort, error: r.error,
    durationMs: r.ended_at ? Date.parse(r.ended_at) - Date.parse(r.started_at) : null,
  }));

  let timings: TimingRow[] = [];
  let phaseEvents: PhaseEvent[] = [];
  if (hasTable(db, "session_events")) {
    timings = db
      .prepare(`SELECT label, ms FROM session_events WHERE kind = 'timing' AND ms IS NOT NULL ORDER BY id ASC`)
      .all() as unknown as TimingRow[];
    phaseEvents = (
      db
        .prepare(`SELECT agent_session_id, ts, label FROM session_events WHERE kind = 'phase' ORDER BY id ASC`)
        .all() as { agent_session_id: string; ts: string; label: string }[]
    ).map((e) => ({ sessionId: e.agent_session_id, ts: e.ts, label: e.label }));
  }

  const sessionsWithPr = tableColumns(db, "sessions").has("pr_url")
    ? (
        db.prepare(`SELECT agent_session_id FROM sessions WHERE pr_url IS NOT NULL`).all() as {
          agent_session_id: string;
        }[]
      ).map((r) => r.agent_session_id)
    : [];

  // Failed tool_results grouped by tool + first content line — the failure miner.
  const counts = new Map<string, number>();
  const payloads = db.prepare(`SELECT payload FROM run_events WHERE type = 'tool_result'`).all() as {
    payload: string;
  }[];
  for (const { payload } of payloads) {
    try {
      const p = JSON.parse(payload) as { tool?: string | null; isError?: boolean; content?: string };
      if (!p.isError) continue;
      const firstLine = String(p.content ?? "").split("\n").find((l) => l.trim()) ?? "";
      const key = `${p.tool ?? "?"}: ${firstLine.slice(0, 120)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    } catch {
      // unparseable payload — skip
    }
  }
  const failureGroups = [...counts.entries()]
    .map(([key, n]) => ({ key, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 30);

  const failedRuns = (
    db
      .prepare(
        `SELECT id, task_type, outcome, error FROM runs
         WHERE outcome IS NOT NULL AND outcome != 'success'
         ORDER BY id DESC LIMIT 10`,
      )
      .all() as { id: number; task_type: string; outcome: string; error: string | null }[]
  ).map((r) => {
    const evs = db
      .prepare(`SELECT ts, type, payload FROM run_events WHERE run_id = ? ORDER BY id DESC LIMIT 3`)
      .all(r.id) as { ts: string; type: string; payload: string }[];
    return { id: r.id, taskType: r.task_type, outcome: r.outcome, error: r.error, lastEvents: evs.reverse() };
  });

  return {
    generatedAt: new Date().toISOString(),
    runs, timings, phaseEvents, sessionsWithPr, failureGroups, failedRuns,
  };
}

// Nearest-rank percentile over unsorted input. p in [0,100]. null on empty.
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

// Fraction of cached-prefix tokens served from cache. null when no cache traffic.
export function cacheHitRate(cacheRead: number, cacheWrite: number): number | null {
  const total = cacheRead + cacheWrite;
  return total === 0 ? null : cacheRead / total;
}

// Human-gate dwell: each time a session enters await_approval, the clock runs
// until its next phase change. Sessions still waiting contribute nothing.
export function approvalDwellsMs(events: PhaseEvent[]): number[] {
  const dwells: number[] = [];
  for (const evs of groupBySession(events).values()) {
    for (let i = 0; i < evs.length - 1; i++) {
      if (evs[i].label === "await_approval") dwells.push(Date.parse(evs[i + 1].ts) - Date.parse(evs[i].ts));
    }
  }
  return dwells;
}

// created→PR wall clock per session that produced a PR: first phase event to the
// first 'done' after it. Sessions born straight into 'done' (a resume that
// inherited a prior PR) are excluded — their e2e time belongs to the original.
export function createdToPrMs(events: PhaseEvent[], sessionsWithPr: string[]): number[] {
  const withPr = new Set(sessionsWithPr);
  const out: number[] = [];
  for (const [sessionId, evs] of groupBySession(events)) {
    if (!withPr.has(sessionId) || evs.length === 0 || evs[0].label === "done") continue;
    const done = evs.find((e) => e.label === "done");
    if (done) out.push(Date.parse(done.ts) - Date.parse(evs[0].ts));
  }
  return out;
}

function groupBySession(events: PhaseEvent[]): Map<string, PhaseEvent[]> {
  const m = new Map<string, PhaseEvent[]>();
  for (const e of events) {
    const list = m.get(e.sessionId);
    if (list) list.push(e);
    else m.set(e.sessionId, [e]);
  }
  return m;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/report/data.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/report/data.ts tests/report/data.test.ts
git commit -m "feat(report): data layer — gatherReport + latency/cache aggregates"
```

---

### Task 7: HTML dashboard + report entry + docs

**Files:**
- Create: `src/report/html.ts`
- Rewrite: `src/report.ts`
- Modify: `.gitignore` (add `jarvis-report.html`), `CLAUDE.md` (persistence + report notes)
- Test: `tests/report/html.test.ts`

**Interfaces:**
- Consumes: everything Task 6 exports.
- Produces: `renderHtml(d: ReportData): string`. `npm run report` prints the console report AND writes `jarvis-report.html` to the cwd.

Design notes (dataviz skill, reference palette — pre-validated, values from its `references/palette.md`): bars ≤24px with a 4px rounded data-end (square at baseline), 2px lines, dots r≥4 with a 2px surface ring, hairline grid, text in ink tokens (never series color), one axis per chart, legend only for multi-series (the stacked outcomes chart), per-mark hover tooltips via one inline script, dark mode via `prefers-color-scheme`, and a table view (the runs table) so nothing is color-gated. Status colors (good/warning/critical) are used only for outcome buckets, with a legend and counts in tooltips (the warning hue is sub-3:1 on light — the legend + labels are the mitigation).

- [ ] **Step 1: Write the failing smoke tests**

Create `tests/report/html.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderHtml } from "../../src/report/html.ts";
import type { ReportData } from "../../src/report/data.ts";

const DATA: ReportData = {
  generatedAt: "2026-07-04T00:00:00.000Z",
  runs: [
    {
      id: 1, taskType: "implement", startedAt: "2026-07-01T00:00:00.000Z",
      endedAt: "2026-07-01T00:10:00.000Z", outcome: "success", costUsd: 2.5, numTurns: 40,
      tokensOut: 100, cacheRead: 3000, cacheWrite: 1000, model: "claude-sonnet-5",
      effort: "high", error: null, durationMs: 600_000,
    },
    {
      id: 2, taskType: "plan", startedAt: "2026-07-02T00:00:00.000Z", endedAt: null,
      outcome: "interrupted", costUsd: null, numTurns: null, tokensOut: 0, cacheRead: 0,
      cacheWrite: 0, model: null, effort: null, error: null, durationMs: null,
    },
  ],
  timings: [
    { label: "clone", ms: 900 },
    { label: "sandbox_create", ms: 4000 },
  ],
  phaseEvents: [
    { sessionId: "a", ts: "2026-07-01T00:00:00.000Z", label: "plan" },
    { sessionId: "a", ts: "2026-07-01T00:05:00.000Z", label: "await_approval" },
    { sessionId: "a", ts: "2026-07-01T01:00:00.000Z", label: "implement" },
    { sessionId: "a", ts: "2026-07-01T02:00:00.000Z", label: "done" },
  ],
  sessionsWithPr: ["a"],
  failureGroups: [{ key: "Bash: npm ERR! boom", n: 3 }],
  failedRuns: [
    { id: 2, taskType: "plan", outcome: "interrupted", error: "<script>alert(1)</script>", lastEvents: [] },
  ],
};

describe("renderHtml", () => {
  it("renders a self-contained dashboard with all sections", () => {
    const html = renderHtml(DATA);
    expect(html).toContain("<svg");
    for (const section of [
      "Cost by task type", "Outcomes by task type", "Run duration", "Host timings",
      "Cache hit rate", "Cost over time", "By model", "Recent failures", "Runs",
    ]) {
      expect(html).toContain(section);
    }
    // self-contained: no external fetches of any kind
    expect(html).not.toMatch(/<(script|link|img)[^>]*(src|href)=/);
  });

  it("escapes HTML in data-derived strings", () => {
    const html = renderHtml(DATA);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders the empty state without throwing", () => {
    const html = renderHtml({
      generatedAt: "t", runs: [], timings: [], phaseEvents: [],
      sessionsWithPr: [], failureGroups: [], failedRuns: [],
    });
    expect(html).toContain("no data yet");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/report/html.test.ts`
Expected: FAIL — cannot resolve `../../src/report/html.ts`.

- [ ] **Step 3: Implement `src/report/html.ts`**

```ts
// Self-contained HTML dashboard for run telemetry. Zero external requests:
// inline CSS + SVG, one inline <script> for tooltips. Colors are the dataviz
// reference palette (pre-validated for CVD + contrast); marks follow its specs —
// bars ≤24px with a 4px rounded data-end (square at the baseline), 2px lines,
// dots ringed in the surface color, hairline grid, text in ink tokens.
import type { ReportData, RunRow } from "./data.ts";
import { percentile, cacheHitRate, approvalDwellsMs, createdToPrMs } from "./data.ts";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const fmtUsd = (v: number): string => (v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`);

function fmtMs(ms: number | null): string {
  if (ms == null) return "–";
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const fmtPct = (v: number | null): string => (v == null ? "–" : `${Math.round(v * 100)}%`);

// Shared horizontal-bar geometry.
const W = 660, LABEL_W = 120, VALUE_W = 100, ROW_H = 30, BAR_H = 18;
const EMPTY = `<p class="empty">no data yet</p>`;

interface BarRow { label: string; value: number; text: string; tip: string; }

// Single-series horizontal bars: 4px rounded data-end, square at the baseline.
function barSvg(rows: BarRow[], max?: number): string {
  if (rows.length === 0) return EMPTY;
  const top = max ?? Math.max(...rows.map((r) => r.value), 1e-9);
  const span = W - LABEL_W - VALUE_W;
  const bars = rows
    .map((r, i) => {
      const w = Math.max(4, (span * r.value) / top);
      const y = i * ROW_H + (ROW_H - BAR_H) / 2;
      return (
        `<g class="hit" data-tip="${esc(r.tip)}">` +
        `<rect x="0" y="${i * ROW_H}" width="${W}" height="${ROW_H}" fill="transparent"/>` +
        `<text x="${LABEL_W - 8}" y="${y + BAR_H / 2}" text-anchor="end" dominant-baseline="central" class="lbl">${esc(r.label)}</text>` +
        `<path d="M${LABEL_W} ${y}h${w - 4}a4 4 0 0 1 4 4v${BAR_H - 8}a4 4 0 0 1-4 4h${4 - w}z" fill="var(--series-1)"/>` +
        `<text x="${LABEL_W + w + 8}" y="${y + BAR_H / 2}" dominant-baseline="central" class="val">${esc(r.text)}</text>` +
        `</g>`
      );
    })
    .join("");
  return `<svg viewBox="0 0 ${W} ${rows.length * ROW_H}" width="100%" role="img">${bars}</svg>`;
}

const BUCKETS = [
  { key: "success", label: "success", color: "var(--good)" },
  { key: "interrupted", label: "interrupted / no result", color: "var(--warn)" },
  { key: "failed", label: "failed", color: "var(--crit)" },
] as const;
type BucketKey = (typeof BUCKETS)[number]["key"];

function outcomeBucket(outcome: string | null): BucketKey {
  if (outcome === "success") return "success";
  if (outcome == null || outcome === "interrupted" || outcome === "no_result") return "interrupted";
  return "failed";
}

// Stacked outcome bars per task type; 2px surface gaps between segments.
function stackedOutcomes(runs: RunRow[]): string {
  const types = [...new Set(runs.map((r) => r.taskType))];
  if (types.length === 0) return EMPTY;
  const counts = new Map<string, Record<BucketKey, number>>();
  for (const r of runs) {
    const c = counts.get(r.taskType) ?? { success: 0, interrupted: 0, failed: 0 };
    c[outcomeBucket(r.outcome)] += 1;
    counts.set(r.taskType, c);
  }
  const maxN = Math.max(...types.map((t) => runs.filter((r) => r.taskType === t).length));
  const span = W - LABEL_W - VALUE_W;
  const rows = types
    .map((t, i) => {
      const c = counts.get(t)!;
      const total = c.success + c.interrupted + c.failed;
      const y = i * ROW_H + (ROW_H - BAR_H) / 2;
      let x = LABEL_W;
      const present = BUCKETS.filter((b) => c[b.key] > 0);
      const segs = present
        .map((b, j) => {
          const gap = j < present.length - 1 ? 2 : 0;
          const w = Math.max(2, (span * c[b.key]) / maxN - gap);
          const last = j === present.length - 1;
          const seg = last
            ? `<path d="M${x} ${y}h${Math.max(w, 4) - 4}a4 4 0 0 1 4 4v${BAR_H - 8}a4 4 0 0 1-4 4h${4 - Math.max(w, 4)}z" fill="${b.color}"/>`
            : `<rect x="${x}" y="${y}" width="${w}" height="${BAR_H}" fill="${b.color}"/>`;
          x += w + gap;
          return seg;
        })
        .join("");
      return (
        `<g class="hit" data-tip="${esc(`${t}: ${c.success} success · ${c.interrupted} interrupted · ${c.failed} failed`)}">` +
        `<rect x="0" y="${i * ROW_H}" width="${W}" height="${ROW_H}" fill="transparent"/>` +
        `<text x="${LABEL_W - 8}" y="${y + BAR_H / 2}" text-anchor="end" dominant-baseline="central" class="lbl">${esc(t)}</text>` +
        segs +
        `<text x="${x + 6}" y="${y + BAR_H / 2}" dominant-baseline="central" class="val">${total}</text>` +
        `</g>`
      );
    })
    .join("");
  const legend =
    `<div class="legend">` +
    BUCKETS.map((b) => `<span><i style="background:${b.color}"></i>${b.label}</span>`).join("") +
    `</div>`;
  return legend + `<svg viewBox="0 0 ${W} ${types.length * ROW_H}" width="100%" role="img">${rows}</svg>`;
}

// Dumbbell: p50 (solid dot) → p90 (faded dot) per task type, 2px connector.
function durationChart(runs: RunRow[]): string {
  const types = [...new Set(runs.filter((r) => r.durationMs != null).map((r) => r.taskType))];
  if (types.length === 0) return EMPTY;
  const stats = types.map((t) => {
    const ds = runs.filter((r) => r.taskType === t && r.durationMs != null).map((r) => r.durationMs!);
    return { label: t, p50: percentile(ds, 50)!, p90: percentile(ds, 90)! };
  });
  const max = Math.max(...stats.map((s) => s.p90), 1);
  const span = W - LABEL_W - VALUE_W;
  const rows = stats
    .map((s, i) => {
      const y = i * ROW_H + ROW_H / 2;
      const x50 = LABEL_W + (span * s.p50) / max;
      const x90 = LABEL_W + (span * s.p90) / max;
      return (
        `<g class="hit" data-tip="${esc(`${s.label}: p50 ${fmtMs(s.p50)} · p90 ${fmtMs(s.p90)}`)}">` +
        `<rect x="0" y="${i * ROW_H}" width="${W}" height="${ROW_H}" fill="transparent"/>` +
        `<text x="${LABEL_W - 8}" y="${y}" text-anchor="end" dominant-baseline="central" class="lbl">${esc(s.label)}</text>` +
        `<line x1="${x50}" y1="${y}" x2="${x90}" y2="${y}" stroke="var(--series-1)" stroke-width="2"/>` +
        `<circle cx="${x50}" cy="${y}" r="5" fill="var(--series-1)" stroke="var(--surface-1)" stroke-width="2"/>` +
        `<circle cx="${x90}" cy="${y}" r="5" fill="var(--series-1)" fill-opacity="0.55" stroke="var(--surface-1)" stroke-width="2"/>` +
        `<text x="${x90 + 10}" y="${y}" dominant-baseline="central" class="val">${fmtMs(s.p50)} / ${fmtMs(s.p90)}</text>` +
        `</g>`
      );
    })
    .join("");
  return `<svg viewBox="0 0 ${W} ${stats.length * ROW_H}" width="100%" role="img">${rows}</svg>`;
}

// Daily total cost: 2px line, 10% area wash, ringed end-dot, per-day hover.
function costOverTime(runs: RunRow[]): string {
  const byDay = new Map<string, number>();
  for (const r of runs) {
    if (r.costUsd == null) continue;
    const day = r.startedAt.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + r.costUsd);
  }
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (days.length === 0) return EMPTY;
  const H = 180, PAD_L = 52, PAD_R = 20, PAD_T = 14, PAD_B = 24;
  const rawMax = Math.max(...days.map(([, v]) => v));
  const max = rawMax * 1.1 || 1;
  const x = (i: number) => PAD_L + ((W - PAD_L - PAD_R) * i) / Math.max(days.length - 1, 1);
  const y = (v: number) => PAD_T + (H - PAD_T - PAD_B) * (1 - v / max);
  const pts = days.map(([, v], i) => `${x(i)},${y(v)}`).join(" ");
  const grid = [rawMax / 2, rawMax]
    .map(
      (v) =>
        `<line x1="${PAD_L}" y1="${y(v)}" x2="${W - PAD_R}" y2="${y(v)}" class="grid"/>` +
        `<text x="${PAD_L - 6}" y="${y(v)}" text-anchor="end" dominant-baseline="central" class="tick">${fmtUsd(v)}</text>`,
    )
    .join("");
  const area = `<polygon points="${x(0)},${y(0)} ${pts} ${x(days.length - 1)},${y(0)}" fill="var(--series-1)" fill-opacity="0.1"/>`;
  const line =
    days.length === 1
      ? ""
      : `<polyline points="${pts}" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  const last = days[days.length - 1];
  const endDot = `<circle cx="${x(days.length - 1)}" cy="${y(last[1])}" r="4.5" fill="var(--series-1)" stroke="var(--surface-1)" stroke-width="2"/>`;
  const endLbl = `<text x="${x(days.length - 1) - 8}" y="${y(last[1]) - 10}" text-anchor="end" class="val">${fmtUsd(last[1])}</text>`;
  const cellW = (W - PAD_L - PAD_R) / Math.max(days.length - 1, 1);
  const hovers = days
    .map(
      ([day, v], i) =>
        `<rect class="hit" data-tip="${esc(`${day}: ${fmtUsd(v)}`)}" x="${x(i) - cellW / 2}" y="0" width="${cellW}" height="${H}" fill="transparent"/>`,
    )
    .join("");
  const xLabels =
    `<text x="${PAD_L}" y="${H - 6}" class="tick">${days[0][0]}</text>` +
    `<text x="${W - PAD_R}" y="${H - 6}" text-anchor="end" class="tick">${last[0]}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">${grid}${area}${line}${endDot}${endLbl}${hovers}${xLabels}</svg>`;
}

function modelTable(runs: RunRow[]): string {
  const models = [...new Set(runs.filter((r) => r.model != null && r.outcome != null).map((r) => r.model!))];
  if (models.length === 0) return `<p class="empty">no model data yet (recorded from this release on)</p>`;
  const rows = models
    .map((m) => {
      const rs = runs.filter((r) => r.model === m && r.outcome != null);
      const ok = rs.filter((r) => r.outcome === "success").length;
      const cost = rs.reduce((s, r) => s + (r.costUsd ?? 0), 0);
      return `<tr><td>${esc(m)}</td><td>${rs.length}</td><td>${fmtPct(ok / rs.length)}</td><td>${fmtUsd(cost / rs.length)}</td></tr>`;
    })
    .join("");
  return `<table><thead><tr><th>model</th><th>runs</th><th>success</th><th>$/run</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function runsTable(runs: RunRow[]): string {
  const latest = [...runs].sort((a, b) => b.id - a.id).slice(0, 50);
  if (latest.length === 0) return EMPTY;
  const rows = latest
    .map(
      (r) =>
        `<tr><td>${r.id}</td><td>${esc(r.taskType)}</td><td>${esc(r.model ?? "–")}</td>` +
        `<td>${esc(r.outcome ?? "open")}</td><td>${fmtMs(r.durationMs)}</td><td>${r.numTurns ?? "–"}</td>` +
        `<td>${r.costUsd != null ? fmtUsd(r.costUsd) : "–"}</td><td>${fmtPct(cacheHitRate(r.cacheRead, r.cacheWrite))}</td></tr>`,
    )
    .join("");
  return `<table><thead><tr><th>id</th><th>task</th><th>model</th><th>outcome</th><th>duration</th><th>turns</th><th>cost</th><th>cache hit</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function failuresSection(d: ReportData): string {
  const groups = d.failureGroups.length
    ? `<ul class="fails">${d.failureGroups.map((g) => `<li><b>${g.n}×</b> ${esc(g.key)}</li>`).join("")}</ul>`
    : `<p class="empty">no failed tool results recorded</p>`;
  const tails = d.failedRuns
    .map(
      (r) =>
        `<details><summary>run ${r.id} [${esc(r.taskType)}] ${esc(r.outcome)}${r.error ? ` — ${esc(r.error.slice(0, 120))}` : ""}</summary>` +
        `<pre>${esc(r.lastEvents.map((e) => `${e.ts} ${e.type} ${e.payload.slice(0, 300)}`).join("\n")) || "(no events)"}</pre></details>`,
    )
    .join("");
  return groups + tails;
}

const CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; margin: 0; }
body {
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  background: var(--page); color: var(--ink); padding: 24px; max-width: 760px; margin: 0 auto;
  --page: #f9f9f7; --surface-1: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --gridline: #e1e0d9; --border: rgba(11,11,11,0.10);
  --series-1: #2a78d6; --good: #0ca30c; --warn: #fab219; --crit: #d03b3b;
}
@media (prefers-color-scheme: dark) {
  body {
    --page: #0d0d0d; --surface-1: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
    --gridline: #2c2c2a; --border: rgba(255,255,255,0.10);
    --series-1: #3987e5;
  }
}
h1 { font-size: 20px; }
.sub { color: var(--muted); margin: 4px 0 20px; }
.tiles { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 20px; }
.tile { background: var(--surface-1); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; flex: 1 1 120px; }
.tile-label { color: var(--ink-2); font-size: 12px; }
.tile-value { font-size: 26px; font-weight: 600; margin-top: 2px; }
section { background: var(--surface-1); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
h2 { font-size: 14px; margin-bottom: 2px; }
.caption { color: var(--muted); font-size: 12px; margin-bottom: 10px; }
svg { display: block; }
.lbl { fill: var(--ink-2); font-size: 12px; }
.val { fill: var(--ink); font-size: 12px; }
.tick { fill: var(--muted); font-size: 11px; }
.grid { stroke: var(--gridline); stroke-width: 1; }
.legend { display: flex; gap: 16px; font-size: 12px; color: var(--ink-2); margin-bottom: 8px; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; font-size: 13px; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--gridline); }
th { color: var(--muted); font-weight: 500; font-size: 12px; }
.empty { color: var(--muted); }
.fails { list-style: none; }
.fails li { padding: 2px 0; }
details { margin-top: 8px; }
summary { cursor: pointer; }
pre { overflow-x: auto; background: var(--page); padding: 8px; border-radius: 6px; font-size: 12px; margin-top: 6px; }
#tip { position: absolute; display: none; background: var(--ink); color: var(--page); padding: 4px 8px; border-radius: 6px; font-size: 12px; pointer-events: none; max-width: 360px; z-index: 10; }
`;

function tile(label: string, value: string): string {
  return `<div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value">${esc(value)}</div></div>`;
}

export function renderHtml(d: ReportData): string {
  const totalCost = d.runs.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  const impl = d.runs.filter((r) => r.taskType === "implement" && r.outcome != null);
  const implRate = impl.length ? impl.filter((r) => r.outcome === "success").length / impl.length : null;
  const dwell = percentile(approvalDwellsMs(d.phaseEvents), 50);
  const e2e = percentile(createdToPrMs(d.phaseEvents, d.sessionsWithPr), 50);

  const types = [...new Set(d.runs.map((r) => r.taskType))];
  const costRows: BarRow[] = types
    .map((t) => {
      const cost = d.runs.filter((r) => r.taskType === t).reduce((s, r) => s + (r.costUsd ?? 0), 0);
      return { label: t, value: cost, text: fmtUsd(cost), tip: `${t}: ${fmtUsd(cost)} total` };
    })
    .sort((a, b) => b.value - a.value);

  const timingLabels = [...new Set(d.timings.map((t) => t.label))];
  const timingRows: BarRow[] = timingLabels
    .map((l) => {
      const ms = d.timings.filter((t) => t.label === l).map((t) => t.ms);
      const p50 = percentile(ms, 50)!;
      return {
        label: l, value: p50, text: fmtMs(p50),
        tip: `${l}: p50 ${fmtMs(p50)} · p90 ${fmtMs(percentile(ms, 90))} · n=${ms.length}`,
      };
    })
    .sort((a, b) => b.value - a.value);

  const cacheRows: BarRow[] = types.flatMap((t) => {
    const rs = d.runs.filter((r) => r.taskType === t);
    const rate = cacheHitRate(
      rs.reduce((s, r) => s + r.cacheRead, 0),
      rs.reduce((s, r) => s + r.cacheWrite, 0),
    );
    return rate == null ? [] : [{ label: t, value: rate, text: fmtPct(rate), tip: `${t}: ${fmtPct(rate)} cache hit` }];
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jarvis telemetry</title>
<style>${CSS}</style>
</head>
<body>
<h1>Jarvis telemetry</h1>
<p class="sub">generated ${esc(d.generatedAt)} · ${d.runs.length} runs</p>
<div class="tiles">
${tile("Total spend", fmtUsd(totalCost))}
${tile("Runs", String(d.runs.length))}
${tile("Implement success", fmtPct(implRate))}
${tile("Median approval wait", fmtMs(dwell))}
${tile("Median created→PR", fmtMs(e2e))}
</div>
<section><h2>Cost by task type</h2><p class="caption">total $ per task type</p>${barSvg(costRows)}</section>
<section><h2>Outcomes by task type</h2><p class="caption">runs per outcome bucket</p>${stackedOutcomes(d.runs)}</section>
<section><h2>Run duration</h2><p class="caption">solid dot = p50, faded dot = p90</p>${durationChart(d.runs)}</section>
<section><h2>Host timings</h2><p class="caption">median wall-clock per sandbox lifecycle step</p>${barSvg(timingRows)}</section>
<section><h2>Cache hit rate</h2><p class="caption">cache reads / (reads + writes) per task type</p>${barSvg(cacheRows, 1)}</section>
<section><h2>Cost over time</h2><p class="caption">$ per day, all task types</p>${costOverTime(d.runs)}</section>
<section><h2>By model</h2><p class="caption">implement routing outcomes</p>${modelTable(d.runs)}</section>
<section><h2>Recent failures</h2>${failuresSection(d)}</section>
<section><h2>Runs</h2><p class="caption">latest 50</p>${runsTable(d.runs)}</section>
<div id="tip"></div>
<script>
const tip = document.getElementById("tip");
for (const el of document.querySelectorAll(".hit")) {
  el.addEventListener("mousemove", (e) => {
    tip.textContent = el.dataset.tip;
    tip.style.display = "block";
    tip.style.left = e.pageX + 12 + "px";
    tip.style.top = e.pageY + 12 + "px";
  });
  el.addEventListener("mouseleave", () => (tip.style.display = "none"));
}
</script>
</body>
</html>`;
}
```

- [ ] **Step 4: Rewrite `src/report.ts`**

```ts
// Failure-pattern + economics report over run telemetry. Usage: npm run report
// Prints the console summary AND writes a self-contained HTML dashboard
// (jarvis-report.html — gitignored).
import "./logger.ts";
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  gatherReport, percentile, cacheHitRate, approvalDwellsMs, createdToPrMs,
  type ReportData,
} from "./report/data.ts";
import { renderHtml } from "./report/html.ts";

const db = new DatabaseSync(process.env.JARVIS_DB ?? "jarvis.db", { readOnly: true });
const data = gatherReport(db);
db.close();

printConsole(data);

const htmlPath = resolve("jarvis-report.html");
writeFileSync(htmlPath, renderHtml(data));
console.log(`\nHTML dashboard: file://${htmlPath.replace(/\\/g, "/")}`);

function fmtDur(ms: number | null): string {
  if (ms == null) return "n/a";
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtRate(rate: number | null): string {
  return rate == null ? "n/a" : `${Math.round(rate * 100)}%`;
}

function printConsole(d: ReportData): void {
  console.log("=== Runs by task type and outcome ===");
  const byOutcome = new Map<string, { n: number; cost: number }>();
  for (const r of d.runs) {
    const key = `${r.taskType} / ${r.outcome ?? "(open)"}`;
    const cur = byOutcome.get(key) ?? { n: 0, cost: 0 };
    cur.n += 1;
    cur.cost += r.costUsd ?? 0;
    byOutcome.set(key, cur);
  }
  for (const [key, v] of [...byOutcome.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${key}: ${v.n} runs ($${v.cost.toFixed(4)})`);
  }

  console.log("\n=== Cost economics (by task type) ===");
  // cost_usd is the only cumulative-truthful figure Claude Code returns; tokens
  // are summed across turns in the runner. A low cache-hit rate means the prompt
  // cache keeps missing (re-writing the prefix at the 1.25x write premium) — the
  // lever is fewer/faster turns and a smaller prefix, not the model.
  const types = [...new Set(d.runs.map((r) => r.taskType))];
  const econ = types
    .map((t) => {
      const rs = d.runs.filter((r) => r.taskType === t && r.costUsd != null);
      const durations = d.runs.filter((r) => r.taskType === t && r.durationMs != null).map((r) => r.durationMs!);
      const cost = rs.reduce((s, r) => s + (r.costUsd ?? 0), 0);
      return {
        t, n: rs.length, cost,
        costAvg: rs.length ? cost / rs.length : 0,
        turnsAvg: rs.length ? rs.reduce((s, r) => s + (r.numTurns ?? 0), 0) / rs.length : 0,
        p50: percentile(durations, 50), p90: percentile(durations, 90),
        cr: rs.reduce((s, r) => s + r.cacheRead, 0), cw: rs.reduce((s, r) => s + r.cacheWrite, 0),
      };
    })
    .filter((e) => e.n > 0)
    .sort((a, b) => b.cost - a.cost);
  if (econ.length === 0) {
    console.log("  (no completed runs with cost recorded)");
  } else {
    console.log("  task          runs   $total   $/run  turns/run   dur p50   dur p90  cache hit");
    for (const e of econ) {
      console.log(
        `  ${e.t.padEnd(12)} ${String(e.n).padStart(4)}  ${("$" + e.cost.toFixed(4)).padStart(8)} ` +
          `${("$" + e.costAvg.toFixed(4)).padStart(7)} ${e.turnsAvg.toFixed(1).padStart(9)}  ` +
          `${fmtDur(e.p50).padStart(8)}  ${fmtDur(e.p90).padStart(8)}  ${fmtRate(cacheHitRate(e.cr, e.cw)).padStart(9)}`,
      );
    }
    console.log(`  total spend: $${econ.reduce((s, e) => s + e.cost, 0).toFixed(4)}`);
    const cr = econ.reduce((s, e) => s + e.cr, 0);
    const cw = econ.reduce((s, e) => s + e.cw, 0);
    if (cr + cw > 0) {
      console.log(
        `  cache write/read ratio: ${(cw / Math.max(cr, 1)).toFixed(2)} ` +
          `(high ⇒ prompt-cache misses — trim the prefix / keep turns under the 5-min TTL)`,
      );
    }
  }

  console.log("\n=== Success by model (implement routing) ===");
  const models = [...new Set(d.runs.filter((r) => r.model != null && r.outcome != null).map((r) => r.model!))];
  if (models.length === 0) console.log("  (no model data yet — recorded from this release on)");
  for (const m of models) {
    const rs = d.runs.filter((r) => r.model === m && r.outcome != null);
    const ok = rs.filter((r) => r.outcome === "success").length;
    const cost = rs.reduce((s, r) => s + (r.costUsd ?? 0), 0);
    console.log(
      `  ${m.padEnd(18)} ${String(rs.length).padStart(4)} runs  ${fmtRate(ok / rs.length).padStart(5)} success  $${(cost / rs.length).toFixed(4)}/run`,
    );
  }

  console.log("\n=== Host timings (sandbox lifecycle) ===");
  const labels = [...new Set(d.timings.map((t) => t.label))];
  if (labels.length === 0) console.log("  (none recorded yet)");
  for (const l of labels) {
    const ms = d.timings.filter((t) => t.label === l).map((t) => t.ms);
    console.log(`  ${l.padEnd(14)} n=${String(ms.length).padStart(3)}  p50=${fmtDur(percentile(ms, 50))}  p90=${fmtDur(percentile(ms, 90))}`);
  }

  console.log("\n=== Human-gate latency ===");
  const dwells = approvalDwellsMs(d.phaseEvents);
  const e2e = createdToPrMs(d.phaseEvents, d.sessionsWithPr);
  console.log(`  approval wait: n=${dwells.length}  p50=${fmtDur(percentile(dwells, 50))}  p90=${fmtDur(percentile(dwells, 90))}`);
  console.log(`  created→PR:    n=${e2e.length}  p50=${fmtDur(percentile(e2e, 50))}  p90=${fmtDur(percentile(e2e, 90))}`);

  console.log("\n=== Failed tool results, grouped (top 30) ===");
  if (d.failureGroups.length === 0) console.log("  (none recorded)");
  for (const g of d.failureGroups) console.log(`  ${String(g.n).padStart(4)}×  ${g.key}`);

  console.log("\n=== Non-success runs (latest 10, last 3 events each) ===");
  if (d.failedRuns.length === 0) console.log("  (none)");
  for (const r of d.failedRuns) {
    console.log(`  run ${r.id} [${r.taskType}] ${r.outcome}${r.error ? ` — ${r.error.slice(0, 120)}` : ""}`);
    for (const e of r.lastEvents) console.log(`     ${e.ts} ${e.type} ${e.payload.slice(0, 140)}`);
  }
}
```

- [ ] **Step 5: `.gitignore` + `CLAUDE.md`**

Append to `.gitignore`:

```
jarvis-report.html
```

In `CLAUDE.md`: in the Commands section, change the `npm run report` line to

```
npm run report        # failure-pattern + economics report (console + jarvis-report.html dashboard)
```

and in the Persistence section, change "Four tables" to "Five tables" and add to the table list:

```
`session_events` (phase transitions + host timings per session — approval dwell,
created→PR, and sandbox_create/clone/serena_index/history durations for the report)
```

- [ ] **Step 6: Run all tests + typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS / clean

- [ ] **Step 7: Render it and look at it (dataviz step 7)**

Run: `npm run report` (works even with an empty/missing-table `jarvis.db` — degrades to empty states). Open `jarvis-report.html` in a browser and eyeball: no label collisions, bars/dots not clipped, tooltips follow the cursor, dark mode readable (flip OS theme or emulate `prefers-color-scheme`).
Expected: dashboard renders; console output shows the new sections.

- [ ] **Step 8: Commit**

```bash
git add src/report.ts src/report/html.ts tests/report/html.test.ts .gitignore CLAUDE.md
git commit -m "feat(report): HTML telemetry dashboard + durations/model/timings/gate-latency in console report"
```

---

## Self-review notes (already applied)

- **Spec coverage:** model/route recording → Task 1+4; durations → Task 6 (`durationMs`) + Task 7 (charts/console); host timings → Tasks 2+5; approval dwell + created→PR → Tasks 2+6+7; reconcile orphan fix → Tasks 3+4; boot sweep → Tasks 3+4; indexes → Task 1; cache-hit rate → Tasks 6+7; graceful degradation → Task 6 (`tableColumns`/`hasTable`); `.gitignore`/docs → Task 7.
- **Type consistency:** `RunFinish` (existing) consumed by `finishOpenRun` (Task 3) and produced by `runFinishFrom` (Task 4); `PhaseEvent`/`ReportData`/`BarRow` names match between Tasks 6 and 7; `SessionEvent.kind` is `"phase" | "timing"` everywhere; `createRun`'s optional params keep all existing 3-arg call sites (tests, history) compiling.
- **Known ponytail ceilings:** phase-event timestamps are host wall-clock (a clock jump skews dwell); `createdToPrMs` counts only sessions with phase history (post-ship); stacked-bar segment widths lose ≤2px per gap to stay proportional-ish. All acceptable at this data volume.
