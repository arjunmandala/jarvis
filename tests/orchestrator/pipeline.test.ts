import { describe, it, expect } from "vitest";
import { nextPhase, toolParameter, Orchestrator, recoverPlan, diffExceedsThreshold } from "../../src/orchestrator/pipeline.ts";
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

  // Non-approval, non-stop feedback now drives a plan-revision run inside
  // withSandbox (clone + runAgent), same as onCreated's plan run — there's no
  // seam to fake e2b here, so this path is covered by live acceptance, not a
  // unit test (matches the repo's convention for withSandbox/e2b paths).
});

describe("onCreated: branch resolution", () => {
  it("asks for a branch and does not touch phase=plan when the description has none", async () => {
    const store = new SessionStore(":memory:");
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log));
    await orch.onCreated(ctxFor("as_br1"));
    expect(store.get("as_br1")?.phase).toBe("await_branch");
    expect(store.get("as_br1")?.branch).toBeNull();
    expect(log.length).toBe(1);
    expect(log[0]).toMatch(/^elicitation:/);
  });
});

describe("onPrompted: await_branch", () => {
  it("stop while awaiting a branch closes the session", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_br2", "await_branch", "iss");
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log));
    await orch.onPrompted(ctxFor("as_br2"), "stop");
    expect(store.get("as_br2")?.phase).toBe("done");
  });

  it("an invalid branch name stays in await_branch and reports the problem", async () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_br3", "await_branch", "iss");
    const log: string[] = [];
    const orch = new Orchestrator({} as Config, store, () => fakeActs(log));
    // Note: "has space" (the brief's literal example) doesn't actually exercise
    // this path — parseBranchAnswer extracts only the first token ("has"),
    // which itself passes isValidBranchName, so the pipeline would proceed into
    // #runPlan/withSandbox instead of staying in await_branch. "-flag" is a
    // single-token reply that isValidBranchName genuinely rejects (leading
    // char must be alnum), so it exercises the intended invalid-branch path.
    await orch.onPrompted(ctxFor("as_br3"), "-flag");
    expect(store.get("as_br3")?.phase).toBe("await_branch");
    expect(store.get("as_br3")?.branch).toBeNull();
    expect(log.some((l) => l.startsWith("error:"))).toBe(true);
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
