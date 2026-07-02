import { describe, it, expect } from "vitest";
import { nextPhase, toolParameter, Orchestrator } from "../../src/orchestrator/pipeline.ts";
import { SessionStore } from "../../src/store/sessions.ts";
import type { Activities } from "../../src/linear/activities.ts";
import type { IssueContext } from "../../src/linear/context.ts";
import type { Config } from "../../src/config.ts";

describe("nextPhase", () => {
  it("clarify -> plan", () => expect(nextPhase("clarify", false)).toBe("plan"));
  it("plan -> await_approval", () => expect(nextPhase("plan", false)).toBe("await_approval"));
  it("await_approval stays until approved", () => {
    expect(nextPhase("await_approval", false)).toBe("await_approval");
    expect(nextPhase("await_approval", true)).toBe("implement");
  });
  it("implement -> done", () => expect(nextPhase("implement", true)).toBe("done"));
});

describe("toolParameter", () => {
  it("prefers command", () => expect(toolParameter({ command: "ls -la" })).toBe("ls -la"));
  it("falls back through descriptive fields", () => {
    expect(toolParameter({ file_path: "src/x.ts" })).toBe("src/x.ts");
    expect(toolParameter({ pattern: "TODO" })).toBe("TODO");
    expect(toolParameter({ skill: "brainstorming" })).toBe("brainstorming");
  });
  it("stringifies unknown input shapes", () => {
    expect(toolParameter({ foo: 1 })).toBe('{"foo":1}');
  });
  it("returns empty for empty/no input (caller supplies the tool name)", () => {
    expect(toolParameter({})).toBe("");
    expect(toolParameter(undefined)).toBe("");
  });
});

function fakeActs(log: string[]): Activities {
  const push = (kind: string) => async (...args: unknown[]) => {
    log.push(`${kind}:${String(args[0]).slice(0, 60)}`);
  };
  return {
    thought: push("thought"),
    action: push("action"),
    response: push("response"),
    error: push("error"),
    elicitation: push("elicitation"),
  };
}

function ctxFor(id: string): IssueContext {
  return {
    agentSessionId: id,
    organizationId: "org",
    issueId: "iss",
    title: "t",
    description: "d",
    comment: "",
    promptContext: "",
  };
}

describe("onPrompted never goes silent", () => {
  it("posts a thought when session phase is not await_approval", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_p1", "error", "iss");
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log));
    await orch.onPrompted(ctxFor("as_p1"), "approve");
    expect(log.length).toBe(1);
    expect(log[0]).toMatch(/^thought:/);
    expect(log[0]).toContain("error");
    store.close();
  });

  it("posts a thought when the session is unknown", async () => {
    const store = new SessionStore(":memory:");
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log));
    await orch.onPrompted(ctxFor("as_p2"), "approve");
    expect(log.length).toBe(1);
    expect(log[0]).toMatch(/^thought:/);
    store.close();
  });

  it("posts an error and sets phase=error when approved but plan is missing", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_p3", "await_approval", "iss");
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log));
    await orch.onPrompted(ctxFor("as_p3"), "approve");
    expect(log.some((l) => l.startsWith("error:"))).toBe(true);
    expect(store.get("as_p3")?.phase).toBe("error");
    store.close();
  });

  it("still posts the not-approved thought on rejection", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_p4", "await_approval", "iss");
    store.setPlan("as_p4", "the plan");
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log));
    await orch.onPrompted(ctxFor("as_p4"), "no, change the approach");
    expect(log.length).toBe(1);
    expect(log[0]).toMatch(/^thought:/);
    expect(store.get("as_p4")?.phase).toBe("await_approval");
    store.close();
  });
});
