import { describe, it, expect, afterEach } from "vitest";
import { SessionStore } from "../../src/store/sessions.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

describe("SessionStore", () => {
  it("upserts and reads phase", () => {
    const s = new SessionStore(":memory:");
    s.upsert("as_1", "clarify", "iss_1");
    expect(s.get("as_1")?.phase).toBe("clarify");
    expect(s.get("as_1")?.issueId).toBe("iss_1");
    s.setPhase("as_1", "plan");
    expect(s.get("as_1")?.phase).toBe("plan");
    s.close();
  });

  it("returns undefined for unknown ids", () => {
    const s = new SessionStore(":memory:");
    expect(s.get("missing")).toBeUndefined();
    s.close();
  });

  it("upsert is idempotent on the same id", () => {
    const s = new SessionStore(":memory:");
    s.upsert("as_2", "clarify");
    s.upsert("as_2", "implement");
    expect(s.get("as_2")?.phase).toBe("implement");
    s.close();
  });

  it("stores and returns the plan text", () => {
    const s = new SessionStore(":memory:");
    s.upsert("as_3", "await_approval", "iss_3");
    expect(s.get("as_3")?.plan).toBeNull();
    s.setPlan("as_3", "1. do the thing\n2. test it");
    expect(s.get("as_3")?.plan).toBe("1. do the thing\n2. test it");
    s.close();
  });

  it("setPlan on unknown id is a no-op", () => {
    const s = new SessionStore(":memory:");
    s.setPlan("missing", "plan");
    expect(s.get("missing")).toBeUndefined();
    s.close();
  });

  it("stores and returns the sandbox id, including clearing back to null", () => {
    const s = new SessionStore(":memory:");
    s.upsert("as_4", "implement", "iss_4");
    expect(s.get("as_4")?.sandboxId).toBeNull();
    s.setSandbox("as_4", "sbx_1");
    expect(s.get("as_4")?.sandboxId).toBe("sbx_1");
    s.setSandbox("as_4", null);
    expect(s.get("as_4")?.sandboxId).toBeNull();
    s.close();
  });

  it("listByPhase returns only rows matching the given phases", () => {
    const s = new SessionStore(":memory:");
    s.upsert("as_p1", "plan");
    s.upsert("as_p2", "implement");
    s.upsert("as_p3", "clarify");
    s.upsert("as_p4", "plan");
    const rows = s.listByPhase("plan", "implement");
    expect(rows.map((r) => r.agentSessionId).sort()).toEqual(["as_p1", "as_p2", "as_p4"]);
    s.close();
  });

  describe("repo maps", () => {
    it("returns undefined when no map is stored for the repo", () => {
      const s = new SessionStore(":memory:");
      expect(s.getRepoMap("owner/repo")).toBeUndefined();
      s.close();
    });

    it("set then get roundtrips the map", () => {
      const s = new SessionStore(":memory:");
      s.setRepoMap("owner/repo", "# Map\n\n- src/foo.ts: does foo");
      expect(s.getRepoMap("owner/repo")).toBe("# Map\n\n- src/foo.ts: does foo");
      s.close();
    });

    it("upsert overwrites an existing map for the same repo", () => {
      const s = new SessionStore(":memory:");
      s.setRepoMap("owner/repo", "first map");
      s.setRepoMap("owner/repo", "second map");
      expect(s.getRepoMap("owner/repo")).toBe("second map");
      s.close();
    });
  });

  describe("migration", () => {
    let dir: string;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("opening a store twice on the same path does not throw", () => {
      dir = mkdtempSync(join(tmpdir(), "sessions-test-"));
      const path = join(dir, "sessions.db");
      const s1 = new SessionStore(path);
      s1.upsert("as_m1", "clarify");
      s1.close();

      let s2: SessionStore | undefined;
      expect(() => {
        s2 = new SessionStore(path);
      }).not.toThrow();
      expect(s2?.get("as_m1")?.phase).toBe("clarify");
      s2?.close();
    });
  });
});

describe("run telemetry", () => {
  it("createRun returns an id and finishRun records the outcome", () => {
    const store = new SessionStore(":memory:");
    const runId = store.createRun("as_t1", "plan", "owner/repo");
    expect(runId).toBeGreaterThan(0);
    store.finishRun(runId, {
      outcome: "success", costUsd: 0.5, numTurns: 12,
      tokensIn: 1000, tokensOut: 200, tokensCacheRead: 800, tokensCacheWrite: 300, error: null,
    });
    // second run gets a distinct id
    expect(store.createRun("as_t1", "implement", "owner/repo")).toBe(runId + 1);
    store.close();
  });

  it("addRunEvent stores JSON payloads per run", () => {
    const store = new SessionStore(":memory:");
    const runId = store.createRun("as_t2", "plan", null);
    store.addRunEvent(runId, "tool_use", { name: "Bash", input: { command: "ls" } });
    store.addRunEvent(runId, "tool_result", { tool: "Bash", isError: true, content: "boom" });
    // no assert on retrieval API — the report script reads SQL directly; just prove no throw
    store.close();
  });
});

describe("pr_url and review columns", () => {
  it("round-trips pr_url and review through setters", () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_r1", "done", "iss");
    store.setPrUrl("as_r1", "https://github.com/o/r/pull/7");
    store.setReview("as_r1", "## Review\n\nLooks fine.");
    const row = store.get("as_r1");
    expect(row?.prUrl).toBe("https://github.com/o/r/pull/7");
    expect(row?.review).toBe("## Review\n\nLooks fine.");
    store.close();
  });

  it("defaults both to null on new rows", () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_r2", "plan", "iss");
    const row = store.get("as_r2");
    expect(row?.prUrl).toBeNull();
    expect(row?.review).toBeNull();
    store.close();
  });

  it("lists sessions in the review phase", () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_r3", "review", "iss");
    const rows = store.listByPhase("review");
    expect(rows.map((r) => r.agentSessionId)).toEqual(["as_r3"]);
    store.close();
  });
});

describe("branch column", () => {
  it("defaults to null on new rows", () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_b1", "clarify", "iss");
    expect(store.get("as_b1")?.branch).toBeNull();
    store.close();
  });

  it("round-trips through setBranch", () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_b2", "plan", "iss");
    store.setBranch("as_b2", "feature/foo");
    expect(store.get("as_b2")?.branch).toBe("feature/foo");
    store.close();
  });

  it("setBranch on unknown id is a no-op", () => {
    const store = new SessionStore(":memory:");
    store.setBranch("missing", "main");
    expect(store.get("missing")).toBeUndefined();
    store.close();
  });

  it("lists sessions in the clarify phase", () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_b3", "clarify", "iss");
    const rows = store.listByPhase("clarify");
    expect(rows.map((r) => r.agentSessionId)).toEqual(["as_b3"]);
    store.close();
  });
});

describe("work branch", () => {
  it("round-trips work_branch and defaults to null", () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_wb", "implement", "iss_1");
    expect(store.get("as_wb")?.workBranch).toBeNull();
    store.setWorkBranch("as_wb", "jarvis/iss_1");
    expect(store.get("as_wb")?.workBranch).toBe("jarvis/iss_1");
    store.close();
  });
});

describe("findResumableByIssue", () => {
  it("returns the latest prior session with a plan for the issue, excluding the current one", () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_old", "error", "iss_42");
    store.setPlan("as_old", "## Plan\n- do it");
    store.setBranch("as_old", "main");
    store.setWorkBranch("as_old", "jarvis/iss_42");
    store.upsert("as_new", "clarify", "iss_42"); // the freshly-created session

    const found = store.findResumableByIssue("iss_42", "as_new");
    expect(found?.agentSessionId).toBe("as_old");
    expect(found?.plan).toContain("do it");
    expect(found?.workBranch).toBe("jarvis/iss_42");

    expect(store.findResumableByIssue("iss_99", "as_new")).toBeNull(); // different issue
    store.close();
  });

  it("ignores prior sessions that never produced a plan", () => {
    const store = new SessionStore(":memory:");
    store.upsert("as_a", "clarify", "iss_7"); // no plan
    store.upsert("as_b", "clarify", "iss_7");
    expect(store.findResumableByIssue("iss_7", "as_b")).toBeNull();
    store.close();
  });
});

describe("listByIssue and getRunLogsBySession", () => {
  it("listByIssue returns all sessions for the issue, oldest-first, and nothing else", () => {
    const s = new SessionStore(":memory:");
    s.upsert("as_h1", "done", "iss_h");
    s.upsert("as_h2", "error", "iss_h");
    s.upsert("as_other", "done", "iss_other");
    const rows = s.listByIssue("iss_h");
    expect(rows.map((r) => r.agentSessionId)).toEqual(["as_h1", "as_h2"]);
    expect(s.listByIssue("iss_missing")).toEqual([]);
    s.close();
  });

  it("listByIssue keeps creation order even when an older session is touched later", () => {
    const s = new SessionStore(":memory:");
    s.upsert("as_h1", "done", "iss_h");
    s.upsert("as_h2", "done", "iss_h");
    // A done⇄review reply on the OLD session bumps its updated_at past as_h2's;
    // creation order must survive (ordering is by rowid, not updated_at).
    s.setPhase("as_h1", "review");
    s.setPhase("as_h1", "done");
    expect(s.listByIssue("iss_h").map((r) => r.agentSessionId)).toEqual(["as_h1", "as_h2"]);
    s.close();
  });

  it("getRunLogsBySession returns runs oldest-first with events joined as JSONL", () => {
    const s = new SessionStore(":memory:");
    s.upsert("as_h3", "implement", "iss_h3");
    const run1 = s.createRun("as_h3", "plan", "o/r");
    const run2 = s.createRun("as_h3", "implement", "o/r");
    s.addRunEvent(run1, "assistant_text", { kind: "assistant_text", text: "thinking" });
    s.addRunEvent(run2, "tool_use", { kind: "tool_use", name: "Bash", input: { command: "npm test" } });
    s.addRunEvent(run2, "result", { kind: "result", text: "https://github.com/o/r/pull/1" });

    const logs = s.getRunLogsBySession("as_h3");
    expect(logs.map((l) => l.taskType)).toEqual(["plan", "implement"]);
    expect(logs[0].runId).toBe(run1);

    const lines = logs[1].jsonl.split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first.type).toBe("tool_use");
    expect(first.payload.input.command).toBe("npm test");
    expect(first.ts).toBeTruthy();
    s.close();
  });

  it("getRunLogsBySession returns an empty jsonl for a run with no events, and [] for unknown sessions", () => {
    const s = new SessionStore(":memory:");
    s.upsert("as_h4", "plan", "iss_h4");
    s.createRun("as_h4", "map", "o/r");
    const logs = s.getRunLogsBySession("as_h4");
    expect(logs).toHaveLength(1);
    expect(logs[0].jsonl).toBe("");
    expect(s.getRunLogsBySession("as_nope")).toEqual([]);
    s.close();
  });
});

describe("runs model/effort columns", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("records model and effort when provided, null otherwise", () => {
    dir = mkdtempSync(join(tmpdir(), "sessions-test-"));
    const path = join(dir, "runs.db");
    const s = new SessionStore(path);
    const withModel = s.createRun("as_me", "implement", "o/r", "claude-opus-4-8", "high");
    const without = s.createRun("as_me", "map", "o/r");
    s.close();
    // the store has no per-run getter — the report reads SQL directly, so verify the same way
    const db = new DatabaseSync(path, { readOnly: true });
    const rows = db.prepare(`SELECT id, model, effort FROM runs ORDER BY id`).all() as
      { id: number; model: string | null; effort: string | null }[];
    db.close();
    expect(rows.find((r) => r.id === withModel)).toMatchObject({ model: "claude-opus-4-8", effort: "high" });
    expect(rows.find((r) => r.id === without)).toMatchObject({ model: null, effort: null });
  });
});
