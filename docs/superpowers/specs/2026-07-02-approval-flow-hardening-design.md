# Approval-flow hardening — design

**Date:** 2026-07-02
**Status:** approved approach (Option A: harden agent-session flow; keep Jarvis as a Linear agent, not a person account)

## Problem

In the vertical-slice test, Jarvis planned an issue but never implemented after the user replied
"approve, and dont use the llm because there is no env for you". Logs showed the `prompted`
webhook arriving repeatedly with a 200, then nothing; Linear showed "working" forever.

Root causes found in code review:

1. **Console-silent early returns in `onPrompted`** (`src/orchestrator/pipeline.ts:115-121`).
   Both the phase-guard return (`row.phase !== "await_approval"`) and the not-approved branch
   log nothing to the console; the phase-guard return also posts **no Linear activity**. Per
   Linear's agent-interaction docs, a session that receives a prompt and emits no activity is
   marked unresponsive — the stuck "working" state.
2. **Plan text is memory-only** (`#plans` Map, `pipeline.ts:33`). Phase survives restarts via
   SQLite but the plan doesn't; a restart between plan and approval makes implement run with
   an empty plan.
3. **Version drift risk**: the parseApproval negation fix (`82637a9`) may not have been the
   running code during the test; there is no startup log identifying the running version.

## Non-goals

- Switching Jarvis to a person/member Linear account (rejected: doesn't fix state bugs, costs a
  seat, loses agent-session UX).
- A polling reconciler for missed webhooks (deferred until a webhook is demonstrably *missed*
  rather than *swallowed*).

## Design

Four small changes, no new dependencies, no new files except a migration line in the store.

### 1. No silent paths in `onPrompted`

Every branch logs to console AND posts a Linear activity (10-second rule):

- Phase mismatch → `console.log("[skip] prompted but phase=X")` + post a `thought` telling the
  user what state the session is in and how to restart ("re-assign the issue to start over").
- Not approved → keep the existing `thought`, add a console log including the parsed verdict.
- Approved path already logs; unchanged.

### 2. Persist the plan in SQLite

Add a nullable `plan` TEXT column to the `sessions` table (`src/store/sessions.ts`), written
when the plan is produced, read in `onPrompted`. `#plans` Map is deleted. If the column is
empty at implement time, post an `error` activity and set phase `error` instead of silently
implementing from an empty plan.

Migration: `ALTER TABLE ... ADD COLUMN` guarded by a check of existing columns (SQLite has no
`IF NOT EXISTS` for columns).

### 3. Startup version log

On boot, log the current git commit (short SHA via `git rev-parse --short HEAD`, best-effort)
so "which code was running" is never ambiguous again.

### 4. SDK/doc alignment check

Verified against current Linear agent-interaction docs (fetched 2026-07-02):

- `prompted` reply text: docs say `agentActivity.body`; code reads `content.body` first with
  flattened fallbacks — keep both shapes in `promptedBody`.
- Activity types thought/action/response/elicitation/error all current; `action` requires
  non-empty `parameter` (already handled).
- Deprecation: `externalLink` → `externalUrls` (we don't use it; note only).
- 10-second rule applies to prompted sessions, not just created — this is what change 1 fixes.

## Error handling

- Empty plan at implement time → `error` activity + phase `error` (fail loud, never implement
  blind).
- Activity-post failures remain non-fatal (existing `#relay` behavior).

## Testing

- Unit: store round-trips the plan column; `onPrompted` on a session in phase `plan`/`error`/
  missing posts a thought and does not run implement (mock activities + store).
- Existing parseApproval tests unchanged.
- Manual: re-run the vertical slice; approval reply must transition Linear out of "working"
  in every branch (approve, reject, wrong-phase).
