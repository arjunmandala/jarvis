# Conversational chat, image attachments, sub-issue decomposition, and dynamic workflow states

Date: 2026-07-05
Status: approved design, pre-implementation

## Problem

Every Linear session assigned to Jarvis today runs the full `plan → await_approval →
implement` pipeline (`src/orchestrator/pipeline.ts` `onCreated`, line 274) regardless
of what was actually asked. There is no intent classification anywhere — a request
like "explain this function" or "review this diff" gets funneled into `planTask()`
the same as "add a rate limiter", producing a plan, an approval gate, and eventually
a PR containing what should have been a plain answer.

Two related gaps compound this:

- Linear attachments (screenshots pasted into comments) are never read. Grep for
  `attachment` across the repo returns zero matches — not ignored, absent.
- There's no concept of "this issue is too big for one PR" beyond `Scope: large`
  in the plan header, which only ever routes model choice (sonnet vs opus), never
  triggers decomposition.
- Jarvis never touches the Linear issue's workflow state (Todo/In Progress/Done
  column) — only its own internal `phase` in SQLite.

This design covers all four: conversational routing, image attachments, sub-issue
decomposition for oversized issues, and dynamic (non-hardcoded) workflow-state
transitions.

## 1. Chat routing

**Phase**: reuse the existing but unused `"clarify"` value in `Phase`
(`src/store/sessions.ts:3` — defined, never produced) as the conversational phase,
rather than adding a new one.

**Classification**: one plain, non-agentic Claude API call (Haiku 4.5, host-side,
no sandbox) given the issue title/description/latest comment/thread context,
returning `"chat" | "change"`. Runs before any `withSandbox` call.

- `onCreated` (`pipeline.ts:274`): classify before the existing `findResumableByIssue`
  check. `"change"` → today's unchanged path. `"chat"` → `store.upsert(..., "clarify",
  ...)` then a new `#runChat(ctx)` (mirrors `#runPlan`).
- `onPrompted` (`pipeline.ts:427`): add a `"clarify"` phase arm. Re-run the same
  classifier on the new reply. `"chat"` → another chat round, phase stays
  `"clarify"`. `"change"` → transition into `"plan"` via the same code path
  `onCreated` uses, just entered from a reply. This is the auto-escalation: a
  conversation that starts as Q&A and pivots into "now implement that" needs no
  special phrasing from the user.
- Post-answer phase: stays `"clarify"` (not `"done"`) — the thread is treated as an
  open conversation indefinitely; only a reclassification to `"change"` moves it
  out. This preserves the escalation-on-reply behavior for all future replies, not
  just the first one.
- `reconcile()` (`pipeline.ts:713`): add `"clarify"` to `listByPhase("plan",
  "implement", "review")` — a chat run is a real tracked sandbox run and needs the
  same crash-recovery coverage as plan/implement.

**Misclassification ceiling**: same category as `parseApproval`/`parseStop` — an
LLM-based heuristic, not perfect. Mark with a `// ponytail:` comment noting the
ceiling and upgrade path (a manual escalation phrase as a fallback override, if
misclassification proves costly in practice). Cost of a wrong `"chat"` call: one
redundant sandbox round-trip before the next reply escalates it. Cost of a wrong
`"change"` call: an unwanted plan/approval elicitation — no worse than today's
baseline (every issue currently gets this).

## 2. `chatTask()` — the lightweight answer task

New builder in `src/agent/tasks.ts`, following the `mapTask()` precedent of
deviating from `ALL_REPO_TOOLS`:

- `allowedTools`: `Read/Glob/Grep/mcp__serena` only — no `Edit/Write/Bash`.
  Structurally incapable of making changes, not just instructed not to.
- `model: claude-sonnet-5`, `maxTurns: 15`, `maxBudgetUsd: 1`, `effort: "medium"`.
- `systemAppend` (fixed, byte-stable per the existing cache convention): answer the
  question directly using the repo; final message is posted verbatim as the
  response — no `Type:`/`Scope:` header, no plan framing.
- `goal`: reuses `issueBlock(ctx)` + `repoMapBlock(repoMap)` + `historyBlock(history)`
  — no new context-assembly code needed.

**Wiring**: `#runChat(ctx)` in `pipeline.ts` mirrors `#runPlan`, ending in
`#finishChat` which posts the final message as a `response` activity (existing
primitive in `activities.ts`) instead of `elicitation`.

## 3. Image attachments

Linear attachments pasted into comments arrive as plain markdown image links in
the comment body (`![...](https://uploads.linear.app/...)`), not a separate
structured attachments field — confirmed via Linear's docs. The images are
authenticated the same way as the rest of the API (OAuth bearer token).

**Extraction**: scan the assembled text (issue description + latest comment +
thread history text already gathered by `makeThreadFetcher`) for
`!\[[^\]]*\]\((https:\/\/uploads\.linear\.app\/[^)]+)\)`, collect and dedupe URLs.

**Download**: `fetch` each URL with `Authorization: Bearer <LINEAR_ACCESS_TOKEN>`,
base64-encode. Cap at 5 images / 5MB each — defensive against a thread linking many
large images.

**Delivery**: `AgentTask` (`src/agent/tasks.ts:6`) gains an optional `images?:
{mediaType: string; data: string}[]`. `runner.mjs`'s `userMsg()` (line 69) appends
`{type:"image", source:{type:"base64", media_type, data}}` blocks alongside the
existing text block when present. Additive-only — `images` is `undefined` for
every task that doesn't populate it, no behavior change elsewhere.

**Scope**: wired into the shared context-assembly path (`issueBlock` or its
caller), not just `chatTask` — benefits chat, plan, revise, and implement equally.
A screenshot-based bug report should be read correctly regardless of which task
handles it.

## 4. Sub-issue decomposition for oversized issues

**Trigger**: the planning agent itself decides, with full repo context — not a
title-only pre-classifier. Extend the existing fixed `PLAN_APPEND` contract
(`src/agent/tasks.ts`) with a third allowed final-message shape: if the issue needs
splitting, the message starts with `Decomposition:` followed by a numbered list of
sub-issue titles + one-paragraph descriptions, instead of the `Type:`/`Scope:` plan
header.

**Approval-gated creation**: `#finishPlan` detects the `Decomposition:` prefix
(same string-prefix-check style as `routeImplement`'s header parsing) and posts it
as the `elicitation` — same approval gate as a normal plan. Nothing is created in
Linear until a human approves the split, exactly like today's plan approval.

**On approval**: instead of transitioning to `implement`, call `@linear/sdk`'s
`LinearClient.createIssue({ parentId: ctx.issueId, title, description, teamId,
assigneeId: <Jarvis's actor id> })` per chunk (native SDK method already available
via `makeLinearClient` — no hand-rolled GraphQL needed), then mark the parent
session `done`.

**No new orchestration for the children**: each created+assigned sub-issue fires
its own `AgentSessionEvent` webhook exactly like any human-assigned issue, entering
`onCreated` and running the full pipeline (chat-routed or plan/approve/implement)
independently. Decomposition is purely a plan-time branch plus N `createIssue`
calls — the rest of the machinery already exists.

**New context needed**: `IssueContext` (`src/linear/context.ts:4`) gains `teamId`
(present on the webhook payload's `issue.team.id`, not currently extracted).

## 5. Dynamic workflow-state transitions

**Fetching states**: Linear's workflow states have a standardized `type` category
(`backlog`/`unstarted`/`started`/`completed`/`canceled`) even though display names
differ per team. Fetch a team's states via `@linear/sdk`'s `team.states()`, cache
per teamId (rarely changes — same cache posture as `repo_maps`) as `{id, name,
type}[]`.

**Transition points** in `pipeline.ts`:

| Jarvis moment | Target category |
|---|---|
| plan starts | `started` |
| implement starts | `started` |
| PR opened | `started` (prefer a state whose name suggests review, if one exists) |
| done | `completed` |
| error | *(no transition — don't fake a status Jarvis isn't confident about)* |

**Picking among same-category states**: filter the team's states to the target
category.
- 0 matches → skip, log, continue (team removed that category — cosmetic, not
  fatal).
- 1 match → use directly, no extra call.
- 2+ matches → one cheap Haiku call (same pattern as the chat/change classifier),
  given the transition's plain-English label ("implementation starting", "PR
  opened for review", etc.) plus the candidate state names, returns the chosen
  state id. Paid only when there's real ambiguity.

**Applying**: `LinearClient.updateIssue(issueId, { stateId })`, best-effort/
advisory — log and continue on failure, same posture as the existing
history/serena advisory-failure handling. A failed status nudge never blocks or
fails a run.

## Testing

- **Classifier tests**: mock the Haiku call (existing SDK-mock pattern) with
  fixture prompts → assert `"chat"`/`"change"` routing for representative issue
  bodies (question, bug report, feature request, ambiguous).
- **Attachment tests**: fixture markdown bodies with/without `uploads.linear.app`
  links, mocked `fetch` for download, assert `AgentTask.images` populated and
  capped correctly.
- **Decomposition tests**: fixture plan output starting with `Decomposition:` →
  assert `#finishPlan` routes to the elicitation-then-createIssue path instead of
  the normal plan path; assert approval triggers exactly N `createIssue` calls with
  `parentId` set.
- **Workflow-state tests**: fixture team-states lists with 0/1/2+ matches per
  category → assert correct skip / direct-use / Haiku-disambiguation behavior;
  mock `updateIssue` to assert it's called with the right id and that a rejected
  promise doesn't fail the run.
- No new Linear activity types needed — chat reuses `response`/`elicitation`/
  `error` primitives already in `activities.ts`.

## Out of scope (this iteration)

- Non-image file attachments (logs, PDFs, CSVs) — images/screenshots only, per
  explicit scoping decision.
- Manual escalation-phrase fallback for chat/change misclassification — noted as
  the upgrade path, not built until misclassification proves costly in practice.
- Cross-issue memory for chat threads — same-issue scope only, consistent with
  the existing `history.ts` `// ponytail:` note.
