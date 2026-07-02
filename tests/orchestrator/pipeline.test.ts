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
  // Terminal activity (error/response), NOT thought — a thought leaves the
  // Linear session stuck in "working".
  it("posts a terminal error when session phase is not await_approval", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_p1", "plan", "iss");
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log));
    await orch.onPrompted(ctxFor("as_p1"), "approve");
    expect(log.length).toBe(1);
    expect(log[0]).toMatch(/^error:/);
    expect(log[0]).toContain("plan");
    store.close();
  });

  it("posts a response (not error) when the session is already done", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_p5", "done", "iss");
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log));
    await orch.onPrompted(ctxFor("as_p5"), "thanks!");
    expect(log.length).toBe(1);
    expect(log[0]).toMatch(/^response:/);
    store.close();
  });

  it("posts a terminal error when the session is unknown", async () => {
    const store = new SessionStore(":memory:");
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log));
    await orch.onPrompted(ctxFor("as_p2"), "approve");
    expect(log.length).toBe(1);
    expect(log[0]).toMatch(/^error:/);
    store.close();
  });

  it("'stop' while awaiting approval closes the session", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_p6", "await_approval", "iss");
    store.setPlan("as_p6", "the plan");
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log));
    await orch.onPrompted(ctxFor("as_p6"), "stop");
    expect(log.length).toBe(1);
    expect(log[0]).toMatch(/^response:/);
    expect(store.get("as_p6")?.phase).toBe("done");
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

  // Elicitation, not thought — puts the session back into "awaiting input"
  // instead of leaving it spinning as "working".
  it("re-elicits on rejection and stays in await_approval", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_p4", "await_approval", "iss");
    store.setPlan("as_p4", "the plan");
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log));
    await orch.onPrompted(ctxFor("as_p4"), "hold on, change the approach");
    expect(log.length).toBe(1);
    expect(log[0]).toMatch(/^elicitation:/);
    expect(store.get("as_p4")?.phase).toBe("await_approval");
    store.close();
  });
});

describe("onPrompted plan recovery from Linear", () => {
  it("still errors (no sandbox call) when the plan is missing and fetchPlan returns null", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_r1", "await_approval", "iss");
    const log: string[] = [];
    const fetchPlan = async () => null;
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log), fetchPlan);
    await orch.onPrompted(ctxFor("as_r1"), "approve");
    expect(log.some((l) => l.startsWith("error:"))).toBe(true);
    expect(store.get("as_r1")?.phase).toBe("error");
    expect(store.get("as_r1")?.plan).toBeFalsy();
    store.close();
  });

  it("still errors (no sandbox call) when the plan is missing and fetchPlan is not provided", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_r2", "await_approval", "iss");
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log));
    await orch.onPrompted(ctxFor("as_r2"), "approve");
    expect(log.some((l) => l.startsWith("error:"))).toBe(true);
    expect(store.get("as_r2")?.phase).toBe("error");
    store.close();
  });

  it("persists the recovered plan via store.setPlan before attempting the sandbox run", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_r3", "await_approval", "iss");
    const log: string[] = [];
    const fetchPlan = async () => "recovered plan text";
    // No real e2b credentials -> withSandbox/Sandbox.create will reject; the
    // orchestrator's onPrompted does not catch that, so the promise rejects,
    // but the persistence happens (via fetchPlan await + store.setPlan) before
    // the sandbox call, so we can assert on the store regardless of the outcome.
    const orch = new Orchestrator({ e2bApiKey: "", e2bTemplate: "", ghToken: "", targetRepo: "" } as Config, store, () => fakeActs(log), fetchPlan);
    await orch.onPrompted(ctxFor("as_r3"), "approve").catch(() => undefined);
    expect(store.get("as_r3")?.plan).toBe("recovered plan text");
    expect(log.some((l) => l.startsWith("[recover]"))).toBe(false); // recover is console.log, not an activity
    store.close();
  });
});
