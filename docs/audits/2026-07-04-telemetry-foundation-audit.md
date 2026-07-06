# Telemetry Foundation — Code Audit

Scope: commit series `4d41706^..945ffbb` (design `4d41706`, plan `a254afa`, implementation
`045867b 61c5847 f9643fc 1b0f7c5 c37de00 f24e32e 945ffbb`).
Type: read-only audit. No production code was modified.
Date: 2026-07-04.

## Executive summary

The telemetry foundation is a well-built, additive feature. Schema migrations follow the
established pragma-guarded `ALTER TABLE` pattern and are idempotent; every new telemetry
write is wrapped so a failure logs `[telemetry]`/`[history]` and never fails an agent run;
the run-lifecycle fixes (`finishOpenRun`, `markInterruptedRuns`, reconcile closing orphaned
runs) close the "outcome stays NULL forever" gaps the design set out to fix; HTML output is
consistently escaped through a single `esc()` helper and is genuinely self-contained (no
external `src`/`href`). Tests pass (237) and typecheck is clean.

Deployment risk is **low**. No Critical or High defects were found. The defects that exist
are **telemetry-accuracy** issues, not runtime-stability or data-loss issues — they make two
reported metrics (median created→PR, and success-rate) mildly-to-moderately misleading, but
they cannot corrupt the store, wedge a session, or fail a run. The most important is that the
`createdToPrMs` "exclude resumed sessions" guard is **unreachable in production** (Medium):
the intended exclusion silently never fires, so resumed sessions inject spurious near-zero
samples into the headline created→PR metric. A unit test locks in the *intended* behavior
against synthetic input that the real write path never produces, giving false confidence.

Verification: `npm test` → 237 passed; `npm run typecheck` → clean; `git diff --check
4d41706^..945ffbb` → clean.

## Findings

### Medium — `createdToPrMs` never excludes resumed sessions; the exclusion guard is dead code

- **Severity:** Medium
- **Files:** `src/report/data.ts:193` (the guard `evs[0].label === "done"`); root cause at
  `src/server.ts:63` (`store.upsert(..., "clarify", ...)`) combined with
  `src/orchestrator/pipeline.ts:310` (inherited-PR resume upserts `done`).
- **Commit:** `1b0f7c5` (report data layer / `createdToPrMs`).
- **What is wrong:** `createdToPrMs` intends to exclude "sessions born straight into `done`
  (a resume that inherited a prior PR)" via `if (... || evs[0].label === "done") continue;`.
  But `server.ts` performs `store.upsert(agentSessionId, "clarify", issueId)` **before**
  `onCreated` runs, and `upsert` emits a `phase` event on the first insert. So the first
  phase event of *every* created session is `clarify`, never `done`. The guard therefore
  never matches, and no resumed session is ever excluded.
- **Consequence:** A resumed session that inherits a prior PR has phase events
  `[clarify, done]` occurring milliseconds apart, yet it has a `pr_url`, so it is included in
  `createdToPrMs` and contributes a ~0 ms sample. Resumed *implement* sessions
  (`[clarify, implement, done]`) contribute a partial e2e (implement duration only, missing
  the original plan+approval time) mislabeled as full created→PR. Both drag the **median
  created→PR** figure — shown in the console "Human-gate latency" section
  (`src/report.ts:116`) and the HTML "Median created→PR" tile (`src/report/html.ts:283,330`)
  — downward. The headline latency metric understates true created→PR time whenever the fleet
  has recovered from any crash/re-assignment.
- **Reproduction:** Confirmed empirically against the real `SessionStore` write path. Seed an
  original full-lifecycle session with a PR, then a resumed session created via
  `upsert("clarify")` → `upsert("done")` + `setPrUrl` (exactly what `server.ts` +
  `pipeline.ts:308-318` do). `createdToPrMs` returns two samples (one real, one ~0 ms) instead
  of the intended one. Guard `evs[0].label === "done"` was `"clarify"` in every case.
- **Recommended fix:** Exclude resumes by a condition that is actually true in production.
  Options: (a) exclude any session whose phase-event sequence never contains
  `plan`/`await_approval` before its first `done` (i.e. it never went through the human gate on
  *this* session); or (b) require the created→PR window to start at a `plan` event, not
  `evs[0]`; or (c) drop samples whose duration is below a small floor. Whichever is chosen, the
  guard must be validated against events produced by the real store, not hand-built arrays.
- **Missing/inadequate test coverage:** `tests/report/data.test.ts:44` feeds
  `{ sessionId: "resume", label: "done" }` as the *first* event — a state the production write
  path never creates (it always prepends `clarify`). The test passes while the production
  behavior is wrong. Add a test that drives phase events through `SessionStore`
  (`upsert("clarify")` then `upsert("done")`) and asserts the resume is excluded.

### Medium — success-rate denominators include `interrupted` (infrastructure-death) runs

- **Severity:** Medium
- **Files:** `src/report/html.ts:280-281` (implement-success tile),
  `src/report/html.ts:193-195` (`modelTable`), `src/report.ts:96-100` ("Success by model").
- **Commit:** `945ffbb` (console/HTML success-by-model + tile); interacts with `c37de00`
  (`markInterruptedRuns` stamping `outcome='interrupted'`).
- **What is wrong:** Success rate is computed as
  `runs.filter(outcome === "success").length / runs.filter(outcome != null).length`. Runs
  swept by `markInterruptedRuns` (host died mid-run) have `outcome = 'interrupted'`, which is
  non-null and non-success, so they land in the denominator but never the numerator.
- **Consequence:** Every host restart that orphaned an in-flight run permanently deflates the
  model/implement success rate — an infrastructure failure is attributed to the model. Since
  `model` on implement runs *is* the routing decision, a routing evaluation based on this
  number is biased against whichever model happened to be running when the host bounced.
- **Reproduction:** Restart the host while an `implement` run (say Opus) is executing;
  `reconcile()`'s boot sweep stamps it `interrupted`; the next `npm run report` shows Opus with
  a lower success rate than it earned, with no indication the miss was infrastructural.
- **Recommended fix:** Exclude `interrupted` (and arguably `no_result`) from the denominator,
  or report it as a distinct bucket (the HTML `stackedOutcomes` chart already separates an
  "interrupted / no result" bucket — reuse that classification for the rate). `pr_failed` is a
  genuine agent failure and should stay in the denominator.
- **Missing/inadequate test coverage:** No test computes a success rate over a run set that
  mixes `success` with `interrupted`. Add one asserting interrupted runs don't count against
  success.

### Low — `serena_index` timing is recorded even when the index is a no-op or fails

- **Severity:** Low
- **Files:** `src/sandbox/session.ts:76-78` (times `indexRepo`), `indexRepo` at
  `src/sandbox/session.ts:85-94` (swallows all failures).
- **Commit:** `f24e32e`.
- **What is wrong:** `cloneRepo` records `onTiming("serena_index", elapsed)` unconditionally
  after `indexRepo`, but `indexRepo` catches every error (serena binary absent, unsupported
  language, LSP crash) and returns normally. So a failed or no-op index still emits a
  `serena_index` timing.
- **Consequence:** The "Host timings" `serena_index` p50/p90 conflates real index latency with
  fast command-not-found/failure latency, understating (or noising) the metric the design
  specifically wanted — the index cost paid "2–4× per issue". Low because failures are fast and
  unlikely to dominate p50, and the whole channel is advisory.
- **Recommended fix:** Have `indexRepo` return a success boolean and only emit the timing on
  success (or emit a distinct `serena_index_failed` label), so the metric reflects real
  indexing work.
- **Missing/inadequate test coverage:** `tests/sandbox/session.test.ts` asserts the two
  timings fire on the happy path but not that a failed index is excluded/labeled.

### Low — failure-miner and phase/timing reads are unindexed full scans

- **Severity:** Low
- **Files:** `src/report/data.ts:120` (`SELECT payload FROM run_events WHERE type =
  'tool_result'` — loads and `JSON.parse`s every tool_result ever recorded),
  `src/report/data.ts:101,105` (`WHERE kind = 'timing'|'phase'` on `session_events`).
- **Commit:** `1b0f7c5`.
- **What is wrong:** The failure miner scans and parses the entire `run_events` history in
  memory on every report; the `session_events` timing/phase reads filter on `kind` with no
  supporting index (only `agent_session_id` is indexed). `run_events` has an index on `run_id`
  but not on `type`.
- **Consequence:** Report runtime and memory grow linearly with total event volume. Because
  `npm run report` is an offline, manually-run script, this is Low — but it is the one place
  the feature does not scale.
- **Recommended fix:** If the event tables grow large, add `run_events(type)` /
  `session_events(kind)` indexes and/or bound the miner to a recent window (e.g. last N days
  by `ts`). Document the unbounded scan if left as-is.
- **Missing/inadequate test coverage:** none needed for correctness; a note in the report
  source would suffice.

### Low (informational) — `costOverTime` x-axis labels interpolated without `esc()`

- **Severity:** Low (no exploitable path)
- **File:** `src/report/html.ts:182-183` (`${days[0][0]}`, `${last[0]}`).
- **What is wrong:** Every other DB-derived string in `html.ts` is passed through `esc()`;
  these two day labels are not. The values are `startedAt.slice(0, 10)` of host-generated ISO
  timestamps (`new Date().toISOString()`), which can never contain `<`/`&`/`"`, so there is no
  injection vector today.
- **Consequence:** None in practice; flagged only for consistency and to prevent a future
  change (e.g. sourcing the label from user data) from opening an XSS hole.
- **Recommended fix:** Wrap both in `esc()` to match the file's invariant.

## Design and implementation deviations

- **`createdToPrMs` resume exclusion (design §Report):** The design states resumed sessions
  inheriting a prior PR are excluded because their first phase event is `done`. In the
  integrated system this is false — `server.ts` records a `clarify` phase event first — so the
  exclusion never fires (see Medium finding). This is the one place implementation diverges
  from design semantics.
- **Success-rate denominator:** Neither design nor plan specifies how `interrupted` runs affect
  success rates; the implementation silently includes them (see Medium finding). Ambiguous
  requirement, resolved in a way that biases the metric.
- **Everything else matches design:** additive pragma-guarded columns (`model`, `effort`,
  `tokens_cache_write`); `session_events` table shape and `phase`-only-on-change semantics;
  `finishOpenRun`/`markInterruptedRuns` behavior and the `started_at <= bootIso` sweep in
  reconcile's `finally`; `runFinishFrom` extracted and shared by `#logUsage` and reconcile;
  timing seams (`sandbox_create`/`clone`/`serena_index` via `onTiming`, `history` via
  `#timed`); the self-contained HTML dashboard with the specified sections; `.gitignore` for
  `jarvis-report.html`. All present and faithful.

## Test and verification results

| Command | Result |
|---|---|
| `npm test` (`vitest run`) | **237 passed**, 14 files, ~3.4s |
| `npm run typecheck` (`tsc --noEmit`) | **clean**, no errors |
| `git diff --check 4d41706^..945ffbb` | **clean** (no whitespace/conflict markers) |

Notes on trustworthiness of the passing suite (do not treat green as proof of correctness):
- `tests/report/data.test.ts` `createdToPrMs` test uses synthetic phase-event arrays whose
  first element is `done` — a shape the real write path never produces — so it validates
  intended behavior, not integrated behavior (see Medium finding #1).
- Store tests strongly assert **values** (round-trips, `interrupted` vs `success`, phase-event
  emission exactly once per change, rounded timings), which is good. Migration coverage is
  limited to "open the same DB twice does not throw" and does not open a DB created by an
  *older schema shape* and assert the `ALTER`s add exactly the missing columns.
- No test exercises: migration onto an genuinely old-shaped DB, concurrent/boot-race run
  lifecycle, HTML injection via `failureGroups`/`timings` labels (only `error` and the
  seeded failure key are tested), or success-rate denominators mixing outcomes.

## Residual risks and test gaps

- **Boot race (pre-existing, not introduced by this feature):** `reconcile()` is fire-and-forget
  (`src/server.ts:27`) while the webhook server accepts requests immediately. A `created`
  webhook that resumes an issue (`findResumableByIssue`) can run concurrently with `reconcile()`
  re-attaching to the *same* prior session's sandbox. The telemetry layer handles this
  gracefully — `finishOpenRun` closes the correct row and the `phase === "done"` guards in
  `#finishImplement`/`#finishPlan` prevent double posts — and the sweep's `started_at <=
  bootIso` guard correctly avoids interrupting runs started after boot. The residual
  operational risk (two implement runs pushing the same `jarvis/<issueId>` branch) predates
  this feature (durable-runs) and is out of scope here, but noted. `hasLive()` cannot see
  reconcile-recovered runs (they are not registered in `#live`), so it does not guard this race.
- **Timing correctness across recovery:** verified — `reconcile()` does not clone or create
  sandboxes, so it emits no timing events; there is no cross-path session-id mixup.
- **Graceful degradation on old DBs:** verified adequate. `tokens_out`/`tokens_cache_read` have
  existed since the `runs` table was first created (`7da5dbc`), so `gatherReport`'s
  unconditional `COALESCE(tokens_out, 0)` cannot hit a missing column on any real jarvis DB;
  the columns added by *this* feature (`tokens_cache_write`, `model`, `effort`) and the
  `session_events` table are all `col(...)`/`hasTable(...)` guarded.
- **Percentile / dwell math:** verified correct on small N — `percentile` nearest-rank is
  clamped `[0, n-1]`, returns `null` on empty; `cacheHitRate` returns `null` on zero traffic;
  `approvalDwellsMs` correctly counts each `await_approval` entry including the revision loop;
  no divide-by-zero paths (`modelTable`/`Success by model` derive the model set from
  `outcome != null` rows, so the denominator is always ≥1).
- **Phase-event exactly-once:** verified — `upsert`/`setPhase` emit only on `prev !== phase`;
  duplicate webhooks do not spam events (covered by `tests/store/sessions.test.ts:323`).
- **HTML injection:** verified — all user/DB-derived strings routed through `esc()` (labels,
  models, outcomes, errors, event payloads, tips) and the tooltip script uses `textContent`;
  the only unescaped interpolation is machine-generated ISO date labels (Low, informational).

No Critical or High defects were found. The feature is safe to deploy; the two Medium findings
should be fixed before the created→PR and success-rate numbers are used to make routing or
process decisions.
