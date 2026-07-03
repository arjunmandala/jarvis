# Branch Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Linear issue's description (or a reply) tell Jarvis which git branch to work from, asking the user when it's missing, and thread that branch through every sandbox clone for the session — including serena indexing, which already runs right after clone.

**Architecture:** A new `await_branch` phase sits before `plan`. `onCreated` tries to parse a `branch: <name>` keyword out of the issue title+description; if found, it proceeds straight to planning; if not, it posts an elicitation and waits. `onPrompted` resolves that wait by parsing the reply the same way `parseApproval`/`parseStop` already parse replies. Once known, the branch is stored on the session row and passed to `cloneRepo` at every clone site.

**Tech Stack:** TypeScript, `node:sqlite`, Vitest. No new dependencies.

## Global Constraints

- `.ts` files import siblings with explicit `.ts` extensions (see CLAUDE.md) — every new import must follow this.
- No new npm dependencies — everything here is a regex validator, a DB column, and control flow.
- SQLite has no `ADD COLUMN IF NOT EXISTS`; new columns use the existing hand-rolled `pragma_table_info` migration pattern in `SessionStore`'s constructor.
- `withSandbox`/e2b-touching code paths are not unit tested per this repo's convention (see `tests/orchestrator/pipeline.test.ts:120-122`) — cover only the pure logic (parsing, validation, phase transitions, `cloneRepo`'s command-string construction against a fake sandbox) with tests; the full clone-with-branch flow is exercised by live acceptance, not the suite.
- Branch names are a trust boundary: they're interpolated into a shell string (`git clone -b <name> ...`). Validate with an allowlist regex *before* the value is ever stored or passed to `cloneRepo` — never after.

---

### Task 1: `branch` column on `sessions`

**Files:**
- Modify: `src/store/sessions.ts:3` (Phase type), `src/store/sessions.ts:5-14` (SessionRow), `src/store/sessions.ts:29-52` (constructor/migration), `src/store/sessions.ts:145-149` area (add `setBranch`), `src/store/sessions.ts:175-231` (`get`/`listByPhase` row mapping)
- Test: `tests/store/sessions.test.ts`

**Interfaces:**
- Produces: `Phase` includes `"await_branch"`. `SessionRow.branch: string | null`. `SessionStore.setBranch(agentSessionId: string, branch: string): void`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/store/sessions.test.ts` (new `describe` block, after the `pr_url and review columns` block):

```typescript
describe("branch column", () => {
  it("defaults to null on new rows", () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_b1", "await_branch", "iss");
    expect(store.get("as_b1")?.branch).toBeNull();
    store.close();
  });

  it("round-trips through setBranch", () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_b2", "plan", "iss");
    store.setBranch("as_b2", "feature/foo");
    expect(store.get("as_b2")?.branch).toBe("feature/foo");
    store.close();
  });

  it("setBranch on unknown id is a no-op", () => {
    const store = new SessionStore(":memory:");
    store.setBranch("missing", "main");
    expect(store.get("missing")).toBeUndefined();
    store.close();
  });

  it("lists sessions in the await_branch phase", () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_b3", "await_branch", "iss");
    const rows = store.listByPhase("await_branch");
    expect(rows.map((r) => r.agentSessionId)).toEqual(["as_b3"]);
    store.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/store/sessions.test.ts -t "branch column"`
Expected: FAIL — `store.setBranch is not a function` / `branch` is `undefined` not `null` (property doesn't exist yet, `toBeNull()` fails on `undefined`).

- [ ] **Step 3: Implement**

In `src/store/sessions.ts`, change line 3:

```typescript
export type Phase = "clarify" | "await_branch" | "plan" | "await_approval" | "implement" | "review" | "done" | "error";
```

Add `branch: string | null;` to the `SessionRow` interface (after `issueId: string | null;`):

```typescript
export interface SessionRow {
  agentSessionId: string;
  phase: Phase;
  issueId: string | null;
  branch: string | null;
  plan: string | null;
  sandboxId: string | null;
  prUrl: string | null;
  review: string | null;
  updatedAt: string;
}
```

In the constructor, after the existing `review` column migration (`src/store/sessions.ts:50-52`), add:

```typescript
    if (!cols.some((c) => c.name === "branch")) {
      this.#db.exec(`ALTER TABLE sessions ADD COLUMN branch TEXT`);
    }
```

After `setReview` (around line 173), add:

```typescript
  setBranch(agentSessionId: string, branch: string): void {
    this.#db
      .prepare(`UPDATE sessions SET branch = ?, updated_at = ? WHERE agent_session_id = ?`)
      .run(branch, new Date().toISOString(), agentSessionId);
  }
```

In `get()` (`src/store/sessions.ts:175-203`), add `branch` to the `SELECT` column list, to the inline row type, and to the returned object:

```typescript
  get(agentSessionId: string): SessionRow | undefined {
    const row = this.#db
      .prepare(
        `SELECT agent_session_id, phase, issue_id, branch, plan, sandbox_id, pr_url, review, updated_at FROM sessions WHERE agent_session_id = ?`,
      )
      .get(agentSessionId) as
      | {
          agent_session_id: string;
          phase: Phase;
          issue_id: string | null;
          branch: string | null;
          plan: string | null;
          sandbox_id: string | null;
          pr_url: string | null;
          review: string | null;
          updated_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      agentSessionId: row.agent_session_id,
      phase: row.phase,
      issueId: row.issue_id,
      branch: row.branch,
      plan: row.plan,
      sandboxId: row.sandbox_id,
      prUrl: row.pr_url,
      review: row.review,
      updatedAt: row.updated_at,
    };
  }
```

Do the identical column addition in `listByPhase()` (`src/store/sessions.ts:205-231`): add `branch` to the `SELECT`, the inline row type, and the mapped object.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/store/sessions.test.ts`
Expected: PASS (all tests, including the pre-existing ones — confirms the column addition didn't break `get`/`listByPhase`/`upsert`).

- [ ] **Step 5: Commit**

```bash
git add src/store/sessions.ts tests/store/sessions.test.ts
git commit -m "feat: add branch column to sessions store"
```

---

### Task 2: Branch keyword parsing + validation (`src/linear/context.ts`)

**Files:**
- Modify: `src/linear/context.ts` (add after `parseStop`, end of file)
- Test: `tests/linear/context.test.ts`

**Interfaces:**
- Consumes: nothing new (pure string functions).
- Produces: `parseBranchKeyword(text: string): string | null`, `parseBranchAnswer(text: string): string | null`, `isValidBranchName(name: string): boolean`, `ASK_BRANCH: string`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/linear/context.test.ts`:

```typescript
import { parseBranchKeyword, parseBranchAnswer, isValidBranchName } from "../../src/linear/context.ts";

describe("parseBranchKeyword", () => {
  it.each([
    ["please use branch: feature/foo for this", "feature/foo"],
    ["Branch:hotfix-123", "hotfix-123"],
    ["work off branch: release/1.2.0, thanks", "release/1.2.0"],
  ])("extracts the branch from %s", (text, expected) => expect(parseBranchKeyword(text)).toBe(expected));

  it("returns null when no keyword is present", () => {
    expect(parseBranchKeyword("just fix the bug please")).toBeNull();
  });
});

describe("parseBranchAnswer", () => {
  it("prefers the branch: keyword form", () => {
    expect(parseBranchAnswer("branch: feature/foo")).toBe("feature/foo");
  });

  it("falls back to the first token of a bare reply", () => {
    expect(parseBranchAnswer("feature/foo")).toBe("feature/foo");
    expect(parseBranchAnswer("feature/foo please")).toBe("feature/foo");
  });

  it("strips trailing punctuation from a bare reply", () => {
    expect(parseBranchAnswer("main.")).toBe("main");
  });

  it("returns null for an empty reply", () => {
    expect(parseBranchAnswer("   ")).toBeNull();
  });
});

describe("isValidBranchName", () => {
  it.each(["main", "feature/foo", "release-1.2.0", "hotfix_123"])(
    "accepts %s",
    (n) => expect(isValidBranchName(n)).toBe(true),
  );
  it.each(["", "-flag", "has space", "a..b", "a/", "a;rm -rf /", "$(whoami)"])(
    "rejects %s",
    (n) => expect(isValidBranchName(n)).toBe(false),
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/linear/context.test.ts -t "parseBranch"`
Expected: FAIL — the imports don't resolve (functions don't exist yet).

- [ ] **Step 3: Implement**

Append to `src/linear/context.ts`:

```typescript
export const ASK_BRANCH =
  "Which branch should I work from? Reply with the branch name " +
  '(e.g. `branch: feature/foo`), or just the name by itself.';

// ponytail: keyword heuristic, same style as parseApproval/parseStop above.
const BRANCH_KEYWORD = /\bbranch\s*:\s*(\S+)/i;
const TRAILING_PUNCT = /[.,;:]+$/;

export function parseBranchKeyword(text: string): string | null {
  const m = BRANCH_KEYWORD.exec(text);
  return m ? m[1].replace(TRAILING_PUNCT, "") || null : null;
}

// Used only when a reply is answering "which branch?" directly — accepts
// either the branch: keyword or a bare branch name as the first token.
export function parseBranchAnswer(text: string): string | null {
  const keyword = parseBranchKeyword(text);
  if (keyword) return keyword;
  const first = text.trim().split(/\s+/)[0] ?? "";
  return first.replace(TRAILING_PUNCT, "") || null;
}

// Trust boundary: this string is interpolated into `git clone -b <name> ...`
// (see cloneRepo in src/sandbox/session.ts). Validate BEFORE storing or
// passing it anywhere near a shell command — never after.
const BRANCH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function isValidBranchName(name: string): boolean {
  return (
    BRANCH_NAME_RE.test(name) &&
    !name.includes("..") &&
    !name.endsWith("/") &&
    !name.endsWith(".lock")
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/linear/context.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add src/linear/context.ts tests/linear/context.test.ts
git commit -m "feat: add branch keyword parsing and validation"
```

---

### Task 3: `cloneRepo` accepts a branch

**Files:**
- Modify: `src/sandbox/session.ts:57-67`
- Test: `tests/sandbox/session.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `cloneRepo(sbx: Sandbox, cfg: SandboxConfig, branch?: string | null): Promise<void>` — call sites in Task 4 pass `row.branch`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/sandbox/session.test.ts` (new `describe` block; reuses the `makeFake` helper already defined at the top of the file):

```typescript
import { cloneRepo, type SandboxConfig } from "../../src/sandbox/session.ts";

describe("cloneRepo", () => {
  const cfg: SandboxConfig = { apiKey: "k", template: "t", ghToken: "tok", targetRepo: "owner/repo" };

  it("clones the default branch when none is given", async () => {
    const f = makeFake({});
    f.sbx.commands.run = async (cmd: string) => {
      f.commandLog.push(cmd);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await cloneRepo(f.sbx, cfg);
    expect(f.commandLog[0]).toBe(`git clone https://x-access-token:tok@github.com/owner/repo.git /home/user/repo`);
  });

  it("passes -b <branch> when a branch is given", async () => {
    const f = makeFake({});
    f.sbx.commands.run = async (cmd: string) => {
      f.commandLog.push(cmd);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await cloneRepo(f.sbx, cfg, "feature/foo");
    expect(f.commandLog[0]).toBe(
      `git clone -b feature/foo https://x-access-token:tok@github.com/owner/repo.git /home/user/repo`,
    );
  });
});
```

Note: `makeFake`'s default `commands.run` resolves via a controllable promise meant for the long-lived runner process, not a one-shot clone command — the override above replaces it with a plain resolver, matching how `indexRepo`'s tests in the same file construct their own minimal fake instead of reusing `makeFake` where the shape doesn't fit.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sandbox/session.test.ts -t "cloneRepo"`
Expected: FAIL — `cloneRepo` isn't exported with that signature yet / TypeScript error on the third argument, or the command string lacks the `-b` flag.

- [ ] **Step 3: Implement**

Replace `src/sandbox/session.ts:57-67`:

```typescript
export async function cloneRepo(sbx: Sandbox, cfg: SandboxConfig, branch?: string | null): Promise<void> {
  // Token-in-URL clone of a private repo; GH_TOKEN is also set in env for gh.
  const url = `https://x-access-token:${cfg.ghToken}@github.com/${cfg.targetRepo}.git`;
  // branch is validated (isValidBranchName) before it ever reaches this
  // call — see src/linear/context.ts and its callers in orchestrator/pipeline.ts.
  const branchFlag = branch ? `-b ${branch} ` : "";
  await withRetries("git clone", async () => {
    const res = await runCommand(sbx, `git clone ${branchFlag}${url} ${REPO_DIR}`);
    if (res.exitCode !== 0) {
      throw new Error(redactSecret(`git clone failed (${res.exitCode}): ${res.stderr}`, cfg.ghToken));
    }
  });
  await indexRepo(sbx, cfg.ghToken);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sandbox/session.test.ts`
Expected: PASS (all tests in the file, including the pre-existing `runAgent`/`watchDetached`/`indexRepo` ones — confirms the signature change didn't break other call sites).

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/session.ts tests/sandbox/session.test.ts
git commit -m "feat: cloneRepo accepts an optional branch to check out"
```

---

### Task 4: `await_branch` phase in the orchestrator

**Files:**
- Modify: `src/orchestrator/pipeline.ts` (imports at top; `nextPhase` at line 39-47; `onCreated` at line 226-255, replaced by an extracted `#runPlan` + a slimmer `onCreated`; `onPrompted` at line 278-365, add the `await_branch` branch; the three other `cloneRepo` call sites at lines 336, 352, 453 pass `row.branch`)
- Test: `tests/orchestrator/pipeline.test.ts`

**Interfaces:**
- Consumes: `parseBranchKeyword`, `parseBranchAnswer`, `isValidBranchName`, `ASK_BRANCH` from `../linear/context.ts` (Task 2); `store.setBranch` (Task 1); `cloneRepo(sbx, cfg, branch)` (Task 3).
- Produces: `Orchestrator#runPlan(ctx: IssueContext, acts: Activities, branch: string | null): Promise<void>` (private) — the shared clone→map→plan→`#finishPlan` pipeline.

- [ ] **Step 1: Write the failing tests**

Add to `tests/orchestrator/pipeline.test.ts` (new `describe` block; reuses `fakeActs`/`ctxFor` already defined in the file):

```typescript
describe("onCreated: branch resolution", () => {
  it("asks for a branch and does not touch phase=plan when the description has none", async () => {
    const store = new SessionStore(":memory:");
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log));
    await orch.onCreated(ctxFor("as_br1"));
    expect(store.get("as_br1")?.phase).toBe("await_branch");
    expect(store.get("as_br1")?.branch).toBeNull();
    expect(log.length).toBe(1);
    expect(log[0]).toMatch(/^elicitation:/);
  });
});

describe("onPrompted: await_branch", () => {
  it("stop while awaiting a branch closes the session", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_br2", "await_branch", "iss");
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log));
    await orch.onPrompted(ctxFor("as_br2"), "stop");
    expect(store.get("as_br2")?.phase).toBe("done");
  });

  it("an invalid branch name stays in await_branch and reports the problem", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_br3", "await_branch", "iss");
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log));
    await orch.onPrompted(ctxFor("as_br3"), "has space");
    expect(store.get("as_br3")?.phase).toBe("await_branch");
    expect(store.get("as_br3")?.branch).toBeNull();
    expect(log.some((l) => l.startsWith("error:"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/orchestrator/pipeline.test.ts -t "branch"`
Expected: FAIL — `onCreated` still always clones+plans (no `await_branch` phase exists yet), so the first test's phase assertion fails; the second two fail because `onPrompted` has no `await_branch` handling (falls into the "phase not await_approval" terminal-error branch with the wrong message, or a phase transition that doesn't match).

- [ ] **Step 3: Implement**

In `src/orchestrator/pipeline.ts`, update the import from context.ts near the bottom (`src/orchestrator/pipeline.ts:586`):

```typescript
import {
  parseApproval as parseApprovalGate,
  parseStop as parseStopGate,
  parseBranchKeyword,
  parseBranchAnswer,
  isValidBranchName,
  ASK_BRANCH,
} from "../linear/context.ts";
```

Update `nextPhase` (`src/orchestrator/pipeline.ts:39-47`) to route through the new phase (kept for the exported unit tested transitions, even though the orchestrator methods below don't call it directly for this path):

```typescript
export function nextPhase(current: Phase, approved: boolean): Phase {
  switch (current) {
    case "clarify": return "plan";
    case "await_branch": return "plan";
    case "plan": return "await_approval";
    case "await_approval": return approved ? "implement" : "await_approval";
    case "implement": return "done";
    default: return current;
  }
}
```

Replace `onCreated` (`src/orchestrator/pipeline.ts:226-255`) with a branch check plus an extracted `#runPlan`:

```typescript
  // created: resolve the branch (description keyword, or ask) -> clarify (implicit)
  // -> produce plan -> post as elicitation -> await approval
  async onCreated(ctx: IssueContext): Promise<void> {
    const acts = this.#makeActs(ctx.agentSessionId);
    const branch = parseBranchKeyword(`${ctx.title}\n${ctx.description}`);
    if (branch && isValidBranchName(branch)) {
      this.#store.upsert(ctx.agentSessionId, "plan", ctx.issueId);
      this.#store.setBranch(ctx.agentSessionId, branch);
      await this.#runPlan(ctx, acts, branch);
      return;
    }
    console.log(`[phase] ${ctx.agentSessionId} → await_branch (no branch in the issue)`);
    this.#store.upsert(ctx.agentSessionId, "await_branch", ctx.issueId);
    await acts.elicitation(ASK_BRANCH);
  }

  // Shared by onCreated (branch known up front) and onPrompted's await_branch
  // resolution (branch known after a reply): clone -> one-time repo map -> plan.
  //
  // A clone failure here (bad/nonexistent branch) is special-cased: it bounces
  // the session back to await_branch instead of the terminal error phase, so a
  // typo doesn't force a full re-assign. Only this first clone gets that
  // treatment — revise/implement clones re-use an already-validated branch, so
  // their failures keep the existing #failLoud behavior.
  async #runPlan(ctx: IssueContext, acts: Activities, branch: string | null): Promise<void> {
    console.log(`[phase] ${ctx.agentSessionId} → plan (cloning + drafting)`);
    await acts.thought("Reading the codebase to draft a plan…");

    let cloneFailed = false;
    const result = await withSandbox(this.#sbxCfg(), async (sbx) => {
      this.#store.setSandbox(ctx.agentSessionId, sbx.sandboxId);
      try {
        await cloneRepo(sbx, this.#sbxCfg(), branch);
      } catch (err) {
        cloneFailed = true;
        console.error(`[phase] ${ctx.agentSessionId} clone failed for branch ${branch ?? "(default)"}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }

      let map = this.#store.getRepoMap(this.#config.targetRepo);
      if (!map) {
        await acts.thought("First time in this repo — mapping it for faster future runs…");
        try {
          const mapResult = await this.#trackedRun(ctx.agentSessionId, "map", sbx, mapTask(), acts);
          if (mapResult?.kind === "result" && mapResult.text && mapResult.text.trim()) {
            map = mapResult.text;
            this.#store.setRepoMap(this.#config.targetRepo, map);
          }
        } catch (err) {
          // Mapping is an optimization only — any failure must never fail the session.
          console.error(`[map] ${ctx.agentSessionId} repo map generation failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return this.#trackedRun(ctx.agentSessionId, "plan", sbx, planTask(ctx, map), acts);
    });

    if (cloneFailed) {
      this.#store.setSandbox(ctx.agentSessionId, null);
      this.#store.setPhase(ctx.agentSessionId, "await_branch");
      await acts.error(`I couldn't check out branch \`${branch}\` — it may not exist. ${ASK_BRANCH}`);
      return;
    }

    await this.#finishPlan(ctx.agentSessionId, acts, result);
  }
```

Note: this `cloneFailed` path has no dedicated unit test — it depends on `withSandbox`/`cloneRepo` actually throwing, which per the Global Constraints is an e2b-touching path this repo covers via live acceptance, not the suite (consistent with how the pre-existing `onCreated`/implement clone sites are already untested).

In `onPrompted` (`src/orchestrator/pipeline.ts:278-298`), add the `await_branch` handling right after `const row = this.#store.get(ctx.agentSessionId);` and before the existing `if (!row || row.phase !== "await_approval")` guard:

```typescript
  async onPrompted(ctx: IssueContext, replyText: string): Promise<void> {
    const acts = this.#makeActs(ctx.agentSessionId);
    const row = this.#store.get(ctx.agentSessionId);

    if (row?.phase === "await_branch") {
      if (parseStopGate(replyText)) {
        console.log(`[phase] ${ctx.agentSessionId} stop requested while awaiting branch — closing session`);
        try {
          await acts.response("Stopped. Re-assign the issue when you want me to plan again.");
        } catch (err) {
          console.error(`[phase] ${ctx.agentSessionId} failed to post stop activity: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          this.#store.setPhase(ctx.agentSessionId, "done");
        }
        return;
      }
      const branch = parseBranchAnswer(replyText);
      if (!branch || !isValidBranchName(branch)) {
        console.log(`[phase] ${ctx.agentSessionId} invalid branch reply — asking again`);
        await acts.error(`"${replyText.trim().slice(0, 80)}" doesn't look like a valid branch name. ${ASK_BRANCH}`);
        return;
      }
      this.#store.setBranch(ctx.agentSessionId, branch);
      this.#store.setPhase(ctx.agentSessionId, "plan");
      await this.#runPlan(ctx, acts, branch);
      return;
    }

    if (!row || row.phase !== "await_approval") {
```

(The rest of the existing `if (!row || row.phase !== "await_approval") { ... }` block body is unchanged — only the condition's opening line moves down, now that `row` is destructured above it instead of below.)

Thread `row.branch` through the three remaining `cloneRepo` calls that already have `row` in scope:
- `src/orchestrator/pipeline.ts:336` (revise path, inside `onPrompted`): `await cloneRepo(sbx, this.#sbxCfg(), row.branch);`
- `src/orchestrator/pipeline.ts:352` (implement path, inside `onPrompted`): `await cloneRepo(sbx, this.#sbxCfg(), row.branch);`
- `src/orchestrator/pipeline.ts:453` (`#onDoneFollowUp`, which already receives `row: SessionRow`): `await cloneRepo(sbx, this.#sbxCfg(), row.branch);`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/orchestrator/pipeline.test.ts`
Expected: PASS (all tests in the file, including the pre-existing `onCreated`/`onPrompted`/`nextPhase` ones — confirms the extraction and new branch didn't change behavior for issues that already carry no plan-blocking branch requirement... note: the pre-existing tests never called real `onCreated` against a live sandbox, since that path is excluded from unit testing per the Global Constraints; only the phase-transition assertions above changed).

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/pipeline.ts tests/orchestrator/pipeline.test.ts
git commit -m "feat: add await_branch phase, thread branch through cloneRepo call sites"
```

---

### Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Full suite**

Run: `npm test`
Expected: all tests pass, no regressions outside the files touched above.

- [ ] **Step 3: Update CLAUDE.md's phase diagram**

Modify: `CLAUDE.md` — the phase state machine diagram (`clarify → plan → await_approval ⇄ plan ...`) currently omits `await_branch`. Update it to:

```
clarify → await_branch (if no branch in the issue) → plan → await_approval ⇄ plan (revision loop, feedback ≠ approve)
                                                                  │
                                                                  └─ approve → implement → done
                                                                                    │
                                                                                    └─ failure → error

done ⇄ review (reply on a finished session with a PR — report-only, always returns to done)
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document await_branch phase in CLAUDE.md"
```
