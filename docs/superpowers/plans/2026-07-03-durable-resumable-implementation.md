# Durable, Resumable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an implement run dies (host restart, credit exhaustion, turn/budget cap), never repeat the plan or lost work — resume from the saved plan and the commits already pushed to a per-issue work branch.

**Architecture:** Jarvis already stores the plan per session and clones a base branch per phase. Three gaps cause the total-loss-on-death behaviour: (1) the implement agent invents its own branch name and only pushes at the very end, so partial work never leaves the sandbox; (2) durable state is keyed by the ephemeral `agentSessionId`, but re-assigning an issue mints a *new* session id, so the saved plan is never found and Jarvis re-plans from scratch; (3) resume logic doesn't exist. This plan adds a **deterministic per-issue work branch** that the agent pushes to incrementally, an **issue-keyed resume lookup**, and a **resume path in `onCreated`** that skips planning and continues implementation from the pushed branch. `reconcile()` keeps state intact so a re-assign resumes cheaply.

**Tech Stack:** TypeScript (nodenext, explicit `.ts` imports), `node:sqlite` (hand-rolled migrations), Claude Agent SDK inside E2B sandboxes, Vitest with a structural `AgentSandbox` fake (no real e2b/network in tests).

## Global Constraints

- Node.js ≥ 24.15.0 (uses `node:sqlite`, `--env-file-if-exists`).
- `.ts` sources import each other with explicit `.ts` extensions.
- Column migrations are hand-rolled: `ALTER TABLE … ADD COLUMN` guarded by a `pragma_table_info` existence check (no `ADD COLUMN IF NOT EXISTS` in SQLite).
- Every orchestrator error path both logs **and** posts a Linear activity (a silent throw leaves the session marked unresponsive by Linear's 10s rule).
- Tests fake the sandbox via the structural `AgentSandbox` interface — no real e2b/network calls in the suite.
- `systemAppend` strings are **fixed, byte-stable text** for prompt-cache hits — per-run content (issue body, plan, work-branch name) goes in `goal`, never in `systemAppend`.
- `src/agent/runner.mjs` is plain JS baked into the E2B template. **This plan does not change `runner.mjs`, so no template rebuild is required.**
- Mark deliberate simplifications with a `// ponytail:` comment naming the ceiling and upgrade path.
- Keep all tools available to every task (do not restrict via `disallowedTools`); reduce cost through resumption and turn caps, not tool removal.

---

### Task 1: Persist a per-issue work branch

**Files:**
- Modify: `src/store/sessions.ts` (SessionRow, schema migration, `get`/`listByPhase` selects, add `setWorkBranch`)
- Test: `tests/store/sessions.test.ts`

**Interfaces:**
- Produces: `SessionRow.workBranch: string | null`; `SessionStore.setWorkBranch(agentSessionId: string, workBranch: string): void`. The `work_branch` column holds the deterministic branch the implement agent commits to — distinct from `branch` (the base branch to clone from).

- [ ] **Step 1: Write the failing test**

```ts
// tests/store/sessions.test.ts — add inside `describe("run telemetry", ...)` sibling block
describe("work branch", () => {
  it("round-trips work_branch and defaults to null", () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_wb", "implement", "iss_1");
    expect(store.get("as_wb")?.workBranch).toBeNull();
    store.setWorkBranch("as_wb", "jarvis/iss_1");
    expect(store.get("as_wb")?.workBranch).toBe("jarvis/iss_1");
    store.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/sessions.test.ts -t "round-trips work_branch"`
Expected: FAIL — `workBranch` is `undefined` (not selected / column absent).

- [ ] **Step 3: Add the column, migration, accessor, and row mapping**

In the schema-migration block (next to the existing `branch` guard), add:

```ts
if (!cols.some((c) => c.name === "work_branch")) {
  this.#db.exec(`ALTER TABLE sessions ADD COLUMN work_branch TEXT`);
}
```

Add to `interface SessionRow` (after `branch`):

```ts
  workBranch: string | null;
```

Add the setter (next to `setBranch`):

```ts
  setWorkBranch(agentSessionId: string, workBranch: string): void {
    this.#db
      .prepare(`UPDATE sessions SET work_branch = ?, updated_at = ? WHERE agent_session_id = ?`)
      .run(workBranch, new Date().toISOString(), agentSessionId);
  }
```

In **both** `get` and `listByPhase`, add `work_branch` to the SELECT column list, add `work_branch: string | null;` to the inline row type, and map it: `workBranch: row.work_branch,`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/store/sessions.test.ts -t "round-trips work_branch"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/sessions.ts tests/store/sessions.test.ts
git commit -m "feat: persist per-issue work_branch on sessions"
```

---

### Task 2: Issue-keyed resume lookup

**Files:**
- Modify: `src/store/sessions.ts` (add `findResumableByIssue`)
- Test: `tests/store/sessions.test.ts`

**Interfaces:**
- Produces: `SessionStore.findResumableByIssue(issueId: string, excludeSessionId: string): SessionRow | null` — the most recently updated session for `issueId`, other than `excludeSessionId`, that has a non-null, non-empty `plan`. Returns the full `SessionRow` (so callers read `plan`, `branch`, `workBranch`, `phase`, `prUrl`). This is the seam that lets a *new* agent session (minted by a re-assign) recover the prior session's plan and pushed work.

- [ ] **Step 1: Write the failing test**

```ts
// tests/store/sessions.test.ts
describe("findResumableByIssue", () => {
  it("returns the latest prior session with a plan for the issue, excluding the current one", () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_old", "error", "iss_42");
    store.setPlan("as_old", "## Plan\n- do it");
    store.setBranch("as_old", "main");
    store.setWorkBranch("as_old", "jarvis/iss_42");
    store.upsert("as_new", "clarify", "iss_42"); // the freshly-created session

    const found = store.findResumableByIssue("iss_42", "as_new");
    expect(found?.agentSessionId).toBe("as_old");
    expect(found?.plan).toContain("do it");
    expect(found?.workBranch).toBe("jarvis/iss_42");

    expect(store.findResumableByIssue("iss_99", "as_new")).toBeNull(); // different issue
    store.close();
  });

  it("ignores prior sessions that never produced a plan", () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_a", "await_branch", "iss_7"); // no plan
    store.upsert("as_b", "clarify", "iss_7");
    expect(store.findResumableByIssue("iss_7", "as_b")).toBeNull();
    store.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/sessions.test.ts -t "findResumableByIssue"`
Expected: FAIL — `findResumableByIssue is not a function`.

- [ ] **Step 3: Implement the lookup**

Add to `SessionStore` (after `listByPhase`):

```ts
  // The resume seam. Re-assigning an issue mints a NEW agentSessionId, so durable
  // state must be recoverable by issue, not by session id. Returns the latest
  // OTHER session for this issue that got far enough to save a plan.
  findResumableByIssue(issueId: string, excludeSessionId: string): SessionRow | null {
    const row = this.#db
      .prepare(
        `SELECT agent_session_id, phase, issue_id, branch, work_branch, plan, sandbox_id, pr_url, review, updated_at
         FROM sessions
         WHERE issue_id = ? AND agent_session_id != ?
           AND plan IS NOT NULL AND TRIM(plan) != ''
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(issueId, excludeSessionId) as
      | {
          agent_session_id: string; phase: Phase; issue_id: string | null;
          branch: string | null; work_branch: string | null; plan: string | null;
          sandbox_id: string | null; pr_url: string | null; review: string | null; updated_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      agentSessionId: row.agent_session_id, phase: row.phase, issueId: row.issue_id,
      branch: row.branch, workBranch: row.work_branch, plan: row.plan,
      sandboxId: row.sandbox_id, prUrl: row.pr_url, review: row.review, updatedAt: row.updated_at,
    };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/store/sessions.test.ts -t "findResumableByIssue"`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/store/sessions.ts tests/store/sessions.test.ts
git commit -m "feat: findResumableByIssue for cross-session plan recovery"
```

---

### Task 3: Implement task commits to a fixed work branch, pushes incrementally, resumes, and dedupes the PR

**Files:**
- Modify: `src/agent/tasks.ts` (`implementTask` signature + goal; `IMPLEMENT_APPEND`)
- Test: `tests/agent/tasks.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `implementTask(ctx: IssueContext, approvedPlan: string, repoMap?: string, workBranch?: string): AgentTask`. When `workBranch` is provided, the goal instructs the agent to use exactly that branch, push after every meaningful step, resume from existing branch state, and avoid opening a duplicate PR. `workBranch` is 4th and optional so existing callers keep working.

- [ ] **Step 1: Write the failing test**

```ts
// tests/agent/tasks.test.ts — new describe
describe("implement work-branch durability", () => {
  it("pins the exact work branch, pushes incrementally, and dedupes the PR", () => {
    const t = implementTask(ctx, "Type: feature\nScope: large\n\n## Plan", undefined, "jarvis/iss_1");
    expect(t.goal).toContain("jarvis/iss_1");
    expect(t.goal).toMatch(/git checkout -B jarvis\/iss_1 origin\/jarvis\/iss_1/);
    expect(t.systemAppend).toMatch(/push .* after (each|every)/i);
    expect(t.systemAppend).toMatch(/already exists/i); // idempotent PR guidance
    expect(t.systemAppend).toMatch(/resume|continue/i); // resume-from-branch guidance
  });

  it("omits branch plumbing when no work branch is given (back-compat)", () => {
    const t = implementTask(ctx, "## Plan");
    expect(t.goal).not.toMatch(/git checkout -B/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/tasks.test.ts -t "implement work-branch durability"`
Expected: FAIL — goal has no branch commands; `implementTask` ignores a 4th arg.

- [ ] **Step 3: Add the `workBranch` param and goal block**

Change the signature and prepend a work-branch block to the goal. Replace the current `implementTask`:

```ts
export function implementTask(ctx: IssueContext, approvedPlan: string, repoMap?: string, workBranch?: string): AgentTask {
  const route = routeImplement(approvedPlan);
  const branchBlock = workBranch
    ? `Work on the branch \`${workBranch}\` and NOTHING else. First run: ` +
      `\`git checkout -B ${workBranch} origin/${workBranch} 2>/dev/null || git checkout -b ${workBranch}\` — ` +
      `this resumes the branch if a previous run already pushed commits to it (build on that work, do not ` +
      `restart from scratch), or creates it fresh otherwise. Commit and \`git push -u origin ${workBranch}\` ` +
      `after each meaningful step so progress survives an interruption. When ready, open the PR from this ` +
      `branch; if one already exists for it, do NOT open a second — return the existing URL.\n\n`
    : "";
  return {
    goal:
      `Implement the following APPROVED plan. ${branchBlock}` +
      `Push with \`git push origin <branch>\` (origin's URL already has your credential — no gh auth needed ` +
      `for the push), then open a PR with \`gh pr create --fill\`. After the PR is created (or found to ` +
      `already exist), run \`gh pr view --json url -q .url\` and make your FINAL message EXACTLY that URL ` +
      `alone — no prose, no markdown. If PR creation fails, your FINAL message must instead start with ` +
      `\`PR_FAILED:\` followed by the reason.\n\n` +
      `${approvedPlan}\n\n---\nOriginal issue:\n${issueBlock(ctx)}${repoMapBlock(repoMap)}`,
    cwd: REPO_DIR,
    model: route.model,
    systemAppend: IMPLEMENT_APPEND,
    allowedTools: ALL_REPO_TOOLS, // defined in Task 6; until then keep the existing implement list
    maxTurns: 200, // tightened in Task 6
    maxBudgetUsd: route.maxBudgetUsd,
    effort: route.effort,
  };
}
```

Append these fixed sentences to `IMPLEMENT_APPEND` (byte-stable — no per-run data), just before `TOOLING_APPEND`:

```ts
  "DURABILITY: you may be resuming a run that died partway. Treat the work branch as the source of truth — " +
  "if it already has commits, read them and continue from there rather than redoing finished work. Commit " +
  "logically-scoped changes and push after each one; a push you skip is work lost if the run is interrupted. " +
  "Before opening a PR, check whether one already exists for this branch (`gh pr view`) and reuse it instead " +
  "of creating a duplicate.\n\n" +
```

> Note: the `ALL_REPO_TOOLS` reference lands in Task 6. If you implement Task 3 before Task 6, keep the current inline `["Read", "Glob", "Grep", "Edit", "Write", "Bash", "Monitor", "WebSearch", "WebFetch", "Skill", "Agent", "mcp__serena", "mcp__jarvis__ask_user"]` and swap it in Task 6.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/agent/tasks.test.ts`
Expected: PASS (new cases + the existing implement tests, which pass `implementTask(ctx, "## Plan")` with no work branch).

- [ ] **Step 5: Commit**

```bash
git add src/agent/tasks.ts tests/agent/tasks.test.ts
git commit -m "feat: implement task pins a work branch, pushes incrementally, dedupes PR"
```

---

### Task 4: Deterministic work branch + `onCreated` resume (the money fix)

**Files:**
- Modify: `src/orchestrator/pipeline.ts` (`onCreated`; extract `#runImplement`; add `#workBranchFor`; call `implementTask` with the work branch; set `work_branch` when entering implement)
- Test: `tests/orchestrator/pipeline.test.ts`

**Interfaces:**
- Consumes: `store.findResumableByIssue`, `store.setWorkBranch` (Tasks 1–2); `implementTask(ctx, plan, repoMap, workBranch)` (Task 3).
- Produces: `#workBranchFor(issueId, agentSessionId): string`; `#runImplement(ctx, acts, plan, baseBranch, workBranch): Promise<void>` — clones `baseBranch`, records the sandbox, runs `implementTask` with `workBranch`, persists the PR URL, self-reviews, and calls `#finishImplement`. `onCreated` resumes an approved-but-incomplete issue straight into `#runImplement`, and reuses a saved-but-unapproved plan for re-approval, instead of re-planning.

- [ ] **Step 1: Write the failing test**

```ts
// tests/orchestrator/pipeline.test.ts
describe("onCreated resume", () => {
  it("resumes implementation from a saved plan without re-planning when a prior attempt was approved", async () => {
    const store = new SessionStore(":memory:");
    // prior attempt died mid-implement (e.g. credit exhaustion)
    store.upsert("as_old", "error", "iss_R");
    store.setPlan("as_old", "Type: feature\nScope: large\n\n## Plan\n- build it");
    store.setBranch("as_old", "main");
    store.setWorkBranch("as_old", "jarvis/iss_R");

    const log: string[] = [];
    // Fake sandbox factory so nothing touches e2b; see existing withSandbox fakes in this file.
    const orch = makeOrchWithFakeSandbox(store, log, {
      // implement run returns a PR URL
      result: { kind: "result", subtype: "success", text: "https://github.com/o/r/pull/5", costUsd: 0.4, sessionId: "s", usage: {}, numTurns: 3 },
    });

    await orch.onCreated({ agentSessionId: "as_new", organizationId: "o", issueId: "iss_R", title: "T", description: "D", comment: "", promptContext: "" });

    // it did NOT run a plan phase; it went straight to implement and finished
    expect(log.join("\n")).not.toMatch(/drafting a plan|Reading the codebase/i);
    expect(store.get("as_new")?.phase).toBe("done");
    expect(store.get("as_new")?.workBranch).toBe("jarvis/iss_R"); // same deterministic branch
    store.close();
  });

  it("re-uses a saved-but-unapproved plan for re-approval instead of re-planning", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_old", "await_approval", "iss_P");
    store.setPlan("as_old", "Type: chore\nScope: small\n\n## Plan\n- tweak");
    store.setBranch("as_old", "main");

    const log: string[] = [];
    const orch = makeOrchWithFakeSandbox(store, log, {});
    await orch.onCreated({ agentSessionId: "as_new2", organizationId: "o", issueId: "iss_P", title: "T", description: "D", comment: "", promptContext: "" });

    expect(store.get("as_new2")?.phase).toBe("await_approval");
    expect(store.get("as_new2")?.plan).toContain("tweak");
    store.close();
  });
});
```

> `makeOrchWithFakeSandbox` is a small helper this task adds to the test file: it constructs an `Orchestrator` whose `#sbxCfg`/`withSandbox` seam is faked. Follow the existing sandbox-faking pattern already used by the reconcile tests in this file (they inject a fake `connect`); mirror it for `withSandbox` by exporting a thin injectable or by stubbing `Sandbox.create`. If the file already has a withSandbox fake, reuse it verbatim.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/orchestrator/pipeline.test.ts -t "onCreated resume"`
Expected: FAIL — `onCreated` always plans; new session ends in `await_branch`/`plan`, not `done`/`await_approval`.

- [ ] **Step 3: Add `#workBranchFor`, extract `#runImplement`, and branch `onCreated`**

Add the branch helper (near `#sbxCfg`), reusing `isValidBranchName` already imported at the bottom of the file:

```ts
  // Deterministic per-issue work branch so a resumed run finds the pushed commits.
  // ponytail: slug of the Linear issue id; falls back to the session id if the
  // issue id is missing or produces an invalid ref. Upgrade to the human-readable
  // issue identifier (ENG-123) if the webhook payload ever carries it.
  #workBranchFor(issueId: string | null, agentSessionId: string): string {
    const seed = (issueId ?? agentSessionId).replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
    const candidate = `jarvis/${seed || agentSessionId}`;
    return isValidBranchName(candidate) ? candidate : `jarvis/${agentSessionId}`;
  }
```

Extract the approved-path body of `onPrompted` (current lines ~406–426) into a reusable method:

```ts
  // Clone the base branch, run implement against the pinned work branch, self-review,
  // finish. Shared by onPrompted (fresh approval) and onCreated (resume).
  async #runImplement(ctx: IssueContext, acts: Activities, plan: string, baseBranch: string | null, workBranch: string): Promise<void> {
    this.#store.setPhase(ctx.agentSessionId, "implement");
    this.#store.setWorkBranch(ctx.agentSessionId, workBranch);
    console.log(`[phase] ${ctx.agentSessionId} → implement (branch ${workBranch})`);

    const map = this.#store.getRepoMap(this.#config.targetRepo);
    let review: string | null = null;
    const result = await withSandbox(this.#sbxCfg(), async (sbx) => {
      this.#store.setSandbox(ctx.agentSessionId, sbx.sandboxId);
      await cloneRepo(sbx, this.#sbxCfg(), baseBranch);
      const r = await this.#trackedRun(ctx.agentSessionId, "implement", sbx, implementTask(ctx, plan, map, workBranch), acts);
      const prText = r?.kind === "result" && r.text ? r.text.trim() : "";
      if (PR_URL_RE.test(prText)) this.#store.setPrUrl(ctx.agentSessionId, prText);
      review = await this.#maybeSelfReview(ctx, sbx, r, plan, map, acts);
      return r;
    });
    await this.#finishImplement(ctx.agentSessionId, acts, result, review);
  }
```

In `onPrompted`, replace the inlined approved block with the call (keeping the `await acts.thought("Approved — implementing in a sandbox now.")` line before it):

```ts
    await acts.thought("Approved — implementing in a sandbox now.");
    await this.#runImplement(ctx, acts, plan, row.branch, this.#workBranchFor(ctx.issueId, ctx.agentSessionId));
    return;
```

At the **top of `onCreated`** (before the existing `parseBranchKeyword` logic), add the resume branch:

```ts
    const prior = ctx.issueId ? this.#store.findResumableByIssue(ctx.issueId, ctx.agentSessionId) : null;
    if (prior?.plan) {
      const workBranch = prior.workBranch ?? this.#workBranchFor(ctx.issueId, ctx.agentSessionId);
      // Already finished with a PR — point at it rather than redo the work.
      if (prior.phase === "done" && prior.prUrl) {
        this.#store.upsert(ctx.agentSessionId, "done", ctx.issueId);
        this.#store.setPrUrl(ctx.agentSessionId, prior.prUrl);
        await acts.response(`This issue already has an open PR from a previous run:\n\n${prior.prUrl}`);
        return;
      }
      // Approved and attempted (implement/error) — resume implementation from the
      // pushed branch, no re-plan, no re-approval.
      if (prior.phase === "implement" || prior.phase === "error") {
        this.#store.upsert(ctx.agentSessionId, "implement", ctx.issueId);
        this.#store.setPlan(ctx.agentSessionId, prior.plan);
        if (prior.branch) this.#store.setBranch(ctx.agentSessionId, prior.branch);
        this.#store.setWorkBranch(ctx.agentSessionId, workBranch);
        await acts.thought("Picking up where the previous run left off — resuming from the saved plan and pushed commits…");
        await this.#runImplement(ctx, acts, prior.plan, prior.branch, workBranch);
        return;
      }
      // Planned but never approved — reuse the plan, skip straight to approval.
      if (prior.phase === "await_approval" || prior.phase === "plan") {
        this.#store.upsert(ctx.agentSessionId, "await_approval", ctx.issueId);
        this.#store.setPlan(ctx.agentSessionId, prior.plan);
        if (prior.branch) this.#store.setBranch(ctx.agentSessionId, prior.branch);
        await acts.elicitation(`${prior.plan}${APPROVAL_FOOTER}`);
        return;
      }
    }
    // no resumable prior — fall through to the existing branch/plan flow below
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/orchestrator/pipeline.test.ts -t "onCreated resume"` then the full file `npx vitest run tests/orchestrator/pipeline.test.ts`
Expected: PASS, and no regression in the existing `onPrompted` approved-path tests (they now exercise `#runImplement`).

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/pipeline.ts tests/orchestrator/pipeline.test.ts
git commit -m "feat: resume implementation from saved plan + work branch on re-assign"
```

---

### Task 5: Reconcile preserves resume state and tells the user how to resume cheaply

**Files:**
- Modify: `src/orchestrator/pipeline.ts` (`reconcile` failure messaging for `implement`)
- Test: `tests/orchestrator/pipeline.test.ts`

**Interfaces:**
- Consumes: existing `#failLoud`, `findResumableByIssue` semantics from Task 4 (resume happens on the next `created` webhook).
- Produces: no new signatures. When `reconcile` cannot recover an in-flight `implement` run (sandbox gone / connect throws / no result), it must leave `plan`, `branch`, and `work_branch` intact (it already does) and post an error whose text tells the human that re-assigning resumes from the pushed branch without re-planning. This makes the host-restart case converge on the Task 4 resume path — no issue-context persistence needed.

- [ ] **Step 1: Write the failing test**

```ts
// tests/orchestrator/pipeline.test.ts — extend the existing reconcile describe
it("on an unrecoverable implement, keeps the plan/work branch and points the user at a cheap resume", async () => {
  const store = new SessionStore(":memory:");
  store.upsert("as_i", "implement", "iss_Z");
  store.setPlan("as_i", "## Plan\n- x");
  store.setWorkBranch("as_i", "jarvis/iss_Z");
  store.setSandbox("as_i", "sbx_dead");

  const log: string[] = [];
  const connect = () => Promise.reject(new Error("Failed to parse URL from [object Request]"));
  const orch = new Orchestrator({} as Config, store, () => fakeActs(log), undefined, connect);

  await orch.reconcile();

  expect(store.get("as_i")?.phase).toBe("error");
  expect(store.get("as_i")?.plan).toContain("- x");         // plan preserved
  expect(store.get("as_i")?.workBranch).toBe("jarvis/iss_Z"); // branch preserved
  expect(log.join("\n")).toMatch(/re-?assign/i);
  expect(log.join("\n")).toMatch(/resume|pushed|saved/i);   // tells user it's cheap
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/orchestrator/pipeline.test.ts -t "cheap resume"`
Expected: FAIL — the current failLoud message says "re-assign the issue to retry" (start over), not "resume from saved progress".

- [ ] **Step 3: Tailor the implement failure message**

In `reconcile`, the `implement` failure paths currently call the generic `fail(...)`. Give implement its own message. Define, inside the `rows.map` callback (after `const fail = ...`):

```ts
        const failImplement = (why: string) =>
          this.#failLoud(
            id,
            acts,
            `${why} Your plan and pushed commits are saved — re-assign this issue and I'll resume from ` +
              `the work branch instead of starting over.`,
          );
```

Then, for `row.phase === "implement"`, route the "connect failed", "no result recovered", and catch-all failures through `failImplement(...)` instead of `fail(...)`. Leave `plan`/`revise`/`review` on the existing `fail(...)`. `#failLoud` already sets `phase = "error"` without clearing `plan`/`branch`/`work_branch`, so state is preserved automatically.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/orchestrator/pipeline.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/pipeline.ts tests/orchestrator/pipeline.test.ts
git commit -m "feat: reconcile guides a cheap resume for unrecoverable implement runs"
```

---

### Task 6: Reduce turns and unify the tool set (keep all tools everywhere)

**Files:**
- Modify: `src/agent/tasks.ts` (shared `ALL_REPO_TOOLS`; lower `maxTurns`)
- Test: `tests/agent/tasks.test.ts`

**Interfaces:**
- Produces: `ALL_REPO_TOOLS: string[]` — one permissive tool list shared by plan/revise/implement/review (map stays read-only Read/Glob/Grep). Turn caps drop so a stuck or dying run fails fast; resumption (Tasks 3–5) makes a truncated implement safe because progress is pushed.

- [ ] **Step 1: Write the failing test**

```ts
// tests/agent/tasks.test.ts
describe("turn caps and unified tools", () => {
  it("caps turns lower now that runs are resumable", () => {
    expect(planTask(ctx).maxTurns).toBe(25);
    expect(reviewTask(ctx, "url", null, null).maxTurns).toBe(40);
    expect(mapTask().maxTurns).toBe(20);
    expect(implementTask(ctx, "## Plan").maxTurns).toBe(120);
  });

  it("plan, revise, implement and review share one permissive tool set", () => {
    const p = planTask(ctx).allowedTools;
    for (const t of [reviseTask(ctx, "p", "f"), implementTask(ctx, "p"), reviewTask(ctx, "u", null, null)]) {
      expect(t.allowedTools).toEqual(p);
    }
    expect(p).toEqual(expect.arrayContaining(["Read", "Glob", "Grep", "Bash", "Edit", "Write", "Agent", "Skill", "mcp__serena", "mcp__jarvis__ask_user"]));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/tasks.test.ts -t "turn caps and unified tools"`
Expected: FAIL — current caps are 40/60/30/200 and tool lists differ per task.

- [ ] **Step 3: Add the shared list and lower the caps**

Near the top of `tasks.ts` (after the appends):

```ts
// One permissive tool set for every repo task. Tool availability isn't the cost
// lever (allowedTools is not enforced under bypassPermissions anyway) — resumption
// and turn caps are. Keeping one list avoids per-task drift. mapTask stays
// read-only on purpose (it must never edit).
const ALL_REPO_TOOLS = [
  "Read", "Glob", "Grep", "Bash", "Edit", "Write", "Monitor",
  "WebSearch", "WebFetch", "Skill", "Agent", "mcp__serena", "mcp__jarvis__ask_user",
];
```

Set `allowedTools: ALL_REPO_TOOLS` on `planTask`, `reviseTask`, `implementTask`, and `reviewTask` (replace their individual arrays). Leave `mapTask` as `["Read", "Glob", "Grep"]`.

Lower `maxTurns`: `planTask` `40 → 25`, `reviseTask` `40 → 25`, `reviewTask` `60 → 40`, `mapTask` `30 → 20`, `implementTask` `200 → 120`.

> The existing tool-allowlist tests (`"plan and revise get Bash + web + serena"`, `"implement gets web + serena"`, review "no Edit/Write") assume divergent lists. Update them: review is now permissive (drop the "no Edit/Write" assertion or move it to a `mapTask` check — map is the read-only one). Update the `reviewTask` "read-only" test to assert on `mapTask()` instead.

- [ ] **Step 4: Run the full task + pipeline suites**

Run: `npm test`
Expected: PASS (after updating the divergent-tool-list assertions noted above).

- [ ] **Step 5: Commit**

```bash
git add src/agent/tasks.ts tests/agent/tasks.test.ts
git commit -m "feat: unify repo tool set and lower turn caps (safe now that runs resume)"
```

---

### Task 7: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (phase state machine + task table + a "durable implementation" note)
- Test: none (docs) — verified by `npm run typecheck && npm test` staying green.

- [ ] **Step 1: Document the resume behaviour**

In the phase state-machine section, add that `onCreated` for an issue with a resumable prior session skips planning: `error/implement (prior) → implement (resume from work branch)`, and `await_approval (prior) → await_approval (reuse plan)`. In the "Agent tasks" table, note `implementTask` now takes a `workBranch` and pushes incrementally. Add one paragraph under Architecture: durable state is keyed by issue (`findResumableByIssue`) with a deterministic `jarvis/<issue>` work branch, so a died run resumes from the saved plan + pushed commits instead of re-planning.

- [ ] **Step 2: Verify the suite is green**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document durable/resumable implementation"
```

---

## Self-Review

**Spec coverage:**
- Ask 1 — "allow all tools everywhere, reduce turns, don't disturb the implement flow": Task 6 (unified `ALL_REPO_TOOLS`, lower `maxTurns`); the implement flow itself is unchanged except for durability. No `disallowedTools`. ✅
- Ask 2 — "if a plan already exists and the agent dies mid-execution, pick up the previous plan": Task 2 (`findResumableByIssue`) + Task 4 (`onCreated` reuses the saved plan; approved → resume implement, unapproved → re-approval) + Task 5 (reconcile preserves the plan and steers to the cheap resume). ✅
- Ask 3 — "a separate git branch, commits pushed, so a dead agent picks up from the work + plan": Task 1 (persist `work_branch`) + Task 3 (deterministic branch, `checkout -B … origin/…` resume, push after each step, idempotent PR) + Task 4 (`#workBranchFor`, clone base then continue on the pushed work branch). ✅

**Placeholder scan:** No TBD/TODO; every code step shows real code; test steps show real assertions. The one forward reference (`ALL_REPO_TOOLS` used in Task 3, defined in Task 6) is called out explicitly with the fallback list. ✅

**Type consistency:** `SessionRow.workBranch` (Task 1) is read in Tasks 2/4/5; `findResumableByIssue(issueId, excludeSessionId)` signature matches its callers; `implementTask(ctx, plan, repoMap, workBranch)` argument order matches the `#runImplement` call in Task 4; `#workBranchFor(issueId, agentSessionId)` matches both call sites. ✅

**Known ceiling (ponytail):** Resume assumes the previous run pushed at least once; a run that dies in its first few seconds (before any push) resumes with the plan but an empty branch — correct, just no work saved. Incremental push frequency is prompt-driven, not enforced — the upgrade path is a git hook or a host-side periodic `git -C … push` if agents under-push in practice.
