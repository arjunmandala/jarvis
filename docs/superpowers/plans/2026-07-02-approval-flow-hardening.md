# Approval-Flow Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a user replies to Jarvis's plan in Linear, every possible branch logs to the console and posts a Linear activity (never a silent hang), and the approved plan survives server restarts by living in SQLite instead of process memory.

**Architecture:** Three small changes to the existing vertical slice: (1) a nullable `plan` TEXT column on the `sessions` table with `setPlan()`, (2) `Orchestrator.onPrompted()` rewritten so all early-return paths log + post an activity and the plan is read from the store (failing loud if missing), (3) a startup log of the running git SHA. No new files, no new dependencies.

**Tech Stack:** Node ≥24 (`node:sqlite` DatabaseSync), TypeScript ESM (`.ts` imports), Hono, @linear/sdk, vitest.

## Global Constraints

- Run tests with `npx vitest run <file>` from repo root `D:\jarvis`; full suite with `npm test`; types with `npm run typecheck`.
- Follow existing style: 2-space indent, `#private` class fields, `// ponytail:` comments mark deliberate ceilings.
- Linear's 10-second rule: any handled `prompted` webhook must result in at least one agent activity being posted — no branch may return without one (except parse-level ignores in server.ts, which are out of scope here).
- Do not modify `parseApproval` or `promptedBody` in `src/linear/context.ts` — they are correct as of commit `82637a9`.

---

### Task 1: Persist plan text in SessionStore

**Files:**
- Modify: `src/store/sessions.ts`
- Test: `tests/store/sessions.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `SessionRow.plan: string | null`; `SessionStore.setPlan(agentSessionId: string, plan: string): void`. `get()` now returns the `plan` field. Task 2 relies on exactly these names.

- [ ] **Step 1: Write the failing tests**

Append to `tests/store/sessions.test.ts` inside the existing `describe("SessionStore", ...)` block:

```ts
  it("stores and returns the plan text", () => {
    const s = new SessionStore(":memory:");
    s.upsert("as_3", "await_approval", "iss_3");
    expect(s.get("as_3")?.plan).toBeNull();
    s.setPlan("as_3", "1. do the thing\n2. test it");
    expect(s.get("as_3")?.plan).toBe("1. do the thing\n2. test it");
    s.close();
  });

  it("setPlan on unknown id is a no-op", () => {
    const s = new SessionStore(":memory:");
    s.setPlan("missing", "plan");
    expect(s.get("missing")).toBeUndefined();
    s.close();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/store/sessions.test.ts`
Expected: FAIL — `s.setPlan is not a function`.

- [ ] **Step 3: Implement the column, migration, and accessor**

In `src/store/sessions.ts`:

Add `plan` to the row interface:

```ts
export interface SessionRow {
  agentSessionId: string;
  phase: Phase;
  issueId: string | null;
  plan: string | null;
  updatedAt: string;
}
```

In the constructor, after the existing `CREATE TABLE IF NOT EXISTS` exec, add the guarded migration (SQLite has no `ADD COLUMN IF NOT EXISTS`; pre-existing dev DBs lack the column, fresh DBs also lack it since the CREATE TABLE is unchanged):

```ts
    const cols = this.#db.prepare(`SELECT name FROM pragma_table_info('sessions')`).all() as { name: string }[];
    if (!cols.some((c) => c.name === "plan")) {
      this.#db.exec(`ALTER TABLE sessions ADD COLUMN plan TEXT`);
    }
```

Add the method after `setPhase`:

```ts
  setPlan(agentSessionId: string, plan: string): void {
    this.#db
      .prepare(`UPDATE sessions SET plan = ?, updated_at = ? WHERE agent_session_id = ?`)
      .run(plan, new Date().toISOString(), agentSessionId);
  }
```

Update `get()` to select and return the column:

```ts
  get(agentSessionId: string): SessionRow | undefined {
    const row = this.#db
      .prepare(`SELECT agent_session_id, phase, issue_id, plan, updated_at FROM sessions WHERE agent_session_id = ?`)
      .get(agentSessionId) as
      | { agent_session_id: string; phase: Phase; issue_id: string | null; plan: string | null; updated_at: string }
      | undefined;
    if (!row) return undefined;
    return {
      agentSessionId: row.agent_session_id,
      phase: row.phase,
      issueId: row.issue_id,
      plan: row.plan,
      updatedAt: row.updated_at,
    };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/store/sessions.test.ts`
Expected: all PASS (3 existing + 2 new).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/store/sessions.ts tests/store/sessions.test.ts
git commit -m "feat: persist plan text in sessions table (survives restarts)"
```

---

### Task 2: No silent paths in onPrompted; plan read from store

**Files:**
- Modify: `src/orchestrator/pipeline.ts`
- Test: `tests/orchestrator/pipeline.test.ts`

**Interfaces:**
- Consumes: `SessionStore.setPlan(id, plan)` and `SessionRow.plan` from Task 1; `Activities` interface from `src/linear/activities.ts` (thought/action/response/error/elicitation, all `Promise<void>`).
- Produces: no signature changes — `onCreated(ctx)` and `onPrompted(ctx, replyText)` keep their shapes. Behavior contract: every `onPrompted` call posts ≥1 activity; implement never runs with an empty plan.

- [ ] **Step 1: Write the failing tests**

Append to `tests/orchestrator/pipeline.test.ts`. These use a real in-memory `SessionStore` and a recording fake `Activities`; the early-return paths under test never touch the sandbox or config, so `{} as Config` is safe.

```ts
import { Orchestrator } from "../../src/orchestrator/pipeline.ts";
import { SessionStore } from "../../src/store/sessions.ts";
import type { Activities } from "../../src/linear/activities.ts";
import type { IssueContext } from "../../src/linear/context.ts";
import type { Config } from "../../src/config.ts";

function fakeActs(log: string[]): Activities {
  const push = (kind: string) => async (...args: unknown[]) => {
    log.push(`${kind}:${String(args[0]).slice(0, 60)}`);
  };
  return {
    thought: push("thought"),
    action: push("action"),
    response: push("response"),
    error: push("error"),
    elicitation: push("elicitation"),
  };
}

function ctxFor(id: string): IssueContext {
  return {
    agentSessionId: id,
    organizationId: "org",
    issueId: "iss",
    title: "t",
    description: "d",
    comment: "",
    promptContext: "",
  };
}

describe("onPrompted never goes silent", () => {
  it("posts a thought when session phase is not await_approval", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_p1", "error", "iss");
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log));
    await orch.onPrompted(ctxFor("as_p1"), "approve");
    expect(log.length).toBe(1);
    expect(log[0]).toMatch(/^thought:/);
    expect(log[0]).toContain("error");
    store.close();
  });

  it("posts a thought when the session is unknown", async () => {
    const store = new SessionStore(":memory:");
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log));
    await orch.onPrompted(ctxFor("as_p2"), "approve");
    expect(log.length).toBe(1);
    expect(log[0]).toMatch(/^thought:/);
    store.close();
  });

  it("posts an error and sets phase=error when approved but plan is missing", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_p3", "await_approval", "iss");
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log));
    await orch.onPrompted(ctxFor("as_p3"), "approve");
    expect(log.some((l) => l.startsWith("error:"))).toBe(true);
    expect(store.get("as_p3")?.phase).toBe("error");
    store.close();
  });

  it("still posts the not-approved thought on rejection", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_p4", "await_approval", "iss");
    store.setPlan("as_p4", "the plan");
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log));
    await orch.onPrompted(ctxFor("as_p4"), "no, change the approach");
    expect(log.length).toBe(1);
    expect(log[0]).toMatch(/^thought:/);
    expect(store.get("as_p4")?.phase).toBe("await_approval");
    store.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/orchestrator/pipeline.test.ts`
Expected: FAIL — the phase-mismatch and unknown-session tests get `log.length === 0` (current code returns silently), and the missing-plan test fails because current code proceeds into `withSandbox` with an empty plan (it will throw on `{} as Config`; either failure mode counts as red).

- [ ] **Step 3: Rewrite onPrompted and switch plan storage to the store**

In `src/orchestrator/pipeline.ts`:

Delete the `#plans` field (line 33):

```ts
  // DELETE this line:
  #plans = new Map<string, string>(); // agentSessionId -> approved/proposed plan text (v1; persist in Phase 4)
```

In `onCreated`, replace `this.#plans.set(ctx.agentSessionId, plan);` with:

```ts
    this.#store.setPlan(ctx.agentSessionId, plan);
```

Replace the whole `onPrompted` method with:

```ts
  // prompted: a reply arrived while awaiting approval.
  // Contract: every path logs AND posts an activity — a session that receives
  // a prompt and emits nothing is marked unresponsive by Linear (10s rule).
  async onPrompted(ctx: IssueContext, replyText: string): Promise<void> {
    const acts = this.#makeActs(ctx.agentSessionId);
    const row = this.#store.get(ctx.agentSessionId);
    if (!row || row.phase !== "await_approval") {
      const phase = row?.phase ?? "unknown";
      console.log(`[skip] ${ctx.agentSessionId} prompted but phase=${phase} — replying with status`);
      await acts.thought(
        `This session is in state \`${phase}\`, so I can't act on that reply. ` +
          `To start over, re-assign the issue to me.`,
      );
      return;
    }
    const approved = parseApprovalGate(replyText);
    if (!approved) {
      console.log(`[phase] ${ctx.agentSessionId} reply parsed as NOT approval — staying in await_approval`);
      await acts.thought("Understood — not implementing yet. Tell me to 'approve' when ready.");
      return;
    }
    const plan = row.plan;
    if (!plan || !plan.trim()) {
      console.error(`[phase] ${ctx.agentSessionId} approved but plan is missing — refusing to implement blind`);
      await acts.error("I lost the plan for this session (likely a restart before it was saved). Re-assign the issue and I'll plan again.");
      this.#store.setPhase(ctx.agentSessionId, "error");
      return;
    }
    this.#store.setPhase(ctx.agentSessionId, "implement");
    console.log(`[phase] ${ctx.agentSessionId} → implement (approved)`);
    await acts.thought("Approved — implementing in a sandbox now.");

    const { result } = await withSandbox(this.#sbxCfg(), async (sbx) => {
      await cloneRepo(sbx, this.#sbxCfg());
      return runAgent(sbx, this.#config.anthropicApiKey, implementTask(ctx, plan), this.#relay(acts));
    });

    this.#logUsage(`implement ${ctx.agentSessionId}`, result);
    if (result?.kind === "result" && result.text) {
      console.log(`[phase] ${ctx.agentSessionId} → done (PR: ${result.text.slice(0, 100)})`);
      await acts.response(`Done. PR opened:\n\n${result.text}\n\n_A human review + merge closes this out._`);
      this.#store.setPhase(ctx.agentSessionId, "done");
    } else {
      console.error(`[phase] ${ctx.agentSessionId} → error (implement did not complete)`);
      await acts.error(result?.kind === "error" ? result.message : "Implementation did not complete.");
      this.#store.setPhase(ctx.agentSessionId, "error");
    }
  }
```

(The approved-path body from `setPhase("implement")` onward is unchanged from the current code except `plan` now comes from `row.plan` instead of the deleted Map.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/orchestrator/pipeline.test.ts`
Expected: all PASS (existing nextPhase/toolParameter tests + 4 new).

- [ ] **Step 5: Full suite, typecheck, commit**

Run: `npm test` then `npm run typecheck`
Expected: all green.

```bash
git add src/orchestrator/pipeline.ts tests/orchestrator/pipeline.test.ts
git commit -m "fix: onPrompted never silent — status reply on phase mismatch, fail loud on lost plan"
```

---

### Task 3: Log the running git SHA at startup

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a `[boot]` console line; nothing programmatic depends on it.

- [ ] **Step 1: Add the boot log**

Replace `src/index.ts` with:

```ts
import { execSync } from "node:child_process";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { makeServer } from "./server.ts";

// ponytail: best-effort SHA so "which code was running" is never a mystery;
// silent "unknown" outside a git checkout is fine.
let sha = "unknown";
try {
  sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
} catch {
  /* not a git checkout */
}
console.log(`[boot] jarvis @ ${sha}`);

const config = loadConfig();
const app = makeServer(config);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Jarvis listening on http://localhost:${info.port}`);
});
```

No unit test — a trivial logged one-liner (YAGNI applies to tests too); verified by the smoke check in Step 2.

- [ ] **Step 2: Smoke-check and commit**

Run: `npm run typecheck`
Expected: no errors.

Run: `node --env-file-if-exists=.env src/index.ts` briefly (Ctrl+C after boot) or check that `[boot] jarvis @ <sha>` appears when starting dev.
Expected: `[boot] jarvis @ df457d0`-style line, then the listening line.

```bash
git add src/index.ts
git commit -m "feat: log running git SHA at boot"
```

---

### Task 4: Manual end-to-end verification (vertical slice re-run)

**Files:** none (verification only).

**Interfaces:** consumes the deployed webhook flow; produces confidence.

- [ ] **Step 1: Start Jarvis and confirm the boot SHA matches HEAD**

Run: `npm run dev` — the `[boot]` line must show the SHA of the commit containing Tasks 1–3.

- [ ] **Step 2: Exercise all three reply branches on a test issue**

1. Assign a test issue to Jarvis → plan posted as elicitation.
2. Reply "not yet" → Linear shows the "not implementing yet" thought; console logs the NOT-approval line; session leaves "working".
3. Reply "approve, and dont use X" → console logs `→ implement (approved)`; implementation starts (the negation clause must NOT block approval).
4. After completion (or error), the session must show a terminal `response` or `error` activity — never a stuck "working".

- [ ] **Step 3: Restart resilience check**

Assign a fresh test issue, wait for the plan elicitation, then restart the server (`Ctrl+C`, `npm run dev`). Reply "approve". Expected: implementation proceeds using the persisted plan (Task 1) — no empty-plan run, no silence.
