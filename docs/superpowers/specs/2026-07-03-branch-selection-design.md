# Branch selection for Jarvis sessions

## Problem

Jarvis always clones the target repo's default branch (`cloneRepo()` in
`src/sandbox/session.ts` runs a bare `git clone` with no branch flag). There's
no way to tell Jarvis to work on a different branch, and no explicit step
ensuring serena indexes whatever branch is actually checked out.

## Goals

- Let the user specify which branch Jarvis should work from, either in the
  issue description or by reply.
- If no branch is specified, Jarvis asks and blocks until it gets one before
  doing any repo work (no wasted sandbox spin-up).
- Serena indexing continues to happen after the correct branch is checked
  out — this already falls out of the existing `cloneRepo` → `indexRepo`
  ordering; it just needs the checkout itself to be branch-aware.

## Design

### Phase state machine

Add `"await_branch"` to `Phase` (`src/store/sessions.ts`), inserted before
`"plan"`:

```
created → (branch known in description? plan : await_branch) → plan → await_approval ⇄ plan → implement → done
```

### Data model

- `sessions.branch TEXT` — new column, hand-rolled migration matching the
  existing `plan`/`sandbox_id`/`pr_url`/`review` columns in
  `SessionStore`'s constructor.
- `SessionStore.setBranch(agentSessionId, branch)`; `get()`/`listByPhase()`
  include `branch` in the returned `SessionRow`.

### Branch keyword parsing (`src/linear/context.ts`)

- `parseBranchKeyword(text)`: matches `/\bbranch\s*:\s*(\S+)/i` anywhere in
  text (title, description, or a reply). Returns the captured token or
  `null`.
- `parseBranchAnswer(text)`: used only in `await_branch` replies — tries
  `parseBranchKeyword` first, else falls back to the reply's first
  whitespace-trimmed token (so a bare `feature/foo` reply to "which branch?"
  works without requiring the `branch:` prefix).
- `isValidBranchName(name)`: allowlist regex for characters safe to
  interpolate into a shell command (`git clone -b <name> ...`) — alnum,
  `.`, `_`, `/`, `-`; rejects `..` and a leading `-` (flag injection). This
  is a real trust boundary (untrusted Linear reply text reaching a shell
  string), not just a UX nicety — validate before it's ever used in a
  command, not after.
- `ASK_BRANCH` footer constant (parallel to `APPROVAL_FOOTER`): the
  elicitation text posted when Jarvis needs to ask.

### Orchestrator (`src/orchestrator/pipeline.ts`)

- Extract the current `onCreated` body (clone → map → plan →
  `#finishPlan`) into a private `#runPlan(ctx, acts, branch)`, so both
  `onCreated` (branch known up front) and the `await_branch` resolution
  path in `onPrompted` (branch known after a reply) call the same code.
- `onCreated`: parse `ctx.title + "\n" + ctx.description` with
  `parseBranchKeyword`. Valid branch found → `store.setBranch()`, call
  `#runPlan`. Not found → `store.upsert(..., "await_branch", issueId)`,
  post the `ASK_BRANCH` elicitation, return — no sandbox opened.
- `onPrompted`: if `row.phase === "await_branch"`:
  - `parseStopGate(replyText)` → close the session (same as
    `await_approval`'s stop handling).
  - Else `parseBranchAnswer(replyText)`; if `!isValidBranchName(...)` →
    post an error activity explaining the problem, stay in
    `await_branch`, return (let the user retry — don't kill the session
    over a typo).
  - Else `store.setBranch()`, call `#runPlan(ctx, acts, branch)`.
- `cloneRepo(sbx, cfg, branch?)` (`src/sandbox/session.ts`): when `branch`
  is set, clone with `-b <branch>`; otherwise unchanged (default-branch
  clone). Every call site (`onCreated`/`#runPlan`, revise, implement,
  self-review re-clone) passes `row.branch` so the same branch is checked
  out for every sandbox spun up over the life of the session.
- First clone failure (out of `await_branch`, branch doesn't exist on the
  remote) is caught specially: report "branch not found" as an error
  activity and drop back to `await_branch` instead of the terminal
  `error` phase. Later clones (revise/implement, once a plan is already
  approved) keep today's behavior — fail loud into `error` — a branch
  vanishing mid-session after being valid at plan time isn't worth more
  machinery.

## Out of scope

- Changing branch mid-session after planning has started (revision/steer
  flows don't re-parse for a branch keyword).
- Any Linear custom field or label integration — this is reply/description
  text only, consistent with how `parseApproval`/`parseStop` already work.
