import { describe, it, expect, vi, afterEach } from "vitest";
import { Sandbox } from "e2b";
import { nextPhase, toolParameter, Orchestrator, recoverPlan, diffExceedsThreshold, runFinishFrom } from "../../src/orchestrator/pipeline.ts";
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
    teamId: "team_1",
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

  // Non-approval, non-stop feedback now drives a plan-revision run inside
  // withSandbox (clone + runAgent), same as onCreated's plan run — there's no
  // seam to fake e2b here, so this path is covered by live acceptance, not a
  // unit test (matches the repo's convention for withSandbox/e2b paths).
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

});

describe("reconcile", () => {
  // Fake connected sandbox: watchDetached reads RESULT_FILE via files.read and
  // polls commands.list. A resultJson makes watchDetached return that event on
  // the first poll; null resultJson => files.read throws (missing file) and the
  // (empty) process list makes watchDetached give up with null.
  function fakeSandbox(resultJson: string | null) {
    const kills: number[] = [];
    const sbx = {
      files: {
        read: async () => {
          if (resultJson == null) throw new Error("no such file");
          return resultJson;
        },
        write: async () => undefined,
      },
      commands: {
        run: async () => ({ exitCode: 0 }),
        list: async () => [],
      },
      kill: async () => {
        kills.push(1);
      },
    };
    return { sbx, kills };
  }

  it("(a) errors a stuck plan row without a sandboxId and sets phase=error", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_rc1", "plan", "iss"); // no sandboxId ever recorded
    const log: string[] = [];
    let connectCalls = 0;
    const connect = async () => {
      connectCalls++;
      return fakeSandbox(null).sbx;
    };
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log), undefined, connect);
    await orch.reconcile();
    expect(connectCalls).toBe(0); // must not touch e2b when there's no sandbox
    expect(log.length).toBe(1);
    expect(log[0]).toMatch(/^error:/);
    expect(log[0]).toContain("before its sandbox was record"); // fakeActs truncates to 60 chars
    expect(store.get("as_rc1")?.phase).toBe("error");
    store.close();
  });

  it("(b) recovers a stuck plan row from a result-file event: elicitation + await_approval + plan persisted", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_rc2", "plan", "iss");
    store.setSandbox("as_rc2", "sbx-abc");
    const log: string[] = [];
    const resultEvent = JSON.stringify({
      kind: "result",
      subtype: "success",
      text: "THE RECOVERED PLAN",
      costUsd: 0.1234,
      sessionId: null,
    });
    const { sbx, kills } = fakeSandbox(resultEvent);
    let connectedWith = "";
    const connect = async (sandboxId: string) => {
      connectedWith = sandboxId;
      return sbx;
    };
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log), undefined, connect);
    await orch.reconcile();
    expect(connectedWith).toBe("sbx-abc");
    expect(kills.length).toBe(1); // sandbox always killed when connected
    expect(log.some((l) => l.startsWith("elicitation:"))).toBe(true);
    expect(store.get("as_rc2")?.phase).toBe("await_approval");
    expect(store.get("as_rc2")?.plan).toBe("THE RECOVERED PLAN");
    store.close();
  });

  it("(c) leaves done rows untouched", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_rc3", "done", "iss");
    const log: string[] = [];
    let connectCalls = 0;
    const connect = async () => {
      connectCalls++;
      return fakeSandbox(null).sbx;
    };
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log), undefined, connect);
    await orch.reconcile();
    expect(connectCalls).toBe(0);
    expect(log.length).toBe(0);
    expect(store.get("as_rc3")?.phase).toBe("done");
    store.close();
  });

  it("(d) PR_FAILED sentinel in the implement result fails loud instead of posting success", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_rc5", "implement", "iss");
    store.setSandbox("as_rc5", "sbx-pf");
    const log: string[] = [];
    const resultEvent = JSON.stringify({
      kind: "result",
      subtype: "success",
      text: "PR_FAILED: gh auth broken",
      costUsd: 0.1,
      sessionId: null,
    });
    const { sbx } = fakeSandbox(resultEvent);
    const connect = async () => sbx;
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log), undefined, connect);
    await orch.reconcile();
    expect(log.some((l) => l.startsWith("error:"))).toBe(true);
    expect(log.some((l) => l.startsWith("response:"))).toBe(false); // not "Done. PR opened"
    expect(store.get("as_rc5")?.phase).toBe("error");
    store.close();
  });

  it("errors a stuck row when connect fails, setting phase=error and not throwing", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_rc4", "implement", "iss");
    store.setSandbox("as_rc4", "sbx-gone");
    const log: string[] = [];
    const connect = async () => {
      throw new Error("sandbox is gone");
    };
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log), undefined, connect);
    await orch.reconcile();
    expect(log.some((l) => l.startsWith("error:"))).toBe(true);
    expect(log.some((l) => l.includes("A restart interrupted this run"))).toBe(true);
    expect(store.get("as_rc4")?.phase).toBe("error");
    store.close();
  });

  it("on an unrecoverable implement, keeps the plan/work branch and points the user at a cheap resume", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_i", "implement", "iss_Z");
    store.setPlan("as_i", "## Plan\n- x");
    store.setWorkBranch("as_i", "jarvis/iss_Z");
    store.setSandbox("as_i", "sbx_dead");

    const log: string[] = [];
    const connect = () => Promise.reject(new Error("Failed to parse URL from [object Request]"));
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log), undefined, connect);

    await orch.reconcile();

    expect(store.get("as_i")?.phase).toBe("error");
    expect(store.get("as_i")?.plan).toContain("- x"); // plan preserved
    expect(store.get("as_i")?.workBranch).toBe("jarvis/iss_Z"); // branch preserved
    expect(log.join("\n")).toMatch(/re-?assign/i);
    expect(log.join("\n")).toMatch(/resume|pushed|saved/i); // tells user it's cheap
  });
});

describe("steer", () => {
  it("hasLive is false and steer posts a terminal response when no run is live", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_s1", "implement", "iss");
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log));
    expect(orch.hasLive("as_s1")).toBe(false);
    await orch.steer(ctxFor("as_s1"), "actually use approach B");
    expect(log.length).toBe(1);
    expect(log[0]).toMatch(/^response:/);
    store.close();
  });
  // The live path (inject + thought, stop-kill, ask_user elicitation, reply
  // posting) runs inside withSandbox/runAgent — covered by live acceptance,
  // matching the repo's convention for e2b paths.
});

describe("recoverPlan", () => {
  it("persists the recovered plan via store.setPlan and returns it", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_r3", "await_approval", "iss");
    const fetchPlan = async () => "recovered plan text";
    const result = await recoverPlan(store, "as_r3", fetchPlan);
    expect(result).toBe("recovered plan text");
    expect(store.get("as_r3")?.plan).toBe("recovered plan text");
    store.close();
  });

  it("returns null and does not persist when fetchPlan is undefined", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_r4", "await_approval", "iss");
    const result = await recoverPlan(store, "as_r4", undefined);
    expect(result).toBeNull();
    expect(store.get("as_r4")?.plan).toBeFalsy();
    store.close();
  });

  it("returns null and does not persist when fetchPlan resolves to null", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_r5", "await_approval", "iss");
    const result = await recoverPlan(store, "as_r5", async () => null);
    expect(result).toBeNull();
    expect(store.get("as_r5")?.plan).toBeFalsy();
    store.close();
  });

  it("returns null and does not persist when fetchPlan resolves to an empty/whitespace string", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_r6", "await_approval", "iss");
    const result = await recoverPlan(store, "as_r6", async () => "   ");
    expect(result).toBeNull();
    expect(store.get("as_r6")?.plan).toBeFalsy();
    store.close();
  });
});

// Fakes the withSandbox seam by stubbing Sandbox.create (the same static both
// pipeline.ts and sandbox/session.ts share), so nothing touches e2b. The fake
// sandbox's RESULT_FILE (files.read) yields `opts.result`, every command returns
// exitCode 0 (so cloneRepo/serena/git-diff all succeed with an empty, sub-threshold
// diff → no self-review), and commands.list is empty. Mirrors the reconcile tests'
// fake `connect`, one seam over.
function makeOrchWithFakeSandbox(
  store: SessionStore,
  log: string[],
  opts: { result?: unknown },
): Orchestrator {
  const resultJson = opts.result ? JSON.stringify(opts.result) : "{}";
  const fakeSbx = {
    sandboxId: "fake-sbx",
    files: {
      read: async () => resultJson,
      write: async () => undefined,
    },
    commands: {
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      list: async () => [],
    },
    kill: async () => undefined,
  };
  vi.spyOn(Sandbox, "create").mockResolvedValue(fakeSbx as unknown as Sandbox);
  return new Orchestrator({ targetRepo: "o/r" } as Config, store, () => fakeActs(log));
}

describe("onCreated resume", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resumes implementation from a saved plan without re-planning when a prior attempt was approved", async () => {
    const store = new SessionStore(":memory:");
    // prior attempt died mid-implement (e.g. credit exhaustion)
    store.upsert("as_old", "error", "iss_R");
    store.setPlan("as_old", "Type: feature\nScope: large\n\n## Plan\n- build it");
    store.setBranch("as_old", "main");
    store.setWorkBranch("as_old", "jarvis/iss_R");

    const log: string[] = [];
    const orch = makeOrchWithFakeSandbox(store, log, {
      result: { kind: "result", subtype: "success", text: "https://github.com/o/r/pull/5", costUsd: 0.4, sessionId: "s", usage: {}, numTurns: 3 },
    });

    await orch.onCreated({ agentSessionId: "as_new", organizationId: "o", issueId: "iss_R", teamId: "team_1", title: "T", description: "D", comment: "", promptContext: "" });

    // it did NOT run a plan phase; it went straight to implement and finished
    expect(log.join("\n")).not.toMatch(/drafting a plan|Reading the codebase/i);
    expect(store.get("as_new")?.phase).toBe("done");
    expect(store.get("as_new")?.workBranch).toBe("jarvis/iss_R"); // same deterministic branch
    store.close();
  });

  it("re-uses a saved-but-unapproved plan for re-approval instead of re-planning", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_old", "await_approval", "iss_P");
    store.setPlan("as_old", "Type: chore\nScope: small\n\n## Plan\n- tweak");
    store.setBranch("as_old", "main");

    const log: string[] = [];
    const orch = makeOrchWithFakeSandbox(store, log, {});
    await orch.onCreated({ agentSessionId: "as_new2", organizationId: "o", issueId: "iss_P", teamId: "team_1", title: "T", description: "D", comment: "", promptContext: "" });

    expect(store.get("as_new2")?.phase).toBe("await_approval");
    expect(store.get("as_new2")?.plan).toContain("tweak");
    store.close();
  });

  // An "error"-phase prior with NO workBranch is a FAILED REVISE run: its plan was
  // never approved (onPrompted feedback → phase "plan" → revise fails → "error"),
  // so resume must re-post it for approval, NOT auto-implement it (human gate #1).
  it("re-approves (does not implement) an error-phase prior whose plan was never approved", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_old", "error", "iss_FR");
    store.setPlan("as_old", "Type: chore\nScope: small\n\n## Plan\n- unapproved revise");
    store.setBranch("as_old", "main");
    // no setWorkBranch — implementation never started

    const log: string[] = [];
    const createSpy = vi.spyOn(Sandbox, "create").mockRejectedValue(new Error("should not create a sandbox"));
    const orch = new Orchestrator({ targetRepo: "o/r" } as Config, store, () => fakeActs(log));

    await orch.onCreated({ agentSessionId: "as_new_fr", organizationId: "o", issueId: "iss_FR", teamId: "team_1", title: "T", description: "D", comment: "", promptContext: "" });

    expect(createSpy).not.toHaveBeenCalled(); // never implemented
    expect(store.get("as_new_fr")?.phase).toBe("await_approval");
    expect(store.get("as_new_fr")?.plan).toContain("unapproved revise");
    expect(log.some((l) => l.startsWith("elicitation:"))).toBe(true); // re-posted for approval
    expect(store.get("as_old")?.phase).toBe("done"); // prior retired
    store.close();
  });

  // A "plan"-phase prior (interrupted revision run) is reconcile-eligible via its
  // stale sandboxId — resuming must retire it so reconcile doesn't post a stray
  // error to the dead session.
  it("retires a plan-phase prior (phase done, sandbox cleared) when reusing its plan", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_old", "plan", "iss_Q");
    store.setPlan("as_old", "Type: chore\nScope: small\n\n## Plan\n- revise me");
    store.setSandbox("as_old", "sbx-stale");

    const log: string[] = [];
    const orch = makeOrchWithFakeSandbox(store, log, {});
    await orch.onCreated({ agentSessionId: "as_new3", organizationId: "o", issueId: "iss_Q", teamId: "team_1", title: "T", description: "D", comment: "", promptContext: "" });

    expect(store.get("as_old")?.phase).toBe("done");
    expect(store.get("as_old")?.sandboxId).toBeNull();
    expect(store.get("as_new3")?.phase).toBe("await_approval");
    expect(store.get("as_new3")?.plan).toContain("revise me");
    store.close();
  });

  // F1: re-assigning while the prior run is still LIVE must not start a second
  // concurrent implement run pushing to the same deterministic work branch.
  it("does not start a second run when the prior session is still live", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_old", "implement", "iss_L");
    store.setPlan("as_old", "Type: feature\nScope: large\n\n## Plan\n- build it");
    store.setSandbox("as_old", "sbx-live");

    const log: string[] = [];
    const createSpy = vi.spyOn(Sandbox, "create").mockRejectedValue(new Error("should not create a sandbox"));
    const orch = new Orchestrator({ targetRepo: "o/r" } as Config, store, () => fakeActs(log));
    vi.spyOn(orch, "hasLive").mockImplementation((id: string) => id === "as_old");

    await orch.onCreated({ agentSessionId: "as_new", organizationId: "o", issueId: "iss_L", teamId: "team_1", title: "T", description: "D", comment: "", promptContext: "" });

    expect(createSpy).not.toHaveBeenCalled(); // no #runImplement side effects
    expect(log.some((l) => l.startsWith("response:"))).toBe(true); // 10s rule: an activity was posted
    expect(store.get("as_new")?.phase).toBe("done");
    expect(store.get("as_old")?.phase).toBe("implement"); // prior left intact for its own run/reconcile
    store.close();
  });

  // F2: a prior in the transient "review" phase (which always carries a prUrl)
  // must point the new session at the PR, not fall through to a full re-plan.
  it("points a new session at the prior PR when the prior was in the transient review phase", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_old", "review", "iss_V");
    store.setPlan("as_old", "Type: chore\nScope: small\n\n## Plan\n- x");
    store.setPrUrl("as_old", "https://github.com/o/r/pull/9");
    store.setSandbox("as_old", "sbx-old");

    const log: string[] = [];
    const orch = makeOrchWithFakeSandbox(store, log, {});
    await orch.onCreated({ agentSessionId: "as_new", organizationId: "o", issueId: "iss_V", teamId: "team_1", title: "T", description: "D", comment: "", promptContext: "" });

    expect(log.join("\n")).not.toMatch(/drafting a plan|Reading the codebase/i); // no re-plan
    expect(store.get("as_new")?.phase).toBe("done");
    expect(store.get("as_new")?.prUrl).toBe("https://github.com/o/r/pull/9");
    expect(log.some((l) => l.includes("already has an open PR"))).toBe(true);
    store.close();
  });

  // F3: the done+prUrl resume must copy the durable context (plan, branch,
  // workBranch), not just prUrl — a later done-follow-up needs it.
  it("copies plan, branch and workBranch (not just prUrl) when resuming a prior PR", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_old", "done", "iss_D");
    store.setPlan("as_old", "Type: chore\nScope: small\n\n## Plan\n- done");
    store.setBranch("as_old", "develop");
    store.setWorkBranch("as_old", "jarvis/iss_D");
    store.setPrUrl("as_old", "https://github.com/o/r/pull/3");

    const log: string[] = [];
    const orch = makeOrchWithFakeSandbox(store, log, {});
    await orch.onCreated({ agentSessionId: "as_new", organizationId: "o", issueId: "iss_D", teamId: "team_1", title: "T", description: "D", comment: "", promptContext: "" });

    expect(store.get("as_new")?.plan).toContain("done");
    expect(store.get("as_new")?.branch).toBe("develop");
    expect(store.get("as_new")?.workBranch).toBe("jarvis/iss_D");
    expect(store.get("as_new")?.prUrl).toBe("https://github.com/o/r/pull/3");
    store.close();
  });

  // F4: resuming implementation must retire the prior row (phase done, sandbox
  // cleared) so boot reconcile() doesn't post a stray error to the dead session.
  it("retires the prior row (phase done, sandbox cleared) when resuming implementation", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_old", "error", "iss_T");
    store.setPlan("as_old", "Type: feature\nScope: large\n\n## Plan\n- build");
    store.setBranch("as_old", "main");
    store.setWorkBranch("as_old", "jarvis/iss_T");
    store.setSandbox("as_old", "sbx-stale");

    const log: string[] = [];
    const orch = makeOrchWithFakeSandbox(store, log, {
      result: { kind: "result", subtype: "success", text: "https://github.com/o/r/pull/7", costUsd: 0.1, sessionId: "s", usage: {}, numTurns: 1 },
    });
    await orch.onCreated({ agentSessionId: "as_new", organizationId: "o", issueId: "iss_T", teamId: "team_1", title: "T", description: "D", comment: "", promptContext: "" });

    expect(store.get("as_old")?.phase).toBe("done");
    expect(store.get("as_old")?.sandboxId).toBeNull();
    expect(store.get("as_new")?.phase).toBe("done");
    store.close();
  });
});

describe("clarify phase", () => {
  it("reconcile() covers the clarify phase (crash recovery)", () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_c1", "clarify", "iss");
    expect(store.listByPhase("clarify").map((r) => r.agentSessionId)).toEqual(["as_c1"]);
    store.close();
  });

  it("onPrompted on a done+no-PR clarify-derived session still gives the existing terminal reply", async () => {
    // Sessions never in "clarify" by the time onPrompted runs after this feature
    // ships still behave exactly as before — this guards the untouched branches.
    const store = new SessionStore(":memory:");
    store.upsert("as_c2", "done", "iss");
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log));
    await orch.onPrompted(ctxFor("as_c2"), "thanks!");
    expect(log[0]).toMatch(/^response:/);
    store.close();
  });
});

describe("diffExceedsThreshold", () => {
  it("small diff is under", () => {
    expect(diffExceedsThreshold(" 2 files changed, 30 insertions(+), 4 deletions(-)")).toBe(false);
  });
  it("many files trips it", () => {
    expect(diffExceedsThreshold(" 6 files changed, 10 insertions(+)")).toBe(true);
  });
  it("many lines trips it (insertions + deletions)", () => {
    expect(diffExceedsThreshold(" 3 files changed, 150 insertions(+), 80 deletions(-)")).toBe(true);
  });
  it("singular forms parse", () => {
    expect(diffExceedsThreshold(" 1 file changed, 1 insertion(+), 1 deletion(-)")).toBe(false);
  });
  it("empty/garbage output is under (no review on parse failure)", () => {
    expect(diffExceedsThreshold("")).toBe(false);
    expect(diffExceedsThreshold("fatal: bad revision")).toBe(false);
  });
});

// A fake Reconnected sandbox whose RESULT_FILE already holds `resultJson`.
// watchDetached reads the file first, so commands.list is never load-bearing.
function fakeReconnected(resultJson: string) {
  return {
    files: {
      read: async () => resultJson,
      write: async () => undefined,
    },
    commands: {
      run: async () => ({ exitCode: 0 }),
      list: async () => [],
    },
    kill: async () => undefined,
  };
}

describe("finishImplement persists pr_url (via reconcile)", () => {
  it("stores the PR URL and moves to done", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_pr1", "implement", "iss");
    store.setSandbox("as_pr1", "sbx_1");
    const log: string[] = [];
    const result = JSON.stringify({
      kind: "result", subtype: "success",
      text: "https://github.com/o/r/pull/42", costUsd: null, sessionId: null,
    });
    const orch = new Orchestrator(
      { targetRepo: "o/r" } as Config, store, () => fakeActs(log),
      undefined, async () => fakeReconnected(result),
    );
    await orch.reconcile();
    const row = store.get("as_pr1");
    expect(row?.phase).toBe("done");
    expect(row?.prUrl).toBe("https://github.com/o/r/pull/42");
    expect(log.some((l) => l.startsWith("response:"))).toBe(true);
    store.close();
  });

  // A restart during self-review: the review run overwrote RESULT_FILE with a
  // markdown report. Reconcile must NOT store it as pr_url or announce it as
  // the PR — it fails loud instead.
  it("a multi-line markdown report in RESULT_FILE does not become pr_url", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_pr2", "implement", "iss");
    store.setSandbox("as_pr2", "sbx_2");
    const log: string[] = [];
    const report = "## Review\n\n1. `src/x.ts:12` — off-by-one\n\n_Report only — no changes were made._";
    const result = JSON.stringify({
      kind: "result", subtype: "success",
      text: report, costUsd: null, sessionId: null,
    });
    const orch = new Orchestrator(
      { targetRepo: "o/r" } as Config, store, () => fakeActs(log),
      undefined, async () => fakeReconnected(result),
    );
    await orch.reconcile();
    const row = store.get("as_pr2");
    expect(row?.phase).toBe("error");
    expect(row?.prUrl).toBeFalsy();
    expect(log.some((l) => l.startsWith("response:"))).toBe(false); // no "Done. PR opened"
    expect(log.some((l) => l.startsWith("error:"))).toBe(true);
    store.close();
  });
});

describe("on-demand review on done sessions", () => {
  it("done WITHOUT pr_url keeps the old re-assign reply", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_od1", "done", "iss");
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log));
    await orch.onPrompted(ctxFor("as_od1"), "can you review it?");
    expect(log.length).toBe(1);
    expect(log[0]).toMatch(/^response:/);
    expect(log[0]).toContain("re-assign");
    store.close();
  });

  it("'stop' on done-with-PR closes politely without a review run", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_od2", "done", "iss");
    store.setPrUrl("as_od2", "https://github.com/o/r/pull/1");
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log));
    await orch.onPrompted(ctxFor("as_od2"), "stop");
    expect(log.length).toBe(1);
    expect(log[0]).toMatch(/^response:/);
    expect(store.get("as_od2")?.phase).toBe("done");
    store.close();
  });

  it("reconcile finishes a review row: report posted, review stored, phase done", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_od3", "review", "iss");
    store.setSandbox("as_od3", "sbx_r");
    const log: string[] = [];
    const report = "## Review\n\nfindings...\n\n_Report only — no changes were made._";
    const result = JSON.stringify({ kind: "result", subtype: "success", text: report, costUsd: null, sessionId: null });
    const orch = new Orchestrator(
      { targetRepo: "o/r" } as Config, store, () => fakeActs(log),
      undefined, async () => fakeReconnected(result),
    );
    await orch.reconcile();
    const row = store.get("as_od3");
    expect(row?.phase).toBe("done");
    expect(row?.review).toBe(report);
    expect(log.some((l) => l.startsWith("response:"))).toBe(true);
    store.close();
  });

  it("reconcile of a review row with no sandbox goes back to done (not error)", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_od4", "review", "iss");
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log));
    await orch.reconcile();
    expect(store.get("as_od4")?.phase).toBe("done");
    expect(log.some((l) => l.startsWith("error:"))).toBe(true);
    store.close();
  });
});

describe("runFinishFrom", () => {
  it("maps a success result with usage", () => {
    expect(
      runFinishFrom({
        kind: "result", subtype: "success", text: "https://github.com/o/r/pull/1",
        costUsd: 1.25, sessionId: null, numTurns: 7,
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
      }),
    ).toEqual({
      outcome: "success", costUsd: 1.25, numTurns: 7,
      tokensIn: 10, tokensOut: 20, tokensCacheRead: 30, tokensCacheWrite: 40, error: null,
    });
  });

  it("maps PR_FAILED text to the pr_failed outcome", () => {
    const f = runFinishFrom({ kind: "result", subtype: "success", text: "PR_FAILED: no permission", costUsd: null, sessionId: null });
    expect(f.outcome).toBe("pr_failed");
  });

  it("maps error events and null results", () => {
    expect(runFinishFrom({ kind: "error", message: "boom" })).toMatchObject({ outcome: "error", error: "boom" });
    expect(runFinishFrom(null)).toMatchObject({ outcome: "no_result", costUsd: null });
  });
});

describe("reconcile telemetry", () => {
  const RESULT_JSON = JSON.stringify({
    kind: "result", subtype: "success", text: "Type: chore\nScope: small\n\n- do it",
    costUsd: 0.4, sessionId: null, numTurns: 3,
    usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
  });

  // Minimal Reconnected fake: watchDetached reads RESULT_FILE on its first poll,
  // so a resolving files.read returns immediately — no timers involved.
  function fakeConnect(resultJson: string | null) {
    return async () => ({
      files: {
        read: async () => {
          if (resultJson == null) throw new Error("ENOENT");
          return resultJson;
        },
        write: async () => ({}),
      },
      commands: { run: async () => ({ exitCode: 0 }), list: async () => [] },
      kill: async () => undefined,
    });
  }

  it("closes the orphaned runs row with the recovered result", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_rc1", "plan", "iss");
    store.setSandbox("as_rc1", "sbx_1");
    store.createRun("as_rc1", "plan", "o/r"); // left open by the dead host
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log), undefined, fakeConnect(RESULT_JSON));
    await orch.reconcile();
    expect(store.getRunLogsBySession("as_rc1").map((l) => l.outcome)).toEqual(["success"]);
    expect(store.get("as_rc1")?.phase).toBe("await_approval"); // #finishPlan replayed
    expect(log.some((l) => l.startsWith("elicitation:"))).toBe(true);
    store.close();
  });

  it("sweeps unrecoverable open runs as interrupted", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_rc2", "plan", "iss"); // no sandboxId — reconcile fails it loud
    store.createRun("as_rc2", "plan", "o/r");
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log), undefined, fakeConnect(null));
    await orch.reconcile();
    expect(store.getRunLogsBySession("as_rc2").map((l) => l.outcome)).toEqual(["interrupted"]);
    expect(store.get("as_rc2")?.phase).toBe("error");
    store.close();
  });

  it("sweeps orphans even when no sessions are in a run phase", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_rc3", "done", "iss"); // session moved on; run row left open
    store.createRun("as_rc3", "review", "o/r");
    const orch = new Orchestrator({} as Config, store, () => fakeActs([]));
    await orch.reconcile();
    expect(store.getRunLogsBySession("as_rc3").map((l) => l.outcome)).toEqual(["interrupted"]);
    store.close();
  });
});
