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
