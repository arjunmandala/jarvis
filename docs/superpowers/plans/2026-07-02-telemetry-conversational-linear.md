# Telemetry + Conversational Linear Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist full run telemetry to SQLite (mineable for "what does Jarvis fail at"), and make Jarvis conversational in Linear: any user comment during a live plan/implement run is injected into the running agent, and the agent can ask the user questions via an `ask_user` tool (10-minute wait, then proceed on best judgment). Plus: bake Python into the E2B template.

**Architecture:** The in-sandbox `runner.mjs` switches from a fixed prompt to the Agent SDK's streaming-input mode, tailing an append-only inbox file (`/tmp/jarvis-inbox.jsonl`) that the host appends to. The Orchestrator keeps an in-memory registry of live runs (sandbox + run id); the server routes `prompted` webhooks for live sessions to a new `steer()` path instead of dropping them. Telemetry: a `runs` row per agent task and a `run_events` row per stream event, written best-effort from the existing relay.

**Tech Stack:** Node 24 (`node:sqlite`), TypeScript (type-checked, run directly via node), vitest, e2b SDK, `@anthropic-ai/claude-agent-sdk` + `zod` (in-sandbox only), Hono.

**Spec:** `docs/superpowers/specs/2026-07-02-telemetry-conversational-linear-design.md`

## Global Constraints

- Repo conventions: `type: module`, Node >= 24.15.0, tests with `npm test` (vitest), typecheck with `npm run typecheck`.
- Telemetry writes are best-effort: wrapped in try/catch, must never fail a run over logging.
- `systemAppend` strings must stay byte-stable **across runs** for prompt caching (adding new fixed text is fine; per-run content never goes in systemAppend).
- e2b `files.write` cannot overwrite runner-written files — clearing files in the sandbox must use `rm -f` via `commands.run`.
- The runner writes `/tmp/jarvis-result.json` as the authoritative final record; with streaming input it must be written **only once, at true end of run** (multiple per-turn `result` messages now occur; a premature write would make `watchDetached` end the run early).
- **Spec deviation (approved rationale):** `reviseTask` keeps its cold-start re-prompt. SDK session transcripts live on the (dead) sandbox's local disk, so `resume: sessionId` cannot work across sandboxes without transcript-export machinery. Revisions already carry full context (previous plan + feedback) in the prompt.
- Commit after every task; messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Telemetry tables + store methods

**Files:**
- Modify: `src/store/sessions.ts`
- Test: `tests/store/sessions.test.ts` (append new describe blocks)

**Interfaces:**
- Produces: `SessionStore.createRun(agentSessionId: string, taskType: string, repo: string | null): number`, `SessionStore.addRunEvent(runId: number, type: string, payload: unknown): void`, `SessionStore.finishRun(runId: number, f: RunFinish): void`, and `export interface RunFinish { outcome: string; costUsd: number | null; numTurns: number | null; tokensIn: number; tokensOut: number; tokensCacheRead: number; error: string | null }`. Tasks 6 and 8 consume these.

- [ ] **Step 1: Write the failing tests**

Append to `tests/store/sessions.test.ts`:

```ts
describe("run telemetry", () => {
  it("createRun returns an id and finishRun records the outcome", () => {
    const store = new SessionStore(":memory:");
    const runId = store.createRun("as_t1", "plan", "owner/repo");
    expect(runId).toBeGreaterThan(0);
    store.finishRun(runId, {
      outcome: "success", costUsd: 0.5, numTurns: 12,
      tokensIn: 1000, tokensOut: 200, tokensCacheRead: 800, error: null,
    });
    // second run gets a distinct id
    expect(store.createRun("as_t1", "implement", "owner/repo")).toBe(runId + 1);
    store.close();
  });

  it("addRunEvent stores JSON payloads per run", () => {
    const store = new SessionStore(":memory:");
    const runId = store.createRun("as_t2", "plan", null);
    store.addRunEvent(runId, "tool_use", { name: "Bash", input: { command: "ls" } });
    store.addRunEvent(runId, "tool_result", { tool: "Bash", isError: true, content: "boom" });
    // no assert on retrieval API — the report script reads SQL directly; just prove no throw
    store.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/store/sessions.test.ts`
Expected: FAIL — `createRun is not a function`

- [ ] **Step 3: Implement**

In `src/store/sessions.ts`, add after the `repo_maps` `CREATE TABLE` in the constructor:

```ts
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_session_id  TEXT NOT NULL,
        task_type         TEXT NOT NULL,
        repo              TEXT,
        started_at        TEXT NOT NULL,
        ended_at          TEXT,
        outcome           TEXT,
        cost_usd          REAL,
        num_turns         INTEGER,
        tokens_in         INTEGER,
        tokens_out        INTEGER,
        tokens_cache_read INTEGER,
        error             TEXT
      ) STRICT
    `);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS run_events (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id  INTEGER NOT NULL,
        ts      TEXT NOT NULL,
        type    TEXT NOT NULL,
        payload TEXT NOT NULL
      ) STRICT
    `);
```

Add the interface (top of file, after `SessionRow`):

```ts
export interface RunFinish {
  outcome: string;
  costUsd: number | null;
  numTurns: number | null;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  error: string | null;
}
```

Add methods to `SessionStore` (after `setRepoMap`):

```ts
  createRun(agentSessionId: string, taskType: string, repo: string | null): number {
    const r = this.#db
      .prepare(`INSERT INTO runs (agent_session_id, task_type, repo, started_at) VALUES (?, ?, ?, ?)`)
      .run(agentSessionId, taskType, repo, new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  addRunEvent(runId: number, type: string, payload: unknown): void {
    this.#db
      .prepare(`INSERT INTO run_events (run_id, ts, type, payload) VALUES (?, ?, ?, ?)`)
      .run(runId, new Date().toISOString(), type, JSON.stringify(payload));
  }

  finishRun(runId: number, f: RunFinish): void {
    this.#db
      .prepare(
        `UPDATE runs SET ended_at = ?, outcome = ?, cost_usd = ?, num_turns = ?,
                tokens_in = ?, tokens_out = ?, tokens_cache_read = ?, error = ?
         WHERE id = ?`,
      )
      .run(
        new Date().toISOString(), f.outcome, f.costUsd, f.numTurns,
        f.tokensIn, f.tokensOut, f.tokensCacheRead, f.error, runId,
      );
  }
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/store/sessions.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/sessions.ts tests/store/sessions.test.ts
git commit -m "feat: runs + run_events telemetry tables in SessionStore"
```

---

### Task 2: New event kinds — `tool_result`, `ask_user`, `user_message`

**Files:**
- Modify: `src/agent/events.ts`
- Test: `tests/agent/events.test.ts` (append)

**Interfaces:**
- Produces: `JarvisEvent` union gains `{ kind: "tool_result"; tool: string | null; isError: boolean; content: string }`, `{ kind: "ask_user"; question: string }`, `{ kind: "user_message"; text: string }`. The first two are parsed from the runner stream (added to `KINDS`); `user_message` is host-generated only (NOT in `KINDS`). Tasks 5, 6, 7 consume these.

- [ ] **Step 1: Write the failing tests**

Append to `tests/agent/events.test.ts`:

```ts
describe("new event kinds", () => {
  it("parses tool_result and ask_user lines from the stream", () => {
    const p = new LineParser();
    const events = p.push(
      JSON.stringify({ kind: "tool_result", tool: "Bash", isError: true, content: "pip: error" }) + "\n" +
      JSON.stringify({ kind: "ask_user", question: "Which DB?" }) + "\n",
    );
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("tool_result");
    expect(events[1].kind).toBe("ask_user");
  });

  it("does NOT parse user_message from the stream (host-generated only)", () => {
    const p = new LineParser();
    const events = p.push(JSON.stringify({ kind: "user_message", text: "hi" }) + "\n");
    expect(events).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/agent/events.test.ts`
Expected: FAIL — tool_result/ask_user lines are dropped (0 events)

- [ ] **Step 3: Implement**

In `src/agent/events.ts`, extend the union (insert before the `error` member):

```ts
  | { kind: "tool_result"; tool: string | null; isError: boolean; content: string }
  | { kind: "ask_user"; question: string }
  | { kind: "user_message"; text: string }
```

Change `KINDS` (note: no `user_message` — it never crosses the stream):

```ts
const KINDS = new Set(["assistant_text", "tool_use", "tool_result", "ask_user", "result", "error"]);
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/agent/events.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/events.ts tests/agent/events.test.ts
git commit -m "feat: tool_result, ask_user, user_message event kinds"
```

---

### Task 3: Sandbox inbox — `injectMessage` + clearing

**Files:**
- Modify: `src/sandbox/session.ts`
- Test: `tests/sandbox/session.test.ts` (append; also update the fake's `rm -f` handling)

**Interfaces:**
- Consumes: `AgentSandbox` (existing).
- Produces: `export const INBOX_FILE = "/tmp/jarvis-inbox.jsonl"`, `export async function injectMessage(sbx: AgentSandbox, text: string): Promise<void>`. Task 6 consumes `injectMessage`; Task 5's runner reads `INBOX_FILE` (path duplicated as a literal in runner.mjs, which cannot import TS).

- [ ] **Step 1: Update the fake + write failing tests**

In `tests/sandbox/session.test.ts`, the fake's `commands.run` handles `rm -f <one path>`. `runAgent` will now `rm -f` two paths in one command. Replace the `rm -f` branch of the fake with:

```ts
        if (cmd.startsWith("rm -f ")) {
          for (const p of cmd.slice("rm -f ".length).trim().split(/\s+/)) files.delete(p);
          return { exitCode: 0 };
        }
```

Append tests (the fake factory returns `{ sbx, ... }`; reuse it, and capture commands by extending — add a `commandLog: string[]` to the fake: in `commands.run`, push `cmd` onto it before anything else, and return it from `makeFake`):

```ts
describe("injectMessage", () => {
  it("appends a base64-encoded JSONL line to the inbox", async () => {
    const commandLog: string[] = [];
    const sbx: AgentSandbox = {
      files: { read: async () => { throw new Error("ENOENT"); }, write: async () => undefined },
      commands: {
        run: async (cmd: string) => { commandLog.push(cmd); return { exitCode: 0 }; },
        list: async () => [],
      },
    };
    await injectMessage(sbx, 'use approach "B" — it\'s better\nthanks');
    expect(commandLog).toHaveLength(1);
    const m = commandLog[0].match(/^echo (\S+) \| base64 -d >> \/tmp\/jarvis-inbox\.jsonl$/);
    expect(m).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(m![1], "base64").toString("utf8"));
    expect(decoded.text).toBe('use approach "B" — it\'s better\nthanks');
  });
});

describe("runAgent inbox clearing", () => {
  it("clears both result and inbox files before starting the runner", async () => {
    const commandLog: string[] = [];
    const files = new Map<string, string>();
    const resultLine = JSON.stringify(RESULT_EVENT) + "\n";
    const sbx: AgentSandbox = {
      files: {
        read: async (p: string) => {
          if (!files.has(p)) throw new Error("ENOENT");
          return files.get(p)!;
        },
        write: async (p: string, d: string) => void files.set(p, d),
      },
      commands: {
        run: async (cmd: string, o: { onStdout?: (d: string) => void }) => {
          commandLog.push(cmd);
          if (cmd.startsWith("rm -f ")) return { exitCode: 0 };
          o.onStdout?.(resultLine); // runner emits its result and exits
          return { exitCode: 0 };
        },
        list: async () => [],
      },
    };
    const task = { goal: "g", cwd: "/r", model: "m", systemAppend: "", allowedTools: [], maxTurns: 1, maxBudgetUsd: 1 } as AgentTask;
    const { result } = await runAgent(sbx, "key", task, () => undefined);
    expect(result?.kind).toBe("result");
    expect(commandLog[0]).toBe(`rm -f ${RESULT_FILE} ${INBOX_FILE}`);
  });
});
```

(Import `INBOX_FILE` and `injectMessage` in the file's import list from `../../src/sandbox/session.ts`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sandbox/session.test.ts`
Expected: FAIL — `injectMessage` not exported; rm command lacks inbox path

- [ ] **Step 3: Implement**

In `src/sandbox/session.ts`, add below the `RESULT_FILE` export:

```ts
// Append-only JSONL the host writes user comments into; the in-sandbox runner
// tails it and injects each line into the live agent session (steering / ask_user
// answers). Cleared alongside RESULT_FILE at the start of every run.
export const INBOX_FILE = "/tmp/jarvis-inbox.jsonl";

// base64 round-trip so arbitrary text (quotes, newlines) survives the shell.
export async function injectMessage(sbx: AgentSandbox, text: string): Promise<void> {
  const b64 = Buffer.from(JSON.stringify({ text }) + "\n", "utf8").toString("base64");
  await sbx.commands.run(`echo ${b64} | base64 -d >> ${INBOX_FILE}`, { timeoutMs: 60_000 });
}
```

In `runAgent`, change the `rm -f` line to:

```ts
  await sbx.commands.run(`rm -f ${RESULT_FILE} ${INBOX_FILE}`, { timeoutMs: 60_000 });
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/sandbox/session.test.ts && npm run typecheck`
Expected: PASS (including all pre-existing tests in the file)

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/session.ts tests/sandbox/session.test.ts
git commit -m "feat: sandbox inbox file + injectMessage for live steering"
```

---

### Task 4: Task prompts — `ask_user` allowance + conversational directives

**Files:**
- Modify: `src/agent/tasks.ts`
- Test: `tests/agent/tasks.test.ts` (append)

**Interfaces:**
- Produces: `planTask`, `reviseTask`, `implementTask` include `"mcp__jarvis__ask_user"` in `allowedTools`; `mapTask` does not. `PLAN_APPEND`/`IMPLEMENT_APPEND` gain a fixed conversational paragraph (byte-stable across runs, so prompt caching is unaffected).

- [ ] **Step 1: Write the failing tests**

Append to `tests/agent/tasks.test.ts`:

```ts
describe("conversational directives", () => {
  it("plan, revise and implement allow the ask_user tool; map does not", () => {
    expect(planTask(ctx).allowedTools).toContain("mcp__jarvis__ask_user");
    expect(reviseTask(ctx, "p", "f").allowedTools).toContain("mcp__jarvis__ask_user");
    expect(implementTask(ctx, "p").allowedTools).toContain("mcp__jarvis__ask_user");
    expect(mapTask().allowedTools).not.toContain("mcp__jarvis__ask_user");
  });

  it("plan and implement prompts explain steering and ask_user restraint", () => {
    for (const t of [planTask(ctx), implementTask(ctx, "p")]) {
      expect(t.systemAppend).toMatch(/ask_user/);
      expect(t.systemAppend).toMatch(/steer/i);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/agent/tasks.test.ts`
Expected: FAIL — allowedTools lacks mcp__jarvis__ask_user

- [ ] **Step 3: Implement**

In `src/agent/tasks.ts`, add a shared constant after `IMPLEMENT_APPEND`:

```ts
// Appended to both plan and implement system prompts. Fixed text — never fold
// per-run content in here (prompt-cache byte-stability).
const CONVERSE_APPEND =
  "\n\nCONVERSATION: the human may send you messages while you work — they arrive as user messages " +
  "mid-run. Treat them as steering: acknowledge briefly and incorporate them. If you are genuinely " +
  "blocked on a decision only the human can make, call the ask_user tool and wait for the reply; " +
  "never ask about anything you can infer from the repo or the issue. If ask_user times out, proceed " +
  "with your best judgment and state the assumption you made.";
```

Append it to both prompts by changing the two definitions' final lines:

- `PLAN_APPEND`: append `+ CONVERSE_APPEND` after the existing string concatenation (i.e. `"Do not write any files." + CONVERSE_APPEND`). Since `CONVERSE_APPEND` is declared after, move its declaration ABOVE `PLAN_APPEND`.
- `IMPLEMENT_APPEND`: append `+ CONVERSE_APPEND` after the DETERMINISTIC ENDING sentence.

Update `allowedTools` in the three factories:

```ts
// planTask and reviseTask:
    allowedTools: ["Read", "Glob", "Grep", "Skill", "mcp__jarvis__ask_user"],
// implementTask:
    allowedTools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "Skill", "Agent", "mcp__jarvis__ask_user"],
```

`mapTask` stays unchanged.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/agent/tasks.test.ts && npm run typecheck`
Expected: PASS — all pre-existing assertions in this file still hold (they use `arrayContaining`, and `reviseTask` still shares `PLAN_APPEND` byte-identically).

- [ ] **Step 5: Commit**

```bash
git add src/agent/tasks.ts tests/agent/tasks.test.ts
git commit -m "feat: ask_user tool allowance + conversational steering directives"
```

---

### Task 5: Runner rewrite — streaming input, inbox tail, ask_user tool, tool_result emission

**Files:**
- Modify: `src/agent/runner.mjs` (full rewrite below)

**Interfaces:**
- Consumes: task JSON (unchanged shape), `/tmp/jarvis-inbox.jsonl` lines of `{"text": "..."}` (Task 3's `injectMessage` format).
- Produces: stdout events including new `tool_result` (`{kind, tool, isError, content}`) and `ask_user` (`{kind, question}`); `/tmp/jarvis-result.json` written ONCE at true end of run (last result wins). MCP tool name as seen by the model: `mcp__jarvis__ask_user`.

No unit test — runner.mjs runs only inside the sandbox (repo convention: e2b paths are covered by live acceptance). Verification is Task 9's template rebuild + smoke run.

- [ ] **Step 1: Replace `src/agent/runner.mjs` with:**

```js
// Runs INSIDE the E2B sandbox. Reads a task JSON, runs the Claude Agent SDK in
// streaming-input mode, and prints newline-delimited JarvisEvent JSON to stdout
// for the host to parse. The host can append {"text": "..."} lines to the inbox
// file at any time: they are injected into the live session as user messages
// (steering), or consumed as the answer to a pending ask_user call.
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";

const task = JSON.parse(readFileSync(process.env.JARVIS_TASK_FILE, "utf8"));
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const RESULT_FILE = "/tmp/jarvis-result.json";
const INBOX_FILE = "/tmp/jarvis-inbox.jsonl"; // keep in sync with INBOX_FILE in src/sandbox/session.ts
const START = Date.now();
// Below the host's 55-min watchDetached deadline so an ask_user wait can never
// outlive the watcher.
const DEADLINE_MS = 50 * 60_000;
const ASK_TIMEOUT_MS = 10 * 60_000;
const NO_ANSWER =
  "No answer within 10 minutes — proceed with your best judgment and state your assumption in your final output.";

// --- inbox tail: read appended lines from a byte offset (no re-reads).
let inboxOffset = 0;
function readNewLines() {
  if (!existsSync(INBOX_FILE)) return [];
  const size = statSync(INBOX_FILE).size;
  if (size <= inboxOffset) return [];
  const fd = openSync(INBOX_FILE, "r");
  const buf = Buffer.alloc(size - inboxOffset);
  readSync(fd, buf, 0, buf.length, inboxOffset);
  closeSync(fd);
  inboxOffset = size;
  const out = [];
  for (const line of buf.toString("utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (typeof o.text === "string" && o.text.trim()) out.push(o.text);
    } catch {
      // partial line still being written; it re-parses next tick via offset? No —
      // offset already advanced. ponytail: host writes each line atomically
      // (single echo >> append), so torn lines don't occur in practice.
    }
  }
  return out;
}

// Priority routing: a pending ask_user takes the next line; otherwise lines
// queue as steering messages for the prompt generator.
const steering = [];
let askWaiter = null; // (text) => void
const pump = setInterval(() => {
  for (const text of readNewLines()) {
    if (askWaiter) {
      const w = askWaiter;
      askWaiter = null;
      w(text);
    } else {
      steering.push(text);
    }
  }
}, 2000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userMsg = (text) => ({
  type: "user",
  message: { role: "user", content: [{ type: "text", text }] },
  parent_tool_use_id: null,
  session_id: "",
});

// The input stream stays open so steering can arrive mid-run; it closes when a
// turn finishes (result message seen) with nothing queued — that result is final.
let turnDone = false;
async function* promptStream() {
  yield userMsg(task.goal);
  for (;;) {
    if (steering.length > 0) {
      turnDone = false;
      yield userMsg(steering.shift());
      continue;
    }
    if (turnDone) return;
    await sleep(500);
  }
}

const askUser = tool(
  "ask_user",
  "Ask the human a question in Linear and wait up to 10 minutes for their reply. " +
    "Use ONLY when blocked on a decision you cannot infer from the repo or issue.",
  { question: z.string() },
  async ({ question }) => {
    emit({ kind: "ask_user", question });
    const waitMs = Math.min(ASK_TIMEOUT_MS, Math.max(0, DEADLINE_MS - (Date.now() - START)));
    const answer = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        askWaiter = null;
        resolve(null);
      }, waitMs);
      askWaiter = (text) => {
        clearTimeout(timer);
        resolve(text);
      };
    });
    return { content: [{ type: "text", text: answer ?? NO_ANSWER }] };
  },
);

let lastResult = null;
try {
  const toolNames = new Map(); // tool_use id -> name, to label tool_results
  for await (const message of query({
    prompt: promptStream(),
    options: {
      cwd: task.cwd,
      model: task.model,
      // excludeDynamicSections keeps the preset byte-stable across sandboxes so the prompt cache hits (Phase 4.2)
      systemPrompt: { type: "preset", preset: "claude_code", append: task.systemAppend, excludeDynamicSections: true },
      settingSources: ["user", "project"], // REQUIRED so superpowers skills load
      allowedTools: task.allowedTools,
      permissionMode: "bypassPermissions", // safe: the sandbox is the isolation boundary
      maxTurns: task.maxTurns,
      maxBudgetUsd: task.maxBudgetUsd,
      mcpServers: { jarvis: createSdkMcpServer({ name: "jarvis", version: "1.0.0", tools: [askUser] }) },
    },
  })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") emit({ kind: "assistant_text", text: block.text });
        else if (block.type === "tool_use") {
          toolNames.set(block.id, block.name);
          emit({ kind: "tool_use", name: block.name, input: block.input });
        }
      }
    } else if (message.type === "user" && Array.isArray(message.message?.content)) {
      for (const block of message.message.content) {
        if (block.type === "tool_result") {
          const content =
            typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
          emit({
            kind: "tool_result",
            tool: toolNames.get(block.tool_use_id) ?? null,
            isError: block.is_error === true,
            content: content.slice(0, 2048),
          });
        }
      }
    } else if (message.type === "result") {
      lastResult = {
        kind: "result",
        subtype: message.subtype,
        text: message.subtype === "success" ? message.result : null,
        costUsd: message.total_cost_usd ?? null,
        sessionId: message.session_id ?? null,
        usage: message.usage ?? null,
        numTurns: message.num_turns ?? null,
      };
      emit(lastResult);
      turnDone = true; // generator closes unless steering is queued
    }
  }
  // True end of run: only now is RESULT_FILE authoritative (per-turn results
  // must not end the host's watchDetached early).
  writeFileSync(RESULT_FILE, JSON.stringify(lastResult ?? { kind: "error", message: "run ended without a result" }));
} catch (err) {
  const ev = { kind: "error", message: String(err?.message ?? err) };
  try {
    writeFileSync(RESULT_FILE, JSON.stringify(ev));
  } catch (writeErr) {
    // Write failure must not mask the emit
  }
  emit(ev);
  process.exitCode = 1;
} finally {
  clearInterval(pump);
}
```

- [ ] **Step 2: Sanity-check the file parses**

Run: `node --check src/agent/runner.mjs`
Expected: no output, exit 0

- [ ] **Step 3: Run full test suite + typecheck (nothing should break)**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/agent/runner.mjs
git commit -m "feat: runner streaming-input mode — inbox steering + ask_user tool + tool_result events"
```

---

### Task 6: Orchestrator — live-run registry, telemetry wiring, steer(), relay upgrades

**Files:**
- Modify: `src/orchestrator/pipeline.ts`
- Test: `tests/orchestrator/pipeline.test.ts` (append)

**Interfaces:**
- Consumes: Task 1 store methods, Task 2 event kinds, Task 3 `injectMessage`.
- Produces: `Orchestrator.hasLive(agentSessionId: string): boolean` and `Orchestrator.steer(ctx: IssueContext, replyText: string): Promise<void>` — Task 7's server consumes both.

- [ ] **Step 1: Write the failing tests**

Append to `tests/orchestrator/pipeline.test.ts`:

```ts
describe("steer", () => {
  it("hasLive is false and steer posts a terminal response when no run is live", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_s1", "implement", "iss");
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log));
    expect(orch.hasLive("as_s1")).toBe(false);
    await orch.steer(ctxFor("as_s1"), "actually use approach B");
    expect(log.length).toBe(1);
    expect(log[0]).toMatch(/^response:/);
    store.close();
  });
  // The live path (inject + thought, stop-kill, ask_user elicitation, reply
  // posting) runs inside withSandbox/runAgent — covered by live acceptance,
  // matching the repo's convention for e2b paths.
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/orchestrator/pipeline.test.ts`
Expected: FAIL — `hasLive is not a function`

- [ ] **Step 3: Implement**

All changes in `src/orchestrator/pipeline.ts`.

**(a) Imports** — extend the session.ts import and add Sandbox-typed live entries:

```ts
import { withSandbox, cloneRepo, runAgent, watchDetached, injectMessage, type AgentSandbox } from "../sandbox/session.ts";
import type { AgentTask } from "../agent/tasks.ts";
```

**(b) Live registry** — add fields to the class:

```ts
  // Live runs: comments arriving while a run executes are injected into its
  // sandbox (steering). In-memory like the server's inflight set — a restart
  // loses steering ability for that run, which reconcile already fails/recovers.
  #live = new Map<string, { sbx: AgentSandbox; kill: () => Promise<unknown>; replyPending: boolean; runId: number | null }>();

  hasLive(agentSessionId: string): boolean {
    return this.#live.has(agentSessionId);
  }
```

**(c) Best-effort event recording** — add:

```ts
  #record(runId: number | null, e: JarvisEvent): void {
    if (runId == null) return;
    try {
      this.#store.addRunEvent(runId, e.kind, e);
    } catch (err) {
      console.error(`[telemetry] addRunEvent failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
```

**(d) `#logUsage` finalizes the run row** — replace the method with:

```ts
  #logUsage(label: string, result: JarvisEvent | null, runId?: number | null): void {
    if (result?.kind === "result") {
      const u = result.usage ?? {};
      const inTok = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      const cost = result.costUsd != null ? `$${result.costUsd.toFixed(4)}` : "n/a";
      console.log(
        `[cost] ${label} ${result.subtype} — cost=${cost} turns=${result.numTurns ?? "?"} ` +
          `tokens in=${inTok} (cache_read=${u.cache_read_input_tokens ?? 0}) out=${u.output_tokens ?? 0}`,
      );
    }
    if (runId == null) return;
    try {
      const outcome =
        result == null ? "no_result"
        : result.kind === "error" ? "error"
        : result.kind !== "result" ? "no_result"
        : result.text?.trim().startsWith("PR_FAILED:") ? "pr_failed"
        : result.subtype;
      const u = result?.kind === "result" ? result.usage ?? {} : {};
      this.#store.finishRun(runId, {
        outcome,
        costUsd: result?.kind === "result" ? result.costUsd : null,
        numTurns: result?.kind === "result" ? (result.numTurns ?? null) : null,
        tokensIn: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        tokensOut: u.output_tokens ?? 0,
        tokensCacheRead: u.cache_read_input_tokens ?? 0,
        error: result?.kind === "error" ? result.message : null,
      });
    } catch (err) {
      console.error(`[telemetry] finishRun failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
```

**(e) `#relay` gains sessionId/runId, ask_user elicitation, conversational replies** — replace with:

```ts
  #relay(acts: Activities, sessionId: string, runId: number | null) {
    return async (e: JarvisEvent) => {
      this.#record(runId, e);
      try {
        if (e.kind === "tool_use") {
          const param = toolParameter(e.input) || String(e.name);
          console.log(`[agent] tool_use ${e.name} → ${param.slice(0, 120)}`);
          // Linear requires action activities to carry a non-empty `parameter`.
          await acts.action(String(e.name), param);
        } else if (e.kind === "ask_user") {
          console.log(`[agent] ask_user: ${e.question.slice(0, 120)}`);
          const live = this.#live.get(sessionId);
          if (live) live.replyPending = true;
          await acts.elicitation(
            `**Jarvis asks:**\n\n${e.question}\n\n_Reply within 10 minutes — after that I proceed on my best judgment._`,
          );
        } else if (e.kind === "error") {
          console.error(`[agent] error: ${e.message}`);
          await acts.error(e.message);
        } else if (e.kind === "assistant_text") {
          console.log(`[agent] text: ${e.text.slice(0, 120).replace(/\n/g, " ")}`);
          // Normally not posted per-block (too noisy) — but the first text after
          // a steering message or ask_user answer is the agent's reply: post it.
          const live = this.#live.get(sessionId);
          if (live?.replyPending && e.text.trim()) {
            live.replyPending = false;
            await acts.response(e.text);
          }
        }
        // tool_result is recorded above but never posted — pure telemetry.
      } catch (err) {
        // A single failed activity post must not crash the run.
        console.error(`[relay] failed to post activity for ${e.kind}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
  }
```

**(f) `#trackedRun` — one wrapper for every agent run** — add:

```ts
  // Runs one agent task with telemetry (runs row + events) and live-steering
  // registration. Sandbox lifetime is managed by the caller's withSandbox.
  async #trackedRun(
    sessionId: string,
    taskType: string,
    sbx: Sandbox,
    task: AgentTask,
    acts: Activities,
  ): Promise<JarvisEvent | null> {
    let runId: number | null = null;
    try {
      runId = this.#store.createRun(sessionId, taskType, this.#config.targetRepo);
    } catch (err) {
      console.error(`[telemetry] createRun failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.#live.set(sessionId, { sbx, kill: () => sbx.kill(), replyPending: false, runId });
    try {
      const { result } = await runAgent(sbx, this.#config.anthropicApiKey, task, this.#relay(acts, sessionId, runId));
      this.#logUsage(`${taskType} ${sessionId}`, result, runId);
      return result;
    } finally {
      this.#live.delete(sessionId);
    }
  }
```

**(g) Use `#trackedRun` everywhere.** In `onCreated`, replace the map-run block's `runAgent` call and the plan `runAgent` call:

```ts
          const mapResult = await this.#trackedRun(ctx.agentSessionId, "map", sbx, mapTask(), acts);
          if (mapResult?.kind === "result" && mapResult.text && mapResult.text.trim()) {
            map = mapResult.text;
            this.#store.setRepoMap(this.#config.targetRepo, map);
          }
```

and

```ts
      return this.#trackedRun(ctx.agentSessionId, "plan", sbx, planTask(ctx, map), acts);
```

(the `withSandbox` callback now returns `Promise<JarvisEvent | null>` directly, so `onCreated` becomes `const result = await withSandbox(...)` — adjust the destructuring: it is no longer `{ result }`.)

In `onPrompted`, replace the revise `runAgent` call:

```ts
      const result = await withSandbox(this.#sbxCfg(), async (sbx) => {
        this.#store.setSandbox(ctx.agentSessionId, sbx.sandboxId);
        await cloneRepo(sbx, this.#sbxCfg());
        return this.#trackedRun(ctx.agentSessionId, "revise", sbx, reviseTask(ctx, plan, replyText, map), acts);
      });
```

and the implement `runAgent` call likewise with `"implement"` and `implementTask(ctx, plan, map)`. Remove the now-redundant `this.#logUsage(...)` first lines from `#finishPlan` and `#finishImplement` (tracked runs already log+finalize); in `reconcile`, add `this.#logUsage(\`reconcile ${id}\`, result)` right before the `if (row.phase === "plan")` branch so recovered results still print cost.

**(h) Done-guard in the finishers** — first line of `#finishPlan` AND `#finishImplement`:

```ts
    // A mid-run "stop" (steer) already closed the session; don't overwrite done
    // with error/await_approval when the killed run's null result lands here.
    if (this.#store.get(agentSessionId)?.phase === "done") return;
```

**(i) `steer()`** — add after `onPrompted`:

```ts
  // A comment arrived while a run is live. stop kills it; anything else is
  // injected into the running agent's inbox and its next reply posts back.
  async steer(ctx: IssueContext, replyText: string): Promise<void> {
    const acts = this.#makeActs(ctx.agentSessionId);
    const live = this.#live.get(ctx.agentSessionId);
    if (!live) {
      await acts.response("That run just finished — I couldn't pass your message to it. Reply again and I'll handle it.");
      return;
    }
    if (parseStopGate(replyText)) {
      console.log(`[steer] ${ctx.agentSessionId} stop requested mid-run — killing sandbox`);
      this.#store.setPhase(ctx.agentSessionId, "done");
      await acts.response("Stopped mid-run. Re-assign the issue to start over.");
      await live.kill().catch(() => undefined);
      return;
    }
    this.#record(live.runId, { kind: "user_message", text: replyText });
    live.replyPending = true;
    try {
      await injectMessage(live.sbx, replyText);
    } catch (err) {
      live.replyPending = false;
      await acts.error(`I couldn't pass your message to the running agent: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    await acts.thought("Got it — passing your message to the running agent.");
  }
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/orchestrator/pipeline.test.ts && npm run typecheck && npm test`
Expected: PASS — all pre-existing pipeline tests (reconcile, onPrompted guards) still green.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/pipeline.ts tests/orchestrator/pipeline.test.ts
git commit -m "feat: live-run registry, steer(), run telemetry wiring in orchestrator"
```

---

### Task 7: Server — route comments on live sessions to steer()

**Files:**
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `orchestrator.hasLive(id)`, `orchestrator.steer(ctx, reply)` from Task 6.

No new unit test — `makeServer` has no test file (repo convention: webhook wiring is covered by live acceptance); the routed-to logic (`steer`) is tested in Task 6.

- [ ] **Step 1: Implement**

In `src/server.ts`, restructure the `AgentSessionEvent` handler: the `inflight` check currently sits above both actions and would swallow mid-run comments. Move it into each branch:

```ts
  handler.on("AgentSessionEvent", async (payload: unknown) => {
    const action = (payload as { action?: string }).action;
    const ctx = extractContext(payload);
    if (!ctx.agentSessionId) return;
    const acts = makeActivities(linear, ctx.agentSessionId);
    console.log(`[webhook] AgentSessionEvent action=${action} session=${ctx.agentSessionId} issue=${JSON.stringify(ctx.title)}`);

    if (action === "created") {
      if (inflight.has(ctx.agentSessionId)) {
        console.log(`[skip] ${ctx.agentSessionId} already processing — dropping ${action}`);
        return;
      }
      inflight.add(ctx.agentSessionId);
      await acts.thought("On it — taking a look."); // 10s rule
      store.upsert(ctx.agentSessionId, "clarify", ctx.issueId);
      void orchestrator
        .onCreated(ctx)
        .catch((e) => {
          console.error(`[error] onCreated ${ctx.agentSessionId}:`, e?.message ?? e);
          acts.error(String(e?.message ?? e)).catch(() => undefined);
        })
        .finally(() => inflight.delete(ctx.agentSessionId));
    } else if (action === "prompted") {
      const reply = promptedBody(payload);
      if (!reply.trim()) {
        // Empty prompts (e.g. echoes of our own activities) would otherwise
        // loop; ignore them. Dump the shape once so we can confirm the field.
        console.log(`[webhook] prompted with EMPTY reply — ignoring. payload=${JSON.stringify(payload).slice(0, 400)}`);
        return;
      }
      console.log(`[webhook] prompted reply=${JSON.stringify(reply.slice(0, 80))}`);
      // A comment while a run is live steers the running agent — it must NOT be
      // dropped by the inflight guard (the run itself holds that flag).
      if (orchestrator.hasLive(ctx.agentSessionId)) {
        void orchestrator.steer(ctx, reply).catch((e) => {
          console.error(`[error] steer ${ctx.agentSessionId}:`, e?.message ?? e);
          acts.error(String(e?.message ?? e)).catch(() => undefined);
        });
        return;
      }
      if (inflight.has(ctx.agentSessionId)) {
        console.log(`[skip] ${ctx.agentSessionId} already processing — dropping ${action}`);
        return;
      }
      inflight.add(ctx.agentSessionId);
      void orchestrator
        .onPrompted(ctx, reply)
        .catch((e) => {
          console.error(`[error] onPrompted ${ctx.agentSessionId}:`, e?.message ?? e);
          acts.error(String(e?.message ?? e)).catch(() => undefined);
        })
        .finally(() => inflight.delete(ctx.agentSessionId));
    }
  });
```

- [ ] **Step 2: Run full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat: route comments on live sessions to steer() instead of dropping"
```

---

### Task 8: `npm run report` — failure-pattern mining

**Files:**
- Create: `src/report.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: `runs` / `run_events` tables (Task 1 schema) read directly via SQL.

No unit test — it's a read-only console report over SQL (trivial glue; verified by running it).

- [ ] **Step 1: Create `src/report.ts`:**

```ts
// Failure-pattern report over run telemetry. Usage: npm run report
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.env.JARVIS_DB ?? "jarvis.db", { readOnly: true });

console.log("=== Runs by task type and outcome ===");
const outcomes = db
  .prepare(
    `SELECT task_type, COALESCE(outcome, '(interrupted)') AS outcome, COUNT(*) AS n,
            ROUND(SUM(COALESCE(cost_usd, 0)), 4) AS cost
     FROM runs GROUP BY task_type, outcome ORDER BY n DESC`,
  )
  .all() as { task_type: string; outcome: string; n: number; cost: number }[];
for (const r of outcomes) console.log(`  ${r.task_type} / ${r.outcome}: ${r.n} runs ($${r.cost})`);

console.log("\n=== Failed tool results, grouped (top 30) ===");
const rows = db.prepare(`SELECT payload FROM run_events WHERE type = 'tool_result'`).all() as { payload: string }[];
const counts = new Map<string, number>();
for (const { payload } of rows) {
  try {
    const p = JSON.parse(payload) as { tool?: string | null; isError?: boolean; content?: string };
    if (!p.isError) continue;
    const firstLine = String(p.content ?? "").split("\n").find((l) => l.trim()) ?? "";
    const key = `${p.tool ?? "?"}: ${firstLine.slice(0, 120)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  } catch {
    // unparseable payload — skip
  }
}
const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
if (top.length === 0) console.log("  (none recorded)");
for (const [key, n] of top) console.log(`  ${String(n).padStart(4)}×  ${key}`);

console.log("\n=== Non-success runs (latest 10, last 3 events each) ===");
const errs = db
  .prepare(
    `SELECT id, task_type, outcome, error FROM runs
     WHERE outcome IS NOT NULL AND outcome != 'success'
     ORDER BY id DESC LIMIT 10`,
  )
  .all() as { id: number; task_type: string; outcome: string; error: string | null }[];
if (errs.length === 0) console.log("  (none)");
for (const r of errs) {
  console.log(`  run ${r.id} [${r.task_type}] ${r.outcome}${r.error ? ` — ${r.error.slice(0, 120)}` : ""}`);
  const evs = db
    .prepare(`SELECT ts, type, payload FROM run_events WHERE run_id = ? ORDER BY id DESC LIMIT 3`)
    .all(r.id) as { ts: string; type: string; payload: string }[];
  for (const e of evs.reverse()) console.log(`     ${e.ts} ${e.type} ${e.payload.slice(0, 140)}`);
}

db.close();
```

- [ ] **Step 2: Add the npm script**

In `package.json` scripts, after `"test:watch"`:

```json
    "report": "node --env-file-if-exists=.env src/report.ts"
```

- [ ] **Step 3: Verify it runs against the real DB**

Run: `npm run report`
Expected: prints the three section headers; sections may be `(none)` until telemetry accumulates. Also run `npm run typecheck` — PASS.

- [ ] **Step 4: Commit**

```bash
git add src/report.ts package.json
git commit -m "feat: npm run report — failure-pattern mining over run telemetry"
```

---

### Task 9: E2B template — Python + zod + rebuild

**Files:**
- Modify: `e2b/build-template.ts`

- [ ] **Step 1: Implement**

Two changes in `e2b/build-template.ts`:

```ts
  .aptInstall(["curl", "git", "ca-certificates", "python3", "python3-venv", "python3-pip"])
```

and (zod powers the runner's ask_user tool schema):

```ts
  .runCmd("cd /opt/jarvis-agent && npm init -y && npm i @anthropic-ai/claude-agent-sdk@^0.3.197 zod@^3")
```

- [ ] **Step 2: Rebuild the template**

Run: `node --env-file-if-exists=.env e2b/build-template.ts`
Expected: `Built template: jarvis-agent` (takes several minutes). Requires `E2B_API_KEY` in `.env`. The rebuild also bakes in Task 5's new runner.mjs.

- [ ] **Step 3: Commit**

```bash
git add e2b/build-template.ts
git commit -m "feat: bake python3/venv/pip + zod into the sandbox template"
```

---

### Task 10: Live acceptance (manual, with the user)

No files. Verifies the e2b/Linear paths that unit tests can't reach, per repo convention.

- [ ] **Step 1:** Start the server (`npm run dev`), assign a test issue to Jarvis in Linear.
- [ ] **Step 2:** While the plan run is live, post a comment (e.g. "keep it to one file"). Expect: a `thought` ("Got it — passing your message…") then a `response` from the agent acknowledging it, and the final plan reflecting it.
- [ ] **Step 3:** Approve; while implementing, post another steering comment. Expect same ack/reply behavior.
- [ ] **Step 4:** Trigger `ask_user` (use an issue with a deliberately ambiguous decision). Expect a **Jarvis asks:** elicitation; reply and expect the agent's reply + continued run. Also test the 10-minute timeout path once (don't reply): the agent should state its assumption and continue.
- [ ] **Step 5:** Post "stop" mid-run. Expect "Stopped mid-run." and session `done`, no follow-up error post.
- [ ] **Step 6:** After runs, `npm run report` shows the runs, events, and any failed tool results.
