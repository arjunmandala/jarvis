# Linear Docs & File Attachments as Agent Context

**Date:** 2026-07-07
**Status:** Approved design, pre-implementation

## Problem

Jarvis's agents currently see only the issue title, description, thread, and
pasted screenshots. Two context sources are missing:

1. **Non-image file attachments** (PDF, docx, csv, txt, …) uploaded to the
   issue — today `fetchImageAttachments` filters anything without an
   `image/*` content type.
2. **Linear documentation** — documents attached to the ticket (Linear's
   Resources section, `Issue.documents`), project docs and the project
   overview (`Project.documents`, `Project.content`), and the workspace-wide
   Documents section (`Query.documents` / `Query.searchDocuments`).

Requirements settled during brainstorming:

- All file formats, not a per-format whitelist.
- Docs: the agent decides at runtime what to pull — via a **uniform MCP tool
  available in both tiers** (Tier 0 host turn and Tier 1 sandbox turn).
- Docs explicitly attached to the ticket are injected as context up front;
  the tool covers everything else, including the global workspace.
- No silent truncation anywhere — a capped doc must say so and be fully
  retrievable, or the agent hallucinates the missing part. This extends to
  the existing session-memory caps (injected thread, exported run logs):
  both get retrieval tools with agent-settable params.

## Design

### 1. Docs MCP server — one server, both tiers

`server.ts` gains a streamable-HTTP MCP endpoint (`POST /mcp/docs`), backed
by a new `src/linear/docs.ts` module that owns the GraphQL queries. Both
tiers register the **identical** remote-server config:

- Tier 1: passed on the task; `runner.mjs` adds
  `{ type: "http", url: PUBLIC_BASE_URL + "/mcp/docs", headers: { Authorization: "Bearer <run token>" } }`
  next to its existing serena registration.
- Tier 0: `host-turn.ts` registers the same config in its SDK options (and
  the two tool names join `HOST_TOOLS`).

Tools (read-only):

- `search_documents(query)` → backed by `Query.searchDocuments`: id, title,
  project, snippet. Search, not list — scales to hundreds of workspace docs.
- `get_document(id, offset?)` → `Document.content` markdown, **full content
  by default**. A generous safety ceiling (~100k chars) applies only to
  pathological docs, and a hit returns an explicit
  `[truncated at <n> — call again with offset=<n>]` marker. Never a silent
  cut.
- `get_thread(offset?, limit?)` → the full visible Linear conversation of
  every session on the run's own issue (what `assembleThread` caps at 20k
  chars in the goal). No issue-id parameter: the per-run bearer token
  identifies the run, so the tool can only read its own issue's thread.
- `get_run_events(runId?, offset?, limit?, filter?)` → prior-run event
  streams from the `run_events` table, same issue-scoping via the token.
  With `runId` omitted it returns the run index (runId, taskType, createdAt,
  size) so the agent can pick; `filter` is a substring/regex match applied
  server-side so the agent can pull just tool_use lines or a failure message
  instead of megabytes of JSONL. Line-aligned slicing (never cuts mid-JSON).

All truncation markers name the recovering tool call — e.g. the goal's
thread cap marker becomes
`[older conversation truncated — call get_thread(offset=…)]`.

**Auth:** the host mints a random per-run bearer token, held in an in-memory
map keyed like `#live`, revoked when the run finishes. The Linear OAuth
token never enters the sandbox; a compromised sandbox can at worst read
workspace docs, never write to Linear.

This endpoint is also the foundation the CLAUDE.md `ponytail:` comment names
as the upgrade path for cross-issue memory — future host-side retrieval
tools join the same server.

### 2. Pre-injected doc context

Assembled host-side alongside `prepareHistory()` and appended to the task
`goal` (per-run content — prompt-cache-safe; `systemAppend` stays
byte-stable):

- **Full content, capped ~15k chars total:**
  - `Issue.documents` — docs attached to the ticket's Resources
  - Linear doc links pasted in issue text
    (`linear.app/<ws>/document/<slug>` → resolved via `slugId`)
  - the project overview (`Project.content`)

  When the cap forces a cut, the cut is labeled:
  `[truncated — full doc: get_document("<id>")]`. The agent always has the
  id to fetch the whole thing.

- **Index only (one line: title + id):** the project's remaining documents,
  with a note to fetch via `get_document` when relevant. Doc-heavy projects
  don't bloat every prompt.

### 3. Session history truncation becomes recoverable

Today's session-memory caps stay (they protect the prompt budget) but every
cut becomes labeled and recoverable through the tools above:

- **Injected thread** (`assembleThread`, 20k-char keep-newest-tail): the
  existing `…(older conversation truncated)` marker becomes
  `[older conversation truncated — call get_thread(offset=…)]`.
- **Exported run logs** (`writeHistoryFiles`, newest 10 runs, 1MB tail
  slices): a tail-sliced file gets a first line
  `[truncated: first <n> bytes dropped — call get_run_events(runId=…, …)]`,
  and the goal's history block notes when runs older than the exported 10
  exist. Tier 0, which never had these files, gains access to run history
  for the first time via `get_run_events`.

The agent sets the retrieval params itself (offset/limit/filter) — the host
never decides what the agent gets to see beyond the issue scoping.

### 4. File attachments

Separate from the MCP tool — uploads are bytes, not Linear documents.
`src/linear/attachments.ts` generalizes from images to all
`uploads.linear.app` links (non-image attachments arrive as the same
markdown links, minus the `!`). Downloads stay host-side (the upload host
needs the Linear token). Routing by content type:

| Type | Tier 1 (sandbox) | Tier 0 (host) |
|---|---|---|
| `image/*` | image content block (unchanged) | image content block (new — Tier 0 gains content-block prompts) |
| `application/pdf` | native `document` content block | native `document` content block |
| text-ish (`text/*`, json, csv) | file in `/home/user/jarvis-attachments/` | inlined fenced text, labeled-truncation rule applies |
| other binary (docx, xlsx, …) | file in `/home/user/jarvis-attachments/`; agent converts with `pandoc` / `poppler-utils` (baked into the E2B template — template rebuild required) | filename listed in goal; agent escalates via the existing `need_repo` path |

Caps stay defensive (count + per-file bytes) and every failure is skipped,
never thrown — same advisory contract as images today.

### 5. Error handling

Advisory end-to-end, matching history/serena/workflow precedent: any doc
fetch, attachment download, or MCP registration failure logs
(`[docs]` / `[attachments]`) and the run proceeds without that context.
Tool-call failures return an error string to the agent, never wedge the run.
No new run-blocking dependencies.

### 6. Testing

- `docs.ts` GraphQL layer faked in tests (same pattern as the faked
  `AgentSandbox` — no network in the suite).
- MCP endpoint unit-tested in-process with a fake bearer token: valid token
  → tool result; revoked/unknown token → 401.
- `attachments.ts` extraction + routing table covered by unit tests with
  faked `fetch`.
- Truncation labeling covered: a doc over the injection cap must produce the
  `get_document` marker; a capped thread the `get_thread` marker; a
  tail-sliced run log the `get_run_events` first line.
- `get_thread` / `get_run_events` issue-scoping: a token for run A must
  never return run B's issue data.

### Out of scope

- Writing to Linear docs (read-only by design).
- Cross-issue memory retrieval (same channel, later tool).
- Host-side office-doc conversion (sandbox `pandoc` covers it).
