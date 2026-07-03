# Same-Issue Session Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jarvis remembers all prior sessions on a Linear issue — the visible conversation is injected into every agent task's prompt, and the raw event logs of prior runs are exported into the sandbox as grep-able JSONL files the agent digs into on demand.

**Architecture:** Two channels, one per information density. (1) *Thread injection:* the visible Linear conversation (user prompts, Jarvis responses/errors/plans) for every session on the issue is fetched from Linear GraphQL (same pattern as `makePlanFetcher`) and appended to the task `goal` — per-run content, so prompt-cache-safe. (2) *Log export:* each prior run's raw `run_events` stream (every tool call, edit, test output) is written from the host DB into the sandbox at `/home/user/jarvis-history/run-<id>-<taskType>.jsonl` right after `cloneRepo()`; the goal tells the agent the files exist and to Grep them when it needs what a past run actually *did*. No new tools, no new host⇄sandbox protocol channel — files in, agent-native Grep out. Everything is advisory: any failure logs and the run proceeds without history.

**Tech Stack:** node:sqlite (existing tables, no migrations), Linear GraphQL over fetch, e2b `files.write`, vitest.

## Global Constraints

- Node ≥ 24.15.0; `.ts` imports carry explicit `.ts` extensions (`moduleResolution: nodenext`).
- `systemAppend` strings must stay **byte-identical** across runs (prompt cache) — all history goes into `goal`.
- History is **advisory end-to-end**: every failure path logs `[history]` and returns undefined/null/empty; no history failure may ever fail a session.
- Every deliberate ceiling gets a `// ponytail:` comment naming the ceiling and upgrade path.
- Tests fake e2b via the structural `AgentSandbox` interface — no real network/e2b in the suite. `withSandbox` orchestrator paths are covered by live acceptance, not unit tests (repo convention, see `tests/orchestrator/pipeline.test.ts:120-124`).
- Scope guard: same-issue memory only. No cross-issue search, no embeddings, no chat task — `// ponytail:` the upgrade path is a host-side retrieval tool if scope ever widens beyond one issue.

---

### Task 1: Store — prior sessions and run logs by issue

**Files:**
- Modify: `src/store/sessions.ts` (add `RunLog` interface, `listByIssue`, `getRunLogsBySession`)
- Test: `tests/store/sessions.test.ts`

**Interfaces:**
- Consumes: existing `sessions`, `runs`, `run_events` tables (no schema changes).
- Produces:
  - `interface RunLog { runId: number; taskType: string; startedAt: string; outcome: string | null; jsonl: string }` (exported from `src/store/sessions.ts`)
  - `SessionStore.listByIssue(issueId: string): SessionRow[]` — all sessions for the issue (including the caller's own), oldest-first by `updated_at`.
  - `SessionStore.getRunLogsBySession(agentSessionId: string): RunLog[]` — one entry per run, oldest-first, `jsonl` = newline-joined raw events.

- [ ] **Step 1: Write the failing tests**

Append to `tests/store/sessions.test.ts` (inside the top-level `describe("SessionStore", ...)` block, after the existing tests):

```ts
  it("listByIssue returns all sessions for the issue, oldest-first, and nothing else", () => {
    const s = new SessionStore(":memory:");
    s.upsert("as_h1", "done", "iss_h");
    s.upsert("as_h2", "error", "iss_h");
    s.upsert("as_other", "done", "iss_other");
    const rows = s.listByIssue("iss_h");
    expect(rows.map((r) => r.agentSessionId)).toEqual(["as_h1", "as_h2"]);
    expect(s.listByIssue("iss_missing")).toEqual([]);
    s.close();
  });

  it("getRunLogsBySession returns runs oldest-first with events joined as JSONL", () => {
    const s = new SessionStore(":memory:");
    s.upsert("as_h3", "implement", "iss_h3");
    const run1 = s.createRun("as_h3", "plan", "o/r");
    const run2 = s.createRun("as_h3", "implement", "o/r");
    s.addRunEvent(run1, "assistant_text", { kind: "assistant_text", text: "thinking" });
    s.addRunEvent(run2, "tool_use", { kind: "tool_use", name: "Bash", input: { command: "npm test" } });
    s.addRunEvent(run2, "result", { kind: "result", text: "https://github.com/o/r/pull/1" });

    const logs = s.getRunLogsBySession("as_h3");
    expect(logs.map((l) => l.taskType)).toEqual(["plan", "implement"]);
    expect(logs[0].runId).toBe(run1);

    const lines = logs[1].jsonl.split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first.type).toBe("tool_use");
    expect(first.payload.input.command).toBe("npm test");
    expect(first.ts).toBeTruthy();
    s.close();
  });

  it("getRunLogsBySession returns an empty jsonl for a run with no events, and [] for unknown sessions", () => {
    const s = new SessionStore(":memory:");
    s.upsert("as_h4", "plan", "iss_h4");
    s.createRun("as_h4", "map", "o/r");
    const logs = s.getRunLogsBySession("as_h4");
    expect(logs).toHaveLength(1);
    expect(logs[0].jsonl).toBe("");
    expect(s.getRunLogsBySession("as_nope")).toEqual([]);
    s.close();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/store/sessions.test.ts -t "listByIssue"`
Expected: FAIL with `s.listByIssue is not a function`

- [ ] **Step 3: Implement**

In `src/store/sessions.ts`, add after the `RunFinish` interface (line 27):

```ts
// One prior run's telemetry, packaged for export into the sandbox as a JSONL
// file (see src/history/history.ts). jsonl is the raw run_events stream.
export interface RunLog {
  runId: number;
  taskType: string;
  startedAt: string;
  outcome: string | null;
  jsonl: string;
}
```

Add two methods to `SessionStore`, after `findResumableByIssue` (line 293):

```ts
  // Session memory: every session for an issue (including the asking one),
  // oldest-first — the source list for thread assembly and log export.
  listByIssue(issueId: string): SessionRow[] {
    const rows = this.#db
      .prepare(
        `SELECT agent_session_id, phase, issue_id, branch, work_branch, plan, sandbox_id, pr_url, review, updated_at
         FROM sessions WHERE issue_id = ? ORDER BY updated_at ASC`,
      )
      .all(issueId) as {
      agent_session_id: string; phase: Phase; issue_id: string | null;
      branch: string | null; work_branch: string | null; plan: string | null;
      sandbox_id: string | null; pr_url: string | null; review: string | null; updated_at: string;
    }[];
    return rows.map((row) => ({
      agentSessionId: row.agent_session_id, phase: row.phase, issueId: row.issue_id,
      branch: row.branch, workBranch: row.work_branch, plan: row.plan,
      sandboxId: row.sandbox_id, prUrl: row.pr_url, review: row.review, updatedAt: row.updated_at,
    }));
  }

  // Raw event stream per run, oldest run first. payload is already a JSON
  // string in the DB — splice it in verbatim instead of parse/re-stringify.
  getRunLogsBySession(agentSessionId: string): RunLog[] {
    const runs = this.#db
      .prepare(`SELECT id, task_type, started_at, outcome FROM runs WHERE agent_session_id = ? ORDER BY id ASC`)
      .all(agentSessionId) as { id: number; task_type: string; started_at: string; outcome: string | null }[];
    return runs.map((r) => {
      const events = this.#db
        .prepare(`SELECT ts, type, payload FROM run_events WHERE run_id = ? ORDER BY id ASC`)
        .all(r.id) as { ts: string; type: string; payload: string }[];
      const jsonl = events
        .map((e) => `{"ts":${JSON.stringify(e.ts)},"type":${JSON.stringify(e.type)},"payload":${e.payload}}`)
        .join("\n");
      return { runId: r.id, taskType: r.task_type, startedAt: r.started_at, outcome: r.outcome, jsonl };
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/store/sessions.test.ts`
Expected: PASS (all, including pre-existing)

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/store/sessions.ts tests/store/sessions.test.ts
git commit -m "feat: store queries for same-issue session history (listByIssue, getRunLogsBySession)"
```

---

### Task 2: Linear — visible-thread fetcher

**Files:**
- Modify: `src/linear/client.ts` (add `makeThreadFetcher`)
- Test: `tests/linear/client.test.ts`

**Interfaces:**
- Consumes: nothing new — mirrors `makePlanFetcher`'s shape exactly (fetch injection, null-on-any-failure).
- Produces: `makeThreadFetcher(accessToken: string, fetchImpl?: typeof fetch): (agentSessionId: string) => Promise<string | null>` — the session's visible conversation as Markdown (`**Human:** …` / `**Jarvis:** …` blocks separated by blank lines), or null.

- [ ] **Step 1: Write the failing tests**

Append to `tests/linear/client.test.ts` (top level, after the `makePlanFetcher` describe; `jsonResponse` is already defined at module scope):

```ts
import { makeThreadFetcher } from "../../src/linear/client.ts";

function contentNode(typename: string, body: string) {
  return { content: { __typename: typename, body } };
}

describe("makeThreadFetcher", () => {
  it("renders prompts and responses as a labelled Markdown thread, in order", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: {
          agentSession: {
            activities: {
              nodes: [
                contentNode("AgentActivityPromptContent", "please fix the login bug"),
                contentNode("AgentActivityThoughtContent", "internal musing — must be skipped"),
                contentNode("AgentActivityElicitationContent", "Type: bug\nScope: small\n1. fix it"),
                contentNode("AgentActivityPromptContent", "approve"),
                contentNode("AgentActivityErrorContent", "PR could not be opened: tests failed"),
                contentNode("AgentActivityResponseContent", "Done. PR opened."),
              ],
            },
          },
        },
      }),
    );
    const fetchThread = makeThreadFetcher("token-123", fetchImpl as unknown as typeof fetch);
    const thread = await fetchThread("as_t1");
    expect(thread).toBe(
      "**Human:** please fix the login bug\n\n" +
        "**Jarvis (plan/question):** Type: bug\nScope: small\n1. fix it\n\n" +
        "**Human:** approve\n\n" +
        "**Jarvis (error):** PR could not be opened: tests failed\n\n" +
        "**Jarvis:** Done. PR opened.",
    );
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("https://api.linear.app/graphql");
    expect(JSON.parse(call[1].body as string).variables).toEqual({ id: "as_t1" });
  });

  it("returns null when the session has no renderable activities", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: {
          agentSession: {
            activities: { nodes: [contentNode("AgentActivityThoughtContent", "only noise")] },
          },
        },
      }),
    );
    const fetchThread = makeThreadFetcher("token-123", fetchImpl as unknown as typeof fetch);
    expect(await fetchThread("as_t2")).toBeNull();
  });

  it("returns null on HTTP failure, GraphQL errors, missing session, and thrown fetch", async () => {
    const cases: Array<() => Promise<Response>> = [
      async () => jsonResponse({ data: {} }, 500),
      async () => jsonResponse({ errors: [{ message: "bad" }] }),
      async () => jsonResponse({ data: { agentSession: null } }),
      async () => { throw new Error("network down"); },
    ];
    for (const impl of cases) {
      const fetchThread = makeThreadFetcher("token-123", vi.fn(impl) as unknown as typeof fetch);
      expect(await fetchThread("as_t3")).toBeNull();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/linear/client.test.ts -t "makeThreadFetcher"`
Expected: FAIL with `makeThreadFetcher` not exported (SyntaxError/undefined)

- [ ] **Step 3: Implement**

Append to `src/linear/client.ts`:

```ts
const THREAD_QUERY = `query($id: String!) { agentSession(id: $id) { activities(first: 250) { nodes { content { __typename ... on AgentActivityPromptContent { body } ... on AgentActivityResponseContent { body } ... on AgentActivityErrorContent { body } ... on AgentActivityElicitationContent { body } } } } } }`;

// Visible-thread speakers only. thought/action are telemetry noise — the raw
// run logs exported into the sandbox cover "what did the agent actually do".
const THREAD_LABELS: Record<string, string> = {
  AgentActivityPromptContent: "Human",
  AgentActivityResponseContent: "Jarvis",
  AgentActivityErrorContent: "Jarvis (error)",
  AgentActivityElicitationContent: "Jarvis (plan/question)",
};

interface ThreadQueryResponse {
  data?: {
    agentSession?: {
      activities?: { nodes?: ElicitationNode[] } | null;
    } | null;
  } | null;
  errors?: unknown;
}

/**
 * Fetch one agent session's visible conversation from Linear as Markdown —
 * the "session memory" thread injected into later runs on the same issue.
 * Same failure contract as makePlanFetcher: null on any error (advisory).
 * ponytail: first 250 activities, no pagination — a session that big has
 * bigger problems; add cursor paging if one ever hits the cap.
 */
export function makeThreadFetcher(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): (agentSessionId: string) => Promise<string | null> {
  return async (agentSessionId: string): Promise<string | null> => {
    try {
      const res = await fetchImpl("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ query: THREAD_QUERY, variables: { id: agentSessionId } }),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as ThreadQueryResponse;
      if (json.errors) return null;
      const nodes = json.data?.agentSession?.activities?.nodes ?? [];
      const blocks = nodes
        .map((n) => {
          const label = n.content?.__typename ? THREAD_LABELS[n.content.__typename] : undefined;
          const body = n.content?.body?.trim();
          return label && body ? `**${label}:** ${body}` : null;
        })
        .filter((b): b is string => b !== null);
      return blocks.length > 0 ? blocks.join("\n\n") : null;
    } catch {
      return null;
    }
  };
}
```

Note: `ElicitationNode` (line 11) already models `{ content?: { __typename?: string; body?: string } | null }` — reuse it, don't duplicate.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/linear/client.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/linear/client.ts tests/linear/client.test.ts
git commit -m "feat: makeThreadFetcher — visible Linear conversation per agent session"
```

---

### Task 3: History module — assemble, export, render

**Files:**
- Create: `src/history/history.ts`
- Test: `tests/history/history.test.ts`

**Interfaces:**
- Consumes: `RunLog` + `SessionStore.listByIssue`/`getRunLogsBySession` (Task 1), a thread fetcher `(id) => Promise<string | null>` (Task 2's shape), `AgentSandbox` (structural, from `src/sandbox/session.ts`).
- Produces (all exported from `src/history/history.ts`):
  - `HISTORY_DIR = "/home/user/jarvis-history"`, `THREAD_CHAR_CAP = 20_000`, `MAX_EXPORTED_RUNS = 10`, `MAX_FILE_BYTES = 1_000_000`
  - `type ThreadFetcher = (agentSessionId: string) => Promise<string | null>`
  - `assembleThread(sessionIds: string[], fetchThread: ThreadFetcher): Promise<string | null>`
  - `writeHistoryFiles(sbx: AgentSandbox, logs: RunLog[]): Promise<string[]>` — returns basenames written
  - `renderHistory(thread: string | null, files: string[]): string | undefined`
  - `prepareHistory(store, sbx, issueId, fetchThread?): Promise<string | undefined>` — the one call sites use

- [ ] **Step 1: Write the failing tests**

Create `tests/history/history.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import {
  HISTORY_DIR, THREAD_CHAR_CAP, MAX_EXPORTED_RUNS,
  assembleThread, writeHistoryFiles, renderHistory, prepareHistory,
} from "../../src/history/history.ts";
import { SessionStore, type RunLog } from "../../src/store/sessions.ts";
import type { AgentSandbox } from "../../src/sandbox/session.ts";

function fakeSbx(): { sbx: AgentSandbox; writes: Map<string, string> } {
  const writes = new Map<string, string>();
  const sbx: AgentSandbox = {
    files: {
      read: async () => { throw new Error("not used"); },
      write: async (path: string, data: string) => { writes.set(path, data); },
    },
    commands: { run: async () => ({ exitCode: 0 }), list: async () => [] },
  };
  return { sbx, writes };
}

function runLog(runId: number, taskType: string, jsonl: string): RunLog {
  return { runId, taskType, startedAt: "2026-07-03T00:00:00Z", outcome: "success", jsonl };
}

describe("assembleThread", () => {
  it("joins per-session threads with separators, skipping empty and failed sessions", async () => {
    const fetchThread = vi.fn(async (id: string) => {
      if (id === "s1") return "**Human:** hi";
      if (id === "s2") return null;
      if (id === "s3") throw new Error("boom");
      return "**Jarvis:** done";
    });
    const out = await assembleThread(["s1", "s2", "s3", "s4"], fetchThread);
    expect(out).toBe("**Human:** hi\n\n---\n\n**Jarvis:** done");
  });

  it("returns null when nothing is fetchable", async () => {
    expect(await assembleThread(["s1"], async () => null)).toBeNull();
  });

  it("caps the assembled thread, keeping the newest tail", async () => {
    const big = "x".repeat(THREAD_CHAR_CAP);
    const out = await assembleThread(["s1", "s2"], async (id) => (id === "s1" ? big : "TAIL_MARKER"));
    expect(out!.length).toBeLessThanOrEqual(THREAD_CHAR_CAP + 100);
    expect(out).toContain("TAIL_MARKER");
    expect(out!.startsWith("…(older conversation truncated)")).toBe(true);
  });
});

describe("writeHistoryFiles", () => {
  it("writes one JSONL file per run under HISTORY_DIR and returns the basenames", async () => {
    const { sbx, writes } = fakeSbx();
    const files = await writeHistoryFiles(sbx, [runLog(7, "plan", '{"a":1}'), runLog(9, "implement", '{"b":2}')]);
    expect(files).toEqual(["run-7-plan.jsonl", "run-9-implement.jsonl"]);
    expect(writes.get(`${HISTORY_DIR}/run-7-plan.jsonl`)).toBe('{"a":1}');
  });

  it("skips empty logs, keeps only the most recent MAX_EXPORTED_RUNS, and survives write failures", async () => {
    const logs: RunLog[] = [runLog(1, "map", "")];
    for (let i = 2; i <= MAX_EXPORTED_RUNS + 3; i++) logs.push(runLog(i, "plan", `{"i":${i}}`));
    const { sbx, writes } = fakeSbx();
    // run-N (the newest) is inside the kept slice(-MAX_EXPORTED_RUNS) window,
    // so its write failure genuinely exercises the skip-that-file-only path.
    const failing = `run-${MAX_EXPORTED_RUNS + 3}-plan.jsonl`;
    sbx.files.write = async (path: string, data: string) => {
      if (path.endsWith(failing)) throw new Error("e2b 500");
      writes.set(path, data);
    };
    const files = await writeHistoryFiles(sbx, logs);
    expect(files).toHaveLength(MAX_EXPORTED_RUNS - 1);
    expect(files).not.toContain("run-1-map.jsonl"); // empty jsonl → filtered
    expect(files).not.toContain(failing); // write threw → skipped, not fatal
    expect(files).toContain(`run-${MAX_EXPORTED_RUNS + 2}-plan.jsonl`);
  });
});

describe("renderHistory", () => {
  it("returns undefined when there is neither thread nor files", () => {
    expect(renderHistory(null, [])).toBeUndefined();
  });

  it("includes the thread and the grep pointer when both exist", () => {
    const out = renderHistory("**Human:** hi", ["run-1-plan.jsonl"]);
    expect(out).toContain("**Human:** hi");
    expect(out).toContain(HISTORY_DIR);
    expect(out).toContain("run-1-plan.jsonl");
  });

  it("renders thread-only and files-only variants", () => {
    expect(renderHistory("**Human:** hi", [])).toContain("**Human:** hi");
    expect(renderHistory("**Human:** hi", [])).not.toContain(HISTORY_DIR);
    expect(renderHistory(null, ["run-1-plan.jsonl"])).toContain(HISTORY_DIR);
  });
});

describe("prepareHistory", () => {
  function seededStore(): SessionStore {
    const s = new SessionStore(":memory:");
    s.upsert("as_old", "error", "iss_1");
    const run = s.createRun("as_old", "implement", "o/r");
    s.addRunEvent(run, "tool_use", { kind: "tool_use", name: "Bash", input: { command: "npm test" } });
    s.upsert("as_new", "plan", "iss_1");
    return s;
  }

  it("assembles thread + writes logs + renders the combined block", async () => {
    const store = seededStore();
    const { sbx, writes } = fakeSbx();
    const out = await prepareHistory(store, sbx, "iss_1", async () => "**Human:** old chat");
    expect(out).toContain("**Human:** old chat");
    expect(out).toContain(HISTORY_DIR);
    expect([...writes.keys()].some((k) => k.startsWith(HISTORY_DIR))).toBe(true);
    store.close();
  });

  it("returns undefined for a null issue, an unknown issue, and on store failure", async () => {
    const store = seededStore();
    const { sbx } = fakeSbx();
    expect(await prepareHistory(store, sbx, null)).toBeUndefined();
    expect(await prepareHistory(store, sbx, "iss_none")).toBeUndefined();
    store.close(); // closed DB → listByIssue throws → advisory undefined
    expect(await prepareHistory(store, sbx, "iss_1")).toBeUndefined();
  });

  it("works without a thread fetcher (logs-only)", async () => {
    const store = seededStore();
    const { sbx } = fakeSbx();
    const out = await prepareHistory(store, sbx, "iss_1");
    expect(out).toContain(HISTORY_DIR);
    expect(out).not.toContain("**Human:**");
    store.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/history/history.test.ts`
Expected: FAIL — cannot resolve `src/history/history.ts`

- [ ] **Step 3: Implement**

Create `src/history/history.ts`:

```ts
import type { AgentSandbox } from "../sandbox/session.ts";
import type { SessionStore, RunLog } from "../store/sessions.ts";

// Where prior runs' raw event logs land inside the sandbox. Outside REPO_DIR
// (/home/user/repo) so the agent can't accidentally commit them; inside
// /home/user so the default sandbox user can write there.
export const HISTORY_DIR = "/home/user/jarvis-history";

// Injected-thread budget. ponytail: char cap with keep-the-tail truncation,
// no summarisation — upgrade to an LLM summary pass if long threads start
// costing real prompt tokens.
export const THREAD_CHAR_CAP = 20_000;

// Export bounds. ponytail: newest N runs, tail-sliced files — a tail slice can
// cut the first line mid-JSON, which grep tolerates; upgrade to line-aligned
// slicing if it ever confuses an agent.
export const MAX_EXPORTED_RUNS = 10;
export const MAX_FILE_BYTES = 1_000_000;

export type ThreadFetcher = (agentSessionId: string) => Promise<string | null>;

/** Concatenate each session's visible thread, oldest-first; cap keeping the newest tail. */
export async function assembleThread(sessionIds: string[], fetchThread: ThreadFetcher): Promise<string | null> {
  const parts: string[] = [];
  for (const id of sessionIds) {
    try {
      const t = await fetchThread(id);
      if (t && t.trim()) parts.push(t.trim());
    } catch (err) {
      console.error(`[history] thread fetch failed for ${id} (advisory): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (parts.length === 0) return null;
  let out = parts.join("\n\n---\n\n");
  if (out.length > THREAD_CHAR_CAP) {
    out = `…(older conversation truncated)\n${out.slice(-THREAD_CHAR_CAP)}`;
  }
  return out;
}

/** Write the newest runs' JSONL into the sandbox; per-file failures skip that file only. */
export async function writeHistoryFiles(sbx: AgentSandbox, logs: RunLog[]): Promise<string[]> {
  const recent = logs.filter((l) => l.jsonl).slice(-MAX_EXPORTED_RUNS);
  const written: string[] = [];
  for (const log of recent) {
    const name = `run-${log.runId}-${log.taskType}.jsonl`;
    const data = log.jsonl.length > MAX_FILE_BYTES ? log.jsonl.slice(-MAX_FILE_BYTES) : log.jsonl;
    try {
      await sbx.files.write(`${HISTORY_DIR}/${name}`, data);
      written.push(name);
    } catch (err) {
      console.error(`[history] write ${name} failed (advisory): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return written;
}

/** The goal-injectable history block: thread text + a grep pointer at the exported logs. */
export function renderHistory(thread: string | null, files: string[]): string | undefined {
  const sections: string[] = [];
  if (thread) {
    sections.push(`Conversation from prior sessions on this issue (oldest first):\n\n${thread}`);
  }
  if (files.length > 0) {
    sections.push(
      `Raw event logs from prior runs are in ${HISTORY_DIR}/ (${files.join(", ")}). ` +
        `Each line is one JSON event (tool_use, tool_result, assistant_text, result). ` +
        `Grep them when you need what a past run actually did — files edited, commands run, ` +
        `test output, failure messages. Do not read them wholesale and never commit them.`,
    );
  }
  if (sections.length === 0) return undefined;
  return sections.join("\n\n");
}

/**
 * The one-call entry point for the orchestrator: gather this issue's prior
 * sessions, fetch their visible threads, export their run logs into the
 * sandbox, and render the goal block. Advisory end-to-end — any failure
 * returns undefined and the run proceeds without history.
 */
export async function prepareHistory(
  store: Pick<SessionStore, "listByIssue" | "getRunLogsBySession">,
  sbx: AgentSandbox,
  issueId: string | null,
  fetchThread?: ThreadFetcher,
): Promise<string | undefined> {
  if (!issueId) return undefined;
  try {
    const sessions = store.listByIssue(issueId);
    if (sessions.length === 0) return undefined;
    const ids = sessions.map((s) => s.agentSessionId);
    const thread = fetchThread ? await assembleThread(ids, fetchThread) : null;
    const logs = ids.flatMap((id) => store.getRunLogsBySession(id));
    const files = await writeHistoryFiles(sbx, logs);
    return renderHistory(thread, files);
  } catch (err) {
    console.error(`[history] prepareHistory failed (advisory): ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/history/history.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/history/history.ts tests/history/history.test.ts
git commit -m "feat: history module — assemble issue thread, export run logs into sandbox"
```

---

### Task 4: Tasks — history block in every repo task's goal

**Files:**
- Modify: `src/agent/tasks.ts` (add `historyBlock`, thread a `history?: string` param through `planTask`, `reviseTask`, `implementTask`, `reviewTask`)
- Test: `tests/agent/tasks.test.ts`

**Interfaces:**
- Consumes: the rendered history string from `renderHistory`/`prepareHistory` (Task 3) — tasks treat it as an opaque per-run string.
- Produces (signature changes — all new params optional and last, so existing callers compile unchanged):
  - `planTask(ctx, repoMap?, history?)`
  - `reviseTask(ctx, previousPlan, feedback, repoMap?, history?)`
  - `implementTask(ctx, approvedPlan, repoMap?, workBranch?, history?)`
  - `reviewTask(ctx, prUrl, plan, userMessage, repoMap?, history?)`
  - `mapTask()` unchanged (repo-level, issue history is irrelevant).

- [ ] **Step 1: Write the failing tests**

Append to `tests/agent/tasks.test.ts` (reuse the file's existing `IssueContext` fixture if one exists; otherwise this local one):

```ts
import { planTask, reviseTask, implementTask, reviewTask } from "../../src/agent/tasks.ts";
import type { IssueContext } from "../../src/linear/context.ts";

const hctx: IssueContext = {
  agentSessionId: "as_hist", organizationId: "org", issueId: "iss",
  title: "t", description: "d", comment: "", promptContext: "",
};
const HISTORY = "Conversation from prior sessions on this issue (oldest first):\n\n**Human:** hi";

describe("history injection", () => {
  it("appends history to the goal of plan/revise/implement/review when provided", () => {
    expect(planTask(hctx, undefined, HISTORY).goal).toContain(HISTORY);
    expect(reviseTask(hctx, "old plan", "feedback", undefined, HISTORY).goal).toContain(HISTORY);
    expect(implementTask(hctx, "Type: chore\nScope: small\nplan", undefined, "jarvis/iss", HISTORY).goal).toContain(HISTORY);
    expect(reviewTask(hctx, "https://github.com/o/r/pull/1", null, null, undefined, HISTORY).goal).toContain(HISTORY);
  });

  it("omits the history section entirely when absent", () => {
    expect(planTask(hctx).goal).not.toContain("prior sessions");
    expect(reviewTask(hctx, "https://github.com/o/r/pull/1", null, null).goal).not.toContain("prior sessions");
  });

  it("never touches systemAppend (prompt-cache byte-stability)", () => {
    expect(planTask(hctx, undefined, HISTORY).systemAppend).toBe(planTask(hctx).systemAppend);
    expect(implementTask(hctx, "Type: chore\nScope: small\nplan", undefined, undefined, HISTORY).systemAppend)
      .toBe(implementTask(hctx, "Type: chore\nScope: small\nplan").systemAppend);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/agent/tasks.test.ts -t "history injection"`
Expected: FAIL — goal does not contain the history string (extra args are silently ignored until the params exist)

- [ ] **Step 3: Implement**

In `src/agent/tasks.ts`, add below `repoMapBlock` (line 122):

```ts
// Per-run content only — same cache rule as repoMapBlock. The string arrives
// pre-rendered from src/history/history.ts (thread + grep pointer).
function historyBlock(history?: string): string {
  if (!history) return "";
  return `\n\n---\nHistory — prior sessions on this issue:\n${history}`;
}
```

Then, for each of the four builders, add the optional trailing param and append the block to the goal template:

- `planTask(ctx: IssueContext, repoMap?: string, history?: string)` — goal ends `...${repoMapBlock(repoMap)}${historyBlock(history)}`
- `reviseTask(ctx: IssueContext, previousPlan: string, feedback: string, repoMap?: string, history?: string)` — goal ends `...${issueBlock(ctx)}${repoMapBlock(repoMap)}${historyBlock(history)}`
- `implementTask(ctx: IssueContext, approvedPlan: string, repoMap?: string, workBranch?: string, history?: string)` — goal ends `...${issueBlock(ctx)}${repoMapBlock(repoMap)}${historyBlock(history)}`
- `reviewTask(ctx: IssueContext, prUrl: string, plan: string | null, userMessage: string | null, repoMap?: string, history?: string)` — goal ends `...${issueBlock(ctx)}${repoMapBlock(repoMap)}${historyBlock(history)}`

Do NOT touch any `*_APPEND` constant or `mapTask()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/agent/tasks.test.ts`
Expected: PASS (new and pre-existing — pre-existing callers pass fewer args, params are optional)

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/agent/tasks.ts tests/agent/tasks.test.ts
git commit -m "feat: optional history block appended to plan/revise/implement/review goals"
```

---

### Task 5: Orchestrator + server wiring, docs

**Files:**
- Modify: `src/orchestrator/pipeline.ts` (thread `prepareHistory` into the four sandbox call sites; new optional `fetchThread` constructor param)
- Modify: `src/server.ts:16` (pass `makeThreadFetcher`)
- Modify: `CLAUDE.md` (document session memory in Architecture)
- Test: `npm test` (full suite) — the `withSandbox` paths themselves are live-acceptance territory per repo convention (`tests/orchestrator/pipeline.test.ts:120-124`); this task adds no unit test, it must not break any existing one.

**Interfaces:**
- Consumes: `prepareHistory` + `ThreadFetcher` (Task 3), `makeThreadFetcher` (Task 2), the new task-builder params (Task 4).
- Produces: `Orchestrator` constructor gains a **6th** optional param `fetchThread?: ThreadFetcher` (after `connect` — existing positional callers, including tests that pass `connect` fifth, stay valid).

- [ ] **Step 1: Wire the orchestrator**

In `src/orchestrator/pipeline.ts`:

1. Add imports:

```ts
import { prepareHistory, type ThreadFetcher } from "../history/history.ts";
```

2. Add a private field after `#fetchPlan` (line 86) and the constructor param after `connect` (line 102), assigning it in the body:

```ts
  #fetchThread?: ThreadFetcher;
```

```ts
    connect?: (sandboxId: string) => Promise<Reconnected>,
    fetchThread?: ThreadFetcher,
```

```ts
    this.#fetchThread = fetchThread;
```

3. In `#runPlan` (line 314), after the map block and before the plan run (line 344), replace the return with:

```ts
      const history = await prepareHistory(this.#store, sbx, ctx.issueId, this.#fetchThread);
      return this.#trackedRun(ctx.agentSessionId, "plan", sbx, planTask(ctx, map, history), acts);
```

4. In `onPrompted`'s revision branch (line 434-438), inside the `withSandbox` callback after `cloneRepo`:

```ts
        const history = await prepareHistory(this.#store, sbx, ctx.issueId, this.#fetchThread);
        return this.#trackedRun(ctx.agentSessionId, "revise", sbx, reviseTask(ctx, plan, replyText, map, history), acts);
```

5. In `#runImplement` (line 466-469), inside the `withSandbox` callback after `cloneRepo`:

```ts
      const history = await prepareHistory(this.#store, sbx, ctx.issueId, this.#fetchThread);
      const r = await this.#trackedRun(ctx.agentSessionId, "implement", sbx, implementTask(ctx, plan, map, workBranch, history), acts);
```

6. In `#onDoneFollowUp` (line 567-571), inside the `withSandbox` callback after `cloneRepo`:

```ts
        const history = await prepareHistory(this.#store, sbx, ctx.issueId, this.#fetchThread);
        return this.#trackedRun(ctx.agentSessionId, "review", sbx, reviewTask(ctx, row.prUrl!, row.plan, replyText, map, history), acts);
```

7. `#maybeSelfReview` stays history-free on purpose — it reviews the diff its own run just produced, in the same sandbox; add this comment above its `reviewTask` call:

```ts
      // No history block here: self-review runs in the implement run's own
      // sandbox against its own fresh diff — prior-session context adds tokens,
      // not signal. On-demand reviews (#onDoneFollowUp) do get history.
```

- [ ] **Step 2: Wire the server**

In `src/server.ts`, extend the import (line 5) and the constructor call (line 16):

```ts
import { makeLinearClient, makePlanFetcher, makeThreadFetcher } from "./linear/client.ts";
```

```ts
  const orchestrator = new Orchestrator(
    config,
    store,
    (id) => makeActivities(linear, id),
    makePlanFetcher(config.linear.accessToken),
    undefined, // connect: default real e2b reconnect
    makeThreadFetcher(config.linear.accessToken),
  );
```

- [ ] **Step 3: Run the full suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS — zero test edits in this task; any failure means the wiring changed observable behavior and must be fixed, not the test.

- [ ] **Step 4: Document**

In `CLAUDE.md`, add to the Architecture section (after "The sandbox ⇄ host protocol"):

```markdown
### Session memory (`src/history/history.ts`)

Every plan/revise/implement/review run gets same-issue memory, assembled by
`prepareHistory()` right after `cloneRepo()`: (1) the visible Linear
conversation of every session on the issue (fetched via `makeThreadFetcher`,
capped at 20k chars keeping the newest) is appended to the task `goal` —
per-run content, so prompt-cache-safe; (2) the newest 10 prior runs' raw
`run_events` streams are exported into the sandbox at
`/home/user/jarvis-history/run-<id>-<taskType>.jsonl` and the goal tells the
agent to Grep them on demand. Advisory end-to-end: any failure logs
`[history]` and the run proceeds memory-less. `// ponytail:` same-issue scope
only; upgrade path for cross-issue memory is a host-side retrieval tool.
```

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/pipeline.ts src/server.ts CLAUDE.md
git commit -m "feat: same-issue session memory wired into all repo task runs"
```

---

## Out of scope (named, not forgotten)

- **Cross-issue / repo-wide memory** — needs real retrieval (host-side tool or MCP); the `// ponytail:` comments mark the seam.
- **A general chat task** for `error`/`done-without-PR` phases — separate feature; this plan makes the *existing* conversational surfaces (revision loop, done-follow-up review) history-aware.
- **DB-loss recovery via Linear** — `prepareHistory` reads session ids from SQLite; with a wiped DB there is no history (and separately, `onCreated` resume still re-plans). Wiring `makeThreadFetcher`+issue-level session discovery into that path is its own small follow-up.

## Live acceptance (after merge)

1. On an issue with a completed (or failed) prior session, re-assign Jarvis → the plan elicitation should reference prior context, and the run's `tool_use` telemetry should show Grep hits under `/home/user/jarvis-history/` when the issue asks about past behavior.
2. Reply to a done-with-PR session with "what did the previous run change and why?" → the review report should cite specifics from prior run logs.
3. `npm run report` still parses run telemetry (no `run_events` schema change was made).
