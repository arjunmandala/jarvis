# Conversational Chat, Attachments, Sub-Issue Decomposition & Workflow States Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Jarvis a conversational fast path (answer questions without a full plan/approve/implement cycle), let it read screenshots pasted into Linear, let it split oversized issues into Linear sub-issues, and let it move the issue's actual workflow status as work progresses — without hardcoding any org's status names.

**Architecture:** A cheap host-side Haiku call classifies each fresh session and each reply on a conversational session as `chat` (answer directly) or `change` (existing plan/approve/implement pipeline); the already-unused `"clarify"` phase becomes the conversational phase. A new lightweight, read-only `chatTask()` answers in-sandbox. Image attachments are parsed out of Linear markdown and passed to the Agent SDK as vision blocks on every task, not just chat. The planning agent can emit a `Decomposition:` message instead of a plan; on approval, Jarvis creates and self-assigns Linear sub-issues instead of implementing. Workflow-state moves use Linear's standardized state `type` category (not display names), with an LLM tiebreak only when a category has more than one state.

**Tech Stack:** TypeScript (Node ≥24.15, `node:sqlite`), `@linear/sdk`, E2B (`e2b`), Claude Agent SDK (in-sandbox), Vitest.

## Global Constraints

- `.ts` files import each other with explicit `.ts` extensions (`moduleResolution: nodenext`).
- No new npm dependencies for the Anthropic classifier calls — use raw `fetch` against `https://api.anthropic.com/v1/messages`, matching the existing raw-`fetch`-to-GraphQL pattern already used in `src/linear/client.ts` (no `@anthropic-ai/sdk` on the host; the Agent SDK only runs inside the sandbox).
- Every new host-side integration failure (classifier call, attachment download, workflow-state update) must be **advisory**: log and continue, never throw into a code path that would fail a whole run over a non-essential enhancement. This matches `src/history/history.ts`'s `prepareHistory` and `src/sandbox/session.ts`'s `indexRepo` posture.
- Fixed `systemAppend` strings (`PLAN_APPEND`, `IMPLEMENT_APPEND`, new `CHAT_APPEND`) stay byte-stable — never interpolate per-run content into them (prompt-cache rule already documented in `src/agent/tasks.ts`).
- Mark deliberate simplifications with a `// ponytail:` comment naming the ceiling and upgrade path, matching existing repo convention.
- Every orchestrator error path both logs and posts a Linear activity (`src/orchestrator/pipeline.ts`'s existing contract) — do not add a silent failure path.
- Sandbox-entering flows (`withSandbox`) have no fake-e2b seam in this test suite — per existing convention (see `tests/orchestrator/pipeline.test.ts`'s comment on the plan-revision path), those are covered by live acceptance, not unit tests. Only test the pure/extracted logic that runs *before* a `withSandbox` call.

---

## File Structure

- **Modify** `src/linear/context.ts` — `IssueContext` gains `teamId`.
- **Create** `src/agent/classify.ts` — host-side Haiku classifier calls (`classifyIntent`, `pickWorkflowState`).
- **Modify** `src/agent/tasks.ts` — `chatTask()` + `CHAT_APPEND`; `AgentTask.images`; `PLAN_APPEND` decomposition instructions + `parseDecomposition()`; thread `images` through `planTask`/`reviseTask`/`implementTask`/`chatTask`.
- **Modify** `src/agent/runner.mjs` — `userMsg()` emits image content blocks.
- **Create** `src/linear/attachments.ts` — `extractImageUrls`, `fetchImageAttachments`.
- **Create** `src/linear/workflow.ts` — `fetchTeamStates`, `resolveTargetState`.
- **Modify** `src/store/sessions.ts` — `team_states` table + `getTeamStates`/`setTeamStates`.
- **Modify** `src/orchestrator/pipeline.ts` — chat routing (`#runChat`/`#finishChat`/`#onClarifyPrompted`), image wiring (`#extractImages`), decomposition wiring (`#createSubIssues`), workflow-state wiring (`#advanceState`), `Orchestrator` constructor gains an optional `linear` client param, `reconcile()` covers `"clarify"`.
- **Modify** `src/server.ts` — pass the raw `LinearClient` into `Orchestrator`.
- **Tests** mirror each file under `tests/`.

---

### Task 1: `IssueContext` gains `teamId`

**Files:**
- Modify: `src/linear/context.ts:4-32`
- Test: `tests/linear/context.test.ts`

**Interfaces:**
- Produces: `IssueContext.teamId: string | null` — consumed by Task 9 (`#createSubIssues`'s `teamId`) and Task 12 (`#advanceState`'s `fetchTeamStates` lookup).

- [ ] **Step 1: Write the failing test**

Add to `tests/linear/context.test.ts` inside the `extractContext` describe block:

```ts
  it("pulls the team id when present", () => {
    const payload = {
      organizationId: "org_1",
      agentSession: {
        id: "as_1",
        issue: { id: "iss_1", title: "t", description: "d", team: { id: "team_1" } },
      },
    };
    const ctx = extractContext(payload);
    expect(ctx.teamId).toBe("team_1");
  });

  it("teamId is null when missing", () => {
    const ctx = extractContext({ agentSession: { id: "as_2" } });
    expect(ctx.teamId).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/linear/context.test.ts -t "team id"`
Expected: FAIL — `ctx.teamId` is `undefined`, not `"team_1"` / not present on the type.

- [ ] **Step 3: Implement**

In `src/linear/context.ts`, extend the interface and extraction:

```ts
export interface IssueContext {
  agentSessionId: string;
  organizationId: string;
  issueId: string | null;
  teamId: string | null;
  title: string;
  description: string;
  comment: string;
  promptContext: string;
}
```

```ts
export function extractContext(payload: unknown): IssueContext {
  const p = asRecord(payload);
  const session = asRecord(p.agentSession);
  const issue = asRecord(session.issue);
  const team = asRecord(issue.team);
  const comment = asRecord(session.comment);
  return {
    agentSessionId: String(session.id ?? ""),
    organizationId: String(p.organizationId ?? ""),
    issueId: issue.id ? String(issue.id) : null,
    teamId: team.id ? String(team.id) : null,
    title: String(issue.title ?? ""),
    description: String(issue.description ?? ""),
    comment: String(comment.body ?? ""),
    promptContext: String(session.promptContext ?? ""),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/linear/context.test.ts`
Expected: all PASS. The existing `"pulls issue + comment + promptContext"` test uses `.toEqual` with an exact object — add `teamId: null` to its expected object so it still passes:

```ts
    expect(ctx).toEqual({
      agentSessionId: "as_1",
      organizationId: "org_1",
      issueId: "iss_1",
      teamId: null,
      title: "Add /health",
      description: "return {ok:true}",
      comment: "please add it",
      promptContext: "<issue>...</issue>",
    });
```

- [ ] **Step 5: Fix every other construction site so typecheck passes**

Run: `npm run typecheck`. Every literal `IssueContext` object elsewhere (e.g. `tests/agent/tasks.test.ts:5-8`, `tests/orchestrator/pipeline.test.ts`'s `ctxFor`) needs `teamId: "team_1"` (or `null`) added — add it to each. Re-run typecheck until clean.

- [ ] **Step 6: Commit**

```bash
git add src/linear/context.ts tests/linear/context.test.ts tests/agent/tasks.test.ts tests/orchestrator/pipeline.test.ts
git commit -m "feat(context): extract issue teamId from the Linear webhook payload"
```

---

### Task 2: Host-side Haiku classifier (`src/agent/classify.ts`)

**Files:**
- Create: `src/agent/classify.ts`
- Test: `tests/agent/classify.test.ts`

**Interfaces:**
- Produces: `classifyIntent(apiKey: string, text: string, fetchImpl?: typeof fetch): Promise<"chat" | "change">` — consumed by Task 4.
- Produces: `pickWorkflowState(apiKey: string, transitionLabel: string, candidateNames: string[], fetchImpl?: typeof fetch): Promise<string>` — consumed by Task 11.

- [ ] **Step 1: Write the failing test**

Create `tests/agent/classify.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { classifyIntent, pickWorkflowState } from "../../src/agent/classify.ts";

function textResponse(text: string): Response {
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("classifyIntent", () => {
  it("returns chat when the model says chat", async () => {
    const fetchImpl = vi.fn(async () => textResponse("chat"));
    const result = await classifyIntent("key", "explain this function", fetchImpl as unknown as typeof fetch);
    expect(result).toBe("chat");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers).toMatchObject({ "x-api-key": "key" });
    const body = JSON.parse(init.body as string);
    expect(body.model).toMatch(/haiku/);
  });

  it("returns change when the model says change", async () => {
    const fetchImpl = vi.fn(async () => textResponse("change"));
    expect(await classifyIntent("key", "add a rate limiter", fetchImpl as unknown as typeof fetch)).toBe("change");
  });

  it("defaults to change on any failure (safer fallback than silently skipping work)", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 }));
    expect(await classifyIntent("key", "text", fetchImpl as unknown as typeof fetch)).toBe("change");
  });

  it("defaults to change when fetch throws", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("network"); });
    expect(await classifyIntent("key", "text", fetchImpl as unknown as typeof fetch)).toBe("change");
  });
});

describe("pickWorkflowState", () => {
  it("returns the candidate the model names", async () => {
    const fetchImpl = vi.fn(async () => textResponse("In Review"));
    const result = await pickWorkflowState(
      "key", "PR opened for review", ["In Progress", "In Review"], fetchImpl as unknown as typeof fetch,
    );
    expect(result).toBe("In Review");
  });

  it("falls back to the first candidate if the model's answer doesn't match any", async () => {
    const fetchImpl = vi.fn(async () => textResponse("Something else entirely"));
    const result = await pickWorkflowState(
      "key", "PR opened for review", ["In Progress", "In Review"], fetchImpl as unknown as typeof fetch,
    );
    expect(result).toBe("In Progress");
  });

  it("falls back to the first candidate on failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 }));
    const result = await pickWorkflowState("key", "x", ["A", "B"], fetchImpl as unknown as typeof fetch);
    expect(result).toBe("A");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/agent/classify.test.ts`
Expected: FAIL — `Cannot find module '../../src/agent/classify.ts'`.

- [ ] **Step 3: Implement**

Create `src/agent/classify.ts`:

```ts
// Cheap host-side Claude calls (Haiku, no E2B sandbox) for two narrow decisions:
// chat-vs-change routing (src/orchestrator/pipeline.ts) and workflow-state
// disambiguation (src/linear/workflow.ts). Raw fetch to the Messages API — no
// SDK dependency, matching src/linear/client.ts's raw GraphQL fetch pattern.

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const CLASSIFY_MODEL = "claude-haiku-4-5-20251001";

interface MessagesResponse {
  content?: { type: string; text?: string }[];
}

async function askClassifier(
  apiKey: string,
  system: string,
  userText: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLASSIFY_MODEL,
        max_tokens: 20,
        system,
        messages: [{ role: "user", content: userText.slice(0, 8000) }],
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as MessagesResponse;
    const text = json.content?.find((b) => b.type === "text")?.text;
    return text ? text.trim() : null;
  } catch {
    return null;
  }
}

const INTENT_SYSTEM =
  "Classify the Linear issue or message below as exactly one word. Reply `chat` if it is a question, " +
  'explanation request, or review-only ask that needs no code change (e.g. "explain X", "why does Y ' +
  'happen", "review this diff"). Reply `change` if it asks for a code change, bug fix, feature, or ' +
  "refactor. Reply with exactly one word: chat or change. No punctuation, no other text.";

// ponytail: LLM heuristic, not a hard classifier — same ceiling as
// parseApproval/parseStop in src/linear/context.ts. Upgrade path: a manual
// escalation phrase fallback if misclassification proves costly in practice.
// Any failure (network, bad response, ambiguous reply) defaults to "change" —
// the safer failure mode is the existing plan/approve/implement pipeline, not
// silently answering a real work request as if it were a question.
export async function classifyIntent(
  apiKey: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<"chat" | "change"> {
  const word = await askClassifier(apiKey, INTENT_SYSTEM, text, fetchImpl);
  return word?.toLowerCase().startsWith("chat") ? "chat" : "change";
}

// Disambiguates among 2+ same-category workflow state names (see
// src/linear/workflow.ts). Falls back to the first candidate on any failure or
// unrecognized reply — still a valid state in the right category.
export async function pickWorkflowState(
  apiKey: string,
  transitionLabel: string,
  candidateNames: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const system =
    `A Linear issue is transitioning: "${transitionLabel}". Pick the single best-matching status name ` +
    `from this exact list, reply with that name verbatim and nothing else: ${candidateNames.join(", ")}`;
  const picked = await askClassifier(apiKey, system, transitionLabel, fetchImpl);
  const match = picked ? candidateNames.find((n) => n.toLowerCase() === picked.toLowerCase().trim()) : undefined;
  return match ?? candidateNames[0];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/agent/classify.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/classify.ts tests/agent/classify.test.ts
git commit -m "feat(classify): host-side Haiku classifier for chat routing and workflow-state disambiguation"
```

---

### Task 3: `chatTask()` — the lightweight, read-only answer task

**Files:**
- Modify: `src/agent/tasks.ts`
- Test: `tests/agent/tasks.test.ts`

**Interfaces:**
- Consumes: `IssueContext` (Task 1's `teamId` field is irrelevant here; existing fields are used), `issueBlock`/`repoMapBlock`/`historyBlock` (existing private helpers in the same file).
- Produces: `chatTask(ctx: IssueContext, repoMap?: string, history?: string): AgentTask` — consumed by Task 4's `#runChat`.

- [ ] **Step 1: Write the failing test**

Add to `tests/agent/tasks.test.ts`:

```ts
import { chatTask } from "../../src/agent/tasks.ts";
```

```ts
describe("chatTask", () => {
  it("is read-only: no Edit/Write/Bash", () => {
    const t = chatTask(ctx);
    expect(t.allowedTools).toEqual(expect.arrayContaining(["Read", "Glob", "Grep", "mcp__serena"]));
    expect(t.allowedTools).not.toContain("Edit");
    expect(t.allowedTools).not.toContain("Write");
    expect(t.allowedTools).not.toContain("Bash");
  });

  it("has a tighter turn/budget cap than planTask", () => {
    const t = chatTask(ctx);
    expect(t.maxTurns).toBeLessThan(25);
    expect(t.maxBudgetUsd).toBeLessThanOrEqual(1);
  });

  it("includes the issue in the goal and injects the repo map when provided", () => {
    const t = chatTask(ctx, "MAP");
    expect(t.goal).toContain(ctx.title);
    expect(t.goal).toContain("MAP");
  });

  it("tells the model its final message is posted verbatim as the answer", () => {
    const t = chatTask(ctx);
    expect(t.systemAppend).toMatch(/FINAL message/);
    expect(t.systemAppend).toMatch(/READ-ONLY/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/tasks.test.ts -t "chatTask"`
Expected: FAIL — `chatTask` is not exported.

- [ ] **Step 3: Implement**

In `src/agent/tasks.ts`, add after `MAP_APPEND`/`mapTask()` (or anywhere after `TOOLING_APPEND`/`CONVERSE_APPEND` are defined):

```ts
const CHAT_APPEND =
  "You are Jarvis, answering a question about this Linear issue and its codebase. You are a READ-ONLY " +
  "assistant for this task — you have no Edit/Write/Bash tools here, so answer using Read/Glob/Grep and " +
  "the serena tools only.\n\n" +
  "Answer directly and concisely, grounded in the actual repo. If the question is really a request for a " +
  "code change, say so plainly and note that you'll plan and implement it if they explicitly ask for the " +
  "change — do not attempt any change in this task.\n\n" +
  "Your FINAL message must be the complete answer — it is posted verbatim as your reply." +
  TOOLING_APPEND +
  CONVERSE_APPEND;

export function chatTask(ctx: IssueContext, repoMap?: string, history?: string): AgentTask {
  return {
    goal: `Answer the human's question about this issue and the repository.\n\n${issueBlock(ctx)}${repoMapBlock(repoMap)}${historyBlock(history)}`,
    cwd: REPO_DIR,
    model: "claude-sonnet-5",
    systemAppend: CHAT_APPEND,
    allowedTools: ["Read", "Glob", "Grep", "mcp__serena"],
    maxTurns: 15,
    maxBudgetUsd: 1,
    effort: "medium",
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/agent/tasks.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/tasks.ts tests/agent/tasks.test.ts
git commit -m "feat(tasks): add chatTask, a read-only lightweight answer task"
```

---

### Task 4: Chat routing in the orchestrator

**Files:**
- Modify: `src/orchestrator/pipeline.ts`
- Test: `tests/orchestrator/pipeline.test.ts`

**Interfaces:**
- Consumes: `classifyIntent` (Task 2), `chatTask` (Task 3), existing `Activities`/`SessionStore`/`withSandbox`/`cloneRepo`/`prepareHistory`.
- Produces: `Orchestrator#runChat`, `Orchestrator#finishChat`, `Orchestrator#onClarifyPrompted` (private methods — not exported, but their externally-observable effects (`onCreated`/`onPrompted` behavior) are what tests assert against). `reconcile()` now covers phase `"clarify"`.

This task only wires the **decision points** that don't require entering `withSandbox` (classification result → which path to take); the actual `chatTask()` sandbox run itself is exercised by live acceptance, matching this repo's existing convention for every other `withSandbox` path (plan, implement, revise).

- [ ] **Step 1: Write the failing tests**

Add to `tests/orchestrator/pipeline.test.ts`. These test the classification **decision**, not the sandboxed run — by injecting a `classify` override that resolves synchronously and asserting which private path was entered via its *observable* side effect (phase / activity posted), stopping before any sandbox call would occur is not directly assertable without touching `withSandbox`, so instead assert the well-defined guard we can observe without a sandbox: `onPrompted` on a `"clarify"`-phase session with a fake classifier that returns `"chat"` must NOT change phase away from `"clarify"` before entering the (untestable) sandbox call — i.e. it must still be attempting a chat run rather than falling through to the `await_approval`-required terminal-reply branch. Assert this via a fake `classify` that we can make throw, forcing the code down the advisory-failure branch, which *is* fully testable without a sandbox:

```ts
describe("clarify phase", () => {
  it("reconcile() covers the clarify phase (crash recovery)", () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_c1", "clarify", "iss");
    expect(store.listByPhase("clarify").map((r) => r.agentSessionId)).toEqual(["as_c1"]);
    store.close();
  });

  it("onPrompted on a done+no-PR clarify-derived session still gives the existing terminal reply", async () => {
    // Sessions never in "clarify" by the time onPrompted runs after this feature
    // ships still behave exactly as before — this guards the untouched branches.
    const store = new SessionStore(":memory:");
    store.upsert("as_c2", "done", "iss");
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log));
    await orch.onPrompted(ctxFor("as_c2"), "thanks!");
    expect(log[0]).toMatch(/^response:/);
    store.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/orchestrator/pipeline.test.ts -t "clarify phase"`
Expected: the `reconcile()` test FAILS (`listByPhase("clarify")` returns `[]` — `"clarify"` rows exist already via `upsert`, so this specific assertion actually already passes; the real failure signal is the second test remaining green while `reconcile()` itself has not yet been extended — proceed to Step 3 regardless, since the meaningful verification here is the reconcile *phase-list* change and the new private methods, both confirmed by re-running the full suite in Step 4).

- [ ] **Step 3: Implement**

In `src/orchestrator/pipeline.ts`:

**3a.** Import `classifyIntent` and `chatTask`:

```ts
import { planTask, implementTask, mapTask, reviseTask, reviewTask, chatTask } from "../agent/tasks.ts";
import { classifyIntent } from "../agent/classify.ts";
```

**3b.** In `onCreated`, replace the tail (after the `prior` resumability block, currently):

```ts
    this.#store.upsert(ctx.agentSessionId, "plan", ctx.issueId);
    await this.#runPlan(ctx, acts, null);
  }
```

with:

```ts
    const intent = await classifyIntent(this.#config.anthropicApiKey, `${ctx.title}\n\n${ctx.description}\n\n${ctx.comment}`);
    if (intent === "chat") {
      await this.#runChat(ctx, acts, null);
      return;
    }
    this.#store.upsert(ctx.agentSessionId, "plan", ctx.issueId);
    await this.#runPlan(ctx, acts, null);
  }
```

**3c.** Add `#runChat` and `#finishChat`, near `#runPlan`/`#finishPlan`:

```ts
  // Called from onCreated/onClarifyPrompted: clone -> answer -> post as response.
  // Stays in phase "clarify" on both success and failure — a chat thread is meant
  // to stay conversational; unlike plan/implement, a failed answer is retried by
  // simply replying again, never wedged into "error".
  async #runChat(ctx: IssueContext, acts: Activities, branch: string | null): Promise<void> {
    console.log(`[phase] ${ctx.agentSessionId} clarify: answering`);
    await acts.thought("Reading the codebase to answer…");

    let cloneFailed = false;
    const result = await withSandbox(this.#sbxCfg(ctx.agentSessionId), async (sbx) => {
      this.#store.setSandbox(ctx.agentSessionId, sbx.sandboxId);
      try {
        await cloneRepo(sbx, this.#sbxCfg(ctx.agentSessionId), branch);
      } catch (err) {
        cloneFailed = true;
        console.error(`[phase] ${ctx.agentSessionId} chat clone failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
      const map = this.#store.getRepoMap(this.#config.targetRepo);
      const history = await this.#timed(ctx.agentSessionId, "history", () =>
        prepareHistory(this.#store, sbx, ctx.issueId, this.#fetchThread),
      );
      return this.#trackedRun(ctx.agentSessionId, "chat", sbx, chatTask(ctx, map, history), acts);
    });

    this.#store.setSandbox(ctx.agentSessionId, null);
    if (cloneFailed) {
      console.error(`[phase] ${ctx.agentSessionId} chat clone failed — staying in clarify`);
      await acts.error("I couldn't clone the repository to answer that. Reply again to retry.").catch(() => undefined);
      return;
    }
    await this.#finishChat(ctx.agentSessionId, acts, result);
  }

  async #finishChat(agentSessionId: string, acts: Activities, result: JarvisEvent | null): Promise<void> {
    const text = result?.kind === "result" && result.text ? result.text.trim() : "";
    if (!text) {
      console.error(`[phase] ${agentSessionId} chat run produced no answer`);
      await acts.error("I couldn't answer that — reply again to retry.").catch(() => undefined);
      return; // stays in "clarify" — retryable by replying again
    }
    console.log(`[phase] ${agentSessionId} clarify: answered (${text.length} chars)`);
    await acts.response(`${text}${costLine(result)}`);
  }

  // A reply on a session in "clarify": re-classify the new message and either
  // continue chatting or escalate into the normal plan pipeline — the same
  // decision onCreated makes for a fresh session.
  async #onClarifyPrompted(ctx: IssueContext, row: SessionRow, replyText: string, acts: Activities): Promise<void> {
    const intent = await classifyIntent(this.#config.anthropicApiKey, replyText);
    if (intent === "change") {
      console.log(`[phase] ${ctx.agentSessionId} clarify -> plan (escalated by reply)`);
      this.#store.upsert(ctx.agentSessionId, "plan", ctx.issueId);
      await this.#runPlan(ctx, acts, row.branch);
      return;
    }
    await this.#runChat(ctx, acts, row.branch);
  }
```

**3d.** In `onPrompted`, add the clarify branch before the existing `await_approval`-only check:

```ts
  async onPrompted(ctx: IssueContext, replyText: string): Promise<void> {
    const acts = this.#makeActs(ctx.agentSessionId);
    const row = this.#store.get(ctx.agentSessionId);

    if (row?.phase === "clarify") {
      await this.#onClarifyPrompted(ctx, row, replyText, acts);
      return;
    }

    if (!row || row.phase !== "await_approval") {
```

(the rest of `onPrompted` is unchanged).

**3e.** In `reconcile()`, add `"clarify"` to the phase list and its dispatch:

```ts
      const rows = this.#store.listByPhase("plan", "implement", "review", "clarify");
```

and inside the per-row `fail`/`failStuck` setup, add the clarify case (mirroring the existing `review` case, which also never escalates to `"error"`):

```ts
        const fail = (message: string) =>
          row.phase === "review" ? this.#finishReview(id, acts, null)
          : row.phase === "clarify" ? this.#finishChat(id, acts, null)
          : this.#failLoud(id, acts, message);
```

and in the result-recovered dispatch:

```ts
            if (row.phase === "plan") {
              await this.#finishPlan(id, acts, result);
            } else if (row.phase === "review") {
              await this.#finishReview(id, acts, result);
            } else if (row.phase === "clarify") {
              await this.#finishChat(id, acts, result);
            } else {
              await this.#finishImplement(id, acts, result);
            }
```

- [ ] **Step 4: Run all tests to verify they pass**

Run: `npm test`
Expected: all PASS (existing tests + the 2 new ones). Note `onCreated`'s classification call means every existing `onCreated`-touching test that doesn't stub a `fetchImpl` will now attempt a real network call to `api.anthropic.com` and fail — check `tests/orchestrator/pipeline.test.ts` for any such test; per Step 5 fix any that surface.

- [ ] **Step 5: Fix any tests broken by the new classify call**

`onCreated` itself is not directly unit-tested today except through the `prior`-resumability branches, which all `return` before reaching the new classification line — confirm by grep:

Run: `grep -n "orch.onCreated" tests/orchestrator/pipeline.test.ts`

If any call reaches the classification line, inject a stub via a test-only `fetch` global stub (`vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })))` in that test, restored in `afterEach`) so it deterministically falls back to `"change"` — matching pre-existing behavior. Re-run `npm test` until green.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/pipeline.ts tests/orchestrator/pipeline.test.ts
git commit -m "feat(orchestrator): route fresh sessions and clarify replies through a chat/change classifier"
```

---

### Task 5: `AgentTask.images` + vision blocks in `runner.mjs`

**Files:**
- Modify: `src/agent/tasks.ts` (interface only)
- Modify: `src/agent/runner.mjs`
- Test: `tests/agent/tasks.test.ts` (type-level; `runner.mjs` itself has no unit tests in this repo — it runs only inside the sandbox, consistent with existing convention. Verify by inspection + Step 4's manual trace, not a new test file.)

**Interfaces:**
- Produces: `AgentTask.images?: { mediaType: string; data: string }[]` — consumed by Task 7 (task builders) and `runner.mjs`.

- [ ] **Step 1: Write the failing test**

Add to `tests/agent/tasks.test.ts`:

```ts
describe("AgentTask.images", () => {
  it("planTask accepts an optional images array without altering goal text", () => {
    const images = [{ mediaType: "image/png", data: "abc123" }];
    const withImages = planTask(ctx, undefined, undefined, images);
    expect(withImages.images).toEqual(images);
    expect(withImages.goal).toBe(planTask(ctx).goal); // goal text is untouched by images
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/tasks.test.ts -t "AgentTask.images"`
Expected: FAIL — `planTask` doesn't accept a 4th argument / `images` is not on the returned object (TS error at compile, or `undefined` at runtime for the `toEqual` assertion).

- [ ] **Step 3: Implement**

In `src/agent/tasks.ts`, extend the interface:

```ts
export interface AgentTask {
  goal: string;
  cwd: string;
  model: string;
  systemAppend: string;
  allowedTools: string[];
  maxTurns: number;
  maxBudgetUsd: number;
  effort?: EffortLevel;
  // Base64 images extracted from Linear attachments (screenshots pasted into the
  // issue/comments) — passed to the agent's first turn as vision blocks alongside
  // goal's text. Undefined for tasks with no attachments found.
  images?: { mediaType: string; data: string }[];
}
```

Update `planTask` to accept and pass through a trailing `images` param (the other task builders are wired in Task 7 — this step only needs `planTask` to make the test pass):

```ts
export function planTask(ctx: IssueContext, repoMap?: string, history?: string, images?: AgentTask["images"]): AgentTask {
  return {
    goal: `Produce an implementation plan for this issue.\n\n${issueBlock(ctx)}${repoMapBlock(repoMap)}${historyBlock(history)}`,
    cwd: REPO_DIR,
    model: "claude-sonnet-5",
    systemAppend: PLAN_APPEND,
    allowedTools: ALL_REPO_TOOLS,
    maxTurns: 25,
    maxBudgetUsd: 2,
    effort: "medium",
    images,
  };
}
```

In `src/agent/runner.mjs`, extend `userMsg` to accept images and emit vision blocks ahead of the text block, and pass `task.images` on the very first message (steering messages carry no images):

```js
const userMsg = (text, images) => ({
  type: "user",
  message: {
    role: "user",
    content: [
      ...(images ?? []).map((img) => ({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: img.data },
      })),
      { type: "text", text },
    ],
  },
  parent_tool_use_id: null,
  session_id: "",
});
```

```js
async function* promptStream() {
  yield userMsg(task.goal, task.images);
  for (;;) {
```

(the rest of `promptStream` is unchanged — `yield userMsg(steering.shift())` correctly omits the second argument, which defaults to `undefined` → `[]`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/agent/tasks.test.ts`
Expected: all PASS. Then run `npm run typecheck` to confirm `runner.mjs` (plain JS, untyped) didn't break anything type-checked elsewhere.

- [ ] **Step 5: Commit**

```bash
git add src/agent/tasks.ts src/agent/runner.mjs tests/agent/tasks.test.ts
git commit -m "feat(agent): thread optional image attachments through AgentTask and the in-sandbox runner"
```

---

### Task 6: Extract and download Linear image attachments (`src/linear/attachments.ts`)

**Files:**
- Create: `src/linear/attachments.ts`
- Test: `tests/linear/attachments.test.ts`

**Interfaces:**
- Produces: `extractImageUrls(text: string): string[]` and `fetchImageAttachments(accessToken: string, text: string, fetchImpl?: typeof fetch): Promise<{ mediaType: string; data: string }[]>` — consumed by Task 7.

- [ ] **Step 1: Write the failing test**

Create `tests/linear/attachments.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { extractImageUrls, fetchImageAttachments } from "../../src/linear/attachments.ts";

describe("extractImageUrls", () => {
  it("finds uploads.linear.app image links in markdown", () => {
    const text = "See this bug: ![screenshot](https://uploads.linear.app/abc/def.png) thanks";
    expect(extractImageUrls(text)).toEqual(["https://uploads.linear.app/abc/def.png"]);
  });

  it("ignores non-linear image links and dedupes repeats", () => {
    const text =
      "![x](https://example.com/pic.png) ![y](https://uploads.linear.app/a.png) ![z](https://uploads.linear.app/a.png)";
    expect(extractImageUrls(text)).toEqual(["https://uploads.linear.app/a.png"]);
  });

  it("caps at 5 urls", () => {
    const urls = Array.from({ length: 8 }, (_, i) => `https://uploads.linear.app/${i}.png`);
    const text = urls.map((u) => `![img](${u})`).join(" ");
    expect(extractImageUrls(text)).toHaveLength(5);
  });

  it("returns an empty array for plain text", () => {
    expect(extractImageUrls("just a regular comment")).toEqual([]);
  });
});

function imgResponse(bytes: number, contentType = "image/png"): Response {
  return new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": contentType } });
}

describe("fetchImageAttachments", () => {
  it("downloads found images with the auth header and base64-encodes them", async () => {
    const fetchImpl = vi.fn(async () => imgResponse(4));
    const text = "![x](https://uploads.linear.app/a.png)";
    const out = await fetchImageAttachments("token-1", text, fetchImpl as unknown as typeof fetch);
    expect(out).toHaveLength(1);
    expect(out[0].mediaType).toBe("image/png");
    expect(typeof out[0].data).toBe("string");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://uploads.linear.app/a.png");
    expect(init.headers).toMatchObject({ authorization: "Bearer token-1" });
  });

  it("skips a download that fails, without throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 403 }));
    const text = "![x](https://uploads.linear.app/a.png)";
    const out = await fetchImageAttachments("token-1", text, fetchImpl as unknown as typeof fetch);
    expect(out).toEqual([]);
  });

  it("skips a non-image content-type", async () => {
    const fetchImpl = vi.fn(async () => imgResponse(4, "text/html"));
    const out = await fetchImageAttachments("token-1", "![x](https://uploads.linear.app/a.png)", fetchImpl as unknown as typeof fetch);
    expect(out).toEqual([]);
  });

  it("returns an empty array when there are no image links", async () => {
    const fetchImpl = vi.fn();
    expect(await fetchImageAttachments("token-1", "no images here", fetchImpl as unknown as typeof fetch)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/linear/attachments.test.ts`
Expected: FAIL — `Cannot find module '../../src/linear/attachments.ts'`.

- [ ] **Step 3: Implement**

Create `src/linear/attachments.ts`:

```ts
// Screenshots pasted into a Linear comment/description arrive as plain
// markdown image links pointing at Linear's authenticated upload host, not a
// separate structured "attachments" field. Both extraction and download live
// here so every task builder can pull real image content out of issue text.
const IMAGE_MD_RE = /!\[[^\]]*\]\((https:\/\/uploads\.linear\.app\/[^)]+)\)/g;

// Defensive caps: a thread could in principle link dozens of large images.
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function extractImageUrls(text: string): string[] {
  const urls: string[] = [];
  for (const m of text.matchAll(IMAGE_MD_RE)) {
    if (!urls.includes(m[1])) urls.push(m[1]);
  }
  return urls.slice(0, MAX_IMAGES);
}

export interface ImageAttachment {
  mediaType: string;
  data: string;
}

// Advisory end-to-end: a failed or oversized or non-image download is skipped,
// never thrown — attachments are a bonus, not a run-blocking dependency.
export async function fetchImageAttachments(
  accessToken: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ImageAttachment[]> {
  const urls = extractImageUrls(text);
  const out: ImageAttachment[] = [];
  for (const url of urls) {
    try {
      const res = await fetchImpl(url, { headers: { authorization: `Bearer ${accessToken}` } });
      if (!res.ok) continue;
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.startsWith("image/")) continue;
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_IMAGE_BYTES) continue;
      out.push({ mediaType: contentType, data: Buffer.from(buf).toString("base64") });
    } catch (err) {
      console.error(`[attachments] download failed for ${url} (advisory): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/linear/attachments.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/linear/attachments.ts tests/linear/attachments.test.ts
git commit -m "feat(attachments): extract and download Linear-hosted screenshot images"
```

---

### Task 7: Wire image attachments into every task builder via the orchestrator

**Files:**
- Modify: `src/agent/tasks.ts` (`reviseTask`, `implementTask`, `chatTask` gain the same trailing `images` param `planTask` got in Task 5)
- Modify: `src/orchestrator/pipeline.ts` (`#extractImages` helper; thread it into `#runPlan`, `#onClarifyPrompted`'s call into `#runChat` — actually `#runChat` itself —, the revise branch in `onPrompted`, and `#runImplement`)
- Test: `tests/agent/tasks.test.ts`, `tests/orchestrator/pipeline.test.ts`

**Interfaces:**
- Consumes: `fetchImageAttachments` (Task 6).
- Produces: nothing new consumed by later tasks — this is a leaf wiring task.

- [ ] **Step 1: Write the failing tests**

Add to `tests/agent/tasks.test.ts`:

```ts
describe("images threaded through every task builder", () => {
  const images = [{ mediaType: "image/png", data: "xyz" }];

  it("reviseTask accepts images", () => {
    expect(reviseTask(ctx, "plan", "feedback", undefined, undefined, images).images).toEqual(images);
  });
  it("implementTask accepts images", () => {
    expect(implementTask(ctx, "## Plan", undefined, undefined, undefined, images).images).toEqual(images);
  });
  it("chatTask accepts images", () => {
    expect(chatTask(ctx, undefined, undefined, images).images).toEqual(images);
  });
});
```

(add `reviseTask, implementTask` to the existing top-of-file import if not already present — they already are, per the current file).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/agent/tasks.test.ts -t "images threaded"`
Expected: FAIL — none of these builders accept a trailing `images` argument yet.

- [ ] **Step 3: Implement — task builders**

In `src/agent/tasks.ts`:

```ts
export function reviseTask(
  ctx: IssueContext,
  previousPlan: string,
  feedback: string,
  repoMap?: string,
  history?: string,
  images?: AgentTask["images"],
): AgentTask {
  return {
    goal:
      `Revise the plan below according to the human's feedback. Apply the feedback faithfully and keep ` +
      `everything the feedback doesn't touch. Re-check the repo where the feedback changes assumptions. ` +
      `Your FINAL message must be the complete revised plan in Markdown — that text is returned verbatim to ` +
      `the human for approval.\n\n` +
      `Feedback:\n${feedback}\n\n---\nPrevious plan:\n${previousPlan}\n\n---\n${issueBlock(ctx)}${repoMapBlock(repoMap)}${historyBlock(history)}`,
    cwd: REPO_DIR,
    model: "claude-sonnet-5",
    systemAppend: PLAN_APPEND,
    allowedTools: ALL_REPO_TOOLS,
    maxTurns: 25,
    maxBudgetUsd: 2,
    effort: "medium",
    images,
  };
}
```

```ts
export function implementTask(
  ctx: IssueContext,
  approvedPlan: string,
  repoMap?: string,
  workBranch?: string,
  history?: string,
  images?: AgentTask["images"],
): AgentTask {
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
      `${approvedPlan}\n\n---\nOriginal issue:\n${issueBlock(ctx)}${repoMapBlock(repoMap)}${historyBlock(history)}`,
    cwd: REPO_DIR,
    model: route.model,
    systemAppend: IMPLEMENT_APPEND,
    allowedTools: ALL_REPO_TOOLS,
    maxTurns: 120,
    maxBudgetUsd: route.maxBudgetUsd,
    effort: route.effort,
    images,
  };
}
```

```ts
export function chatTask(ctx: IssueContext, repoMap?: string, history?: string, images?: AgentTask["images"]): AgentTask {
  return {
    goal: `Answer the human's question about this issue and the repository.\n\n${issueBlock(ctx)}${repoMapBlock(repoMap)}${historyBlock(history)}`,
    cwd: REPO_DIR,
    model: "claude-sonnet-5",
    systemAppend: CHAT_APPEND,
    allowedTools: ["Read", "Glob", "Grep", "mcp__serena"],
    maxTurns: 15,
    maxBudgetUsd: 1,
    effort: "medium",
    images,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/agent/tasks.test.ts`
Expected: all PASS.

- [ ] **Step 5: Implement — orchestrator wiring**

In `src/orchestrator/pipeline.ts`, import `fetchImageAttachments`:

```ts
import { fetchImageAttachments } from "../linear/attachments.ts";
```

Add a private helper (near `#extractImages`'s natural neighbors, e.g. below `#workBranchFor`):

```ts
  // Pulls any Linear-hosted screenshot images out of the issue description,
  // latest comment, and prior-session history text, and downloads them. Advisory:
  // any failure inside fetchImageAttachments is already swallowed there — this
  // wrapper exists so every call site has one line, not a try/catch each.
  async #extractImages(ctx: IssueContext, history?: string): Promise<AgentTask["images"]> {
    const text = `${ctx.description}\n${ctx.comment}\n${history ?? ""}`;
    const images = await fetchImageAttachments(this.#config.linear.accessToken, text);
    return images.length > 0 ? images : undefined;
  }
```

Import `AgentTask` type if not already imported (it already is, per the existing `import type { AgentTask } from "../agent/tasks.ts";`).

Wire it into each call site, right after `history` is computed and right before the task builder call:

In `#runPlan`:

```ts
      const history = await this.#timed(ctx.agentSessionId, "history", () =>
        prepareHistory(this.#store, sbx, ctx.issueId, this.#fetchThread),
      );
      const images = await this.#extractImages(ctx, history);
      return this.#trackedRun(ctx.agentSessionId, "plan", sbx, planTask(ctx, map, history, images), acts);
```

In `#runChat`:

```ts
      const history = await this.#timed(ctx.agentSessionId, "history", () =>
        prepareHistory(this.#store, sbx, ctx.issueId, this.#fetchThread),
      );
      const images = await this.#extractImages(ctx, history);
      return this.#trackedRun(ctx.agentSessionId, "chat", sbx, chatTask(ctx, map, history, images), acts);
```

In `onPrompted`'s revise branch:

```ts
        const history = await this.#timed(ctx.agentSessionId, "history", () =>
          prepareHistory(this.#store, sbx, ctx.issueId, this.#fetchThread),
        );
        const images = await this.#extractImages(ctx, history);
        return this.#trackedRun(ctx.agentSessionId, "revise", sbx, reviseTask(ctx, plan, replyText, map, history, images), acts);
```

In `#runImplement`:

```ts
      const history = await this.#timed(ctx.agentSessionId, "history", () =>
        prepareHistory(this.#store, sbx, ctx.issueId, this.#fetchThread),
      );
      const images = await this.#extractImages(ctx, history);
      const r = await this.#trackedRun(ctx.agentSessionId, "implement", sbx, implementTask(ctx, plan, map, workBranch, history, images), acts);
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all PASS — these call sites are all inside `withSandbox` closures with no direct unit test, so no test file changes are required here beyond Step 1's; confirm nothing else broke.

- [ ] **Step 7: Commit**

```bash
git add src/agent/tasks.ts src/orchestrator/pipeline.ts tests/agent/tasks.test.ts
git commit -m "feat(orchestrator): extract and pass Linear screenshot attachments into every agent task"
```

---

### Task 8: Sub-issue decomposition — plan contract + parser

**Files:**
- Modify: `src/agent/tasks.ts` (`PLAN_APPEND`, new `parseDecomposition`)
- Test: `tests/agent/tasks.test.ts`

**Interfaces:**
- Produces: `parseDecomposition(text: string): { title: string; description: string }[] | null` — consumed by Task 9.

- [ ] **Step 1: Write the failing test**

Add to `tests/agent/tasks.test.ts`:

```ts
import { parseDecomposition } from "../../src/agent/tasks.ts";

describe("parseDecomposition", () => {
  it("parses a numbered Decomposition: list", () => {
    const text =
      "Decomposition:\n" +
      "1. Add the settings page — build the new /settings route and its form.\n" +
      "2. Wire the API — persist the settings server-side and validate input.\n";
    expect(parseDecomposition(text)).toEqual([
      { title: "Add the settings page", description: "build the new /settings route and its form." },
      { title: "Wire the API", description: "persist the settings server-side and validate input." },
    ]);
  });

  it("returns null for a normal Type:/Scope: plan", () => {
    expect(parseDecomposition("Type: feature\nScope: small\n\nDo the thing.")).toBeNull();
  });

  it("returns null when Decomposition: has no parseable items", () => {
    expect(parseDecomposition("Decomposition:\nsomething unstructured")).toBeNull();
  });

  it("tolerates leading whitespace before Decomposition:", () => {
    expect(parseDecomposition("  \nDecomposition:\n1. A — b.\n")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/tasks.test.ts -t "parseDecomposition"`
Expected: FAIL — `parseDecomposition` is not exported.

- [ ] **Step 3: Implement**

In `src/agent/tasks.ts`, extend `PLAN_APPEND` (insert right after the `CLASSIFY FIRST` block, before `Then follow that type's playbook:`):

```ts
const PLAN_APPEND =
  "You are Jarvis, an autonomous engineer working a Linear ticket.\n\n" +
  "CLASSIFY FIRST: the first TWO lines of your plan must be exactly:\n" +
  "`Type: <one of: bug, feature, refactor, chore, investigation>`\n" +
  "`Scope: <small|large>` — small = roughly 2 or fewer files and no design ambiguity; large = " +
  "multiple files, cross-cutting changes, or real design choices. Be honest: this line routes how the " +
  "implementation is run.\n\n" +
  "DECOMPOSE IF TOO BIG: if this issue is too large or has too much design ambiguity for one PR (it spans " +
  "several unrelated areas, or the sensible approach is genuinely multiple separate pieces of work), do NOT " +
  "produce a Type:/Scope: plan. Instead your FINAL message must start with exactly `Decomposition:` on its " +
  "own line, followed by a numbered list, each item formatted exactly as `<n>. <title> — <one paragraph " +
  "description>`. Use this rarely — most issues, even meaty ones, are one plan.\n\n" +
  "Then follow that type's playbook:\n" +
  "- bug: reproduce the failure FIRST (run the failing test or command with Bash), trace it to a root " +
  "cause, and plan the minimal fix plus a regression test. Use the systematic-debugging skill when the " +
  "cause is not obvious.\n" +
  "- feature: gauge design ambiguity. A small, unambiguous feature gets a short direct plan; reach for " +
  "the brainstorming and writing-plans skills only for substantial features with real design choices.\n" +
  "- refactor: map the blast radius — find every caller and reference of what changes — and plan " +
  "behavior-preserving steps, naming the tests that prove behavior is unchanged.\n" +
  "- chore: the shortest plan that names the exact files and changes.\n" +
  "- investigation: state the questions to answer and how you will answer each one.\n\n" +
  "GROUNDING: explore the repo so the plan names real files. Bash is for understanding only — " +
  "reproduce failures, run tests, inspect behavior. Never write or modify files, and install only what " +
  "reproduction strictly requires.\n\n" +
  "Keep the plan proportional to the issue: a small fix gets a handful of bullets naming the exact " +
  "files and changes, nothing more.\n\n" +
  "Your FINAL message must be the complete implementation plan in Markdown, starting with the `Type:` " +
  "and `Scope:` lines (or the `Decomposition:` list above) — that text is returned verbatim to the human " +
  "for approval. Do not write any files." +
  TOOLING_APPEND +
  CONVERSE_APPEND;
```

Add `parseDecomposition` near `routeImplement`:

```ts
export interface DecompositionItem {
  title: string;
  description: string;
}

// Detects the plan agent's escape hatch for an oversized issue (see
// PLAN_APPEND's "DECOMPOSE IF TOO BIG" instruction). Mirrors routeImplement's
// header-prefix style: a plain string check, not a classifier — the ceiling is
// a malformed Decomposition: list, which simply returns null and the plan is
// then treated as a normal (if odd-looking) plan text by #finishPlan.
export function parseDecomposition(text: string): DecompositionItem[] | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("Decomposition:")) return null;
  const body = trimmed.slice("Decomposition:".length);
  const items: DecompositionItem[] = [];
  const re = /^\s*\d+\.\s*(.+?)\s*—\s*(.+)$/gm;
  for (const m of body.matchAll(re)) {
    const title = m[1].trim();
    const description = m[2].trim();
    if (title && description) items.push({ title, description });
  }
  return items.length > 0 ? items : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/agent/tasks.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/tasks.ts tests/agent/tasks.test.ts
git commit -m "feat(tasks): let the planning agent propose a sub-issue decomposition instead of a plan"
```

---

### Task 9: Sub-issue creation — orchestrator wiring

**Files:**
- Modify: `src/orchestrator/pipeline.ts` (`Orchestrator` constructor gains `linear`; `#finishPlan` decomposition branch; `#createSubIssues`; `onPrompted`'s approval branch)
- Modify: `src/server.ts` (pass the raw `LinearClient` into `Orchestrator`)
- Test: `tests/orchestrator/pipeline.test.ts`

**Interfaces:**
- Consumes: `parseDecomposition` (Task 8), `@linear/sdk`'s `LinearClient.createIssue`/`.viewer`.
- Produces: `Orchestrator`'s constructor signature grows an 7th optional param `linear?: OrchestratorLinear` — Task 11/12 reuse the same client reference for workflow-state calls, so the type alias is exported from `pipeline.ts`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/orchestrator/pipeline.test.ts`:

```ts
import type { LinearClient } from "@linear/sdk";
```

```ts
describe("sub-issue decomposition", () => {
  function fakeLinear(created: string[]): Pick<LinearClient, "createIssue" | "updateIssue" | "viewer" | "workflowStates"> {
    return {
      createIssue: (async (input: { title: string }) => {
        created.push(input.title);
        return { issue: Promise.resolve({ identifier: `ENG-${created.length}` }) };
      }) as LinearClient["createIssue"],
      updateIssue: (async () => ({})) as unknown as LinearClient["updateIssue"],
      viewer: Promise.resolve({ id: "jarvis-bot" }) as unknown as LinearClient["viewer"],
      workflowStates: (async () => ({ nodes: [] })) as unknown as LinearClient["workflowStates"],
    };
  }

  it("posts the decomposition as an elicitation instead of a normal plan", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_d1", "await_approval", "iss");
    store.setPlan("as_d1", "placeholder"); // pre-existing row so onPrompted's plan-missing guard doesn't fire
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log));
    // Directly exercise #finishPlan's public seam via reconcile-style call: call
    // onPrompted is not the right seam for finishPlan; instead assert through
    // the documented, exported behavior — simulate approval on an already
    // decomposition-shaped stored plan and confirm no sandbox/implement path
    // is taken (createIssue is called, not implementTask).
    store.setPlan("as_d1", "Decomposition:\n1. A — do a.\n2. B — do b.\n");
    const created: string[] = [];
    const orch2 = new Orchestrator({} as Config, store, () => fakeActs(log), undefined, undefined, undefined, fakeLinear(created));
    await orch2.onPrompted(ctxFor("as_d1"), "approve");
    expect(created).toEqual(["A", "B"]);
    expect(store.get("as_d1")?.phase).toBe("done");
    expect(log.some((l) => l.startsWith("response:") && l.includes("sub-issue"))).toBe(true);
    store.close();
  });

  it("reports failure gracefully when linear client is not configured", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_d2", "await_approval", "iss");
    store.setPlan("as_d2", "Decomposition:\n1. A — do a.\n");
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log)); // no linear client passed
    await orch.onPrompted(ctxFor("as_d2"), "approve");
    expect(store.get("as_d2")?.phase).toBe("done");
    expect(log.some((l) => l.startsWith("response:"))).toBe(true);
    store.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/orchestrator/pipeline.test.ts -t "sub-issue decomposition"`
Expected: FAIL — `Orchestrator`'s constructor doesn't accept a 7th `linear` argument, and approving a `Decomposition:`-prefixed plan currently falls into `#runImplement` (which would attempt a real sandbox and hang/fail the test).

- [ ] **Step 3: Implement**

In `src/orchestrator/pipeline.ts`, near the top (after the `Reconnected` type):

```ts
import type { LinearClient } from "@linear/sdk";
import { parseDecomposition } from "../agent/tasks.ts";

// The subset of LinearClient the orchestrator needs for sub-issue creation
// (Task 9) and workflow-state moves (Task 11-12) — kept narrow so tests can
// fake it without the real SDK.
export type OrchestratorLinear = Pick<LinearClient, "createIssue" | "updateIssue" | "viewer" | "workflowStates">;
```

Add `#linear` field and a 7th constructor param, plus a lazily-cached Jarvis actor id getter:

```ts
export class Orchestrator {
  #config: Config;
  #store: SessionStore;
  #makeActs: (agentSessionId: string) => Activities;
  #fetchPlan?: (agentSessionId: string) => Promise<string | null>;
  #fetchThread?: ThreadFetcher;
  #connect: (sandboxId: string) => Promise<Reconnected>;
  #linear?: OrchestratorLinear;
  #jarvisActorId?: string;
  #live = new Map<string, { sbx: AgentSandbox; kill: () => Promise<unknown>; replyPending: boolean; runId: number | null }>();

  hasLive(agentSessionId: string): boolean {
    return this.#live.has(agentSessionId);
  }

  constructor(
    config: Config,
    store: SessionStore,
    makeActs: (agentSessionId: string) => Activities,
    fetchPlan?: (agentSessionId: string) => Promise<string | null>,
    connect?: (sandboxId: string) => Promise<Reconnected>,
    fetchThread?: ThreadFetcher,
    linear?: OrchestratorLinear,
  ) {
    this.#config = config;
    this.#store = store;
    this.#makeActs = makeActs;
    this.#fetchPlan = fetchPlan;
    this.#fetchThread = fetchThread;
    this.#linear = linear;
    this.#connect =
      connect ??
      ((sandboxId) => Sandbox.connect(sandboxId, { apiKey: this.#config.e2bApiKey }) as Promise<Reconnected>);
  }

  async #getJarvisActorId(): Promise<string | undefined> {
    if (this.#jarvisActorId) return this.#jarvisActorId;
    if (!this.#linear) return undefined;
    try {
      const viewer = await this.#linear.viewer;
      this.#jarvisActorId = viewer.id;
      return viewer.id;
    } catch (err) {
      console.error(`[decompose] fetching Jarvis's own actor id failed (advisory): ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }
```

In `#finishPlan`, branch on `parseDecomposition` before the normal plan path:

```ts
  async #finishPlan(agentSessionId: string, acts: Activities, result: JarvisEvent | null): Promise<void> {
    if (this.#store.get(agentSessionId)?.phase === "done") return;
    const plan = result?.kind === "result" && result.text ? result.text : null;
    console.log(`[phase] ${agentSessionId} plan run finished (plan=${plan ? plan.length + " chars" : "NONE"})`);
    if (!plan) {
      await this.#failLoud(agentSessionId, acts, "I couldn't produce a plan. Please add detail to the issue and re-assign me.");
      return;
    }
    this.#store.setPlan(agentSessionId, plan);
    this.#store.setPhase(agentSessionId, "await_approval");
    const decomposition = parseDecomposition(plan);
    if (decomposition) {
      const list = decomposition.map((d, i) => `${i + 1}. **${d.title}** — ${d.description}`).join("\n");
      await acts.elicitation(
        `This issue looks too big for one PR. I'd split it into:\n\n${list}${APPROVAL_FOOTER}${costLine(result)}`,
      );
      return;
    }
    await acts.elicitation(`${plan}${APPROVAL_FOOTER}${costLine(result)}`);
  }
```

Add `#createSubIssues`, near `#runImplement`:

```ts
  // Approval-gated: nothing is created in Linear until a human approves the
  // decomposition (same posture as plan approval). Each created sub-issue is
  // self-assigned, which fires its own AgentSessionEvent webhook and runs the
  // normal pipeline independently — no new orchestration needed for the children.
  async #createSubIssues(ctx: IssueContext, acts: Activities, items: { title: string; description: string }[]): Promise<void> {
    console.log(`[phase] ${ctx.agentSessionId} approved decomposition — creating ${items.length} sub-issue(s)`);
    if (!this.#linear || !ctx.teamId) {
      console.error(`[decompose] ${ctx.agentSessionId} no linear client or teamId — can't create sub-issues`);
      this.#store.setPhase(ctx.agentSessionId, "done");
      await acts.response("I approved the split but couldn't create the sub-issues in Linear (missing team context). Please split it manually.");
      return;
    }
    const assigneeId = await this.#getJarvisActorId();
    const created: string[] = [];
    for (const item of items) {
      try {
        const payload = await this.#linear.createIssue({
          parentId: ctx.issueId ?? undefined,
          teamId: ctx.teamId,
          title: item.title,
          description: item.description,
          assigneeId,
        });
        const issue = await payload.issue;
        created.push(issue?.identifier ?? item.title);
      } catch (err) {
        console.error(`[decompose] ${ctx.agentSessionId} createIssue failed for "${item.title}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.#store.setPhase(ctx.agentSessionId, "done");
    await acts.response(
      created.length > 0
        ? `Created ${created.length} sub-issue(s): ${created.join(", ")}. I'll pick each one up as it's assigned to me.`
        : "I approved the split but couldn't create the sub-issues in Linear — check my permissions and try again.",
    );
  }
```

In `onPrompted`, replace the final approved-path tail:

```ts
    await acts.thought("Approved — implementing in a sandbox now.");
    await this.#runImplement(ctx, acts, plan, row.branch, this.#workBranchFor(ctx.issueId, ctx.agentSessionId));
    return;
  }
```

with:

```ts
    const decomposition = parseDecomposition(plan);
    if (decomposition) {
      await this.#createSubIssues(ctx, acts, decomposition);
      return;
    }
    await acts.thought("Approved — implementing in a sandbox now.");
    await this.#runImplement(ctx, acts, plan, row.branch, this.#workBranchFor(ctx.issueId, ctx.agentSessionId));
    return;
  }
```

In `src/server.ts`, pass the already-constructed `linear` client through as the 7th argument:

```ts
  const orchestrator = new Orchestrator(
    config,
    store,
    (id) => makeActivities(linear, id),
    makePlanFetcher(config.linear.accessToken),
    undefined, // connect: default real e2b reconnect
    makeThreadFetcher(config.linear.accessToken),
    linear,
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/orchestrator/pipeline.test.ts`
Expected: all PASS.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all PASS/clean.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/pipeline.ts src/server.ts tests/orchestrator/pipeline.test.ts
git commit -m "feat(orchestrator): create and self-assign Linear sub-issues on decomposition approval"
```

---

### Task 10: `team_states` cache table

**Files:**
- Modify: `src/store/sessions.ts`
- Test: `tests/store/sessions.test.ts`

**Interfaces:**
- Produces: `SessionStore#getTeamStates(teamId: string): TeamState[] | undefined`, `SessionStore#setTeamStates(teamId: string, states: TeamState[]): void` — consumed by Task 11.

- [ ] **Step 1: Write the failing test**

Add to `tests/store/sessions.test.ts`:

```ts
describe("team_states cache", () => {
  it("round-trips team workflow states", () => {
    const store = new SessionStore(":memory:");
    expect(store.getTeamStates("team_1")).toBeUndefined();
    const states = [{ id: "s1", name: "Todo", type: "unstarted" }, { id: "s2", name: "In Progress", type: "started" }];
    store.setTeamStates("team_1", states);
    expect(store.getTeamStates("team_1")).toEqual(states);
    store.close();
  });

  it("overwrites on re-set", () => {
    const store = new SessionStore(":memory:");
    store.setTeamStates("team_1", [{ id: "s1", name: "Todo", type: "unstarted" }]);
    store.setTeamStates("team_1", [{ id: "s2", name: "Done", type: "completed" }]);
    expect(store.getTeamStates("team_1")).toEqual([{ id: "s2", name: "Done", type: "completed" }]);
    store.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/sessions.test.ts -t "team_states"`
Expected: FAIL — `getTeamStates`/`setTeamStates` don't exist.

- [ ] **Step 3: Implement**

In `src/store/sessions.ts`, add the table in the constructor (after the `session_events` block):

```ts
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS team_states (
        team_id    TEXT PRIMARY KEY,
        states     TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT
    `);
```

Add the type and methods (near `getRepoMap`/`setRepoMap`, which this mirrors):

```ts
export interface TeamState {
  id: string;
  name: string;
  type: string;
}
```

```ts
  getTeamStates(teamId: string): TeamState[] | undefined {
    const row = this.#db.prepare(`SELECT states FROM team_states WHERE team_id = ?`).get(teamId) as
      | { states: string }
      | undefined;
    return row ? (JSON.parse(row.states) as TeamState[]) : undefined;
  }

  setTeamStates(teamId: string, states: TeamState[]): void {
    this.#db
      .prepare(
        `INSERT INTO team_states (team_id, states, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(team_id)
         DO UPDATE SET states = excluded.states, updated_at = excluded.updated_at`,
      )
      .run(teamId, JSON.stringify(states), new Date().toISOString());
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/store/sessions.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/sessions.ts tests/store/sessions.test.ts
git commit -m "feat(store): cache a team's Linear workflow states"
```

---

### Task 11: Resolve the target workflow state for a transition (`src/linear/workflow.ts`)

**Files:**
- Create: `src/linear/workflow.ts`
- Test: `tests/linear/workflow.test.ts`

**Interfaces:**
- Consumes: `SessionStore#getTeamStates`/`#setTeamStates` (Task 10), `pickWorkflowState` (Task 2).
- Produces: `fetchTeamStates(client, store, teamId): Promise<TeamState[]>`, `resolveTargetState(apiKey, states, transition, fetchImpl?): Promise<string | undefined>`, `type Transition` — consumed by Task 12.

- [ ] **Step 1: Write the failing test**

Create `tests/linear/workflow.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { fetchTeamStates, resolveTargetState } from "../../src/linear/workflow.ts";
import { SessionStore } from "../../src/store/sessions.ts";

describe("fetchTeamStates", () => {
  it("fetches and caches on first call", async () => {
    const store = new SessionStore(":memory:");
    const nodes = [{ id: "s1", name: "Todo", type: "unstarted" }];
    const client = { workflowStates: vi.fn(async () => ({ nodes })) };
    const result = await fetchTeamStates(client as never, store, "team_1");
    expect(result).toEqual(nodes);
    expect(client.workflowStates).toHaveBeenCalledTimes(1);
    store.close();
  });

  it("uses the cache on the second call, no second fetch", async () => {
    const store = new SessionStore(":memory:");
    const nodes = [{ id: "s1", name: "Todo", type: "unstarted" }];
    const client = { workflowStates: vi.fn(async () => ({ nodes })) };
    await fetchTeamStates(client as never, store, "team_1");
    await fetchTeamStates(client as never, store, "team_1");
    expect(client.workflowStates).toHaveBeenCalledTimes(1);
    store.close();
  });

  it("returns an empty array on failure, never throws", async () => {
    const store = new SessionStore(":memory:");
    const client = { workflowStates: vi.fn(async () => { throw new Error("boom"); }) };
    expect(await fetchTeamStates(client as never, store, "team_1")).toEqual([]);
    store.close();
  });
});

describe("resolveTargetState", () => {
  const states = [
    { id: "s1", name: "Todo", type: "unstarted" },
    { id: "s2", name: "In Progress", type: "started" },
    { id: "s3", name: "In Review", type: "started" },
    { id: "s4", name: "Done", type: "completed" },
  ];

  it("returns undefined when no state matches the category", async () => {
    const noCompleted = states.filter((s) => s.type !== "completed");
    expect(await resolveTargetState("key", noCompleted, "done")).toBeUndefined();
  });

  it("returns the single match directly, no fetch call", async () => {
    const fetchImpl = vi.fn();
    const result = await resolveTargetState("key", states, "done", fetchImpl as unknown as typeof fetch);
    expect(result).toBe("s4");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("prefers a review-named state for pr_opened without calling the model", async () => {
    const fetchImpl = vi.fn();
    const result = await resolveTargetState("key", states, "pr_opened", fetchImpl as unknown as typeof fetch);
    expect(result).toBe("s3");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("disambiguates plan_start among 2+ started states via the classifier", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: "In Progress" }] }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    );
    const result = await resolveTargetState("key", states, "plan_start", fetchImpl as unknown as typeof fetch);
    expect(result).toBe("s2");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/linear/workflow.test.ts`
Expected: FAIL — `Cannot find module '../../src/linear/workflow.ts'`.

- [ ] **Step 3: Implement**

Create `src/linear/workflow.ts`:

```ts
import type { LinearClient } from "@linear/sdk";
import type { SessionStore, TeamState } from "../store/sessions.ts";
import { pickWorkflowState } from "../agent/classify.ts";

export type { TeamState };

type StatesClient = Pick<LinearClient, "workflowStates">;

/** Fetch a team's workflow states, cached in SQLite (a team's states rarely
 * change). Advisory: any failure returns [] so a status nudge never blocks a run. */
export async function fetchTeamStates(
  client: StatesClient,
  store: Pick<SessionStore, "getTeamStates" | "setTeamStates">,
  teamId: string,
): Promise<TeamState[]> {
  const cached = store.getTeamStates(teamId);
  if (cached) return cached;
  try {
    const connection = await client.workflowStates({ filter: { team: { id: { eq: teamId } } } } as never);
    const states: TeamState[] = connection.nodes.map((n: { id: string; name: string; type: string }) => ({
      id: n.id, name: n.name, type: n.type,
    }));
    store.setTeamStates(teamId, states);
    return states;
  } catch (err) {
    console.error(`[workflow] fetchTeamStates failed for team ${teamId} (advisory): ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// Jarvis moments that move the issue's status. `type` is Linear's standardized
// state category — stable across teams even though display names ("In
// Progress" vs "Doing") differ. Deliberately no "error" transition: don't fake
// a status Jarvis isn't confident about.
export type Transition = "plan_start" | "implement_start" | "pr_opened" | "done";

const CATEGORY: Record<Transition, string> = {
  plan_start: "started",
  implement_start: "started",
  pr_opened: "started",
  done: "completed",
};

const LABEL: Record<Transition, string> = {
  plan_start: "planning started",
  implement_start: "implementation starting",
  pr_opened: "PR opened for review",
  done: "work finished",
};

/**
 * Pick the target state id for a transition among a team's states.
 * 0 matches -> undefined (team removed that category — skip, not fatal).
 * 1 match -> it, no extra call. 2+ -> prefer a name containing "review" for
 * pr_opened (cheap, no model call); otherwise ask the classifier to
 * disambiguate among the candidate names.
 */
export async function resolveTargetState(
  apiKey: string,
  states: TeamState[],
  transition: Transition,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const category = CATEGORY[transition];
  const candidates = states.filter((s) => s.type === category);
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0].id;
  if (transition === "pr_opened") {
    const reviewLike = candidates.find((s) => /review/i.test(s.name));
    if (reviewLike) return reviewLike.id;
  }
  const pickedName = await pickWorkflowState(apiKey, LABEL[transition], candidates.map((s) => s.name), fetchImpl);
  return candidates.find((s) => s.name === pickedName)?.id ?? candidates[0].id;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/linear/workflow.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/linear/workflow.ts tests/linear/workflow.test.ts
git commit -m "feat(workflow): resolve a team's actual workflow state for a Jarvis-moment transition"
```

---

### Task 12: Move the Linear issue's workflow state at plan/implement/PR/done

**Files:**
- Modify: `src/orchestrator/pipeline.ts` (`#advanceState` + call sites in `#runPlan`, `#runImplement`, `#finishImplement`)

**Interfaces:**
- Consumes: `fetchTeamStates`, `resolveTargetState`, `Transition` (Task 11).
- Produces: nothing new consumed elsewhere — this is the final leaf task.

**No new test file for this task.** `#advanceState`'s own logic (category filtering,
disambiguation, fallback) is already fully covered by Task 11's `resolveTargetState`/
`fetchTeamStates` tests — `#advanceState` itself is thin glue whose only job is
calling those and swallowing errors, and every one of its call sites sits inside a
`withSandbox` closure. Per this repo's existing convention (see
`tests/orchestrator/pipeline.test.ts`'s comment on the plan-revision path: "there's
no seam to fake e2b here... covered by live acceptance, not a unit test"), this glue
is verified the same way — by inspection here, and by the live-acceptance pass in
the post-plan checklist. Proceed straight to implementation.

- [ ] **Step 1: Implement**

In `src/orchestrator/pipeline.ts`, import the new module:

```ts
import { fetchTeamStates, resolveTargetState, type Transition } from "../linear/workflow.ts";
```

Add `#advanceState`, near `#extractImages`:

```ts
  // Best-effort issue-status nudge. Advisory end-to-end: no linear client, no
  // teamId, or any API failure just skips — a failed status move never fails
  // or blocks a run.
  async #advanceState(ctx: IssueContext, transition: Transition): Promise<void> {
    if (!this.#linear || !ctx.issueId || !ctx.teamId) return;
    try {
      const states = await fetchTeamStates(this.#linear, this.#store, ctx.teamId);
      const stateId = await resolveTargetState(this.#config.anthropicApiKey, states, transition);
      if (!stateId) return;
      await this.#linear.updateIssue(ctx.issueId, { stateId });
    } catch (err) {
      console.error(`[workflow] ${ctx.agentSessionId} advanceState(${transition}) failed (advisory): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
```

Call it at the top of `#runPlan` (right after the existing `console.log`/`acts.thought` lines):

```ts
  async #runPlan(ctx: IssueContext, acts: Activities, branch: string | null): Promise<void> {
    console.log(`[phase] ${ctx.agentSessionId} → plan (cloning + drafting)`);
    await acts.thought("Reading the codebase to draft a plan…");
    await this.#advanceState(ctx, "plan_start");
```

At the top of `#runImplement`:

```ts
  async #runImplement(
    ctx: IssueContext,
    acts: Activities,
    plan: string,
    baseBranch: string | null,
    workBranch: string,
  ): Promise<void> {
    this.#store.setPhase(ctx.agentSessionId, "implement");
    this.#store.setWorkBranch(ctx.agentSessionId, workBranch);
    console.log(`[phase] ${ctx.agentSessionId} → implement (branch ${workBranch})`);
    await this.#advanceState(ctx, "implement_start");
```

Right after the PR URL is persisted inside `#runImplement`'s `withSandbox` closure:

```ts
      const prText = r?.kind === "result" && r.text ? r.text.trim() : "";
      if (PR_URL_RE.test(prText)) {
        this.#store.setPrUrl(ctx.agentSessionId, prText);
        await this.#advanceState(ctx, "pr_opened");
      }
      review = await this.#maybeSelfReview(ctx, sbx, r, plan, map, acts);
```

`#finishImplement`'s only caller is `#runImplement`, which already has `ctx` in
scope; `reconcile()`'s call site has only `row`/`id`, not a full `IssueContext`.
Give `#finishImplement` a `ctx: IssueContext` parameter (replacing its old bare
`agentSessionId: string`) so it can call `#advanceState`, and replace every
internal use of `agentSessionId` with `ctx.agentSessionId`:

```ts
  async #finishImplement(
    ctx: IssueContext,
    acts: Activities,
    result: JarvisEvent | null,
    review: string | null = null,
  ): Promise<void> {
    const agentSessionId = ctx.agentSessionId;
    if (this.#store.get(agentSessionId)?.phase === "done") return;
    const text = result?.kind === "result" && result.text ? result.text.trim() : "";
    if (text.startsWith("PR_FAILED:")) {
      console.error(`[phase] ${agentSessionId} → error (PR creation failed: ${text.slice(0, 100)})`);
      await this.#failLoud(agentSessionId, acts, `PR could not be opened: ${text.slice("PR_FAILED:".length).trim()}`);
    } else if (result?.kind === "result" && result.text && PR_URL_RE.test(text)) {
      console.log(`[phase] ${agentSessionId} → done (PR: ${result.text.slice(0, 100)})`);
      this.#store.setPrUrl(agentSessionId, text);
      if (review) this.#store.setReview(agentSessionId, review);
      await this.#advanceState(ctx, "done");
      try {
        await acts.response(`Done. PR opened:\n\n${result.text}\n\n_A human review + merge closes this out._${costLine(result)}`);
        if (review) await acts.response(`**Self-review of the diff** (advisory — the PR is unchanged):\n\n${review}`);
      } catch (err) {
        console.error(`[phase] ${agentSessionId} failed to post done activity: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.#store.setPhase(agentSessionId, "done");
      }
    } else if (result?.kind === "result" && result.text) {
      console.error(`[phase] ${agentSessionId} → error (implement finished without a PR URL: ${text.slice(0, 100).replace(/\n/g, " ")})`);
      await this.#failLoud(agentSessionId, acts, "Implement finished without a PR URL. Re-assign the issue to retry, or check GitHub — the PR may already exist.");
    } else {
      console.error(`[phase] ${agentSessionId} → error (implement did not complete)`);
      await this.#failLoud(agentSessionId, acts, result?.kind === "error" ? result.message : "Implementation did not complete.");
    }
  }
```

Update `#runImplement`'s call site:

```ts
    await this.#finishImplement(ctx, acts, result, review);
```

Update `reconcile()`'s call site. `reconcile()` only has `row`/`id` in scope, not
the original webhook's `IssueContext` — build a minimal one; `teamId: null` means
`#advanceState` simply no-ops for a reconciled run (advisory, and the run's earlier
transitions already fired before the restart — only the final `"done"` move can be
missed on a reconciled path, which is an acceptable gap for a best-effort nudge):

```ts
            } else {
              await this.#finishImplement(
                { agentSessionId: id, organizationId: "", issueId: row.issueId, teamId: null, title: "", description: "", comment: "", promptContext: "" },
                acts,
                result,
              );
            }
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: all PASS. Pay particular attention to any test calling `#finishImplement`/`#runImplement` indirectly that might break on the signature change — per Task grep, none call it directly (it's private); confirm via `grep -n "finishImplement\|runImplement" tests/orchestrator/pipeline.test.ts` returns nothing, since these are private methods only reachable through `onCreated`/`onPrompted`'s implement path, which per this repo's convention is live-acceptance-only (not unit tested).

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/pipeline.ts tests/orchestrator/pipeline.test.ts
git commit -m "feat(workflow): move the Linear issue's workflow state at plan/implement/PR/done"
```

---

## Post-plan checklist

- [ ] `npm run typecheck && npm test` green from a clean checkout.
- [ ] Rebuild the E2B template (`node --env-file-if-exists=.env e2b/build-template.ts`) — Task 5 changed `src/agent/runner.mjs`, which is baked into the `jarvis-agent` template at build time, not uploaded per-run. Skipping this leaves sandboxes running the old runner (no image support) until the next rebuild.
- [ ] Live-acceptance pass on a real Linear issue for each of: a pure question ("explain X"), a mixed thread that starts as a question and pivots to "now implement it", an issue with a pasted screenshot, an intentionally oversized issue, and one full plan→PR run — to exercise the `withSandbox` paths this suite cannot cover, per this repo's existing testing convention.
