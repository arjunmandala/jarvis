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

test("registers the docs MCP server and allows its tools when docsMcp is set", async () => {
  let captured: any = null;
  const queryFn = (args: any) => {
    captured = args;
    return (async function* () {
      yield { type: "result", subtype: "success", result: "ACTION: reply\nhi", total_cost_usd: 0, session_id: "sess" };
    })();
  };
  await runHostTurn({
    apiKey: "k", ctx, userMessage: "q",
    docsMcp: { url: "http://h/mcp/docs", token: "tok" },
    docsContext: "DOC CONTEXT",
    queryFn: queryFn as any,
  });
  expect(captured.options.mcpServers.docs).toMatchObject({ type: "http", url: "http://h/mcp/docs", headers: { Authorization: "Bearer tok" } });
  expect(captured.options.allowedTools.some((t: string) => t.startsWith("mcp__docs"))).toBe(true);
  // canUseTool allows a docs tool call
  const decision = await captured.options.canUseTool("mcp__docs__get_document");
  expect(decision.behavior).toBe("allow");
  // and still denies Bash
  const denied = await captured.options.canUseTool("Bash");
  expect(denied.behavior).toBe("deny");
  expect(String(captured.prompt).includes("DOC CONTEXT")).toBe(true);
});
