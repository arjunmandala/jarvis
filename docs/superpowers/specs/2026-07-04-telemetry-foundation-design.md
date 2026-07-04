# Telemetry Foundation — Design

Date: 2026-07-04
Status: approved (brainstormed in-session; scope = autonomy roadmap Phase 1, Workstream A)

## Goal

Make the existing run telemetry (`runs` / `run_events` + `npm run report`) answer the
questions the autonomy roadmap needs answered: what does each run cost *and how long
does it take*, which model was used and how often it succeeds, where wall-clock time
goes (sandbox create / clone / serena index / history), how long humans sit on the
approval gate, and end-to-end created→PR latency. Surface all of it in `npm run report`
(console) **plus a self-contained HTML dashboard** (`jarvis-report.html`).

## Non-goals

- No new external dependencies, no metrics server, no OpenTelemetry. SQLite + one script.
- No cross-issue analytics or failure-lesson store (roadmap Phase 4).
- No Phase-2 fields (verifier outcomes, revision-loop counts) — nothing writes them yet.
- No backfill: rows created before this ships keep NULLs; the report tolerates them.

## Current gaps (verified against the code)

1. `routeImplement` picks sonnet-5 vs opus-4-8 per run, but the decision is never
   stored — success-rate-by-model is unqueryable.
2. `started_at`/`ended_at` exist but nothing computes durations; zero visibility into
   sandbox-create/clone/index cost (paid 2–4× per issue).
3. No session-level latency: time-in-`await_approval`, created→PR.
4. `reconcile()` recovery calls `#logUsage(label, result)` with **no runId** — even a
   successfully recovered run's row stays `outcome NULL` forever.
5. Runs interrupted before recovery also stay `outcome NULL` forever; aggregates lie.
6. No indexes on `run_events(run_id)` / `runs(agent_session_id)`.
7. Report has no per-run cache-hit rate despite both columns existing.

## Design

### Schema (all additive, existing hand-rolled migration pattern)

- `runs` gains `model TEXT` and `effort TEXT` (pragma-guarded `ALTER TABLE`).
  `#trackedRun` writes them from the `AgentTask` it already holds (`task.model`,
  `task.effort ?? "high"` — high is the SDK default when unset). For implement runs
  `model` *is* the route decision.
- New table:

  ```sql
  CREATE TABLE IF NOT EXISTS session_events (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_session_id TEXT NOT NULL,
    ts               TEXT NOT NULL,
    kind             TEXT NOT NULL,   -- 'phase' | 'timing'
    label            TEXT NOT NULL,   -- phase name | 'sandbox_create'|'clone'|'serena_index'|'history'
    ms               INTEGER          -- elapsed ms for timings; NULL for phase events
  ) STRICT
  ```

  - `kind='phase'`: written by `upsert`/`setPhase` **only when the phase actually
    changes** (idempotent webhooks must not spam events). Gives approval dwell and
    created→PR for free.
  - `kind='timing'`: host-side durations via `store.addTiming(sessionId, label, ms)`.
- Indexes: `run_events(run_id)`, `runs(agent_session_id)`, `session_events(agent_session_id)`.

### Write-path changes

- **Timing seams.** `SandboxConfig` gains optional `onTiming?: (label, ms) => void`.
  `withSandbox` times `Sandbox.create` → `sandbox_create`; `cloneRepo` times the clone
  → `clone` and the serena index → `serena_index`. The pipeline builds the callback in
  `#sbxCfg(sessionId?)` (wrapping `store.addTiming` in try/catch — advisory, never
  fails a run). `prepareHistory` calls are wrapped by a pipeline `#timed()` helper →
  `history`.
- **`runFinishFrom(result)`** — the result→`RunFinish` mapping currently inlined in
  `#logUsage` is extracted as an exported pure function (testable), used by both
  `#logUsage` and reconcile.
- **Reconcile closes recovered runs.** New store method `finishOpenRun(sessionId,
  finish)` finds the session's latest run with `ended_at IS NULL` and finishes it;
  reconcile calls it with `runFinishFrom(result)` after recovery.
- **Boot sweep.** New store method `markInterruptedRuns(beforeIso)` stamps
  `outcome='interrupted'`, `ended_at=now` on every run still open with
  `started_at <= beforeIso`. `reconcile()` captures `bootIso` at entry and runs the
  sweep in a `finally` — after recovery has closed the recoverable ones, and even when
  there are no sessions to reconcile. Runs started after boot are untouched.
- All new telemetry writes follow the existing advisory stance: try/catch +
  `console.error("[telemetry] …")`, never fail the run.

### Report

- `src/report/data.ts` — gathers a plain `ReportData` (per-run rows with computed
  `durationMs`, timing rows, phase events, failure groups, failed-run tails) plus pure
  aggregate helpers: `percentile`, `cacheHitRate`, `approvalDwellsMs`,
  `createdToPrMs`. Every query pragma-guards missing columns/tables so a read-only
  report against an old DB degrades instead of throwing (existing behavior, kept).
  - `createdToPrMs` excludes sessions whose first phase event is already `done`
    (resume sessions that inherit a prior PR) — their e2e time belongs to the
    original session.
- `src/report/html.ts` — `renderHtml(data): string`, a fully self-contained HTML
  dashboard (inline CSS + SVG, no CDN, light/dark via `prefers-color-scheme`,
  built per the dataviz skill): stat tiles (total spend, runs, implement success
  rate, median approval dwell, median created→PR), cost per task type, outcomes,
  duration p50/p90, host timings, cache-hit rate, success-by-model.
- `src/report.ts` — entry: open DB read-only, `gatherReport`, print the console
  report (existing sections kept, new ones added: durations, model stats, host
  timings, gate latency), write `jarvis-report.html` to the cwd, log its path.
  `jarvis-report.html` goes in `.gitignore`.

## Testing

- Store: migration guards (open old-shaped DB twice), `model`/`effort` round-trip,
  phase events written once per actual change, `addTiming`, `finishOpenRun`,
  `markInterruptedRuns` (only pre-boot open runs swept).
- Pipeline: `runFinishFrom` unit tests; reconcile closes the orphaned run via the
  existing fake-`connect` seam; sweep marks unrecoverable runs interrupted.
- Sandbox: `cloneRepo` emits `clone` + `serena_index` timings (existing fake-sandbox
  pattern); `withSandbox` timing is e2b-bound → live acceptance, per repo convention.
- Report: pure aggregates unit-tested; `gatherReport` over a temp DB seeded through
  `SessionStore`; `renderHtml` smoke test (contains sections, escapes HTML).
