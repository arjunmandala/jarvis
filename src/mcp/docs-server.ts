import { randomUUID } from "node:crypto";
import type { SessionStore } from "../store/sessions.ts";
import type { TokenSource } from "../linear/client.ts";
import type { ThreadFetcher } from "../history/history.ts";
import { assembleThread } from "../history/history.ts";
import { searchDocuments, getDocumentContent, sliceWithMarker, DOC_FETCH_CEILING } from "../linear/docs.ts";

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

// ponytail: hand-rolled minimal MCP handler covering exactly the JSON-RPC
// methods the Agent SDK's streamable-HTTP MCP client calls (initialize,
// tools/list, tools/call, plus swallowing notifications/initialized) — not
// the full MCP spec (no SSE streaming, no session resumption). Upgrade to
// @modelcontextprotocol/sdk's StreamableHTTPServerTransport if the client
// ever needs more.
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
