import { describe, it, expect } from "vitest";
import { RunTokenRegistry, handleDocsMcp, type DocsMcpDeps } from "../../src/mcp/docs-server.ts";
import { SessionStore } from "../../src/store/sessions.ts";

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
