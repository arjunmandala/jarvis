# Fluid Conversational Planning Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the regex approval gate with a single conversational agent that decides, per reply, whether to answer, search the web, read the repo, revise the plan, or start implementing — with no keyword matching.

**Architecture:** One conversational persona runs each pre-implementation reply as a turn in one of two tiers it self-selects: **Tier 0** runs the Agent SDK in-process on the host with a web-only toolset (no sandbox) for replies that only reason or websearch; **Tier 1** clones the repo into an E2B sandbox with the full toolset when the agent needs the code or is implementing. The agent signals its decision with a leading `ACTION:` tag in its final message (same convention as the existing `Type:`/`Decomposition:`/`PR_FAILED:` prefixes). Continuity comes from the Linear thread (canonical memory, already assembled by `prepareHistory`); `sdkSessionId` is captured for a future cross-turn-resume (option C) but is not relied on for memory now.

**Tech Stack:** TypeScript (nodenext, `.ts` import extensions), `@anthropic-ai/claude-agent-sdk` (`query`), `node:sqlite`, `node:test`-style vitest suite, E2B sandboxes (faked in tests via the structural `AgentSandbox` interface).

## Global Constraints

- Node.js ≥ 24.15.0.
- `.ts` sources import each other with explicit `.ts` extensions.
- `systemAppend` strings are **fixed, byte-stable text** — never interpolate per-run content into them (Agent SDK prompt-cache byte-stability). Per-run content goes in `goal`.
- Every orchestrator path both logs **and** posts a Linear activity — a webhook handler that emits nothing trips Linear's 10s unresponsive rule.
- Tests fake E2B via the structural `AgentSandbox` interface — no real e2b/network calls in the suite.
- **Trust boundary (do not simplify away):** a Tier 0 host turn runs the SDK *on the host*, so its toolset must never include `Bash`/`Edit`/`Write` or any repo/file/exec tool. Enforced two ways: an explicit allowlist AND a `canUseTool` callback that denies anything off it.
- **Human gate that stays:** Jarvis opens PRs and never merges. `parseStop` stays deterministic. Only `parseApproval` is removed.
- Mark deliberate simplifications with a `// ponytail:` comment naming the ceiling and upgrade path.

---

## File Structure

- `src/store/sessions.ts` — add `sdkSessionId` column + `setSdkSessionId`, extend `SessionRow`.
- `src/agent/converse.ts` — **new**: `parseConverseAction()` (pure parser) + the `CONVERSE_APPEND` protocol constant + `converseTask()` (Tier 1 builder).
- `src/agent/host-turn.ts` — **new**: `runHostTurn()`, the in-process Tier 0 SDK call with the injectable `queryFn` seam and the tool-deny gate.
- `src/orchestrator/pipeline.ts` — replace the `clarify`/`await_approval` machinery with `#runConverseTurn` (the two-tier driver) and rewire `onCreated`/`onPrompted`.
- `src/linear/context.ts` — delete `parseApproval` + its constants (keep `parseStop`).
- Tests alongside: `tests/agent/converse.test.ts`, `tests/agent/host-turn.test.ts`, `tests/store/sessions.test.ts` (extend), `tests/orchestrator/pipeline.test.ts` (extend).

---

### Task 1: Persist `sdkSessionId` on sessions

**Files:**
- Modify: `src/store/sessions.ts` (SessionRow ~19-30; migrations ~76-94; setters ~343-371; `get`/`listByPhase`/`findResumableByIssue`/`listByIssue` SELECT lists)
- Test: `tests/store/sessions.test.ts`

**Interfaces:**
- Produces: `SessionStore.setSdkSessionId(agentSessionId: string, sdkSessionId: string): void`; `SessionRow.sdkSessionId: string | null`.

- [ ] **Step 1: Write the failing test**

Add to `tests/store/sessions.test.ts`:

```ts
import { test, expect } from "vitest";
import { SessionStore } from "../../src/store/sessions.ts";

test("sdkSessionId round-trips and defaults to null", () => {
  const store = new SessionStore(":memory:");
  store.upsert("s1", "clarify", "issue-1");
  expect(store.get("s1")?.sdkSessionId).toBe(null);
  store.setSdkSessionId("s1", "sdk-abc");
  expect(store.get("s1")?.sdkSessionId).toBe("sdk-abc");
  store.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/sessions.test.ts -t "sdkSessionId round-trips"`
Expected: FAIL — `setSdkSessionId is not a function` (or `sdkSessionId` is `undefined`).

- [ ] **Step 3: Add the column, migration, setter, and SELECT wiring**

In the `sessions` migration block (after the `work_branch` guard, ~line 94):

```ts
    if (!cols.some((c) => c.name === "sdk_session_id")) {
      this.#db.exec(`ALTER TABLE sessions ADD COLUMN sdk_session_id TEXT`);
    }
```

Add `sdkSessionId: string | null;` to the `SessionRow` interface (after `review`, ~line 28).

Add the setter (next to `setWorkBranch`, ~line 371):

```ts
  // Forward seam for cross-turn SDK transcript resume (option C). Captured from
  // each turn's result; not yet used for memory — the Linear thread is canonical.
  // ponytail: stored, not resumed. Upgrade path: ship the SDK transcript off-box
  // and pass `resume` in the next turn's options.
  setSdkSessionId(agentSessionId: string, sdkSessionId: string): void {
    this.#db
      .prepare(`UPDATE sessions SET sdk_session_id = ?, updated_at = ? WHERE agent_session_id = ?`)
      .run(sdkSessionId, new Date().toISOString(), agentSessionId);
  }
```

Add `sdk_session_id` to the SELECT column list and the row-shape type + mapped object in **all four** read methods: `get` (~376/393), `listByPhase` (~411/425), `findResumableByIssue` (~445/459), `listByIssue` (~473/481). In each SELECT add `sdk_session_id` to the column list; in each row type add `sdk_session_id: string | null;`; in each mapped object add `sdkSessionId: row.sdk_session_id,`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/store/sessions.test.ts -t "sdkSessionId round-trips"`
Expected: PASS.

- [ ] **Step 5: Run the full store suite + typecheck**

Run: `npx vitest run tests/store/sessions.test.ts && npm run typecheck`
Expected: PASS (typecheck catches any missed row-mapping site).

- [ ] **Step 6: Commit**

```bash
git add src/store/sessions.ts tests/store/sessions.test.ts
git commit -m "feat(store): persist sdkSessionId column (forward seam for resume)"
```

---

### Task 2: The `ACTION:` protocol — parser + system prompt

**Files:**
- Create: `src/agent/converse.ts`
- Test: `tests/agent/converse.test.ts`

**Interfaces:**
- Produces:
  - `type ConverseAction = "reply" | "need_repo" | "plan" | "implement" | "stop";`
  - `parseConverseAction(text: string): { action: ConverseAction; body: string }` — reads a leading `ACTION: <verb>` line (case-insensitive verb), returns the rest as `body`. Missing/garbled tag → `{ action: "reply", body: text.trim() }` (safe default: just post it).
  - `CONVERSE_APPEND: string` — the fixed protocol system-prompt text.

- [ ] **Step 1: Write the failing test**

Create `tests/agent/converse.test.ts`:

```ts
import { test, expect } from "vitest";
import { parseConverseAction } from "../../src/agent/converse.ts";

test("parses a leading ACTION tag and returns the body", () => {
  const r = parseConverseAction("ACTION: implement\nGo ahead and build it.");
  expect(r.action).toBe("implement");
  expect(r.body).toBe("Go ahead and build it.");
});

test("verb is case-insensitive and trimmed", () => {
  expect(parseConverseAction("ACTION:   Need_Repo  \nlet me look").action).toBe("need_repo");
});

test("missing tag defaults to reply with the whole text as body", () => {
  const r = parseConverseAction("Postgres, because the issue mentions JSONB.");
  expect(r.action).toBe("reply");
  expect(r.body).toBe("Postgres, because the issue mentions JSONB.");
});

test("unknown verb defaults to reply and keeps the full text", () => {
  const r = parseConverseAction("ACTION: ponder\nhmm");
  expect(r.action).toBe("reply");
  expect(r.body).toBe("ACTION: ponder\nhmm");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/converse.test.ts`
Expected: FAIL — cannot find module `converse.ts`.

- [ ] **Step 3: Write `converse.ts` (parser + protocol constant only)**

```ts
import type { IssueContext } from "../linear/context.ts";
import { REPO_DIR } from "../sandbox/session.ts";
import type { AgentTask } from "./tasks.ts";

export type ConverseAction = "reply" | "need_repo" | "plan" | "implement" | "stop";
const VERBS = new Set<ConverseAction>(["reply", "need_repo", "plan", "implement", "stop"]);

// The agent's final message starts with `ACTION: <verb>` on its own line; the
// rest is the body (the reply to post, or the plan text). Mirrors the repo's
// existing final-message-prefix routing (parseDecomposition, PR_URL_RE). A
// missing or unknown verb is a safe "reply" — we just post the text verbatim.
// ponytail: prefix parse, not a classifier. Ceiling: the agent forgets the tag
// on an implement/need_repo turn and it reads as a plain reply — surfaced to the
// human, who simply nudges again. Upgrade path: an SDK tool the agent must call.
export function parseConverseAction(text: string): { action: ConverseAction; body: string } {
  const m = /^\s*ACTION:\s*([A-Za-z_]+)\s*(?:\n|$)/.exec(text);
  const verb = m?.[1]?.toLowerCase() as ConverseAction | undefined;
  if (m && verb && VERBS.has(verb)) {
    return { action: verb, body: text.slice(m[0].length).trim() };
  }
  return { action: "reply", body: text.trim() };
}

// Fixed, byte-stable protocol text appended to the converse system prompt.
export const CONVERSE_APPEND =
  "\n\nYou are Jarvis, a senior engineer talking through a Linear ticket with a human before any code is " +
  "written. Hold the conversation like a colleague: answer what they actually asked, push back when " +
  "you disagree, ask a follow-up when something is genuinely ambiguous. Do not force every message into a " +
  "plan.\n\n" +
  "PROTOCOL: your FINAL message MUST begin with one line, exactly `ACTION: <verb>`, where <verb> is one of:\n" +
  "- `reply` — you answered from context or the web / asked a follow-up. The rest of your message is posted " +
  "to the human verbatim.\n" +
  "- `need_repo` — you cannot answer or plan without reading the actual code. The rest is a short note to the " +
  "human ('let me pull up the code'); you will be re-run with full repo access.\n" +
  "- `plan` — the rest of your message is a complete implementation plan (start it with the `Type:`/`Scope:` " +
  "lines). Post it and keep talking; do NOT treat it as approved.\n" +
  "- `implement` — the human has clearly agreed to a plan you already posted. The rest is a one-line " +
  "acknowledgement. Only use this when they actually said go; if you are unsure, use `reply` and ask.\n" +
  "- `stop` — the human asked to stop. The rest is a brief sign-off.\n\n" +
  "Never emit `implement` unless a plan has already been posted in this conversation and the human agreed to it.";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent/converse.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/converse.ts tests/agent/converse.test.ts
git commit -m "feat(agent): ACTION protocol parser + converse system prompt"
```

---

### Task 3: `converseTask()` — the Tier 1 (sandbox) builder

**Files:**
- Modify: `src/agent/converse.ts` (add `converseTask`)
- Modify: `src/agent/tasks.ts` (export `issueBlock`, `repoMapBlock`, `historyBlock`, `ALL_REPO_TOOLS`, `TOOLING_APPEND` for reuse)
- Test: `tests/agent/converse.test.ts` (extend)

**Interfaces:**
- Consumes: `ALL_REPO_TOOLS`, `TOOLING_APPEND`, `issueBlock`, `repoMapBlock`, `historyBlock` from `tasks.ts`; `CONVERSE_APPEND` from `converse.ts`.
- Produces: `converseTask(ctx: IssueContext, userMessage: string, repoMap?: string, history?: string, images?: AgentTask["images"]): AgentTask`.

- [ ] **Step 1: Export the shared builders from `tasks.ts`**

In `src/agent/tasks.ts`, add `export` to the four helpers and the two constants so `converse.ts` reuses them verbatim (no duplication): `export const ALL_REPO_TOOLS`, `export const TOOLING_APPEND`, `export function issueBlock`, `export function repoMapBlock`, `export function historyBlock`.

- [ ] **Step 2: Write the failing test**

Add to `tests/agent/converse.test.ts`:

```ts
import { converseTask } from "../../src/agent/converse.ts";
import type { IssueContext } from "../../src/linear/context.ts";

const ctx: IssueContext = {
  agentSessionId: "s1", organizationId: "o", issueId: "i", teamId: "t",
  title: "Add rate limiter", description: "limit to 100/min", comment: "", promptContext: "",
};

test("converseTask carries full repo tools and the user message in the goal", () => {
  const t = converseTask(ctx, "why token bucket?");
  expect(t.allowedTools).toContain("Bash");
  expect(t.allowedTools).toContain("mcp__serena");
  expect(t.goal).toContain("why token bucket?");
  expect(t.systemAppend).toContain("ACTION:");
  expect(t.cwd).toBe("/home/user/repo");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/agent/converse.test.ts -t "converseTask carries"`
Expected: FAIL — `converseTask is not a function`.

- [ ] **Step 4: Implement `converseTask` in `converse.ts`**

Add the imports at the top of `converse.ts`:

```ts
import { ALL_REPO_TOOLS, TOOLING_APPEND, issueBlock, repoMapBlock, historyBlock } from "./tasks.ts";
```

Append:

```ts
const CONVERSE_SYSTEM = CONVERSE_APPEND + TOOLING_APPEND;

// Tier 1: runs in the sandbox with the full repo toolset. Used when a host turn
// emitted `need_repo`, or directly for the very first turn on a change request.
export function converseTask(
  ctx: IssueContext,
  userMessage: string,
  repoMap?: string,
  history?: string,
  images?: AgentTask["images"],
): AgentTask {
  return {
    goal:
      `The human's latest message:\n${userMessage}\n\n` +
      `Respond per the PROTOCOL. Read the repo as needed to answer, plan, or decide.\n\n` +
      `---\n${issueBlock(ctx)}${repoMapBlock(repoMap)}${historyBlock(history)}`,
    cwd: REPO_DIR,
    model: "claude-sonnet-5",
    systemAppend: CONVERSE_SYSTEM,
    allowedTools: ALL_REPO_TOOLS,
    maxTurns: 30,
    maxBudgetUsd: 2,
    effort: "medium",
    images,
  };
}
```

- [ ] **Step 5: Run test + typecheck**

Run: `npx vitest run tests/agent/converse.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/converse.ts src/agent/tasks.ts tests/agent/converse.test.ts
git commit -m "feat(agent): converseTask (Tier 1 sandbox builder)"
```

---

### Task 4: `runHostTurn()` — the Tier 0 in-process host turn

**Files:**
- Create: `src/agent/host-turn.ts`
- Test: `tests/agent/host-turn.test.ts`

**Interfaces:**
- Produces:
  - `interface HostTurnResult { text: string; action: ConverseAction; body: string; sessionId: string | null; costUsd: number | null; }`
  - `runHostTurn(opts: { apiKey: string; ctx: IssueContext; userMessage: string; history?: string; queryFn?: QueryFn }): Promise<HostTurnResult>`
  - `queryFn` defaults to the real SDK `query`; tests inject a fake. Signature: `(args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<SdkMessage>`.
- Consumes: `parseConverseAction`, `CONVERSE_APPEND` (Task 2); `issueBlock`, `historyBlock` (Task 3).

- [ ] **Step 1: Write the failing test**

Create `tests/agent/host-turn.test.ts`:

```ts
import { test, expect } from "vitest";
import { runHostTurn } from "../../src/agent/host-turn.ts";
import type { IssueContext } from "../../src/linear/context.ts";

const ctx: IssueContext = {
  agentSessionId: "s1", organizationId: "o", issueId: "i", teamId: "t",
  title: "T", description: "D", comment: "", promptContext: "",
};

// Fake SDK: yields one assistant text block then a result message.
function fakeQuery(finalText: string, sessionId = "sdk-1") {
  return async function* () {
    yield { type: "assistant", message: { content: [{ type: "text", text: finalText }] } };
    yield { type: "result", subtype: "success", result: finalText, total_cost_usd: 0.002, session_id: sessionId };
  };
}

test("collects the final text and parses the action", async () => {
  const r = await runHostTurn({
    apiKey: "k", ctx, userMessage: "why?",
    queryFn: () => fakeQuery("ACTION: reply\nBecause X.")(),
  });
  expect(r.action).toBe("reply");
  expect(r.body).toBe("Because X.");
  expect(r.sessionId).toBe("sdk-1");
  expect(r.costUsd).toBe(0.002);
});

test("passes a web-only allowlist and a deny-all-else canUseTool", async () => {
  let captured: any;
  await runHostTurn({
    apiKey: "k", ctx, userMessage: "hi",
    queryFn: (args) => { captured = args; return fakeQuery("ACTION: reply\nhi")(); },
  });
  expect(captured.options.allowedTools).toEqual(["WebSearch", "WebFetch"]);
  expect(captured.options.permissionMode).not.toBe("bypassPermissions");
  // The gate denies a repo/exec tool.
  const decision = await captured.options.canUseTool("Bash", { command: "rm -rf /" });
  expect(decision.behavior).toBe("deny");
  const ok = await captured.options.canUseTool("WebSearch", { query: "x" });
  expect(ok.behavior).toBe("allow");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/host-turn.test.ts`
Expected: FAIL — cannot find module `host-turn.ts`.

- [ ] **Step 3: Implement `host-turn.ts`**

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { IssueContext } from "../linear/context.ts";
import { issueBlock, historyBlock } from "./tasks.ts";
import { CONVERSE_APPEND, parseConverseAction, type ConverseAction } from "./converse.ts";

// The only tools a host turn may use: web lookups. NEVER add Bash/Edit/Write —
// this SDK call runs on the host, not in the sandbox, so a repo/exec tool would
// execute against the host filesystem. Enforced by BOTH the allowlist and the
// canUseTool deny gate below (defense in depth).
const HOST_TOOLS = ["WebSearch", "WebFetch"];
const HOST_TOOLS_SET = new Set(HOST_TOOLS);

export interface HostTurnResult {
  text: string;
  action: ConverseAction;
  body: string;
  sessionId: string | null;
  costUsd: number | null;
}

type SdkMessage = {
  type: string;
  subtype?: string;
  result?: string | null;
  total_cost_usd?: number | null;
  session_id?: string | null;
  message?: { content?: { type: string; text?: string }[] };
};
type QueryFn = (args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<SdkMessage>;

// Tier 0: run one conversational turn in-process on the host with no sandbox and
// a web-only toolset. Returns the parsed ACTION. If the agent needs the repo it
// returns action="need_repo" and the caller escalates to a Tier 1 sandbox turn.
export async function runHostTurn(opts: {
  apiKey: string;
  ctx: IssueContext;
  userMessage: string;
  history?: string;
  queryFn?: QueryFn;
}): Promise<HostTurnResult> {
  const run = opts.queryFn ?? (query as unknown as QueryFn);
  const prompt =
    `The human's latest message:\n${opts.userMessage}\n\n` +
    `Respond per the PROTOCOL. You do NOT have repo access in this turn — if you must read the code to ` +
    `answer or plan, emit ACTION: need_repo.\n\n---\n${issueBlock(opts.ctx)}${historyBlock(opts.history)}`;

  process.env.ANTHROPIC_API_KEY = opts.apiKey; // SDK reads it from env, same as the sandbox runner

  let finalText = "";
  let sessionId: string | null = null;
  let costUsd: number | null = null;

  for await (const message of run({
    prompt,
    options: {
      model: "claude-sonnet-5",
      systemPrompt: { type: "preset", preset: "claude_code", append: CONVERSE_APPEND, excludeDynamicSections: true },
      allowedTools: HOST_TOOLS,
      permissionMode: "default",
      canUseTool: async (name: string) =>
        HOST_TOOLS_SET.has(name) ? { behavior: "allow" as const } : { behavior: "deny" as const },
      maxTurns: 8,
      maxBudgetUsd: 0.5,
      effort: "medium",
    },
  })) {
    if (message.type === "assistant") {
      for (const block of message.message?.content ?? []) {
        if (block.type === "text" && block.text) finalText = block.text;
      }
    } else if (message.type === "result") {
      if (message.subtype === "success" && typeof message.result === "string") finalText = message.result;
      costUsd = message.total_cost_usd ?? null;
      sessionId = message.session_id ?? null;
    }
  }

  const { action, body } = parseConverseAction(finalText);
  return { text: finalText, action, body, sessionId, costUsd };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent/host-turn.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (If the SDK's `query` type rejects the `as unknown as QueryFn` cast, keep the cast — the runtime call shape matches; the cast is the seam that lets tests inject a fake.)

- [ ] **Step 6: Commit**

```bash
git add src/agent/host-turn.ts tests/agent/host-turn.test.ts
git commit -m "feat(agent): runHostTurn — in-process Tier 0 turn with tool-deny gate"
```

---

### Task 5: Orchestrator — `#runConverseTurn` two-tier driver + wire `onCreated`

**Files:**
- Modify: `src/orchestrator/pipeline.ts` (imports ~1-16; `onCreated` ~421-428; add `#runConverseTurn`)
- Test: `tests/orchestrator/pipeline.test.ts`

**Interfaces:**
- Consumes: `runHostTurn`/`HostTurnResult` (Task 4), `converseTask` (Task 3), `parseConverseAction` (Task 2), existing `#runImplement`, `#trackedRun`, `prepareHistory`, `withSandbox`, `cloneRepo`.
- Produces: `Orchestrator.#runConverseTurn(ctx: IssueContext, acts: Activities, userMessage: string): Promise<void>` — runs Tier 0, escalates to Tier 1 on `need_repo`, then dispatches on the final action.

**Design of `#runConverseTurn` dispatch (both tiers converge here):**
- `reply` → `acts.response(body)`; phase stays `clarify`.
- `plan` → `store.setPlan(body)`; `acts.response(body)`; phase stays `clarify` (b2 — no approval gate; posting the plan is just a message, the agent decides later to implement).
- `implement` → **guard**: only if `store.get(...).plan` is non-empty (a plan was posted). If so → `acts.thought(body)` then `#runImplement(...)`. If not → `acts.response("I don't have an agreed plan yet — let me lay one out first.")` and stay in `clarify`.
- `stop` → handled by the deterministic `parseStop` pre-check in the callers, not here.
- `need_repo` (Tier 0 only) → escalate to Tier 1; never returned to the caller as a final action.

- [ ] **Step 1: Write the failing test (Tier 0 reply needs no sandbox)**

Add to `tests/orchestrator/pipeline.test.ts` (follow the file's existing harness for constructing an `Orchestrator` with fakes; inject the host-turn via the same seam the test file already uses for tasks — see Step 3 for the injection point):

```ts
test("onCreated: a question is answered by a host turn with no sandbox", async () => {
  const { orch, acts, store, sandboxCreations } = makeOrch({
    hostTurn: async () => ({ text: "ACTION: reply\nBecause JSONB.", action: "reply", body: "Because JSONB.", sessionId: "sdk-1", costUsd: 0.001 }),
  });
  await orch.onCreated(ctxFor("s1", "i1", "Why Postgres?"));
  expect(acts.responses).toContain("Because JSONB.");
  expect(sandboxCreations).toBe(0);            // Tier 0: no sandbox
  expect(store.get("s1")?.phase).toBe("clarify");
  expect(store.get("s1")?.sdkSessionId).toBe("sdk-1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/orchestrator/pipeline.test.ts -t "answered by a host turn"`
Expected: FAIL — `onCreated` still calls `classifyIntent`/`#runChat` (spins a sandbox), so `sandboxCreations` is 1 and there's no `sdkSessionId`.

- [ ] **Step 3: Add the injectable host-turn seam + imports**

At the top of `pipeline.ts`, replace the `chatTask`/`classifyIntent` imports with converse imports:

```ts
import { planTask, implementTask, mapTask, reviseTask, reviewTask } from "../agent/tasks.ts";
import { converseTask, parseConverseAction } from "../agent/converse.ts";
import { runHostTurn as defaultRunHostTurn, type HostTurnResult } from "../agent/host-turn.ts";
```

(Keep `classifyPrRevision` if the done-follow-up split still uses it — that path is out of scope here. Remove `classifyIntent` and `chatTask` only if nothing else references them; run `npm run typecheck` to confirm before deleting `chatTask`/`#runChat`/`#finishChat`/`#onClarifyPrompted` in Task 7.)

Add a constructor-injectable field so tests fake the host turn (mirror how the store/linear fakes are already injected in this file's constructor — add an optional dep):

```ts
  #runHostTurn: typeof defaultRunHostTurn;
  // in the constructor options/assignment, alongside the other injected deps:
  //   this.#runHostTurn = deps.runHostTurn ?? defaultRunHostTurn;
```

- [ ] **Step 4: Implement `#runConverseTurn`**

Add the method (near `#runChat`, which it replaces):

```ts
  // One conversational turn. Tier 0 runs on the host (no sandbox); if the agent
  // needs the repo (need_repo) or we already know it will (forceRepo), run Tier 1
  // in a sandbox. Both tiers converge on the same action dispatch below.
  async #runConverseTurn(ctx: IssueContext, acts: Activities, userMessage: string, forceRepo = false): Promise<void> {
    const history = await this.#fetchThread?.(ctx.issueId).catch(() => "");

    let action: ReturnType<typeof parseConverseAction>["action"];
    let body: string;
    let sessionId: string | null = null;
    let costUsd: number | null = null;

    if (!forceRepo) {
      await acts.thought("Thinking…");
      const r: HostTurnResult = await this.#runHostTurn({
        apiKey: this.#config.anthropicApiKey, ctx, userMessage, history: history || undefined,
      });
      ({ action, body, sessionId, costUsd } = r);
    } else {
      action = "need_repo"; body = ""; // jump straight to Tier 1
    }

    if (action === "need_repo") {
      await acts.thought("Let me pull up the code…");
      const map = this.#store.getRepoMap(this.#config.targetRepo);
      const result = await withSandbox(this.#sbxCfg(ctx.agentSessionId), async (sbx) => {
        this.#store.setSandbox(ctx.agentSessionId, sbx.sandboxId);
        await cloneRepo(sbx, this.#sbxCfg(ctx.agentSessionId), this.#store.get(ctx.agentSessionId)?.branch ?? null);
        const hist = await this.#timed(ctx.agentSessionId, "history", () =>
          prepareHistory(this.#store, sbx, ctx.issueId, this.#fetchThread));
        const images = await this.#extractImages(ctx, hist);
        return this.#trackedRun(ctx.agentSessionId, "converse", sbx, converseTask(ctx, userMessage, map, hist, images), acts);
      });
      this.#store.setSandbox(ctx.agentSessionId, null);
      const text = result?.kind === "result" && result.text ? result.text : "";
      if (result?.kind === "result" && result.sessionId) this.#store.setSdkSessionId(ctx.agentSessionId, result.sessionId);
      if (!text) {
        await acts.error("I couldn't work that out — reply again to retry.").catch(() => undefined);
        return; // stays in clarify, retryable
      }
      const parsed = parseConverseAction(text);
      await this.#dispatchConverse(ctx, acts, parsed.action, parsed.body, costLine(result));
      return;
    }

    if (sessionId) this.#store.setSdkSessionId(ctx.agentSessionId, sessionId);
    const cost = costUsd != null ? `\n\n_Cost: $${costUsd.toFixed(4)}_` : "";
    await this.#dispatchConverse(ctx, acts, action, body, cost);
  }

  // Shared action dispatch for both tiers. `implement` is guarded on a posted plan.
  async #dispatchConverse(ctx: IssueContext, acts: Activities, action: string, body: string, costSuffix: string): Promise<void> {
    if (action === "implement") {
      const row = this.#store.get(ctx.agentSessionId);
      if (!row?.plan || !row.plan.trim()) {
        await acts.response("I don't have an agreed plan yet — let me lay one out first, then I'll build it.");
        return; // stays in clarify
      }
      const decomposition = parseDecomposition(row.plan);
      if (decomposition) { await this.#createSubIssues(ctx, acts, decomposition); return; }
      await acts.thought(body || "On it — implementing now.");
      this.#store.upsert(ctx.agentSessionId, "implement", ctx.issueId);
      await this.#runImplement(ctx, acts, row.plan, row.branch, this.#workBranchFor(ctx.issueId, ctx.agentSessionId));
      return;
    }
    if (action === "plan") {
      this.#store.setPlan(ctx.agentSessionId, body);
      await acts.response(`${body}${costSuffix}`);
      return; // b2: posting a plan is just a message; no approval gate
    }
    // reply (and any unknown) — post and keep talking
    await acts.response(`${body}${costSuffix}`);
  }
```

- [ ] **Step 5: Rewire `onCreated`**

Replace the `classifyIntent`/`#runChat`/`#runPlan` tail of `onCreated` (~421-428) with:

```ts
    this.#store.upsert(ctx.agentSessionId, "clarify", ctx.issueId);
    await this.#runConverseTurn(ctx, acts, `${ctx.title}\n\n${ctx.description}\n\n${ctx.comment}`.trim());
```

Leave the entire `prior` resume block above it (lines ~349-419) unchanged — resume semantics are out of scope.

- [ ] **Step 6: Run the new test + typecheck**

Run: `npx vitest run tests/orchestrator/pipeline.test.ts -t "answered by a host turn" && npm run typecheck`
Expected: PASS. (Typecheck will flag any remaining `classifyIntent` reference; if `#runPlan`/`mapTask` are now only used by resume, keep them — resume still posts plans. Do not delete `#runPlan` here.)

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/pipeline.ts tests/orchestrator/pipeline.test.ts
git commit -m "feat(orchestrator): two-tier converse turn + wire onCreated (clarify entry)"
```

---

### Task 6: Orchestrator — rewrite `onPrompted` (delete the regex gate)

**Files:**
- Modify: `src/orchestrator/pipeline.ts` (`onPrompted` ~605-689)
- Test: `tests/orchestrator/pipeline.test.ts`

**Interfaces:**
- Consumes: `#runConverseTurn`, `#dispatchConverse` (Task 5), `parseStopGate` (kept), `#runImplement`.

**New `onPrompted` control flow:**
1. `clarify` phase → deterministic `parseStop` check first (stop closes the session); else `#runConverseTurn(ctx, acts, replyText)`.
2. `await_approval` phase no longer exists as a resting state, but **legacy rows** may still carry it after a deploy — treat an `await_approval` row exactly like `clarify` (run a converse turn) so nothing wedges.
3. `done` + `prUrl` → unchanged `#onDoneFollowUp`.
4. other terminal phases → unchanged status replies.
5. The entire `parseApprovalGate` / feedback-revise / decomposition block (632-688) is **deleted** — its behavior now lives in the converse turn.

- [ ] **Step 1: Write the failing tests**

Add to `tests/orchestrator/pipeline.test.ts`:

```ts
test("onPrompted: 'yeah ship it' implements when a plan was posted (no regex)", async () => {
  const { orch, store, implementCalls } = makeOrch({
    hostTurn: async () => ({ text: "ACTION: implement\nOn it.", action: "implement", body: "On it.", sessionId: "sdk-2", costUsd: 0.001 }),
  });
  store.upsert("s1", "clarify", "i1");
  store.setPlan("s1", "Type: feature\nScope: small\n- do the thing");
  await orch.onPrompted(ctxFor("s1", "i1", "yeah ship it"), "yeah ship it");
  expect(implementCalls.length).toBe(1);
  expect(store.get("s1")?.phase).toBe("implement");
});

test("onPrompted: implement action is refused when no plan was posted", async () => {
  const { orch, store, acts, implementCalls } = makeOrch({
    hostTurn: async () => ({ text: "ACTION: implement\ngo", action: "implement", body: "go", sessionId: null, costUsd: null }),
  });
  store.upsert("s1", "clarify", "i1"); // no plan set
  await orch.onPrompted(ctxFor("s1", "i1", "go go go"), "go go go");
  expect(implementCalls.length).toBe(0);
  expect(acts.responses.join(" ")).toMatch(/don't have an agreed plan/);
  expect(store.get("s1")?.phase).toBe("clarify");
});

test("onPrompted: explicit 'stop' closes the session deterministically", async () => {
  const { orch, store, acts } = makeOrch({ hostTurn: async () => { throw new Error("host turn should not run on stop"); } });
  store.upsert("s1", "clarify", "i1");
  await orch.onPrompted(ctxFor("s1", "i1", "stop"), "stop");
  expect(store.get("s1")?.phase).toBe("done");
  expect(acts.responses.join(" ")).toMatch(/Stopped/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/orchestrator/pipeline.test.ts -t "onPrompted:"`
Expected: FAIL — current `onPrompted` requires `phase === "await_approval"` and routes on `parseApproval`, so a `clarify` row goes to the old `#onClarifyPrompted` (classify) path and these assertions don't hold.

- [ ] **Step 3: Rewrite `onPrompted`**

Replace the body of `onPrompted` (from the `const row = this.#store.get(...)` line through the end of the method, ~607-689) with:

```ts
    const row = this.#store.get(ctx.agentSessionId);

    // done-with-PR follow-up keeps its existing path.
    if (row?.phase === "done" && row.prUrl) {
      await this.#onDoneFollowUp(ctx, row, replyText, acts);
      return;
    }

    // The conversational phase: clarify (and legacy await_approval rows post-deploy).
    if (row && (row.phase === "clarify" || row.phase === "await_approval")) {
      // Deterministic stop stays a keyword check — do not leave a kill to agent judgment.
      if (parseStopGate(replyText)) {
        console.log(`[phase] ${ctx.agentSessionId} stop requested — closing session`);
        this.#store.setPhase(ctx.agentSessionId, "done");
        await acts.response("Stopped. Re-assign the issue when you want me to pick this up again.").catch(() => undefined);
        return;
      }
      await this.#runConverseTurn(ctx, acts, replyText);
      return;
    }

    // Terminal / interrupted phases — unchanged status replies.
    const phase = row?.phase ?? "unknown";
    console.log(`[skip] ${ctx.agentSessionId} prompted but phase=${phase} — replying with status`);
    if (phase === "done") {
      await acts.response("This task is already done — re-assign the issue to start something new.");
    } else {
      await acts.error(
        `This session is in state \`${phase}\` and can't continue (it was likely interrupted). ` +
          `Re-assign the issue to me to start over.`,
      );
    }
```

Delete the now-unused `#onClarifyPrompted` method (its logic moved into `#runConverseTurn`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/orchestrator/pipeline.test.ts -t "onPrompted:"`
Expected: PASS (all three).

- [ ] **Step 5: Run the full orchestrator suite**

Run: `npx vitest run tests/orchestrator/pipeline.test.ts`
Expected: PASS. Old tests asserting the `await_approval`/`parseApproval` flow will fail — update or delete them (they test removed behavior). For each failure, confirm it targets the old regex gate before deleting.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/pipeline.ts tests/orchestrator/pipeline.test.ts
git commit -m "feat(orchestrator): conversational onPrompted, delete regex approval gate"
```

---

### Task 7: Remove `parseApproval`, prune dead code, update all three docs

**Files:**
- Modify: `src/linear/context.ts` (delete `parseApproval`, `APPROVE*`, `SOFT_*` ~46-59)
- Modify: `src/orchestrator/pipeline.ts` (drop the `parseApproval as parseApprovalGate` re-export ~1081-1084; delete `#runChat`/`#finishChat`/`chatTask` import if unused; delete `nextPhase`'s `await_approval` arm if unused)
- Modify: `tests/linear/context.test.ts` (delete `parseApproval` tests; keep `parseStop`)
- Modify: `CLAUDE.md` (phase diagram + human-gates section)
- Modify: `README.md` (context.ts one-liner ~49; tasks.ts one-liner ~38; classify.ts one-liner ~39; pipeline sketch ~14-16, ~36)
- Modify: `docs/jarvis.html` (phase diagram ~496-500; "approval is a regex" section ~602-603; task table ~561-563; pipeline SVG label ~381-382; prose ~420)
- Test: full suite

**Doc rule (user decision):** these three describe the *live* architecture, so they are updated **only as this code lands** — never ahead of it. This task runs last, after Tasks 1-6 are merged and the conversational gate is the real behavior.

- [ ] **Step 1: Delete `parseApproval` and its constants**

In `src/linear/context.ts`, remove `APPROVE`, `APPROVE_NEGATED`, `SOFT_AFFIRM`, `SOFT_NEGATE`, and the `parseApproval` function (~46-59). Keep `parseStop`, `STOP`, `STOP_NEGATED`. Keep `APPROVAL_FOOTER` only if the resume block still posts it (it does, at ~416) — leave it.

- [ ] **Step 2: Remove the re-export and confirm no references remain**

In `pipeline.ts`, change the bottom re-export block (~1081-1084) to import only `parseStop`:

```ts
import { parseStop as parseStopGate } from "../linear/context.ts";
```

Run: `npx grep -rn "parseApproval\|classifyIntent\|#runChat\|chatTask" src/`
(or use the Grep tool). Expected: zero matches in `src/` except historical comments. Delete `#runChat`, `#finishChat`, and the `chatTask` import if the grep shows they're now unreferenced.

- [ ] **Step 3: Run typecheck to prove nothing dangles**

Run: `npm run typecheck`
Expected: PASS with no unused-import or missing-symbol errors.

- [ ] **Step 4: Delete the `parseApproval` tests**

In `tests/linear/context.test.ts`, delete every `parseApproval` test case. Keep the `parseStop` cases.

Run: `npx vitest run tests/linear/context.test.ts`
Expected: PASS.

- [ ] **Step 5: Update `CLAUDE.md`**

Replace the phase-state-machine diagram's `clarify → plan → await_approval ⇄ plan → implement` line with the collapsed conversational model:

```
converse (clarify) ──[agent emits ACTION: implement on an agreed plan]──> implement → done
   (answers, websearch, plan drafts, revisions all stay in converse; two tiers:
    host-side no-sandbox turn for reason/web, sandbox turn when the code is needed)
done ⇄ review  (unchanged PR follow-up)
```

Under "Human gates", change gate 1 from "blocks in `await_approval` until `parseApproval`" to: "the conversational agent decides when an already-posted plan has been agreed and emits `ACTION: implement`; it will not implement a plan the human never saw (guarded in `#dispatchConverse`). `parseStop` stays a deterministic kill." Note this is the b2 trade-off from the design doc.

- [ ] **Step 6: Update `README.md`**

- The `src/` file annotations: change `context.ts # webhook payload parsing, approve/stop parsing` (~49) to `... stop parsing` (approval is gone; only stop is parsed). Change the `tasks.ts` task list (~38) to drop `chat` and note `converse` (`map / plan / revise / implement / review / converse`). Change the `classify.ts` line (~39) to drop `chat-vs-plan` (that classifier is removed): `host-side Haiku classifiers (revise-vs-review, workflow state)`.
- The ASCII pipeline sketch (~14-16): replace `clarify → plan` / `⇩ human approves plan` with the conversational framing, e.g. `converse ⇄ (answer / websearch / plan)` and `⇩ agent sees the human agree → implement`.
- The intro (~4-5): "clarifies, posts a plan, and on approval writes code" → "talks it through, posts a plan, and once you agree writes code" (no "approve" keyword implication).

- [ ] **Step 7: Update `docs/jarvis.html`**

- Phase diagram (~496-500): replace the `clarify → plan → await_approval ⇄ plan → approve → implement` block with the collapsed model — `converse` holds answers/websearch/plan drafts/revisions, and `ACTION: implement` on an agreed plan moves to `implement`. Keep the decomposition note (~507).
- "approval is a regex" section (~602-603): this is now false. Replace the `<dt>`/`<dd>` with an honest description of the b2 conversational gate: the agent decides when a posted plan is agreed and emits `ACTION: implement`; it won't implement a plan the human never saw; `stop` stays a deterministic keyword. Reference the two-tier (host/sandbox) turn.
- Task table (~561-563): replace the `plan`/`revise` rows' "a human will approve" / "Loops until approval" wording; add/relabel a `converse` row (Sonnet, the conversational turn). Keep `implement`/`review`.
- Pipeline SVG (~381-382): `HUMAN GATE 1` / `APPROVE` label — keep the gate concept (the human still agrees before code) but relabel from the keyword "APPROVE" to "AGREE" / "PLAN OK" to match that it's no longer a magic word. The gate is still real (b2 won't implement an unseen/unagreed plan); do not remove it.
- Prose (~420): "When a human replies **approve**, it writes the code" → "When you're agreed on the plan, it writes the code".
- Leave the two-gates framing (~456-457, ~646) intact — b2 keeps a plan-agreement gate and the merge gate; both still hold.

- [ ] **Step 8: Run the whole suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/linear/context.ts src/orchestrator/pipeline.ts tests/linear/context.test.ts CLAUDE.md README.md docs/jarvis.html
git commit -m "refactor: remove regex approval gate + dead chat path, update all docs"
```

---

## Notes for the implementer

- **Deviation from the spec, on purpose:** the spec described resuming the SDK `session_id` for cross-turn memory. SDK transcripts are stored on the machine that ran the turn, and this system runs each turn in a fresh host process or a fresh sandbox — so a transcript never survives to the next turn. Memory therefore comes from the Linear thread (canonical, via `prepareHistory`/`#fetchThread`), exactly the backstop the spec named. `sdkSessionId` is captured (Task 1) purely as the forward seam for option C (ship-transcript-off-box), not wired to `resume`. Do not add resume plumbing in this plan.
- **The `makeOrch` test helper** referenced in Tasks 5-6 is shorthand for this file's existing Orchestrator-construction pattern with fakes. Extend that pattern to (a) inject `runHostTurn`, (b) count sandbox creations, (c) capture `#runImplement` calls — follow whatever seams the current tests already use (e.g. a fake `withSandbox`/sandbox factory). If the current tests construct the Orchestrator directly, add a `runHostTurn?` field to its constructor deps (Task 5, Step 3) and pass the fake there.
- **`server.ts` / `steer`:** unchanged. Mid-run steering still applies only to live Tier 1 sandbox runs (registered via `#trackedRun`/`#live`). A Tier 0 host turn is synchronous and short; a comment landing during it is handled as the next turn. Per-session serialization is the existing `inflight` guard in `server.ts` — out of scope.
```
