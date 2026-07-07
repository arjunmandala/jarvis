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
  retrievable, or the agent hallucinates the missing part.

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

### 3. File attachments

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

### 4. Error handling

Advisory end-to-end, matching history/serena/workflow precedent: any doc
fetch, attachment download, or MCP registration failure logs
(`[docs]` / `[attachments]`) and the run proceeds without that context.
Tool-call failures return an error string to the agent, never wedge the run.
No new run-blocking dependencies.

### 5. Testing

- `docs.ts` GraphQL layer faked in tests (same pattern as the faked
  `AgentSandbox` — no network in the suite).
- MCP endpoint unit-tested in-process with a fake bearer token: valid token
  → tool result; revoked/unknown token → 401.
- `attachments.ts` extraction + routing table covered by unit tests with
  faked `fetch`.
- Truncation labeling covered: a doc over the injection cap must produce the
  `get_document` marker.

### Out of scope

- Writing to Linear docs (read-only by design).
- Cross-issue memory retrieval (same channel, later tool).
- Host-side office-doc conversion (sandbox `pandoc` covers it).
