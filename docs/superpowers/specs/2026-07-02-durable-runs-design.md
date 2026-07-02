# Durable Agent Runs — Design

**Date:** 2026-07-02
**Status:** Approved (approach B of three presented)

## Incident that motivated this

On 2026-07-02 a plan run for ARJ-8 completed successfully inside its E2B sandbox
(transcript shows `end_turn` at 06:25:21Z with a complete 27KB plan), but the host
never learned of it. The stdout stream of `sbx.commands.run(..., { timeoutMs: 0 })`
went half-open; the final result line and the exit event were never delivered. With
no timeout and no liveness check, `runAgent` awaited forever, the orchestrator never
posted the elicitation, and Linear showed "Working" indefinitely. The plan was only
recoverable by manually reading the agent transcript out of the sandbox.

**Root cause:** the run result depends on a single long-lived output stream with no
watchdog, and the plan's durability depends on the host being alive at the moment
the stream ends.

## Failure modes to cover

1. Stream drops mid-run (the incident) — sandbox has the result, host waits forever.
2. Host restarts mid-run — the in-memory `await` is gone; sandbox keeps working.
3. Result obtained but the Linear post fails transiently.
4. Plan approved after a restart/DB loss — DB `plan` column is empty.
5. Sandbox genuinely dies mid-run — must fail loud in Linear, never hang silently.

## Design (approach B: durable runs + Linear as plan source of truth)

### 1. Result file in the sandbox (authoritative result)

`runner.mjs` writes the final `result`/`error` event to `/tmp/jarvis-result.json`
**before** emitting it on stdout. Stdout becomes live telemetry; the file is the
authoritative record and survives any stream failure for the sandbox's lifetime.

### 2. Supervised `runAgent` (no unbounded await)

`runAgent` races the streaming run against a detached watcher:

- **Stream branch** — today's behaviour: stream stdout, parse events, relay to Linear.
- **Watcher branch** — poll every 30s: if `/tmp/jarvis-result.json` exists, return it;
  if `commands.list()` shows no `runner.mjs` process, grace-wait, final file read, return.
- **Deadline** — 55 min absolute cap (sandbox TTL is 60); after that, give up loudly.

Whichever branch wins, the loser is aborted. If the stream ends without a result
event, the file is read as fallback. Covers failure modes 1 and 5.

### 3. Sandbox ID persisted + boot reconciliation

`sessions` gains a `sandbox_id` column, set when a run's sandbox is created. On boot,
the orchestrator reconciles every session stuck in `plan`/`implement`:

- Sandbox alive → re-attach the watcher, recover the result file, finish the pipeline
  (post the plan elicitation / PR response) exactly as if the run had never detached.
- Sandbox dead / no result → post a loud `error` activity ("re-assign to retry") and
  set phase `error`. Nothing stays silently stuck. Covers failure mode 2.

### 4. Plan recovery from Linear (source of truth)

The plan already reaches Linear as the approval elicitation (which ends with a fixed
footer). On approval, if the DB has no plan, fetch the session's activities via the
Linear GraphQL API, find the elicitation carrying the footer, strip the footer, and
use that as the approved plan. A wiped DB or restart no longer loses the plan.
Covers failure mode 4.

### 5. Retried terminal posts

`response` / `error` / `elicitation` posts retry 3× with backoff (they are the
posts that gate phase transitions). High-volume `action` telemetry stays one-shot.
Covers failure mode 3.

## Also folded in from the vertical-slice plan (Phase 4)

- **4.1 cost visibility:** the plan elicitation and final PR response append a
  `_Cost: $X.XX_` line from the run's result usage.
- **4.5 retries + failure reporting:** covered by items 3 and 5 above.
- **4.2 prompt-cache flag (`excludeDynamicSections`):** deferred — the agent SDK only
  exists inside the sandbox template, so the option cannot be verified locally and a
  wrong name breaks every run. Revisit with a template rebuild.
- **4.3 CLAUDE.md map task, 4.6 Serena:** out of scope, unchanged.

## Rejected alternatives

- **A. Watchdog only** — fixes the incident but not restarts or DB loss.
- **C. Sandbox pushes results to the host URL** — the public URL is an ephemeral
  trycloudflare tunnel; it adds a failure mode instead of removing one.
