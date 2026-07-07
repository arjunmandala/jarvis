# Linear Docs & File Attachments as Agent Context — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Jarvis's agents two missing context sources — Linear documents (via a uniform MCP tool in both tiers, plus up-front injection of ticket-attached docs) and non-image file attachments (all formats) — and make every existing session-memory truncation recoverable through the same MCP tools.

**Architecture:** A new hand-rolled streamable-HTTP MCP endpoint (`POST /mcp/docs`) on the existing Hono server exposes four read-only tools (`search_documents`, `get_document`, `get_thread`, `get_run_events`), authed by a random per-run bearer token held in an in-memory registry and scoped to the run's issue. Ticket-attached docs are assembled host-side and appended to the task `goal` (per-run, prompt-cache-safe). File attachments generalize the existing image path with content-type routing. Every truncation marker (doc cap, injected thread, exported run logs) names the tool call that recovers the full content. Advisory end-to-end — every new path fails soft, matching the history/serena/workflow precedent.

**Tech Stack:** TypeScript (Node ≥24.15, `node:sqlite`, `moduleResolution: nodenext` with `.ts` import extensions), Hono, Linear GraphQL over raw `fetch`, `@anthropic-ai/claude-agent-sdk`, E2B, Vitest.

## Global Constraints

- **`.ts` imports use explicit `.ts` extensions** (`import { x } from "./y.ts"`) — normal in this repo, not a mistake.
- **`systemAppend` strings must stay byte-stable across runs** — never interpolate per-run content into them (Agent SDK prompt cache). All per-run content (issue text, docs, plan, history) goes in `goal`.
- **Advisory end-to-end**: any doc fetch, attachment download, MCP registration, or tool-call failure **logs** (`[docs]` / `[attachments]`) and the run proceeds without that context. No new run-blocking dependencies. Tool-call failures return an error string to the agent, never wedge the run.
- **No silent truncation anywhere**: a capped/sliced payload must carry a marker naming the recovering tool call, or be fully retrievable.
- **The Linear OAuth token never enters the sandbox.** Doc/thread/run-event reads happen host-side, gated by the per-run bearer token (issue-scoped).
- **No new npm dependency** — the MCP endpoint is hand-rolled JSON-RPC on the existing Hono server.
- **`src/agent/runner.mjs` is plain JS**, copied verbatim into the E2B template by `e2b/build-template.ts`; it is not type-checked or unit-tested. Any change to it (or to the template) **requires a template rebuild** (`node --env-file-if-exists=.env e2b/build-template.ts`) before it takes effect in sandboxes.
- **Tests never touch the network or real e2b** — fake `fetch`, fake the `AgentSandbox` structural interface, use `SessionStore(":memory:")`.
- Commands: `npm test` (vitest run), `npx vitest run <file>` (single file), `npx vitest run <file> -t "<name>"` (single test), `npm run typecheck`.

---

## File Structure

**New files:**
- `src/linear/docs.ts` — Linear docs GraphQL layer (`searchDocuments`, `getDocumentContent`) + up-front doc-context assembly (`assembleDocContext` and its helpers) + the `DOC_FETCH_CEILING` / `DOC_CONTEXT_CAP` / `sliceWithMarker` primitives shared by the MCP tools and the injector.
- `src/mcp/docs-server.ts` — the `RunTokenRegistry` (mint/resolve/revoke) and the transport-agnostic `handleDocsMcp` JSON-RPC dispatcher wiring the four tools to `docs.ts` + the store + the thread fetcher.
- `tests/linear/docs.test.ts`, `tests/mcp/docs-server.test.ts` — unit tests for the two new modules.

**Modified files:**
- `src/store/sessions.ts` — add issue-scoped run-event reads (`getRunIndexByIssue`, `getRunJsonl`) for `get_run_events`.
- `src/history/history.ts` — recoverable truncation markers (thread + exported run logs), an uncapped `assembleThread` mode, and an "older runs exist" note.
- `src/agent/tasks.ts` — `DocsMcpConfig` + `docsMcp`/`docsContext` fields on `AgentTask`, `docsBlock()` goal injector, `mcp__docs` in `ALL_REPO_TOOLS`, thread both through every task builder.
- `src/agent/converse.ts` — thread `docsMcp`/`docsContext` through `converseTask`.
- `src/agent/host-turn.ts` — register the docs HTTP MCP server, widen the tool allowlist/deny gate, accept `docsContext` + attachment content blocks.
- `src/agent/runner.mjs` — register the docs HTTP MCP server from `task.docsMcp`.
- `src/orchestrator/pipeline.ts` — mint/revoke run tokens, pass `docsMcp` + doc context to every task, generalize `#extractImages` → attachments.
- `src/server.ts` — mount `POST /mcp/docs`, construct the registry, thread it into the `Orchestrator`.
- `src/linear/attachments.ts` — generalize image extraction/download to all `uploads.linear.app` attachments with content-type routing.
- `e2b/build-template.ts` — apt-install `pandoc` + `poppler-utils` for in-sandbox office/PDF conversion.

---

## Task 1: Linear docs GraphQL layer (`searchDocuments`, `getDocumentContent`)

**Files:**
- Create: `src/linear/docs.ts`
- Test: `tests/linear/docs.test.ts`

**Interfaces:**
- Consumes: `fetchWithAuth`, `TokenSource` from `src/linear/client.ts`.
- Produces:
  - `interface DocSearchResult { id: string; title: string; project: string | null; snippet: string }`
  - `interface DocContent { id: string; title: string; content: string }`
  - `const DOC_FETCH_CEILING = 100_000`
  - `function sliceWithMarker(content: string, offset: number, ceiling: number, marker: (nextOffset: number) => string): string`
  - `function searchDocuments(token: TokenSource, query: string, opts?: { first?: number; fetchImpl?: typeof fetch; onUnauthorized?: () => Promise<string> }): Promise<DocSearchResult[]>`
  - `function getDocumentContent(token: TokenSource, id: string, opts?: { fetchImpl?: typeof fetch; onUnauthorized?: () => Promise<string> }): Promise<DocContent | null>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/linear/docs.test.ts
import { describe, it, expect, vi } from "vitest";
import {
  sliceWithMarker, DOC_FETCH_CEILING, searchDocuments, getDocumentContent,
} from "../../src/linear/docs.ts";

function gqlResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("sliceWithMarker", () => {
  it("returns full content untouched when under the ceiling", () => {
    expect(sliceWithMarker("hello world", 0, 100, (n) => `[cut ${n}]`)).toBe("hello world");
  });
  it("slices from offset and appends the marker when content exceeds offset+ceiling", () => {
    const body = "0123456789";
    const out = sliceWithMarker(body, 2, 3, (n) => `[cut ${n}]`);
    expect(out).toBe("234[cut 5]");
  });
  it("no marker when the slice reaches the end exactly", () => {
    expect(sliceWithMarker("0123456789", 5, 5, (n) => `[cut ${n}]`)).toBe("56789");
  });
});

describe("searchDocuments", () => {
  it("maps nodes to id/title/project/snippet", async () => {
    const fetchImpl = vi.fn(async () =>
      gqlResponse({ searchDocuments: { nodes: [
        { id: "d1", title: "Runbook", project: { name: "Infra" }, content: "line one\nline two\nline three" },
        { id: "d2", title: "Spec", project: null, content: "" },
      ] } }),
    );
    const out = await searchDocuments("tok", "runbook", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toEqual([
      { id: "d1", title: "Runbook", project: "Infra", snippet: "line one line two line three" },
      { id: "d2", title: "Spec", project: null, snippet: "" },
    ]);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ authorization: "Bearer tok" });
  });
  it("returns [] on a GraphQL error or non-200 (advisory)", async () => {
    expect(await searchDocuments("t", "q", { fetchImpl: (async () => new Response("", { status: 500 })) as unknown as typeof fetch })).toEqual([]);
    const errBody = (async () => new Response(JSON.stringify({ errors: [{ message: "nope" }] }), { status: 200 })) as unknown as typeof fetch;
    expect(await searchDocuments("t", "q", { fetchImpl: errBody })).toEqual([]);
  });
});

describe("getDocumentContent", () => {
  it("returns id/title/content", async () => {
    const fetchImpl = (async () => gqlResponse({ document: { id: "d1", title: "T", content: "BODY" } })) as unknown as typeof fetch;
    expect(await getDocumentContent("t", "d1", { fetchImpl })).toEqual({ id: "d1", title: "T", content: "BODY" });
  });
  it("returns null when the document is missing or the call fails", async () => {
    expect(await getDocumentContent("t", "d1", { fetchImpl: (async () => gqlResponse({ document: null })) as unknown as typeof fetch })).toBeNull();
    expect(await getDocumentContent("t", "d1", { fetchImpl: (async () => new Response("", { status: 500 })) as unknown as typeof fetch })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/linear/docs.test.ts`
Expected: FAIL — `Cannot find module '../../src/linear/docs.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/linear/docs.ts
import { fetchWithAuth, type TokenSource } from "./client.ts";

const GRAPHQL = "https://api.linear.app/graphql";

// A generous safety ceiling for a single doc fetch. Only pathological docs hit
// it; a hit returns an explicit marker so the agent knows to page, never a
// silent cut. ponytail: char count, not tokens — the point is "never hallucinate
// the missing part", not a precise token budget.
export const DOC_FETCH_CEILING = 100_000;

export interface DocSearchResult { id: string; title: string; project: string | null; snippet: string }
export interface DocContent { id: string; title: string; content: string }

/** Slice `content` from `offset`; if more than `ceiling` chars remain, cut at the
 *  ceiling and append `marker(nextOffset)`. Under the ceiling → returned verbatim. */
export function sliceWithMarker(
  content: string,
  offset: number,
  ceiling: number,
  marker: (nextOffset: number) => string,
): string {
  const start = Math.max(0, offset);
  const slice = content.slice(start, start + ceiling);
  const nextOffset = start + ceiling;
  return nextOffset < content.length ? `${slice}${marker(nextOffset)}` : slice;
}

async function gql<T>(
  token: TokenSource,
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: typeof fetch,
  onUnauthorized?: () => Promise<string>,
): Promise<T | null> {
  try {
    const res = await fetchWithAuth(
      GRAPHQL,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }) },
      token, fetchImpl, onUnauthorized,
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: T; errors?: unknown };
    if (json.errors || !json.data) return null;
    return json.data;
  } catch (err) {
    console.error(`[docs] gql failed (advisory): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

const SEARCH_QUERY =
  `query($q: String!, $first: Int!) { searchDocuments(term: $q, first: $first) { nodes { id title project { name } content } } }`;

const DOC_QUERY = `query($id: String!) { document(id: $id) { id title content } }`;

interface SearchData { searchDocuments?: { nodes?: { id: string; title?: string; project?: { name?: string } | null; content?: string }[] } }

/** Search workspace documents. Advisory: [] on any failure. */
export async function searchDocuments(
  token: TokenSource,
  query: string,
  opts: { first?: number; fetchImpl?: typeof fetch; onUnauthorized?: () => Promise<string> } = {},
): Promise<DocSearchResult[]> {
  const data = await gql<SearchData>(token, SEARCH_QUERY, { q: query, first: opts.first ?? 20 }, opts.fetchImpl ?? fetch, opts.onUnauthorized);
  const nodes = data?.searchDocuments?.nodes ?? [];
  return nodes.map((n) => ({
    id: n.id,
    title: n.title ?? "",
    project: n.project?.name ?? null,
    // A short one-line snippet; the agent pulls the full doc via get_document.
    snippet: (n.content ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
  }));
}

interface DocData { document?: { id: string; title?: string; content?: string } | null }

/** Fetch one document's markdown content. Advisory: null on any failure/missing. */
export async function getDocumentContent(
  token: TokenSource,
  id: string,
  opts: { fetchImpl?: typeof fetch; onUnauthorized?: () => Promise<string> } = {},
): Promise<DocContent | null> {
  const data = await gql<DocData>(token, DOC_QUERY, { id }, opts.fetchImpl ?? fetch, opts.onUnauthorized);
  const d = data?.document;
  if (!d?.id) return null;
  return { id: d.id, title: d.title ?? "", content: d.content ?? "" };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/linear/docs.test.ts`
Expected: PASS (all cases).

> **Note on the GraphQL schema:** the exact `searchDocuments(term:)` field is verified live against Linear's schema during acceptance; a wrong field name degrades to `[]` (advisory) rather than crashing. If Linear's schema differs, adjust `SEARCH_QUERY`/`DOC_QUERY` only — the mapping stays the same.

- [ ] **Step 5: Commit**

```bash
git add src/linear/docs.ts tests/linear/docs.test.ts
git commit -m "feat(docs): Linear docs GraphQL layer (search + get_document) with recoverable slice marker"
```

---

## Task 2: Issue-scoped run-event reads in the store

**Files:**
- Modify: `src/store/sessions.ts` (add `RunIndexEntry` interface + two methods after `getRunLogsBySession`, ~line 525)
- Test: `tests/store/sessions.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: existing `runs` / `run_events` / `sessions` tables.
- Produces:
  - `interface RunIndexEntry { runId: number; taskType: string; createdAt: string; sizeBytes: number }`
  - `SessionStore.getRunIndexByIssue(issueId: string): RunIndexEntry[]` — newest run first.
  - `SessionStore.getRunJsonl(runId: number, issueId: string): string | null` — the run's raw JSONL, but only if the run belongs to a session on `issueId` (scoping); `null` otherwise.

- [ ] **Step 1: Write the failing test**

```ts
// tests/store/sessions.test.ts — append
import { describe, it, expect } from "vitest";
import { SessionStore } from "../../src/store/sessions.ts";

describe("issue-scoped run-event reads", () => {
  function seeded(): SessionStore {
    const s = new SessionStore(":memory:");
    s.upsert("A", "done", "iss_1");
    s.upsert("B", "done", "iss_2");
    const rA = s.createRun("A", "implement", "o/r");
    s.addRunEvent(rA, "tool_use", { kind: "tool_use", name: "Bash", input: { command: "npm test" } });
    const rB = s.createRun("B", "plan", "o/r");
    s.addRunEvent(rB, "assistant_text", { kind: "assistant_text", text: "hi" });
    return s;
  }

  it("indexes only the asking issue's runs, newest first, with a byte size", () => {
    const s = seeded();
    const idx = s.getRunIndexByIssue("iss_1");
    expect(idx).toHaveLength(1);
    expect(idx[0]).toMatchObject({ taskType: "implement" });
    expect(idx[0].sizeBytes).toBeGreaterThan(0);
    s.close();
  });

  it("returns a run's jsonl only when the run belongs to the issue (scoping)", () => {
    const s = seeded();
    const idx1 = s.getRunIndexByIssue("iss_1");
    const jsonl = s.getRunJsonl(idx1[0].runId, "iss_1");
    expect(jsonl).toContain("npm test");
    // A run from issue 2, requested with issue 1's scope, must be refused.
    const idx2 = s.getRunIndexByIssue("iss_2");
    expect(s.getRunJsonl(idx2[0].runId, "iss_1")).toBeNull();
    s.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/store/sessions.test.ts -t "issue-scoped run-event reads"`
Expected: FAIL — `getRunIndexByIssue is not a function`.

- [ ] **Step 3: Write the implementation**

Add the interface near `RunLog` (after line 52):

```ts
// One prior run's index entry for get_run_events (runId omitted): lets the agent
// pick a run before pulling its (possibly large) JSONL.
export interface RunIndexEntry { runId: number; taskType: string; createdAt: string; sizeBytes: number }
```

Add these methods after `getRunLogsBySession` (before `close()`):

```ts
  // Run index for one issue, newest run first — every run of every session on
  // the issue. sizeBytes is the assembled JSONL length so the agent can gauge
  // cost before fetching. Issue-scoped: the join to sessions is the security
  // boundary for the docs MCP get_run_events tool.
  getRunIndexByIssue(issueId: string): RunIndexEntry[] {
    const runs = this.#db
      .prepare(
        `SELECT r.id AS id, r.task_type AS task_type, r.started_at AS started_at
         FROM runs r JOIN sessions s ON r.agent_session_id = s.agent_session_id
         WHERE s.issue_id = ? ORDER BY r.id DESC`,
      )
      .all(issueId) as { id: number; task_type: string; started_at: string }[];
    return runs.map((r) => {
      const rows = this.#db
        .prepare(`SELECT SUM(LENGTH(payload)) AS n FROM run_events WHERE run_id = ?`)
        .get(r.id) as { n: number | null };
      return { runId: r.id, taskType: r.task_type, createdAt: r.started_at, sizeBytes: rows.n ?? 0 };
    });
  }

  // The raw JSONL for one run, but ONLY if that run belongs to a session on
  // `issueId` — returns null otherwise so a per-run token can never read another
  // issue's runs. Same line shape as getRunLogsBySession's jsonl.
  getRunJsonl(runId: number, issueId: string): string | null {
    const owned = this.#db
      .prepare(
        `SELECT r.id FROM runs r JOIN sessions s ON r.agent_session_id = s.agent_session_id
         WHERE r.id = ? AND s.issue_id = ?`,
      )
      .get(runId, issueId) as { id: number } | undefined;
    if (!owned) return null;
    const events = this.#db
      .prepare(`SELECT ts, type, payload FROM run_events WHERE run_id = ? ORDER BY id ASC`)
      .all(runId) as { ts: string; type: string; payload: string }[];
    return events
      .map((e) => `{"ts":${JSON.stringify(e.ts)},"type":${JSON.stringify(e.type)},"payload":${e.payload}}`)
      .join("\n");
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/store/sessions.test.ts -t "issue-scoped run-event reads"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/sessions.ts tests/store/sessions.test.ts
git commit -m "feat(store): issue-scoped run-event index + jsonl reads for docs MCP"
```

---

## Task 3: Recoverable history truncation markers + uncapped thread assembly

**Files:**
- Modify: `src/history/history.ts`
- Test: `tests/history/history.test.ts` (update the existing marker assertion + add cases)

**Interfaces:**
- Consumes: existing `assembleThread`, `writeHistoryFiles`, `renderHistory`, `prepareHistory`.
- Produces (signature changes):
  - `assembleThread(sessionIds, fetchThread, cap?: number): Promise<string | null>` — `cap` defaults to `THREAD_CHAR_CAP`; pass `Infinity` for the uncapped full thread (used by the `get_thread` tool). The truncation marker becomes `[older conversation truncated — call get_thread(offset=…)]`.
  - `writeHistoryFiles` unchanged signature, but a tail-sliced file gets a first line `[truncated: first <n> bytes dropped — call get_run_events(runId=<id>, …)]`.
  - `renderHistory(thread, files, olderRunsExist?: boolean)` — when `olderRunsExist` is true, the run-log block notes runs beyond the exported 10 are reachable via `get_run_events`.
  - `prepareHistory` passes `olderRunsExist` computed from the run count vs `MAX_EXPORTED_RUNS`.

- [ ] **Step 1: Update the existing failing assertion + add new tests**

In `tests/history/history.test.ts`, change the cap test's marker assertion:

```ts
  it("caps the assembled thread, keeping the newest tail with a recoverable marker", async () => {
    const big = "x".repeat(THREAD_CHAR_CAP);
    const out = await assembleThread(["s1", "s2"], async (id) => (id === "s1" ? big : "TAIL_MARKER"));
    expect(out!.length).toBeLessThanOrEqual(THREAD_CHAR_CAP + 100);
    expect(out).toContain("TAIL_MARKER");
    expect(out!.startsWith("[older conversation truncated — call get_thread(offset=")).toBe(true);
  });

  it("does not truncate when cap is Infinity (full thread for get_thread)", async () => {
    const big = "y".repeat(THREAD_CHAR_CAP * 2);
    const out = await assembleThread(["s1"], async () => big, Infinity);
    expect(out).toBe(big);
  });
```

Add to the `writeHistoryFiles` describe:

```ts
  it("prepends a recoverable first line when a run log is tail-sliced", async () => {
    const { sbx, writes } = fakeSbx();
    const big = "z".repeat(MAX_FILE_BYTES + 10);
    await writeHistoryFiles(sbx, [runLog(42, "implement", big)]);
    const written = writes.get(`${HISTORY_DIR}/run-42-implement.jsonl`)!;
    expect(written.startsWith("[truncated: first ")).toBe(true);
    expect(written).toContain("get_run_events(runId=42");
    expect(written).toContain(big.slice(-100)); // newest tail retained
  });
```

Import `MAX_FILE_BYTES` at the top of the test file.

Add to the `renderHistory` describe:

```ts
  it("notes older runs are reachable via get_run_events when olderRunsExist", () => {
    const out = renderHistory(null, ["run-1-plan.jsonl"], true);
    expect(out).toContain("get_run_events");
  });
```

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run tests/history/history.test.ts`
Expected: FAIL — old marker string no longer matches; `assembleThread` ignores 3rd arg; no tail first-line; `renderHistory` third arg unused.

- [ ] **Step 3: Implement the changes**

`assembleThread` (replace body):

```ts
export async function assembleThread(
  sessionIds: string[],
  fetchThread: ThreadFetcher,
  cap: number = THREAD_CHAR_CAP,
): Promise<string | null> {
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
  if (out.length > cap) {
    const dropped = out.length - cap;
    out = `[older conversation truncated — call get_thread(offset=${dropped}) for the earlier messages]\n${out.slice(-cap)}`;
  }
  return out;
}
```

`writeHistoryFiles` (replace the slice line + write):

```ts
export async function writeHistoryFiles(sbx: AgentSandbox, logs: RunLog[]): Promise<string[]> {
  const recent = logs.filter((l) => l.jsonl).slice(-MAX_EXPORTED_RUNS);
  const written: string[] = [];
  for (const log of recent) {
    const name = `run-${log.runId}-${log.taskType}.jsonl`;
    let data = log.jsonl;
    if (data.length > MAX_FILE_BYTES) {
      const dropped = data.length - MAX_FILE_BYTES;
      data =
        `[truncated: first ${dropped} bytes dropped — call get_run_events(runId=${log.runId}, offset=0) for the full stream]\n` +
        data.slice(-MAX_FILE_BYTES);
    }
    try {
      await sbx.files.write(`${HISTORY_DIR}/${name}`, data);
      written.push(name);
    } catch (err) {
      console.error(`[history] write ${name} failed (advisory): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return written;
}
```

`renderHistory` (add param + note):

```ts
export function renderHistory(thread: string | null, files: string[], olderRunsExist = false): string | undefined {
  const sections: string[] = [];
  if (thread) {
    sections.push(`Conversation from prior sessions on this issue (oldest first):\n\n${thread}`);
  }
  if (files.length > 0) {
    const older = olderRunsExist
      ? ` Older runs beyond these are not exported — call get_run_events(runId=…) to fetch any of them.`
      : "";
    sections.push(
      `Raw event logs from prior runs are in ${HISTORY_DIR}/ (${files.join(", ")}). ` +
        `Each line is one JSON event (tool_use, tool_result, assistant_text, result). ` +
        `Grep them when you need what a past run actually did — files edited, commands run, ` +
        `test output, failure messages. Do not read them wholesale and never commit them.${older}`,
    );
  }
  if (sections.length === 0) return undefined;
  return sections.join("\n\n");
}
```

`prepareHistory` (compute `olderRunsExist`; the thread call keeps the default cap):

```ts
    const logs = ids.flatMap((id) => store.getRunLogsBySession(id));
    const files = await writeHistoryFiles(sbx, logs);
    const olderRunsExist = logs.filter((l) => l.jsonl).length > MAX_EXPORTED_RUNS;
    return renderHistory(thread, files, olderRunsExist);
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/history/history.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/history/history.ts tests/history/history.test.ts
git commit -m "feat(history): recoverable truncation markers + uncapped thread mode for docs MCP"
```

---

## Task 4: Per-run bearer-token registry

**Files:**
- Create: `src/mcp/docs-server.ts` (registry only in this task)
- Test: `tests/mcp/docs-server.test.ts` (registry describe)

**Interfaces:**
- Produces:
  - `interface RunTokenClaims { agentSessionId: string; issueId: string | null }`
  - `class RunTokenRegistry { mint(claims: RunTokenClaims): string; resolve(token: string): RunTokenClaims | undefined; revoke(token: string): void }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/mcp/docs-server.test.ts
import { describe, it, expect } from "vitest";
import { RunTokenRegistry } from "../../src/mcp/docs-server.ts";

describe("RunTokenRegistry", () => {
  it("mints unique tokens that resolve to their claims and revoke cleanly", () => {
    const reg = new RunTokenRegistry();
    const t1 = reg.mint({ agentSessionId: "A", issueId: "iss_1" });
    const t2 = reg.mint({ agentSessionId: "B", issueId: "iss_2" });
    expect(t1).not.toBe(t2);
    expect(reg.resolve(t1)).toEqual({ agentSessionId: "A", issueId: "iss_1" });
    reg.revoke(t1);
    expect(reg.resolve(t1)).toBeUndefined();
    expect(reg.resolve(t2)).toEqual({ agentSessionId: "B", issueId: "iss_2" });
    expect(reg.resolve("bogus")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mcp/docs-server.test.ts -t "RunTokenRegistry"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the registry**

```ts
// src/mcp/docs-server.ts
import { randomUUID } from "node:crypto";

export interface RunTokenClaims { agentSessionId: string; issueId: string | null }

// The host mints a random bearer token per agent run, held only in memory (like
// the orchestrator's #live map) and revoked when the run finishes. The Linear
// OAuth token never enters the sandbox; a token resolves only to its run's
// issue, so a compromised sandbox can at worst read that issue's docs/thread/runs.
export class RunTokenRegistry {
  #tokens = new Map<string, RunTokenClaims>();
  mint(claims: RunTokenClaims): string {
    const token = randomUUID();
    this.#tokens.set(token, claims);
    return token;
  }
  resolve(token: string): RunTokenClaims | undefined {
    return this.#tokens.get(token);
  }
  revoke(token: string): void {
    this.#tokens.delete(token);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/mcp/docs-server.test.ts -t "RunTokenRegistry"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/docs-server.ts tests/mcp/docs-server.test.ts
git commit -m "feat(mcp): per-run bearer-token registry for the docs MCP endpoint"
```

---

## Task 5: Docs MCP JSON-RPC dispatcher + the four tools

**Files:**
- Modify: `src/mcp/docs-server.ts` (add `handleDocsMcp` + tool wiring)
- Test: `tests/mcp/docs-server.test.ts` (add `handleDocsMcp` describe)

**Interfaces:**
- Consumes: `RunTokenRegistry` (Task 4); `searchDocuments`, `getDocumentContent`, `sliceWithMarker`, `DOC_FETCH_CEILING` from `src/linear/docs.ts` (Task 1); `assembleThread` from `src/history/history.ts` (Task 3); `getRunIndexByIssue`, `getRunJsonl` from the store (Task 2); `TokenSource` from `src/linear/client.ts`; `ThreadFetcher` from `src/history/history.ts`.
- Produces:
  - `interface DocsMcpDeps { registry: RunTokenRegistry; store: Pick<SessionStore, "listByIssue" | "getRunIndexByIssue" | "getRunJsonl">; linearToken: TokenSource; fetchThread?: ThreadFetcher; fetchImpl?: typeof fetch; onUnauthorized?: () => Promise<string> }`
  - `const DOCS_TOOL_NAMES = ["search_documents", "get_document", "get_thread", "get_run_events"] as const`
  - `function handleDocsMcp(deps: DocsMcpDeps, authHeader: string | null, body: unknown): Promise<{ status: number; json: unknown }>`

**Protocol note:** `handleDocsMcp` implements exactly the JSON-RPC methods the Agent SDK's streamable-HTTP MCP client calls — `initialize`, `tools/list`, `tools/call` — plus swallowing the `notifications/initialized` notification. It returns `application/json` (a single response is spec-legal for streamable HTTP; no SSE needed). `// ponytail:` names the ceiling: this covers the client's actual call set, not the full MCP spec (no SSE streaming, no session resumption); upgrade to `@modelcontextprotocol/sdk`'s `StreamableHTTPServerTransport` if the client ever needs more.

- [ ] **Step 1: Write the failing test**

```ts
// tests/mcp/docs-server.test.ts — add
import { RunTokenRegistry, handleDocsMcp, type DocsMcpDeps } from "../../src/mcp/docs-server.ts";
import { SessionStore } from "../../src/store/sessions.ts";
import { vi } from "vitest";

function gqlFetch(data: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify({ data }), { status: 200 })) as unknown as typeof fetch;
}

function seededStore(): SessionStore {
  const s = new SessionStore(":memory:");
  s.upsert("A", "done", "iss_1");
  s.upsert("B", "done", "iss_2");
  const r = s.createRun("A", "implement", "o/r");
  s.addRunEvent(r, "tool_use", { kind: "tool_use", name: "Bash", input: { command: "npm test" } });
  return s;
}

function deps(over: Partial<DocsMcpDeps> = {}): { deps: DocsMcpDeps; reg: RunTokenRegistry; store: SessionStore } {
  const reg = new RunTokenRegistry();
  const store = seededStore();
  return {
    reg, store,
    deps: {
      registry: reg,
      store,
      linearToken: "linear-tok",
      fetchThread: async (id: string) => `**Human:** thread of ${id}`,
      fetchImpl: gqlFetch({ document: { id: "d1", title: "T", content: "DOC BODY" } }),
      ...over,
    },
  };
}

describe("handleDocsMcp", () => {
  it("401s on a missing or unknown bearer token", async () => {
    const { deps: d } = deps();
    const noAuth = await handleDocsMcp(d, null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(noAuth.status).toBe(401);
    const bad = await handleDocsMcp(d, "Bearer nope", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(bad.status).toBe(401);
  });

  it("initialize + tools/list return the four tools", async () => {
    const { deps: d, reg } = deps();
    const token = reg.mint({ agentSessionId: "A", issueId: "iss_1" });
    const init = await handleDocsMcp(d, `Bearer ${token}`, { jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(init.status).toBe(200);
    expect((init.json as any).result.serverInfo.name).toBe("jarvis-docs");
    const list = await handleDocsMcp(d, `Bearer ${token}`, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = (list.json as any).result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(["get_document", "get_run_events", "get_thread", "search_documents"]);
  });

  it("get_document returns full content under the ceiling", async () => {
    const { deps: d, reg } = deps();
    const token = reg.mint({ agentSessionId: "A", issueId: "iss_1" });
    const r = await handleDocsMcp(d, `Bearer ${token}`, {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "get_document", arguments: { id: "d1" } },
    });
    expect((r.json as any).result.content[0].text).toContain("DOC BODY");
  });

  it("get_thread reads the token's own issue only", async () => {
    const { deps: d, reg } = deps();
    const token = reg.mint({ agentSessionId: "A", issueId: "iss_1" });
    const r = await handleDocsMcp(d, `Bearer ${token}`, {
      jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_thread", arguments: {} },
    });
    expect((r.json as any).result.content[0].text).toContain("thread of A");
  });

  it("get_run_events issue-scopes: token for iss_1 cannot read iss_2's run", async () => {
    const { deps: d, reg, store } = deps();
    const token = reg.mint({ agentSessionId: "A", issueId: "iss_1" });
    const rB = store.createRun("B", "plan", "o/r"); // belongs to iss_2
    store.addRunEvent(rB, "assistant_text", { kind: "assistant_text", text: "secret" });
    const r = await handleDocsMcp(d, `Bearer ${token}`, {
      jsonrpc: "2.0", id: 5, method: "tools/call",
      params: { name: "get_run_events", arguments: { runId: rB } },
    });
    // Not found within iss_1's scope → an error string, never iss_2's data.
    const text = (r.json as any).result.content[0].text as string;
    expect(text).not.toContain("secret");
    expect(text.toLowerCase()).toContain("not found");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mcp/docs-server.test.ts -t "handleDocsMcp"`
Expected: FAIL — `handleDocsMcp is not exported`.

- [ ] **Step 3: Implement the dispatcher + tools**

Append to `src/mcp/docs-server.ts`:

```ts
import type { SessionStore } from "../store/sessions.ts";
import type { TokenSource } from "../linear/client.ts";
import type { ThreadFetcher } from "../history/history.ts";
import { assembleThread } from "../history/history.ts";
import { searchDocuments, getDocumentContent, sliceWithMarker, DOC_FETCH_CEILING } from "../linear/docs.ts";

export interface DocsMcpDeps {
  registry: RunTokenRegistry;
  store: Pick<SessionStore, "listByIssue" | "getRunIndexByIssue" | "getRunJsonl">;
  linearToken: TokenSource;
  fetchThread?: ThreadFetcher;
  fetchImpl?: typeof fetch;
  onUnauthorized?: () => Promise<string>;
}

export const DOCS_TOOL_NAMES = ["search_documents", "get_document", "get_thread", "get_run_events"] as const;

// Default page size for get_thread / get_run_events when the agent doesn't pass
// one. Large enough to be useful, small enough to leave room to page.
const THREAD_PAGE = 20_000;
const EVENTS_PAGE = 200_000;

const TOOL_DEFS = [
  {
    name: "search_documents",
    description: "Search Linear workspace documents by keyword. Returns id, title, project, and a snippet. Use get_document to read a full doc.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "get_document",
    description: "Read a Linear document's full markdown content by id. Returns full content by default; if it exceeds a safety ceiling the result ends with a marker telling you the offset to call again with.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, offset: { type: "number" } }, required: ["id"] },
  },
  {
    name: "get_thread",
    description: "Read the full Linear conversation of every session on THIS issue (the one you are working). offset/limit page through it; the injected thread is only the newest tail.",
    inputSchema: { type: "object", properties: { offset: { type: "number" }, limit: { type: "number" } } },
  },
  {
    name: "get_run_events",
    description: "Read raw event streams from prior runs on THIS issue. Omit runId to get the run index (runId, taskType, createdAt, size). With runId, returns that run's JSONL; offset/limit page it and filter is a substring match applied per line.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "number" }, offset: { type: "number" }, limit: { type: "number" }, filter: { type: "string" } },
    },
  },
];

function ok(id: unknown, result: unknown) { return { status: 200, json: { jsonrpc: "2.0", id, result } }; }
function rpcError(id: unknown, code: number, message: string) { return { status: 200, json: { jsonrpc: "2.0", id, error: { code, message } } }; }
function toolText(text: string) { return { content: [{ type: "text", text }] }; }

async function runTool(deps: DocsMcpDeps, claims: RunTokenClaims, name: string, args: Record<string, unknown>): Promise<unknown> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    if (name === "search_documents") {
      const results = await searchDocuments(deps.linearToken, String(args.query ?? ""), { fetchImpl, onUnauthorized: deps.onUnauthorized });
      if (results.length === 0) return toolText("No documents matched.");
      return toolText(results.map((r) => `- ${r.title} (id: ${r.id}${r.project ? `, project: ${r.project}` : ""}) — ${r.snippet}`).join("\n"));
    }
    if (name === "get_document") {
      const doc = await getDocumentContent(deps.linearToken, String(args.id ?? ""), { fetchImpl, onUnauthorized: deps.onUnauthorized });
      if (!doc) return toolText(`Document not found: ${String(args.id)}`);
      const offset = Number(args.offset ?? 0);
      const body = sliceWithMarker(doc.content, offset, DOC_FETCH_CEILING, (n) => `\n\n[truncated at ${n} — call get_document(id="${doc.id}", offset=${n}) for more]`);
      return toolText(`# ${doc.title}\n\n${body}`);
    }
    if (name === "get_thread") {
      if (!claims.issueId || !deps.fetchThread) return toolText("No thread available for this issue.");
      const ids = deps.store.listByIssue(claims.issueId).map((s) => s.agentSessionId);
      const full = (await assembleThread(ids, deps.fetchThread, Infinity)) ?? "";
      const offset = Number(args.offset ?? 0);
      const limit = Number(args.limit ?? THREAD_PAGE);
      const slice = full.slice(offset, offset + limit);
      const more = offset + limit < full.length ? `\n\n[more — call get_thread(offset=${offset + limit})]` : "";
      return toolText(slice + more);
    }
    if (name === "get_run_events") {
      if (!claims.issueId) return toolText("No runs available for this issue.");
      if (args.runId === undefined || args.runId === null) {
        const idx = deps.store.getRunIndexByIssue(claims.issueId);
        if (idx.length === 0) return toolText("No prior runs on this issue.");
        return toolText(idx.map((e) => `- runId=${e.runId} taskType=${e.taskType} createdAt=${e.createdAt} sizeBytes=${e.sizeBytes}`).join("\n"));
      }
      const jsonl = deps.store.getRunJsonl(Number(args.runId), claims.issueId);
      if (jsonl === null) return toolText(`Run not found for this issue: ${String(args.runId)}`);
      let lines = jsonl.split("\n");
      const filter = args.filter ? String(args.filter) : null;
      if (filter) lines = lines.filter((l) => l.includes(filter));
      const offset = Number(args.offset ?? 0);
      const limit = Number(args.limit ?? EVENTS_PAGE);
      // Line-aligned char slicing: walk lines, never cut mid-JSON.
      const out: string[] = [];
      let taken = 0, skipped = 0, more = false;
      for (const l of lines) {
        if (skipped < offset) { skipped += l.length + 1; continue; }
        if (taken + l.length + 1 > limit) { more = true; break; }
        out.push(l); taken += l.length + 1;
      }
      const tail = more ? `\n[more — call get_run_events(runId=${Number(args.runId)}, offset=${offset + taken}${filter ? `, filter=${JSON.stringify(filter)}` : ""})]` : "";
      return toolText(out.join("\n") + tail);
    }
    return toolText(`Unknown tool: ${name}`);
  } catch (err) {
    // Tool failures return an error string to the agent — never wedge the run.
    return { ...toolText(`Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`), isError: true };
  }
}

/** Transport-agnostic JSON-RPC dispatcher for POST /mcp/docs. Every request must
 *  carry a valid per-run bearer token (issue scoping). Returns {status, json}. */
export async function handleDocsMcp(
  deps: DocsMcpDeps,
  authHeader: string | null,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : null;
  const claims = token ? deps.registry.resolve(token) : undefined;
  if (!claims) return { status: 401, json: { jsonrpc: "2.0", id: (body as { id?: unknown })?.id ?? null, error: { code: -32001, message: "unauthorized" } } };

  const msg = (body ?? {}) as { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
  const method = msg.method;

  // Notifications (no id) — e.g. notifications/initialized: ack with no body.
  if (msg.id === undefined || msg.id === null) return { status: 202, json: null };

  if (method === "initialize") {
    return ok(msg.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "jarvis-docs", version: "1.0.0" },
    });
  }
  if (method === "tools/list") return ok(msg.id, { tools: TOOL_DEFS });
  if (method === "tools/call") {
    const name = msg.params?.name ?? "";
    const result = await runTool(deps, claims, name, msg.params?.arguments ?? {});
    return ok(msg.id, result);
  }
  return rpcError(msg.id, -32601, `method not found: ${method}`);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/mcp/docs-server.test.ts`
Expected: PASS (registry + all `handleDocsMcp` cases).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/docs-server.ts tests/mcp/docs-server.test.ts
git commit -m "feat(mcp): docs MCP JSON-RPC dispatcher with 4 issue-scoped tools + auth"
```

---

## Task 6: Mount `POST /mcp/docs` on the server + construct the registry

**Files:**
- Modify: `src/server.ts`
- Test: `tests/server.test.ts` (create — a light Hono route test via `app.request`)

**Interfaces:**
- Consumes: `RunTokenRegistry`, `handleDocsMcp`, `DocsMcpDeps` (Tasks 4–5); `makeServer(config)` (existing, returns a Hono app).
- Produces: the `Orchestrator` gains one new constructor parameter — the `RunTokenRegistry` — added in Task 11's signature; for now `server.ts` constructs the registry and mounts the route. **The registry instance is shared between the route (reads/auths tokens) and the orchestrator (mints/revokes tokens).**

- [ ] **Step 1: Write the failing test**

```ts
// tests/server.test.ts
import { describe, it, expect } from "vitest";
import { makeServer } from "../src/server.ts";
import type { Config } from "../src/config.ts";

const config: Config = {
  port: 0,
  linear: { webhookSecret: "whsec", clientId: "cid", clientSecret: "csec", accessToken: "seed" },
  anthropicApiKey: "sk-test", e2bApiKey: "e2b", e2bTemplate: "jarvis-agent",
  ghToken: "gh", targetRepo: "o/r", publicBaseUrl: "http://localhost:3000",
};

describe("POST /mcp/docs", () => {
  it("401s an unauthenticated MCP request", async () => {
    const app = makeServer(config);
    const res = await app.request("/mcp/docs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });
});
```

> If `makeServer` constructing a real `SessionStore` at a file path is a problem in tests, set `process.env.JARVIS_DB = ":memory:"` at the top of the test (matches `server.ts` line 13 `process.env.JARVIS_DB ?? "jarvis.db"`).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL — `/mcp/docs` returns 404 (route not mounted).

- [ ] **Step 3: Implement the mount**

In `src/server.ts`, add imports:

```ts
import { RunTokenRegistry, handleDocsMcp } from "./mcp/docs-server.ts";
```

After the `store` and `getToken`/`onUnauthorized` are defined (after line ~24) construct the registry:

```ts
  // Shared between the /mcp/docs route (auths tokens) and the orchestrator
  // (mints/revokes per run). In-memory, like the inflight set below.
  const docsTokens = new RunTokenRegistry();
```

Pass `docsTokens` into the `Orchestrator` constructor as its final argument (see Task 11 for the constructor change):

```ts
  const orchestrator = new Orchestrator(
    config, store,
    (id) => makeActivities(linearFor(), id),
    makePlanFetcher(getToken, fetch, onUnauthorized),
    undefined,
    makeThreadFetcher(getToken, fetch, onUnauthorized),
    linearFor, getToken, onUnauthorized,
    undefined, undefined,
    makeParentFetcher(getToken, fetch, onUnauthorized),
    docsTokens, // NEW (Task 11)
  );
```

Mount the route (near the other `app.post`/`app.get` handlers, before `return app`):

```ts
  app.post("/mcp/docs", async (c) => {
    let body: unknown = null;
    try { body = await c.req.json(); } catch { /* malformed → treated as no method */ }
    const { status, json } = await handleDocsMcp(
      { registry: docsTokens, store, linearToken: getToken, fetchThread: makeThreadFetcher(getToken, fetch, onUnauthorized), onUnauthorized },
      c.req.header("authorization") ?? null,
      body,
    );
    if (json === null) return c.body(null, status as 202);
    return c.json(json as object, status as 200 | 401);
  });
```

> Note: `makeThreadFetcher` here fetches by `agentSessionId`. `handleDocsMcp`'s `get_thread` calls it per session id from `store.listByIssue` — the same fetcher the orchestrator uses.

- [ ] **Step 4: Run the tests + full suite + typecheck**

Run: `npx vitest run tests/server.test.ts && npm run typecheck`
Expected: server test PASSES; typecheck fails ONLY on the new 12th `Orchestrator` arg until Task 11 adds the parameter. If you implement Task 11's constructor signature first (it's a pure addition), typecheck is clean. Otherwise land Task 11 before typechecking the whole tree.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat(server): mount POST /mcp/docs with shared run-token registry"
```

---

## Task 7: Up-front doc-context assembly (`assembleDocContext`)

**Files:**
- Modify: `src/linear/docs.ts` (add assembly helpers)
- Test: `tests/linear/docs.test.ts` (add `assembleDocContext` describe)

**Interfaces:**
- Consumes: `fetchWithAuth`, `TokenSource`; `getDocumentContent` reuse not required (assembly uses its own combined query).
- Produces:
  - `const DOC_CONTEXT_CAP = 15_000`
  - `interface IssueDocsBundle { fullDocs: { id: string; title: string; content: string }[]; projectContent: { id: string; title: string; content: string } | null; projectDocIndex: { id: string; title: string }[] }`
  - `function extractPastedDocSlugs(text: string): string[]` — pulls `linear.app/<ws>/document/<slug>` links, returns the trailing slugId of each.
  - `function renderDocContext(bundle: IssueDocsBundle, cap?: number): string | undefined`
  - `function assembleDocContext(token: TokenSource, issueId: string | null, issueText: string, opts?: { fetchImpl?: typeof fetch; onUnauthorized?: () => Promise<string> }): Promise<string | undefined>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/linear/docs.test.ts — add
import { extractPastedDocSlugs, renderDocContext, assembleDocContext, DOC_CONTEXT_CAP } from "../../src/linear/docs.ts";

describe("extractPastedDocSlugs", () => {
  it("pulls the slugId from pasted Linear document links", () => {
    const text = "see https://linear.app/acme/document/design-notes-9f8e7d6c5b4a and https://linear.app/acme/document/rfc-1234abcd";
    expect(extractPastedDocSlugs(text)).toEqual(["9f8e7d6c5b4a", "1234abcd"]);
  });
  it("returns [] with no doc links", () => {
    expect(extractPastedDocSlugs("nothing here")).toEqual([]);
  });
});

describe("renderDocContext", () => {
  it("emits full docs, project overview, and an index of the rest", () => {
    const out = renderDocContext({
      fullDocs: [{ id: "d1", title: "Runbook", content: "step one" }],
      projectContent: { id: "p1", title: "Project", content: "overview text" },
      projectDocIndex: [{ id: "d9", title: "Old ADR" }],
    })!;
    expect(out).toContain("Runbook");
    expect(out).toContain("step one");
    expect(out).toContain("overview text");
    expect(out).toContain("Old ADR");
    expect(out).toContain("get_document");
  });
  it("labels a doc cut with a get_document marker naming the id", () => {
    const big = "x".repeat(DOC_CONTEXT_CAP + 500);
    const out = renderDocContext({ fullDocs: [{ id: "dBIG", title: "Big", content: big }], projectContent: null, projectDocIndex: [] })!;
    expect(out).toContain('[truncated — full doc: get_document("dBIG")]');
  });
  it("returns undefined when there is nothing to inject", () => {
    expect(renderDocContext({ fullDocs: [], projectContent: null, projectDocIndex: [] })).toBeUndefined();
  });
});

describe("assembleDocContext", () => {
  it("returns undefined for a null issue and never throws on fetch failure", async () => {
    expect(await assembleDocContext("t", null, "")).toBeUndefined();
    const bad = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    expect(await assembleDocContext("t", "iss_1", "text", { fetchImpl: bad })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/linear/docs.test.ts -t "DocContext"` (matches the three describes)
Expected: FAIL — not exported.

- [ ] **Step 3: Implement the assembly**

Add to `src/linear/docs.ts`:

```ts
// Full-content injection budget (Issue.documents + pasted docs + project
// overview). ponytail: char cap, keep-what-fits with a per-doc marker — the
// remaining project docs go in as a one-line index instead of body.
export const DOC_CONTEXT_CAP = 15_000;

const DOC_LINK_RE = /linear\.app\/[^/\s]+\/document\/[^)\s]*-([A-Za-z0-9]+)/g;

/** slugId is the trailing token after the last '-' in a Linear document URL. */
export function extractPastedDocSlugs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(DOC_LINK_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

export interface IssueDocsBundle {
  fullDocs: { id: string; title: string; content: string }[];
  projectContent: { id: string; title: string; content: string } | null;
  projectDocIndex: { id: string; title: string }[];
}

// One combined query: the ticket's attached docs, its project overview + name,
// and the project's remaining docs (for the index). Pasted-link docs are resolved
// separately by slugId and merged into fullDocs.
const ISSUE_DOCS_QUERY =
  `query($id: String!) { issue(id: $id) {
     documents { nodes { id title content } }
     project { id name content documents { nodes { id title } } }
   } }`;
const DOC_BY_SLUG_QUERY = `query($slug: String!) { documents(filter: { slugId: { eq: $slug } }, first: 1) { nodes { id title content } } }`;

/** Render the injected block. Full docs are emitted until the cap; the doc that
 *  overflows is cut with a marker naming its id, and any later full docs fall to
 *  the index. Project docs not already shown appear as one-line index entries. */
export function renderDocContext(bundle: IssueDocsBundle, cap: number = DOC_CONTEXT_CAP): string | undefined {
  const shownIds = new Set<string>();
  const sections: string[] = [];
  let used = 0;
  const emit = (id: string, title: string, content: string) => {
    shownIds.add(id);
    const header = `### ${title} (id: ${id})\n`;
    const remaining = cap - used - header.length;
    if (remaining <= 0) {
      sections.push(`${header}[truncated — full doc: get_document("${id}")]`);
      return;
    }
    if (content.length > remaining) {
      sections.push(`${header}${content.slice(0, remaining)}\n[truncated — full doc: get_document("${id}")]`);
      used = cap;
    } else {
      sections.push(`${header}${content}`);
      used += header.length + content.length;
    }
  };

  if (bundle.projectContent) emit(bundle.projectContent.id, `Project overview: ${bundle.projectContent.title}`, bundle.projectContent.content);
  for (const d of bundle.fullDocs) emit(d.id, d.title, d.content);

  const index = bundle.projectDocIndex.filter((d) => !shownIds.has(d.id));
  if (index.length > 0) {
    sections.push(
      `Other project documents (fetch with get_document when relevant):\n` +
        index.map((d) => `- ${d.title} (id: ${d.id})`).join("\n"),
    );
  }
  if (sections.length === 0) return undefined;
  return `Linear documents attached to this ticket and project:\n\n${sections.join("\n\n")}`;
}

/** Assemble the up-front doc context for an issue. Advisory: undefined on any
 *  failure or when there's nothing to inject. */
export async function assembleDocContext(
  token: TokenSource,
  issueId: string | null,
  issueText: string,
  opts: { fetchImpl?: typeof fetch; onUnauthorized?: () => Promise<string> } = {},
): Promise<string | undefined> {
  if (!issueId) return undefined;
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const data = await gql<{ issue?: {
      documents?: { nodes?: { id: string; title?: string; content?: string }[] };
      project?: { id: string; name?: string; content?: string; documents?: { nodes?: { id: string; title?: string }[] } } | null;
    } }>(token, ISSUE_DOCS_QUERY, { id: issueId }, fetchImpl, opts.onUnauthorized);
    if (!data?.issue) return undefined;

    const fullDocs = (data.issue.documents?.nodes ?? []).map((d) => ({ id: d.id, title: d.title ?? "", content: d.content ?? "" }));

    // Resolve pasted doc links (dedupe against already-attached docs).
    const seen = new Set(fullDocs.map((d) => d.id));
    for (const slug of extractPastedDocSlugs(issueText)) {
      const sd = await gql<{ documents?: { nodes?: { id: string; title?: string; content?: string }[] } }>(token, DOC_BY_SLUG_QUERY, { slug }, fetchImpl, opts.onUnauthorized);
      const node = sd?.documents?.nodes?.[0];
      if (node && !seen.has(node.id)) { seen.add(node.id); fullDocs.push({ id: node.id, title: node.title ?? "", content: node.content ?? "" }); }
    }

    const proj = data.issue.project;
    const projectContent = proj?.content ? { id: proj.id, title: proj.name ?? "Project", content: proj.content } : null;
    const projectDocIndex = (proj?.documents?.nodes ?? []).map((d) => ({ id: d.id, title: d.title ?? "" }));

    return renderDocContext({ fullDocs, projectContent, projectDocIndex });
  } catch (err) {
    console.error(`[docs] assembleDocContext failed (advisory): ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/linear/docs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/linear/docs.ts tests/linear/docs.test.ts
git commit -m "feat(docs): up-front issue/project doc-context assembly with recoverable markers"
```

---

## Task 8: Thread `docsMcp` + `docsContext` through the task builders

**Files:**
- Modify: `src/agent/tasks.ts`
- Modify: `src/agent/converse.ts`
- Test: `tests/agent/tasks.test.ts` (add cases); `tests/agent/converse.test.ts` (add a case)

**Interfaces:**
- Produces (on `AgentTask` in `tasks.ts`):
  - `interface DocsMcpConfig { url: string; token: string }`
  - `AgentTask.docsMcp?: DocsMcpConfig` — passed to the sandbox runner to register the HTTP MCP server.
  - `function docsBlock(docsContext?: string): string` — per-run goal injector (byte-stable-safe: renders `""` when absent).
  - `ALL_REPO_TOOLS` gains `"mcp__docs"` (server-prefix allow, mirroring `"mcp__serena"`).
  - Every task builder (`planTask`, `reviseTask`, `implementTask`, `reviewTask`, `chatTask`) and `converseTask` gains an optional trailing `docsContext?: string` param appended to `goal` via `docsBlock`, plus a `docsMcp?: DocsMcpConfig` param set on the returned task.
- Consumes: nothing new.

> To avoid a long positional argument list, add `docsMcp` and `docsContext` as fields on a single options bag is tempting — but the existing builders are positional and the orchestrator is the only caller. Keep positional for minimal churn: append `docsContext` after `history`/`images`, and `docsMcp` last. `mapTask()` does NOT get docs (read-only repo map, no issue context).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/agent/tasks.test.ts — add
import { planTask, implementTask, docsBlock, ALL_REPO_TOOLS, type DocsMcpConfig } from "../../src/agent/tasks.ts";
import type { IssueContext } from "../../src/linear/context.ts";

const ctx: IssueContext = { agentSessionId: "s", organizationId: "o", issueId: "i", teamId: "t", title: "T", description: "D", comment: "", promptContext: "" };

describe("docs plumbing", () => {
  it("ALL_REPO_TOOLS allows the docs MCP server", () => {
    expect(ALL_REPO_TOOLS).toContain("mcp__docs");
  });
  it("docsBlock renders empty when absent (prompt-cache safe) and a labeled block when present", () => {
    expect(docsBlock(undefined)).toBe("");
    expect(docsBlock("DOC STUFF")).toContain("DOC STUFF");
  });
  it("planTask injects docsContext into the goal and carries docsMcp", () => {
    const cfg: DocsMcpConfig = { url: "http://h/mcp/docs", token: "tok" };
    const t = planTask(ctx, undefined, undefined, undefined, "INJECTED DOCS", cfg);
    expect(t.goal).toContain("INJECTED DOCS");
    expect(t.docsMcp).toEqual(cfg);
  });
  it("implementTask carries docsMcp and docsContext", () => {
    const cfg: DocsMcpConfig = { url: "http://h/mcp/docs", token: "tok" };
    const t = implementTask(ctx, "Type: chore\nScope: small\nplan", undefined, "jarvis/i", undefined, undefined, "DOCS", cfg);
    expect(t.goal).toContain("DOCS");
    expect(t.docsMcp).toEqual(cfg);
  });
});
```

```ts
// tests/agent/converse.test.ts — add
import { converseTask } from "../../src/agent/converse.ts";
it("converseTask injects docsContext and carries docsMcp", () => {
  const cfg = { url: "http://h/mcp/docs", token: "tok" };
  const t = converseTask(ctxForConverse, "hi", undefined, undefined, undefined, "DOCS BLOCK", cfg);
  expect(t.goal).toContain("DOCS BLOCK");
  expect(t.docsMcp).toEqual(cfg);
});
```
(Reuse or define `ctxForConverse` following the existing converse test's context fixture.)

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run tests/agent/tasks.test.ts tests/agent/converse.test.ts`
Expected: FAIL — `docsBlock`/`DocsMcpConfig` not exported; builders reject extra args.

- [ ] **Step 3: Implement the plumbing**

In `src/agent/tasks.ts`:

Add the interface + field to `AgentTask`:

```ts
export interface DocsMcpConfig { url: string; token: string }
```
```ts
export interface AgentTask {
  // ...existing fields...
  images?: { mediaType: string; data: string }[];
  // Docs MCP server config — registered by runner.mjs so the agent can pull
  // Linear docs / thread / prior run events on demand. Undefined → not registered.
  docsMcp?: DocsMcpConfig;
}
```

Add `"mcp__docs"` to `ALL_REPO_TOOLS`:

```ts
export const ALL_REPO_TOOLS = [
  "Read", "Glob", "Grep", "Bash", "Edit", "Write", "Monitor",
  "WebSearch", "WebFetch", "Skill", "Agent", "mcp__serena", "mcp__docs", "mcp__jarvis__ask_user",
];
```

Add the injector (next to `historyBlock`):

```ts
// Per-run content only — same cache rule as historyBlock. The string arrives
// pre-rendered from src/linear/docs.ts (assembleDocContext).
export function docsBlock(docsContext?: string): string {
  if (!docsContext) return "";
  return `\n\n---\nLinear documents (attached to this ticket/project):\n${docsContext}`;
}
```

Thread `docsContext` + `docsMcp` through each builder. Example for `planTask` (apply the same pattern to `reviseTask`, `implementTask`, `reviewTask`, `chatTask`):

```ts
export function planTask(
  ctx: IssueContext,
  repoMap?: string,
  history?: string,
  images?: AgentTask["images"],
  docsContext?: string,
  docsMcp?: DocsMcpConfig,
): AgentTask {
  return {
    goal: `Produce an implementation plan for this issue.\n\n${issueBlock(ctx)}${repoMapBlock(repoMap)}${historyBlock(history)}${docsBlock(docsContext)}`,
    cwd: REPO_DIR,
    model: "claude-sonnet-5",
    systemAppend: PLAN_APPEND,
    allowedTools: ALL_REPO_TOOLS,
    maxTurns: 25,
    maxBudgetUsd: 2,
    effort: "medium",
    images,
    docsMcp,
  };
}
```

For `implementTask`, append `docsContext`/`docsMcp` after `images` in the parameter list and add `${docsBlock(docsContext)}` to the goal (after `historyBlock(history)`) and `docsMcp` to the returned object. For `reviewTask` (no `images` param today) append `docsContext?`/`docsMcp?` after `history` and set both.

In `src/agent/converse.ts`, extend `converseTask`:

```ts
import { ALL_REPO_TOOLS, TOOLING_APPEND, issueBlock, repoMapBlock, historyBlock, docsBlock, type DocsMcpConfig } from "./tasks.ts";

export function converseTask(
  ctx: IssueContext,
  userMessage: string,
  repoMap?: string,
  history?: string,
  images?: AgentTask["images"],
  docsContext?: string,
  docsMcp?: DocsMcpConfig,
): AgentTask {
  return {
    goal:
      `The human's latest message:\n${userMessage}\n\n` +
      `Respond per the PROTOCOL. Read the repo as needed to answer, plan, or decide.\n\n` +
      `---\n${issueBlock(ctx)}${repoMapBlock(repoMap)}${historyBlock(history)}${docsBlock(docsContext)}`,
    cwd: REPO_DIR,
    model: "claude-sonnet-5",
    systemAppend: CONVERSE_SYSTEM,
    allowedTools: ALL_REPO_TOOLS,
    maxTurns: 30,
    maxBudgetUsd: 2,
    effort: "medium",
    images,
    docsMcp,
  };
}
```

- [ ] **Step 4: Run the tests + typecheck**

Run: `npx vitest run tests/agent/tasks.test.ts tests/agent/converse.test.ts && npm run typecheck`
Expected: PASS (typecheck: the orchestrator still compiles — new params are optional; the new 12th `Orchestrator` arg from Task 6 is added in Task 11).

- [ ] **Step 5: Commit**

```bash
git add src/agent/tasks.ts src/agent/converse.ts tests/agent/tasks.test.ts tests/agent/converse.test.ts
git commit -m "feat(agent): thread docsMcp config + injected doc context through task builders"
```

---

## Task 9: Register the docs HTTP MCP server in Tier 0 (`host-turn.ts`)

**Files:**
- Modify: `src/agent/host-turn.ts`
- Test: `tests/agent/host-turn.test.ts` (add a case asserting option shape via faked `queryFn`)

**Interfaces:**
- Consumes: `DocsMcpConfig` from `src/agent/tasks.ts`; existing `runHostTurn` opts.
- Produces: `runHostTurn` opts gain `docsMcp?: DocsMcpConfig` and `docsContext?: string`. When `docsMcp` is present, the SDK options get `mcpServers: { docs: { type: "http", url, headers: { Authorization: "Bearer <token>" } } }` and the allowlist/deny gate accept `mcp__docs*` tool names. `docsContext` is appended to the prompt (per-run).

- [ ] **Step 1: Write the failing test**

```ts
// tests/agent/host-turn.test.ts — add
import { runHostTurn } from "../../src/agent/host-turn.ts";

it("registers the docs MCP server and allows its tools when docsMcp is set", async () => {
  let captured: any = null;
  const queryFn = (args: any) => {
    captured = args;
    return (async function* () {
      yield { type: "result", subtype: "success", result: "ACTION: reply\nhi", total_cost_usd: 0, session_id: "sess" };
    })();
  };
  await runHostTurn({
    apiKey: "k", ctx: hostCtx, userMessage: "q",
    docsMcp: { url: "http://h/mcp/docs", token: "tok" },
    docsContext: "DOC CONTEXT",
    queryFn: queryFn as any,
  });
  expect(captured.options.mcpServers.docs).toMatchObject({ type: "http", url: "http://h/mcp/docs", headers: { Authorization: "Bearer tok" } });
  expect(captured.options.allowedTools.some((t: string) => t.startsWith("mcp__docs"))).toBe(true);
  // canUseTool allows a docs tool call
  const decision = await captured.options.canUseTool("mcp__docs__get_document");
  expect(decision.behavior).toBe("allow");
  expect(String(captured.prompt).includes("DOC CONTEXT")).toBe(true);
});
```
(Define `hostCtx` following the existing host-turn test's context fixture; if the file has none yet, add a minimal `IssueContext`.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/agent/host-turn.test.ts -t "registers the docs MCP"`
Expected: FAIL — `docsMcp`/`docsContext` ignored; no `mcpServers`.

- [ ] **Step 3: Implement**

In `src/agent/host-turn.ts`:

```ts
import type { DocsMcpConfig } from "./tasks.ts";
```

Change the tool allow set to accept the docs prefix. Replace the `HOST_TOOLS`/`HOST_TOOLS_SET` usage in `canUseTool` with a predicate:

```ts
const HOST_WEB_TOOLS = ["WebSearch", "WebFetch"];
function hostToolAllowed(name: string): boolean {
  return name === "WebSearch" || name === "WebFetch" || name.startsWith("mcp__docs");
}
```

Extend the opts and prompt:

```ts
export async function runHostTurn(opts: {
  apiKey: string;
  ctx: IssueContext;
  userMessage: string;
  history?: string;
  docsContext?: string;
  docsMcp?: DocsMcpConfig;
  queryFn?: QueryFn;
}): Promise<HostTurnResult> {
  const run = opts.queryFn ?? (query as unknown as QueryFn);
  const docsTools = opts.docsMcp ? ["mcp__docs"] : [];
  const prompt =
    `The human's latest message:\n${opts.userMessage}\n\n` +
    `Respond per the PROTOCOL. You do NOT have repo access in this turn — if you must read the code to ` +
    `answer or plan, emit ACTION: need_repo.\n\n---\n${issueBlock(opts.ctx)}${historyBlock(opts.history)}` +
    (opts.docsContext ? `\n\n---\nLinear documents:\n${opts.docsContext}` : "");

  process.env.ANTHROPIC_API_KEY = opts.apiKey;
  // ...unchanged locals...

  for await (const message of run({
    prompt,
    options: {
      model: "claude-sonnet-5",
      systemPrompt: { type: "preset", preset: "claude_code", append: CONVERSE_APPEND, excludeDynamicSections: true },
      allowedTools: [...HOST_WEB_TOOLS, ...docsTools],
      permissionMode: "default",
      canUseTool: async (name: string) =>
        hostToolAllowed(name) ? { behavior: "allow" as const } : { behavior: "deny" as const },
      maxTurns: 8,
      maxBudgetUsd: 0.5,
      effort: "medium",
      ...(opts.docsMcp ? { mcpServers: { docs: { type: "http", url: opts.docsMcp.url, headers: { Authorization: `Bearer ${opts.docsMcp.token}` } } } } : {}),
    },
  })) {
    // ...unchanged message handling...
  }
  // ...unchanged return...
}
```

> The `HOST_TOOLS`/`HOST_TOOLS_SET` constants (lines 10–11) are replaced by `HOST_WEB_TOOLS` + `hostToolAllowed`. Keep the "NEVER add Bash/Edit/Write" comment — the deny gate still enforces it (docs tools are remote read-only).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/agent/host-turn.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/host-turn.ts tests/agent/host-turn.test.ts
git commit -m "feat(agent): register docs MCP server + doc context in the Tier 0 host turn"
```

---

## Task 10: Register the docs HTTP MCP server in the sandbox runner (`runner.mjs`)

**Files:**
- Modify: `src/agent/runner.mjs`

**Interfaces:**
- Consumes: `task.docsMcp` = `{ url, token }` (Task 8).
- Produces: when present, `mcpServers.docs = { type: "http", url, headers: { Authorization: "Bearer <token>" } }` registered alongside serena.

> **No unit test:** `runner.mjs` is plain JS run only inside the sandbox and is not in the vitest suite (see Global Constraints). Verified by template rebuild + live acceptance run.

- [ ] **Step 1: Implement**

In `src/agent/runner.mjs`, after the serena registration block (after line ~141):

```js
// Docs MCP (Linear docs / thread / prior run events over streamable HTTP).
// The host passes a per-run bearer token; the Linear OAuth token never enters
// the sandbox. ponytail: presence check only — no docsMcp, no registration, and
// the agent simply lacks the tools (advisory), never a crash.
if (task.docsMcp?.url && task.docsMcp?.token) {
  mcpServers.docs = {
    type: "http",
    url: task.docsMcp.url,
    headers: { Authorization: `Bearer ${task.docsMcp.token}` },
  };
}
```

- [ ] **Step 2: Rebuild the template**

Run: `node --env-file-if-exists=.env e2b/build-template.ts`
Expected: `Built template: jarvis-agent`. (Requires `E2B_API_KEY`.)

> Until the template is rebuilt, sandboxes run the old runner and the docs tools are absent in Tier 1 (advisory — runs still succeed without them). Combine this rebuild with Task 13's template change to rebuild once.

- [ ] **Step 3: Commit**

```bash
git add src/agent/runner.mjs
git commit -m "feat(runner): register docs HTTP MCP server from task.docsMcp in the sandbox"
```

---

## Task 11: Orchestrator wiring — mint/revoke tokens, pass docsMcp + doc context

**Files:**
- Modify: `src/orchestrator/pipeline.ts`
- Test: `tests/orchestrator/pipeline.test.ts` (add cases; extend the test harness's `Orchestrator` construction with the new registry arg)

**Interfaces:**
- Consumes: `RunTokenRegistry` (Task 4); `assembleDocContext` (Task 7); `DocsMcpConfig` (Task 8); task builders' new params (Task 8); `runHostTurn` new opts (Task 9); `config.publicBaseUrl`.
- Produces:
  - `Orchestrator` constructor gains a final optional param `docsTokens?: RunTokenRegistry`. When absent (tests that don't exercise docs), doc plumbing no-ops.
  - Private helper `#withDocsToken<T>(ctx, fn: (docsMcp?: DocsMcpConfig) => Promise<T>): Promise<T>` — mints a token (issue-scoped to `ctx.issueId`, keyed by `ctx.agentSessionId`), calls `fn` with the `{ url, token }` config, and revokes in a `finally`. Returns `fn(undefined)` when no registry is wired.
  - Private helper `#docContext(ctx): Promise<string | undefined>` — wraps `assembleDocContext(this.#getToken, ctx.issueId, issueText, {...})` where `issueText = ${ctx.description}\n${ctx.comment}\n${ctx.promptContext}`; advisory (`assembleDocContext` already swallows failures).

- [ ] **Step 1: Write the failing test**

Add to `tests/orchestrator/pipeline.test.ts` a test that the converse host turn receives a `docsMcp` when a registry is wired, and that the token is revoked after. Follow the file's existing harness for constructing an `Orchestrator` with fakes; capture `runHostTurn` opts via the injected `runHostTurn` fake.

```ts
// tests/orchestrator/pipeline.test.ts — sketch (adapt to the file's existing fakes)
import { RunTokenRegistry } from "../../src/mcp/docs-server.ts";

it("mints a docsMcp token for the host turn and revokes it after", async () => {
  const registry = new RunTokenRegistry();
  let seenToken: string | undefined;
  const runHostTurn = vi.fn(async (opts: any) => {
    seenToken = opts.docsMcp?.token;
    expect(opts.docsMcp?.url).toContain("/mcp/docs");
    expect(registry.resolve(seenToken!)).toBeTruthy(); // live during the turn
    return { text: "ACTION: reply\nhi", action: "reply", body: "hi", sessionId: null, costUsd: null };
  });
  const orch = makeOrchestrator({ runHostTurn, docsTokens: registry }); // harness helper
  await orch.onCreated(baseCtx);
  expect(seenToken).toBeTruthy();
  expect(registry.resolve(seenToken!)).toBeUndefined(); // revoked after
});
```

> The pipeline test file already injects `runHostTurn` (constructor position 11). Add `docsTokens` as position 12. If the harness builds the orchestrator inline, thread the new arg there.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/orchestrator/pipeline.test.ts -t "mints a docsMcp token"`
Expected: FAIL — constructor has no 12th param; host turn gets no `docsMcp`.

- [ ] **Step 3: Implement the wiring**

Imports:

```ts
import { assembleDocContext } from "../linear/docs.ts";
import type { RunTokenRegistry } from "../mcp/docs-server.ts";
import type { DocsMcpConfig } from "../agent/tasks.ts";
```

Add the field + constructor param (append after `fetchParent`):

```ts
  #docsTokens?: RunTokenRegistry;
```
```ts
  constructor(
    // ...existing params through fetchParent...
    fetchParent?: (issueId: string) => Promise<{ id: string; title: string; description: string } | null>,
    docsTokens?: RunTokenRegistry,
  ) {
    // ...existing assignments...
    this.#docsTokens = docsTokens;
  }
```

Add the helpers (near `#extractImages`):

```ts
  // Mint a per-run issue-scoped bearer token, run fn with the docs MCP config,
  // and revoke it after. No registry wired (tests) → fn runs with no config.
  async #withDocsToken<T>(ctx: IssueContext, fn: (docsMcp?: DocsMcpConfig) => Promise<T>): Promise<T> {
    if (!this.#docsTokens) return fn(undefined);
    const token = this.#docsTokens.mint({ agentSessionId: ctx.agentSessionId, issueId: ctx.issueId });
    try {
      return await fn({ url: `${this.#config.publicBaseUrl}/mcp/docs`, token });
    } finally {
      this.#docsTokens.revoke(token);
    }
  }

  // Up-front doc context (ticket + project docs, pasted doc links). Advisory:
  // assembleDocContext swallows all failures and returns undefined.
  async #docContext(ctx: IssueContext): Promise<string | undefined> {
    const issueText = `${ctx.description}\n${ctx.comment}\n${ctx.promptContext}`;
    return assembleDocContext(this.#getToken, ctx.issueId, issueText, { onUnauthorized: this.#onUnauthorized });
  }
```

Wire into each run path. **`#runConverseTurn`** (Tier 0 + Tier 1) — wrap the whole turn:

```ts
  async #runConverseTurn(ctx: IssueContext, acts: Activities, userMessage: string): Promise<void> {
    await acts.thought("Thinking…");
    const history = ctx.issueId ? await this.#fetchThread?.(ctx.issueId).catch(() => "") : "";
    const docsContext = await this.#docContext(ctx);
    await this.#withDocsToken(ctx, async (docsMcp) => {
      const r: HostTurnResult = await this.#runHostTurn({
        apiKey: this.#config.anthropicApiKey, ctx, userMessage,
        history: history || undefined, docsContext, docsMcp,
      });
      const { action, body, sessionId, costUsd } = r;

      if (action === "need_repo") {
        await acts.thought("Let me pull up the code…");
        const map = this.#store.getRepoMap(this.#config.targetRepo);
        const result = await withSandbox(this.#sbxCfg(ctx.agentSessionId), async (sbx) => {
          this.#store.setSandbox(ctx.agentSessionId, sbx.sandboxId);
          await cloneRepo(sbx, this.#sbxCfg(ctx.agentSessionId), this.#store.get(ctx.agentSessionId)?.branch ?? null);
          const hist = await this.#timed(ctx.agentSessionId, "history", () =>
            prepareHistory(this.#store, sbx, ctx.issueId, this.#fetchThread));
          const images = await this.#extractImages(ctx, hist);
          return this.#trackedRun(ctx.agentSessionId, "converse", sbx, converseTask(ctx, userMessage, map, hist, images, docsContext, docsMcp), acts);
        });
        this.#store.setSandbox(ctx.agentSessionId, null);
        const text = result?.kind === "result" && result.text ? result.text : "";
        if (result?.kind === "result" && result.sessionId) this.#store.setSdkSessionId(ctx.agentSessionId, result.sessionId);
        if (!text) { await acts.error("I couldn't work that out — reply again to retry.").catch(() => undefined); return; }
        const parsed = parseConverseAction(text);
        await this.#dispatchConverse(ctx, acts, parsed.action, parsed.body, costLine(result));
        return;
      }

      if (sessionId) this.#store.setSdkSessionId(ctx.agentSessionId, sessionId);
      const cost = costUsd != null ? `\n\n_Cost: $${costUsd.toFixed(4)}_` : "";
      await this.#dispatchConverse(ctx, acts, action, body, cost);
    });
  }
```

**`#runPlan`** — inside the `withSandbox`, after computing `history`/`images`:

```ts
      const history = await this.#timed(ctx.agentSessionId, "history", () =>
        prepareHistory(this.#store, sbx, ctx.issueId, this.#fetchThread),
      );
      const images = await this.#extractImages(ctx, history);
      const docsContext = await this.#docContext(ctx);
      return this.#withDocsToken(ctx, (docsMcp) =>
        this.#trackedRun(ctx.agentSessionId, "plan", sbx, planTask(ctx, map, history, images, docsContext, docsMcp), acts),
      );
```

**`#runImplement`** — same pattern around the implement `#trackedRun`:

```ts
      const images = await this.#extractImages(ctx, history);
      const docsContext = await this.#docContext(ctx);
      const r = await this.#withDocsToken(ctx, (docsMcp) =>
        this.#trackedRun(ctx.agentSessionId, "implement", sbx, implementTask(ctx, plan, map, workBranch, history, images, docsContext, docsMcp), acts),
      );
```

**`#runReview`** — around the review `#trackedRun`, add `docsContext`:

```ts
        const history = await this.#timed(ctx.agentSessionId, "history", () =>
          prepareHistory(this.#store, sbx, ctx.issueId, this.#fetchThread),
        );
        const docsContext = await this.#docContext(ctx);
        return this.#withDocsToken(ctx, (docsMcp) =>
          this.#trackedRun(ctx.agentSessionId, "review", sbx, reviewTask(ctx, row.prUrl!, row.plan, replyText, map, history, docsContext, docsMcp), acts),
        );
```

> `#maybeSelfReview` (self-review of a fresh diff) deliberately gets **no** history and **no** docs — it reviews its own diff; leave it unchanged.

- [ ] **Step 4: Run the tests + full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS. The `server.ts` 12th-arg call (Task 6) now type-checks. Existing pipeline tests still pass (registry absent → `#withDocsToken` runs `fn(undefined)`, doc context undefined → `docsBlock` renders `""`, byte-identical goals).

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/pipeline.ts tests/orchestrator/pipeline.test.ts
git commit -m "feat(orchestrator): mint/revoke per-run docs tokens + inject doc context into every tier"
```

---

## Task 12: Generalize `attachments.ts` to all file formats with content-type routing

**Files:**
- Modify: `src/linear/attachments.ts`
- Test: `tests/linear/attachments.test.ts`

**Interfaces:**
- Consumes: `fetchWithAuth`, `TokenSource`.
- Produces:
  - `interface FileAttachment { url: string; filename: string; mediaType: string; data: string /* base64 */ }`
  - `function extractAttachmentUrls(text: string): string[]` — all `uploads.linear.app` links (image markdown `![]()` **and** plain link markdown `[]()` **and** bare URLs), deduped, capped at `MAX_ATTACHMENTS`.
  - `function fetchAttachments(token, text, fetchImpl?, onUnauthorized?): Promise<FileAttachment[]>` — downloads each (cap `MAX_ATTACHMENT_BYTES`), skipping failures/oversized.
  - `function routeAttachment(a: FileAttachment): "image" | "pdf" | "text" | "binary"` — content-type router.
  - Keep `extractImageUrls` / `fetchImageAttachments` as thin wrappers over the generalized functions (filter to `image/*`) so existing callers/tests keep working.
- New constants: `MAX_ATTACHMENTS = 5`, `MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/linear/attachments.test.ts — add (keep existing describes)
import { extractAttachmentUrls, fetchAttachments, routeAttachment } from "../../src/linear/attachments.ts";

function res(bytes: number, contentType: string): Response {
  return new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": contentType } });
}

describe("extractAttachmentUrls", () => {
  it("finds image, plain-link, and bare uploads.linear.app urls, deduped", () => {
    const text =
      "![img](https://uploads.linear.app/a.png) [doc](https://uploads.linear.app/b.pdf) " +
      "raw https://uploads.linear.app/c.csv and dup https://uploads.linear.app/a.png";
    expect(extractAttachmentUrls(text)).toEqual([
      "https://uploads.linear.app/a.png",
      "https://uploads.linear.app/b.pdf",
      "https://uploads.linear.app/c.csv",
    ]);
  });
});

describe("routeAttachment", () => {
  it("routes by content type", () => {
    expect(routeAttachment({ url: "", filename: "", mediaType: "image/png", data: "" })).toBe("image");
    expect(routeAttachment({ url: "", filename: "", mediaType: "application/pdf", data: "" })).toBe("pdf");
    expect(routeAttachment({ url: "", filename: "", mediaType: "text/csv", data: "" })).toBe("text");
    expect(routeAttachment({ url: "", filename: "", mediaType: "application/json", data: "" })).toBe("text");
    expect(routeAttachment({ url: "", filename: "", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data: "" })).toBe("binary");
  });
});

describe("fetchAttachments", () => {
  it("downloads all formats and records filename + mediaType, skipping oversized", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith(".pdf")) return res(10, "application/pdf");
      if (url.endsWith(".csv")) return res(6 * 1024 * 1024, "text/csv"); // oversized → skipped
      return res(4, "image/png");
    });
    const text = "![i](https://uploads.linear.app/a.png) [d](https://uploads.linear.app/b.pdf) https://uploads.linear.app/c.csv";
    const out = await fetchAttachments("tok", text, fetchImpl as unknown as typeof fetch);
    expect(out.map((a) => a.mediaType)).toEqual(["image/png", "application/pdf"]);
    expect(out[1].filename).toBe("b.pdf");
  });
});
```

Keep the existing `extractImageUrls` / `fetchImageAttachments` describes — they must still pass.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/linear/attachments.test.ts`
Expected: FAIL — new exports missing.

- [ ] **Step 3: Implement**

Replace `src/linear/attachments.ts`:

```ts
import { fetchWithAuth, type TokenSource } from "./client.ts";

// Attachments (screenshots and files) arrive as markdown links to Linear's
// authenticated upload host. Images use ![](), files use [](); tolerate bare
// URLs too. All extraction + download lives here.
const UPLOAD_URL_RE = /https:\/\/uploads\.linear\.app\/[^\s)]+/g;

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export interface FileAttachment { url: string; filename: string; mediaType: string; data: string }
export interface ImageAttachment { mediaType: string; data: string }

/** Every distinct uploads.linear.app URL in `text`, capped. */
export function extractAttachmentUrls(text: string): string[] {
  const urls: string[] = [];
  for (const m of text.matchAll(UPLOAD_URL_RE)) {
    const url = m[0].replace(/[),.]+$/, ""); // strip trailing punctuation from bare URLs
    if (!urls.includes(url)) urls.push(url);
  }
  return urls.slice(0, MAX_ATTACHMENTS);
}

// Back-compat: image-only extraction still used where only vision blocks matter.
const IMAGE_MD_RE = /!\[[^\]]*\]\((https:\/\/uploads\.linear\.app\/[^)]+)\)/g;
export function extractImageUrls(text: string): string[] {
  const urls: string[] = [];
  for (const m of text.matchAll(IMAGE_MD_RE)) if (!urls.includes(m[1])) urls.push(m[1]);
  return urls.slice(0, MAX_ATTACHMENTS);
}

function filenameOf(url: string): string {
  try { return decodeURIComponent(new URL(url).pathname.split("/").pop() || "file"); } catch { return "file"; }
}

/** Download all attachments; advisory — a failed/oversized download is skipped. */
export async function fetchAttachments(
  token: TokenSource,
  text: string,
  fetchImpl: typeof fetch = fetch,
  onUnauthorized?: () => Promise<string>,
): Promise<FileAttachment[]> {
  const out: FileAttachment[] = [];
  for (const url of extractAttachmentUrls(text)) {
    try {
      const r = await fetchWithAuth(url, {}, token, fetchImpl, onUnauthorized);
      if (!r.ok) continue;
      const buf = await r.arrayBuffer();
      if (buf.byteLength > MAX_ATTACHMENT_BYTES) continue;
      const mediaType = (r.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim();
      out.push({ url, filename: filenameOf(url), mediaType, data: Buffer.from(buf).toString("base64") });
    } catch (err) {
      console.error(`[attachments] download failed for ${url} (advisory): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

export type AttachmentKind = "image" | "pdf" | "text" | "binary";
export function routeAttachment(a: FileAttachment): AttachmentKind {
  if (a.mediaType.startsWith("image/")) return "image";
  if (a.mediaType === "application/pdf") return "pdf";
  if (a.mediaType.startsWith("text/") || a.mediaType === "application/json" || a.mediaType.includes("csv")) return "text";
  return "binary";
}

/** Back-compat wrapper: image content blocks only (used by callers that only
 *  want vision). Delegates to fetchAttachments + the image router. */
export async function fetchImageAttachments(
  token: TokenSource,
  text: string,
  fetchImpl: typeof fetch = fetch,
  onUnauthorized?: () => Promise<string>,
): Promise<ImageAttachment[]> {
  const all = await fetchAttachments(token, text, fetchImpl, onUnauthorized);
  return all.filter((a) => routeAttachment(a) === "image").map((a) => ({ mediaType: a.mediaType, data: a.data }));
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/linear/attachments.test.ts`
Expected: PASS (new + existing describes).

> The existing image tests assert `extractImageUrls` caps at 5 and dedupes — preserved. The 401-refresh test uses `fetchImageAttachments` — preserved via the wrapper.

- [ ] **Step 5: Commit**

```bash
git add src/linear/attachments.ts tests/linear/attachments.test.ts
git commit -m "feat(attachments): generalize to all file formats with content-type routing"
```

---

## Task 13: Route file attachments into tasks + Tier 0 content blocks + template deps

**Files:**
- Modify: `src/orchestrator/pipeline.ts` (`#extractImages` → `#extractAttachments`; write text/binary files into the sandbox; pass PDFs/images as content blocks)
- Modify: `src/agent/tasks.ts` (add `documents?` + `attachmentNote?` support to `AgentTask` / builders as needed)
- Modify: `src/agent/host-turn.ts` (accept `images` + `documents` content blocks on the Tier 0 prompt)
- Modify: `src/agent/runner.mjs` (accept `document` content blocks in `userMsg`)
- Modify: `e2b/build-template.ts` (apt-install `pandoc`, `poppler-utils`)
- Test: `tests/orchestrator/pipeline.test.ts`, `tests/agent/tasks.test.ts`, `tests/agent/host-turn.test.ts`

**Interfaces:**
- Produces:
  - `AgentTask.documents?: { mediaType: string; data: string; filename: string }[]` — native `document` content blocks (PDFs) for the first turn, next to `images`.
  - `AgentTask` goal gains, when binary/text files were written into the sandbox, a one-line pointer: `Files attached to this issue are in /home/user/jarvis-attachments/ (…names…). Read them; convert office/binary formats with pandoc or poppler-utils (pdftotext) as needed.`
  - Pipeline: `#extractAttachments(ctx, history): Promise<{ images?; documents?; sandboxFiles: { filename: string; data: string }[]; note?: string }>`.
  - Sandbox attachment dir constant `ATTACHMENTS_DIR = "/home/user/jarvis-attachments"` (declare in `pipeline.ts` or `session.ts`; put it in `session.ts` next to `REPO_DIR`).
- Routing (matches the spec table):
  - `image/*` → image content block (Tier 0 + Tier 1).
  - `application/pdf` → native `document` content block (Tier 0 + Tier 1).
  - text-ish → Tier 1: file in `ATTACHMENTS_DIR`; Tier 0: append inlined fenced text to `docsContext`-style goal note (labeled-truncation rule; cap per file, marker points to nothing external — Tier 0 text is best-effort, so cap at e.g. 20k with a `[truncated]` note and rely on `need_repo` escalation).
  - other binary → Tier 1: file in `ATTACHMENTS_DIR` (agent converts with pandoc/poppler); Tier 0: filename listed in the goal note, agent escalates via `need_repo`.

> This task is the "file attachments" subsystem and is the most involved; keep each sub-change behind a test where the surface is testable (extraction/routing already covered in Task 12; here test the pipeline's file-writing + the task/host-turn content-block shape). The runner.mjs `document`-block change has no unit test (same rule as Task 10).

- [ ] **Step 1: Write the failing tests**

`tasks.test.ts` — `documents` field carried + attachment note in goal:

```ts
it("carries document content blocks and an attachments note", () => {
  const t = planTask(ctx, undefined, undefined, undefined, undefined, undefined);
  expect(t.documents).toBeUndefined();
  // builder accepts documents/attachmentNote via the images-style path (see impl)
});
```

`host-turn.test.ts` — Tier 0 builds a content-block prompt when images/documents present:

```ts
it("builds a content-block user message when images/documents are present", async () => {
  let captured: any = null;
  const queryFn = (args: any) => { captured = args; return (async function* () {
    yield { type: "result", subtype: "success", result: "ACTION: reply\nok", session_id: "s" };
  })(); };
  await runHostTurn({
    apiKey: "k", ctx: hostCtx, userMessage: "q",
    images: [{ mediaType: "image/png", data: "AAAA" }],
    documents: [{ mediaType: "application/pdf", data: "BBBB", filename: "spec.pdf" }],
    queryFn: queryFn as any,
  });
  // prompt is now an async iterable of a user message with content blocks
  const first = (await captured.prompt[Symbol.asyncIterator]().next()).value;
  const kinds = first.message.content.map((b: any) => b.type);
  expect(kinds).toContain("image");
  expect(kinds).toContain("document");
  expect(kinds).toContain("text");
});
```

`pipeline.test.ts` — text/binary attachments are written into the sandbox and the goal note appears. Use the existing sandbox fake's `files.write` capture; assert a write under `/home/user/jarvis-attachments/`.

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run tests/agent/tasks.test.ts tests/agent/host-turn.test.ts tests/orchestrator/pipeline.test.ts`
Expected: FAIL — `documents` unsupported; host-turn prompt is a string; no attachment writes.

- [ ] **Step 3: Implement**

**`session.ts`** — add the dir constant next to `REPO_DIR`:

```ts
export const ATTACHMENTS_DIR = "/home/user/jarvis-attachments";
```

**`tasks.ts`** — add `documents` to `AgentTask` and an `attachmentNote` goal segment. Simplest: add both as fields on `AgentTask` and let the orchestrator fold `attachmentNote` into `docsContext` (reuse `docsBlock`) OR add a dedicated `attachmentsBlock(note?)`. Use a dedicated block for clarity:

```ts
export interface AgentTask {
  // ...existing...
  documents?: { mediaType: string; data: string; filename: string }[];
}
export function attachmentsBlock(note?: string): string {
  if (!note) return "";
  return `\n\n---\n${note}`;
}
```
Thread an optional `attachmentNote?: string` param into each builder's goal via `attachmentsBlock(attachmentNote)` and set `documents` on the returned task. (Positional, appended after `docsMcp`.)

**`runner.mjs`** — extend `userMsg` to emit `document` blocks:

```js
const userMsg = (text, images, documents) => ({
  type: "user",
  message: {
    role: "user",
    content: [
      ...(images ?? []).map((img) => ({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } })),
      ...(documents ?? []).map((doc) => ({ type: "document", source: { type: "base64", media_type: doc.mediaType, data: doc.data } })),
      { type: "text", text },
    ],
  },
  parent_tool_use_id: null,
  session_id: "",
});
```
And the first yield in `promptStream`: `yield userMsg(task.goal, task.images, task.documents);`

**`host-turn.ts`** — accept `images`/`documents`; when present, pass `prompt` as an async generator yielding one user message with content blocks; else keep the plain string. Widen `QueryFn` prompt type to `string | AsyncIterable<unknown>`:

```ts
type QueryFn = (args: { prompt: string | AsyncIterable<unknown>; options: Record<string, unknown> }) => AsyncIterable<SdkMessage>;

// inside runHostTurn, after building `prompt` (string):
const hasBlocks = (opts.images?.length ?? 0) + (opts.documents?.length ?? 0) > 0;
const promptArg = hasBlocks
  ? (async function* () {
      yield {
        type: "user",
        message: { role: "user", content: [
          ...(opts.images ?? []).map((i) => ({ type: "image", source: { type: "base64", media_type: i.mediaType, data: i.data } })),
          ...(opts.documents ?? []).map((d) => ({ type: "document", source: { type: "base64", media_type: d.mediaType, data: d.data } })),
          { type: "text", text: prompt },
        ] },
        parent_tool_use_id: null, session_id: "",
      };
    })()
  : prompt;
// pass promptArg as `prompt` in the run({...}) call
```
Add `images?` / `documents?` to `runHostTurn`'s opts type.

**`pipeline.ts`** — replace `#extractImages` with `#extractAttachments`, which downloads all attachments (via `fetchAttachments`), splits by `routeAttachment`, writes text/binary into `ATTACHMENTS_DIR` in the sandbox, and returns `{ images, documents, note }`. Because Tier 0 has no sandbox, add a separate lightweight extractor for the host turn returning only `images`/`documents` (+ inlined text into a note). Keep it advisory (try/catch, log `[attachments]`).

Sketch (sandbox-aware variant used by plan/implement/converse-Tier1/review):

```ts
import { fetchAttachments, routeAttachment } from "../linear/attachments.ts";
import { ATTACHMENTS_DIR } from "../sandbox/session.ts";

async #extractAttachments(ctx: IssueContext, sbx: AgentSandbox | null, history?: string): Promise<{
  images?: AgentTask["images"]; documents?: AgentTask["documents"]; note?: string;
}> {
  const text = `${ctx.description}\n${ctx.comment}\n${history ?? ""}`;
  try {
    const all = await fetchAttachments(this.#getToken, text, fetch, this.#onUnauthorized);
    const images: AgentTask["images"] = [];
    const documents: AgentTask["documents"] = [];
    const written: string[] = [];
    for (const a of all) {
      const kind = routeAttachment(a);
      if (kind === "image") images.push({ mediaType: a.mediaType, data: a.data });
      else if (kind === "pdf") documents.push({ mediaType: a.mediaType, data: a.data, filename: a.filename });
      else if (sbx) {
        try { await sbx.files.write(`${ATTACHMENTS_DIR}/${a.filename}`, Buffer.from(a.data, "base64").toString("binary")); written.push(a.filename); }
        catch (err) { console.error(`[attachments] write ${a.filename} failed (advisory): ${err instanceof Error ? err.message : String(err)}`); }
      }
    }
    const note = written.length
      ? `Files attached to this issue are in ${ATTACHMENTS_DIR}/ (${written.join(", ")}). Read them directly; convert office/binary formats with pandoc or poppler-utils (pdftotext) as needed.`
      : undefined;
    return { images: images.length ? images : undefined, documents: documents.length ? documents : undefined, note };
  } catch (err) {
    console.error(`[attachments] extract failed (advisory): ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}
```
Replace the existing `#extractImages(ctx, history)` call sites: pass the new `images`/`documents`/`note` into the task builders (`images` + `documents` fields, `note` as `attachmentNote`). For the Tier 0 host turn, call `#extractAttachments(ctx, null, history)` (no sandbox → text/binary become filenames only in `note`, images/pdf become content blocks) and pass `images`/`documents` to `runHostTurn`.

> **Note (text on Tier 0):** the spec's "inlined fenced text" for Tier 0 text files is optional polish; the lazy path here lists them in `note` and lets the agent `need_repo`-escalate to read them in a sandbox. If inlining is wanted, extend `#extractAttachments(null)` to fold small text files into `note` with a `[truncated]` marker at ~20k. Marked as a follow-up, not required for the feature to work.

**`build-template.ts`** — add the packages to the first `aptInstall`:

```ts
  .aptInstall(["curl", "git", "ca-certificates", "python3", "python3-venv", "python3-pip", "pandoc", "poppler-utils"])
```

- [ ] **Step 4: Run tests + typecheck + rebuild template**

Run: `npm run typecheck && npm test`
Expected: PASS.
Run: `node --env-file-if-exists=.env e2b/build-template.ts`
Expected: `Built template: jarvis-agent` (bakes runner.mjs's `document`-block change from this task + Task 10's docs MCP registration + pandoc/poppler).

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/pipeline.ts src/agent/tasks.ts src/agent/host-turn.ts src/agent/runner.mjs src/sandbox/session.ts e2b/build-template.ts tests/
git commit -m "feat(attachments): route files into tasks, Tier 0 content blocks, pandoc/poppler in template"
```

---

## Task 14: End-to-end verification pass

**Files:** none (verification only).

- [ ] **Step 1: Full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 2: Confirm the CLAUDE.md upgrade-path claim holds**

The `src/history/history.ts` `ponytail:` comment named "a host-side retrieval tool" as the cross-issue-memory upgrade path, and CLAUDE.md's session-memory section names the same. The `/mcp/docs` endpoint is now that channel. Update the two `ponytail:` notes (history.ts + CLAUDE.md session-memory paragraph) to point at `src/mcp/docs-server.ts` as the realized channel (future cross-issue tools join the same server). One-line edits.

```bash
git add src/history/history.ts CLAUDE.md
git commit -m "docs: point session-memory upgrade-path notes at the realized docs MCP channel"
```

- [ ] **Step 3: Live acceptance (manual, outside the suite)**

With the rebuilt template deployed, on a test Linear issue:
1. Attach a PDF + a Linear doc to the ticket; assign to Jarvis. Confirm the plan references doc content (up-front injection) and the run logs show a `mcp__docs` tool call is *available* (agent may or may not call it).
2. In the sandbox agent's logs, confirm `get_document` / `get_thread` return content and that an unknown token 401s (`curl` the endpoint with a bogus bearer).
3. Confirm a non-image attachment lands in `/home/user/jarvis-attachments/` and the agent can `pdftotext`/`pandoc` it.

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task(s) |
|---|---|
| §1 Docs MCP server, both tiers | 4 (registry), 5 (dispatcher+tools), 6 (mount), 9 (Tier 0), 10 (Tier 1 runner), 11 (wiring/tokens) |
| §1 `search_documents` / `get_document` | 1 (GraphQL) + 5 (tool wiring) |
| §1 `get_thread` (issue-scoped, no id param) | 3 (uncapped assemble) + 5 (tool) + 2/11 (issue scope via token) |
| §1 `get_run_events` (index, filter, line-aligned) | 2 (store) + 5 (tool) |
| §1 Auth: per-run bearer token, revoked on finish, Linear token never in sandbox | 4 (registry) + 11 (mint/revoke) + 5 (401) + 6 (host-side reads) |
| §1 truncation markers name the recovering tool | 3 (thread + run logs) + 5 (get_document marker) + 7 (injection marker) |
| §2 pre-injected doc context (Issue.documents, pasted links, Project.content, index) | 7 (assembleDocContext) + 8/11 (goal injection) |
| §3 recoverable session-memory caps | 3 (thread + run-log markers, older-runs note) |
| §4 file attachments, all formats, routing table | 12 (generalize + routing) + 13 (route into tasks, Tier 0 blocks, template) |
| §5 advisory error handling | every task (log-and-continue, tool errors return strings) |
| §6 testing (docs faked, endpoint 401/scoping, attachments routing, truncation labels) | 1,2,3,5,7,12 tests |
| Out of scope (write, cross-issue, host-side office conversion) | not implemented; §14 step 2 only re-points the upgrade-path note |

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N" — every code step shows the code. The two deliberately-untested surfaces (`runner.mjs` in Tasks 10 & 13) are flagged with the reason (plain JS, not in the suite) and get a template-rebuild verification step instead, consistent with the repo's stated conventions.

**3. Type consistency:** `DocsMcpConfig { url; token }` defined in Task 8, consumed identically in Tasks 9/10/11. `RunTokenClaims { agentSessionId; issueId }` defined Task 4, used Task 5/11. `RunIndexEntry`/`getRunIndexByIssue`/`getRunJsonl` defined Task 2, consumed Task 5. `FileAttachment`/`routeAttachment` defined Task 12, consumed Task 13. `assembleDocContext`/`renderDocContext` defined Task 7, consumed Task 11. Tool names (`search_documents`, `get_document`, `get_thread`, `get_run_events`) and MCP server key (`docs` → `mcp__docs`) consistent across Tasks 5/8/9/10. `Orchestrator` constructor's new 12th arg (`docsTokens`) added in Task 11, passed in Task 6 — Task 6's step 4 note calls out the ordering dependency.
