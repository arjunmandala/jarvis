import { test, expect } from "vitest";
import { parseConverseAction, converseTask } from "../../src/agent/converse.ts";
import type { IssueContext } from "../../src/linear/context.ts";

const ctx: IssueContext = {
  agentSessionId: "s1", organizationId: "o", issueId: "i", teamId: "t",
  title: "Add rate limiter", description: "limit to 100/min", comment: "", promptContext: "",
};

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

test("converseTask carries full repo tools and the user message in the goal", () => {
  const t = converseTask(ctx, "why token bucket?");
  expect(t.allowedTools).toContain("Bash");
  expect(t.allowedTools).toContain("mcp__serena");
  expect(t.goal).toContain("why token bucket?");
  expect(t.systemAppend).toContain("ACTION:");
  expect(t.cwd).toBe("/home/user/repo");
});

test("converseTask injects docsContext and carries docsMcp", () => {
  const cfg = { url: "http://h/mcp/docs", token: "tok" };
  const t = converseTask(ctx, "hi", undefined, undefined, undefined, "DOCS BLOCK", cfg);
  expect(t.goal).toContain("DOCS BLOCK");
  expect(t.docsMcp).toEqual(cfg);
});
