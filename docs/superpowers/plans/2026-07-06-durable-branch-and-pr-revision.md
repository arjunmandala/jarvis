# Durable Branch Visibility + PR Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push the per-issue work branch to the remote *before* the implement agent writes anything (so a dying run leaves an assignable branch, not nothing), and route a rejected/commented-on PR's Linear follow-up back into implementation on that same branch (so the open PR updates in place) — with no Linear↔GitHub integration.

**Architecture:** Two independent changes to the orchestrator. (1) In `#runImplement`, after `cloneRepo` and before the agent runs, deterministically create + push the work branch host-side (advisory — a failure just logs). (2) Add a narrow keyword gate `parseChangeRequest` and route a done-session follow-up that asks for code changes into `#runImplement` on the existing work branch (feedback folded into the plan text), instead of the read-only review path. Pushing more commits to the branch auto-updates the existing PR — GitHub's native behavior, no webhook wiring.

**Tech Stack:** TypeScript (`moduleResolution: nodenext`, `.ts` import extensions), Node ≥ 24.15, vitest, SQLite (`node:sqlite`), E2B sandbox (faked in tests via `Sandbox.create` spy).

## Global Constraints

- `.ts` sources import each other with **explicit `.ts` extensions**.
- `systemAppend` strings must stay **byte-stable across runs** (prompt-cache) — per-run content goes in `goal`, never in a system prompt. (Not touched by this plan, but do not violate it.)
- Every orchestrator branch that handles a webhook must **both log and post a Linear activity** — a silent throw wedges the session (Linear's 10s responsiveness rule).
- Keyword parsers are **regex heuristics, not classifiers** — mark the ceiling with a `ponytail:` comment, matching `parseApproval`/`parseStop` in `src/linear/context.ts`.
- Branch names interpolated into shell commands must already be validated by `isValidBranchName` (they are — `#workBranchFor` guarantees it).
- Run `npm run typecheck` and `npm test` green before claiming done.

---

## File Structure

- **`src/linear/context.ts`** — add `parseChangeRequest(text): boolean` next to the existing `parseApproval`/`parseStop` parsers. One responsibility: keyword gates for the state machine.
- **`src/orchestrator/pipeline.ts`** — add `#pushEmptyBranch` (Task 1), add `#reviseOnBranch` and extract `#runReview` from the current inline `#onDoneFollowUp` body, and wire `parseChangeRequest` routing (Task 2). Import `parseChangeRequest` in the existing bottom-of-file re-export block.
- **`tests/linear/context.test.ts`** — unit tests for `parseChangeRequest`.
- **`tests/orchestrator/pipeline.test.ts`** — a recording-sandbox test for the early branch push (Task 1) and follow-up routing tests (Task 2).

No new files, no new dependencies.

---

## Task 1: Deterministic early branch push in `#runImplement`

Guarantees the work branch exists on the remote the moment implementation starts — before the agent produces (and possibly loses) any work. Advisory: a push failure logs and the run proceeds (the agent's own per-step push retries).

**Files:**
- Modify: `src/orchestrator/pipeline.ts` — `#runImplement` (around line 705-707, right after `cloneRepo`), plus a new private helper `#pushEmptyBranch`.
- Test: `tests/orchestrator/pipeline.test.ts`

**Interfaces:**
- Consumes: `runCommand(sbx, cmd)` (already imported from `../sandbox/session.ts`, returns `{ exitCode, stdout, stderr }`), `REPO_DIR` (imported), `Sandbox` type (imported).
- Produces: `#pushEmptyBranch(sbx: Sandbox, workBranch: string): Promise<void>` — advisory, never throws.

- [ ] **Step 1: Write the failing test**

Add to `tests/orchestrator/pipeline.test.ts`. This needs a fake sandbox that *records* commands (the shared `makeOrchWithFakeSandbox` discards them), so define a local recording fake:

```ts
describe("early work-branch push", () => {
  afterEach(() => vi.restoreAllMocks());

  it("pushes the work branch to origin before the implement agent runs", async () => {
    const store = new SessionStore(":memory:");
    // A prior approved-but-died attempt so onCreated resumes straight to implement.
    store.upsert("as_old", "error", "iss_B");
    store.setPlan("as_old", "Type: feature\nScope: large\n\n## Plan\n- build it");
    store.setBranch("as_old", "main");
    store.setWorkBranch("as_old", "jarvis/iss_B");

    const commands: string[] = [];
    const fakeSbx = {
      sandboxId: "fake-sbx",
      files: { read: async () => JSON.stringify({ kind: "result", subtype: "success", text: "https://github.com/o/r/pull/9", costUsd: 0.1, sessionId: "s", usage: {}, numTurns: 2 }), write: async () => undefined },
      commands: { run: async (cmd: string) => { commands.push(cmd); return { exitCode: 0, stdout: "", stderr: "" }; }, list: async () => [] },
      kill: async () => undefined,
    };
    vi.spyOn(Sandbox, "create").mockResolvedValue(fakeSbx as unknown as Sandbox);
    const log: string[] = [];
    const orch = new Orchestrator({ targetRepo: "o/r", linear: { accessToken: "" } } as Config, store, () => fakeActs(log));

    await orch.onCreated({ agentSessionId: "as_newB", organizationId: "o", issueId: "iss_B", teamId: "team_1", title: "T", description: "D", comment: "", promptContext: "" });

    // The branch was pushed to origin before/around the agent run.
    expect(commands.some((c) => /git push -u origin jarvis\/iss_B/.test(c))).toBe(true);
    store.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/orchestrator/pipeline.test.ts -t "pushes the work branch to origin"`
Expected: FAIL — no command matches `git push -u origin jarvis/iss_B` (the host never pushes today; only the agent does, and the agent is faked).

- [ ] **Step 3: Add the `#pushEmptyBranch` helper**

Add this private method to the `Orchestrator` class in `src/orchestrator/pipeline.ts` (place it just above `#runImplement`, near line 686):

```ts
  // Make the work branch visible on the remote immediately — before the agent
  // writes anything — so a run that dies early (credits, crash, kill) leaves an
  // assignable branch on GitHub instead of nothing. Prefers the remote branch if
  // a prior run already pushed real commits (fast-forward no-op); else creates it
  // at the base HEAD (no work yet — just a visible, assignable ref).
  // ponytail: advisory — a push failure (offline, perms, non-fast-forward) only
  // logs; the implement agent's own per-step `git push` retries. workBranch is
  // pre-validated by #workBranchFor (isValidBranchName), so shell interpolation is safe.
  async #pushEmptyBranch(sbx: Sandbox, workBranch: string): Promise<void> {
    const cmd =
      `cd ${REPO_DIR} && ` +
      `(git checkout -B ${workBranch} origin/${workBranch} 2>/dev/null || git checkout -B ${workBranch}) && ` +
      `git push -u origin ${workBranch}`;
    try {
      const r = await runCommand(sbx, cmd);
      if (r.exitCode !== 0) {
        console.error(`[branch] ${workBranch} initial push failed (advisory): ${r.stderr.slice(0, 200)}`);
      } else {
        console.log(`[branch] ${workBranch} pushed to remote before implement`);
      }
    } catch (err) {
      console.error(`[branch] ${workBranch} initial push threw (advisory): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
```

- [ ] **Step 4: Call it in `#runImplement`**

In `#runImplement`, immediately after the `cloneRepo` call (currently line 707) and before `prepareHistory`, insert the call:

```ts
      await cloneRepo(sbx, this.#sbxCfg(ctx.agentSessionId), baseBranch);
      await this.#pushEmptyBranch(sbx, workBranch);
      const history = await this.#timed(ctx.agentSessionId, "history", () =>
        prepareHistory(this.#store, sbx, ctx.issueId, this.#fetchThread),
      );
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/orchestrator/pipeline.test.ts -t "pushes the work branch to origin"`
Expected: PASS.

- [ ] **Step 6: Run the full suite + typecheck**

Run: `npm run typecheck && npx vitest run tests/orchestrator/pipeline.test.ts`
Expected: PASS (the existing `makeOrchWithFakeSandbox` resume tests still pass — its `commands.run` returns exitCode 0, so `#pushEmptyBranch` succeeds silently).

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/pipeline.ts tests/orchestrator/pipeline.test.ts
git commit -m "feat(implement): push work branch to remote before agent runs so early deaths leave assignable work"
```

---

## Task 2: Route a rejected/commented PR follow-up back into implementation

Add a narrow keyword gate `parseChangeRequest`, and in `#onDoneFollowUp` route a change request into `#runImplement` on the existing work branch (feedback folded into the plan). Refactor the current inline review body into `#runReview` so it can also serve as the fallback when no saved plan exists.

**Files:**
- Modify: `src/linear/context.ts` — add `parseChangeRequest` (after `parseStop`, ~line 68).
- Modify: `src/orchestrator/pipeline.ts` — extract `#runReview` from `#onDoneFollowUp` (lines 805-831), add `#reviseOnBranch`, wire routing, import `parseChangeRequest` in the bottom re-export block (lines 1009-1013).
- Test: `tests/linear/context.test.ts`, `tests/orchestrator/pipeline.test.ts`.

**Interfaces:**
- Consumes (context.ts): existing `parseStop(text): boolean`.
- Produces (context.ts): `parseChangeRequest(text: string): boolean`.
- Consumes (pipeline.ts): `#runImplement(ctx, acts, plan: string, baseBranch: string | null, workBranch: string): Promise<void>`, `#workBranchFor(issueId, agentSessionId): string`, `SessionRow` (has `plan: string | null`, `prUrl: string | null`, `workBranch: string | null`).
- Produces (pipeline.ts): `#reviseOnBranch(ctx, row: SessionRow, feedback: string, acts): Promise<void>`, `#runReview(ctx, row: SessionRow, replyText: string, acts): Promise<void>`, and `parseChangeRequestGate` (the imported alias).

### Sub-part A — the parser

- [ ] **Step A1: Write the failing parser test**

Add to `tests/linear/context.test.ts` (mirror the existing `parseApproval` describe block; import `parseChangeRequest` from `../../src/linear/context.ts`):

```ts
import { parseChangeRequest } from "../../src/linear/context.ts";

describe("parseChangeRequest", () => {
  it("treats clear change requests as true", () => {
    expect(parseChangeRequest("please fix the error handling")).toBe(true);
    expect(parseChangeRequest("this is wrong, redo the validation")).toBe(true);
    expect(parseChangeRequest("address the PR comments")).toBe(true);
    expect(parseChangeRequest("the tests don't work")).toBe(true);
    expect(parseChangeRequest("rejected — make these changes")).toBe(true);
  });
  it("treats reviews and questions as false", () => {
    expect(parseChangeRequest("can you review it?")).toBe(false);
    expect(parseChangeRequest("what does this change do?")).toBe(false);
    expect(parseChangeRequest("looks good, thanks!")).toBe(false);
  });
  it("never fires on a stop", () => {
    expect(parseChangeRequest("stop")).toBe(false);
    expect(parseChangeRequest("never mind")).toBe(false);
  });
});
```

- [ ] **Step A2: Run to verify it fails**

Run: `npx vitest run tests/linear/context.test.ts -t "parseChangeRequest"`
Expected: FAIL — `parseChangeRequest is not a function`.

- [ ] **Step A3: Implement `parseChangeRequest`**

Add to `src/linear/context.ts` after `parseStop` (after line 68):

```ts
// A reply on a DONE session with an open PR: does it ask for code CHANGES
// (a rejection, "fix this", "address the comments") or is it a review/question?
// A change request routes back into implement on the existing work branch — the
// open PR updates when the new commits are pushed (GitHub's native behavior, no
// Linear↔GitHub wiring). Anything else stays on the read-only review path.
// Biased NARROW on purpose: a false positive spends a whole implement run
// ($3-8), while a false negative just yields a review the human can re-ask.
// ponytail: keyword heuristic, same ceiling as parseApproval — sarcasm/edge
// phrasing slips through. Upgrade path: a tiny classifier call if misroutes bite.
const CHANGE_REQUEST =
  /\b(fix|redo|revise|rework|reject(?:ed)?|address\s+(?:the\s+)?(?:pr\s+)?comments?|make\s+(?:the\s+|these\s+)?changes?|change\s+it|doesn'?t\s+work|does\s+not\s+work|don'?t\s+work|is\s+wrong|not\s+right|not\s+working)\b/i;

export function parseChangeRequest(text: string): boolean {
  if (parseStop(text)) return false;
  return CHANGE_REQUEST.test(text);
}
```

- [ ] **Step A4: Run to verify it passes**

Run: `npx vitest run tests/linear/context.test.ts -t "parseChangeRequest"`
Expected: PASS.

- [ ] **Step A5: Commit**

```bash
git add src/linear/context.ts tests/linear/context.test.ts
git commit -m "feat(context): parseChangeRequest gate for done-session PR follow-ups"
```

### Sub-part B — routing in the orchestrator

- [ ] **Step B1: Import the parser**

In `src/orchestrator/pipeline.ts`, extend the bottom-of-file re-export block (lines 1009-1013) to also import `parseChangeRequest`:

```ts
// re-export from context to avoid a circular import in tests
import {
  parseApproval as parseApprovalGate,
  parseStop as parseStopGate,
  parseChangeRequest as parseChangeRequestGate,
} from "../linear/context.ts";
```

- [ ] **Step B2: Extract `#runReview` and rewrite `#onDoneFollowUp`**

Replace the current `#onDoneFollowUp` (lines 805-831) with a thin router plus an extracted `#runReview` holding the *exact* current review body (everything from the `console.log("done → review")` through the `#finishReview` call). No behavior change to the review path itself.

```ts
  // A reply on a finished session that has a PR. "stop" closes politely; a clear
  // change request (rejected/commented PR) reworks the PR on its branch; anything
  // else runs the read-only review agent against the PR diff.
  async #onDoneFollowUp(ctx: IssueContext, row: SessionRow, replyText: string, acts: Activities): Promise<void> {
    if (parseStopGate(replyText)) {
      console.log(`[phase] ${ctx.agentSessionId} done follow-up: stop — staying done`);
      await acts.response("Understood — closing this out. The PR is waiting on human review.");
      return;
    }
    if (parseChangeRequestGate(replyText)) {
      return this.#reviseOnBranch(ctx, row, replyText, acts);
    }
    return this.#runReview(ctx, row, replyText, acts);
  }

  // Read-only review of the PR diff (unchanged from the prior inline body).
  async #runReview(ctx: IssueContext, row: SessionRow, replyText: string, acts: Activities): Promise<void> {
    console.log(`[phase] ${ctx.agentSessionId} done → review (follow-up on ${row.prUrl})`);
    this.#store.setPhase(ctx.agentSessionId, "review");
    // Fire-and-forget: thought is one-shot telemetry, and a rejection here
    // (outside the try/catch) would wedge the session in `review`.
    void acts.thought("Looking at the PR diff…").catch(() => {});
    const map = this.#store.getRepoMap(this.#config.targetRepo);
    let result: JarvisEvent | null = null;
    try {
      result = await withSandbox(this.#sbxCfg(ctx.agentSessionId), async (sbx) => {
        this.#store.setSandbox(ctx.agentSessionId, sbx.sandboxId);
        await cloneRepo(sbx, this.#sbxCfg(ctx.agentSessionId), row.branch);
        const history = await this.#timed(ctx.agentSessionId, "history", () =>
          prepareHistory(this.#store, sbx, ctx.issueId, this.#fetchThread),
        );
        return this.#trackedRun(ctx.agentSessionId, "review", sbx, reviewTask(ctx, row.prUrl!, row.plan, replyText, map, history), acts);
      });
    } catch (err) {
      console.error(`[review] ${ctx.agentSessionId} review run failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.#finishReview(ctx.agentSessionId, acts, result);
  }

  // A done-session follow-up asking for code changes (a rejected/commented PR).
  // Resume implement on the SAME work branch — it already carries the PR's
  // commits, and pushing to it updates the open PR in place (no Linear↔GitHub
  // wiring). Plan + PR URL + the human's feedback are folded into the goal, and
  // the agent is REQUIRED to fetch and address the GitHub PR comments first via
  // `gh pr view <url> --comments` — so the human never repeats on Linear what
  // they already said on GitHub.
  async #reviseOnBranch(ctx: IssueContext, row: SessionRow, feedback: string, acts: Activities): Promise<void> {
    if (!row.plan) {
      // Nothing to revise against — fall back to the read-only review path.
      console.log(`[phase] ${ctx.agentSessionId} change request but no saved plan — reviewing instead`);
      return this.#runReview(ctx, row, feedback, acts);
    }
    const workBranch = row.workBranch ?? this.#workBranchFor(ctx.issueId, ctx.agentSessionId);
    console.log(`[phase] ${ctx.agentSessionId} done → implement (PR revision on ${workBranch})`);
    await acts.thought("Got it — reworking the PR on its branch…");
    // Append the revision request AFTER the plan so routeImplement still reads
    // the plan's Type:/Scope: header from the top 400 chars.
    const revisedPlan =
      `${row.plan}\n\n---\nPR REVISION REQUESTED\n` +
      `The PR ${row.prUrl} was reviewed and changes were requested. Work on the existing branch ` +
      `(it already has the PR's commits — build on them, do not restart), push your changes, and the ` +
      `open PR updates automatically — do NOT open a second PR.\n` +
      `FIRST, run \`gh pr view ${row.prUrl} --comments\` and read every review comment and thread on the PR. ` +
      `Address ALL of them — the human should never have to repeat in Linear what they already said on GitHub. ` +
      `If there are no PR comments, work from the requested changes below alone.\n\n` +
      `Requested changes:\n${feedback}`;
    // baseBranch=null: clone the default branch; implementTask's branchBlock then
    // checks out origin/<workBranch> (the PR's commits) and builds on them.
    await this.#runImplement(ctx, acts, revisedPlan, null, workBranch);
  }
```

Note: `#runImplement` already sets phase `implement`, pins the work branch, runs, self-reviews, and calls `#finishImplement` (which posts "Done. PR opened: <url>" and returns the session to `done`). The revision re-uses all of it — the posted URL is the same PR, now updated.

- [ ] **Step B3: Write the routing tests**

Add to `tests/orchestrator/pipeline.test.ts` inside the `on-demand review on done sessions` describe (it can reuse `makeOrchWithFakeSandbox`):

```ts
  it("routes a change request on a done+PR session into implement on the same branch", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_od4", "done", "iss");
    store.setPrUrl("as_od4", "https://github.com/o/r/pull/3");
    store.setPlan("as_od4", "Type: bug\nScope: small\n\n## Plan\n- fix it");
    store.setWorkBranch("as_od4", "jarvis/iss");
    const log: string[] = [];
    const orch = makeOrchWithFakeSandbox(store, log, {
      result: { kind: "result", subtype: "success", text: "https://github.com/o/r/pull/3", costUsd: 0.2, sessionId: "s", usage: {}, numTurns: 4 },
    });
    await orch.onPrompted(ctxFor("as_od4"), "this is wrong, please fix the null check");
    // Implement path ran (PR announced), session back to done, branch preserved.
    expect(log.some((l) => l.startsWith("response:") && /PR opened/i.test(l))).toBe(true);
    expect(store.get("as_od4")?.phase).toBe("done");
    expect(store.get("as_od4")?.workBranch).toBe("jarvis/iss");
    store.close();
  });

  it("a plain question on a done+PR session still runs the review path", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_od5", "done", "iss");
    store.setPrUrl("as_od5", "https://github.com/o/r/pull/4");
    store.setPlan("as_od5", "Type: bug\nScope: small\n\n## Plan\n- fix it");
    const log: string[] = [];
    const report = "## Review\n\nlooks fine\n\n_Report only — no changes were made._";
    const orch = makeOrchWithFakeSandbox(store, log, {
      result: { kind: "result", subtype: "success", text: report, costUsd: null, sessionId: null },
    });
    await orch.onPrompted(ctxFor("as_od5"), "what does this change do?");
    expect(log.some((l) => l.startsWith("response:") && l.includes("Review"))).toBe(true);
    expect(log.some((l) => /PR opened/i.test(l))).toBe(false);
    expect(store.get("as_od5")?.phase).toBe("done");
    store.close();
  });
```

- [ ] **Step B4: Run the routing tests**

Run: `npx vitest run tests/orchestrator/pipeline.test.ts -t "change request"` then `-t "plain question"`
Expected: both PASS. The existing `'stop' on done-with-PR closes politely` and `done WITHOUT pr_url keeps the old re-assign reply` tests must still PASS (stop is checked first; no-PR sessions never reach `#onDoneFollowUp`).

- [ ] **Step B5: Full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step B6: Commit**

```bash
git add src/orchestrator/pipeline.ts tests/orchestrator/pipeline.test.ts
git commit -m "feat(orchestrator): route rejected/commented PR follow-ups back into implement on the same branch"
```

---

## Task 3: Update CLAUDE.md docs

Keep the architecture doc honest — two behaviors changed.

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Document the early branch push**

In the "Where code executes" / durable-state section (the paragraph describing `sessions.workBranch` and `git checkout -B`), add one sentence: the work branch is now pushed to the remote host-side right after clone, before the agent runs, so a run that dies before its first agent-side push still leaves an assignable branch on the remote.

- [ ] **Step 2: Document the PR-revision follow-up**

In the phase-state-machine section, update the `done ⇄ review` note to record that a done-session follow-up parsed as a **change request** (`parseChangeRequest`) routes back into `implement` on the existing work branch (updating the open PR in place), while questions/review requests still take the report-only `review` path. Note this needs no Linear↔GitHub integration — feedback arrives via Linear, the PR updates via a push to its branch.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: early branch push + PR-revision follow-up routing"
```

---

## Self-Review

**Spec coverage:**
- "Branch committed/visible as soon as the agent starts" → Task 1 (`#pushEmptyBranch`, host-side, before the agent). ✓
- "If the agent dies, branch visible to reassign, picks right up" → Task 1 makes the branch exist immediately; existing `findResumableByIssue` + `workBranch` resume (unchanged) picks it up on the next `created` webhook. ✓
- "After a PR, a comment/rejection lets the agent pick up with full context" → Task 2 (`parseChangeRequest` → `#reviseOnBranch` → `#runImplement` on the existing branch, plan + PR URL + feedback + `gh pr view --comments` in the goal). ✓
- "Without connecting Linear to GitHub" → feedback flows through Linear; the PR updates via a push to its branch (native GitHub). No integration added. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code and exact commands. ✓

**Type consistency:** `#pushEmptyBranch(sbx: Sandbox, workBranch: string)` uses the imported `Sandbox` type and `runCommand`'s `{exitCode,stdout,stderr}` shape. `#reviseOnBranch`/`#runReview` take `(ctx, row: SessionRow, ..., acts)` matching `#onDoneFollowUp`'s existing signature; `#runImplement(ctx, acts, plan, baseBranch, workBranch)` call matches its definition (line 691). `parseChangeRequest` returns `boolean`, aliased to `parseChangeRequestGate`. ✓

**Ceilings marked:** `#pushEmptyBranch` is advisory (ponytail comment names the failure modes). `parseChangeRequest` is a narrow keyword heuristic (ponytail comment names the ceiling + upgrade path), and biased narrow so misfires are cheap. ✓
