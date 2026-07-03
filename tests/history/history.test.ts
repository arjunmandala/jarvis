import { describe, it, expect, vi } from "vitest";
import {
  HISTORY_DIR, THREAD_CHAR_CAP, MAX_EXPORTED_RUNS,
  assembleThread, writeHistoryFiles, renderHistory, prepareHistory,
} from "../../src/history/history.ts";
import { SessionStore, type RunLog } from "../../src/store/sessions.ts";
import type { AgentSandbox } from "../../src/sandbox/session.ts";

function fakeSbx(): { sbx: AgentSandbox; writes: Map<string, string> } {
  const writes = new Map<string, string>();
  const sbx: AgentSandbox = {
    files: {
      read: async () => { throw new Error("not used"); },
      write: async (path: string, data: string) => { writes.set(path, data); },
    },
    commands: { run: async () => ({ exitCode: 0 }), list: async () => [] },
  };
  return { sbx, writes };
}

function runLog(runId: number, taskType: string, jsonl: string): RunLog {
  return { runId, taskType, startedAt: "2026-07-03T00:00:00Z", outcome: "success", jsonl };
}

describe("assembleThread", () => {
  it("joins per-session threads with separators, skipping empty and failed sessions", async () => {
    const fetchThread = vi.fn(async (id: string) => {
      if (id === "s1") return "**Human:** hi";
      if (id === "s2") return null;
      if (id === "s3") throw new Error("boom");
      return "**Jarvis:** done";
    });
    const out = await assembleThread(["s1", "s2", "s3", "s4"], fetchThread);
    expect(out).toBe("**Human:** hi\n\n---\n\n**Jarvis:** done");
  });

  it("returns null when nothing is fetchable", async () => {
    expect(await assembleThread(["s1"], async () => null)).toBeNull();
  });

  it("caps the assembled thread, keeping the newest tail", async () => {
    const big = "x".repeat(THREAD_CHAR_CAP);
    const out = await assembleThread(["s1", "s2"], async (id) => (id === "s1" ? big : "TAIL_MARKER"));
    expect(out!.length).toBeLessThanOrEqual(THREAD_CHAR_CAP + 100);
    expect(out).toContain("TAIL_MARKER");
    expect(out!.startsWith("…(older conversation truncated)")).toBe(true);
  });
});

describe("writeHistoryFiles", () => {
  it("writes one JSONL file per run under HISTORY_DIR and returns the basenames", async () => {
    const { sbx, writes } = fakeSbx();
    const files = await writeHistoryFiles(sbx, [runLog(7, "plan", '{"a":1}'), runLog(9, "implement", '{"b":2}')]);
    expect(files).toEqual(["run-7-plan.jsonl", "run-9-implement.jsonl"]);
    expect(writes.get(`${HISTORY_DIR}/run-7-plan.jsonl`)).toBe('{"a":1}');
  });

  it("skips empty logs, keeps only the most recent MAX_EXPORTED_RUNS, and survives write failures", async () => {
    const logs: RunLog[] = [runLog(1, "map", "")];
    for (let i = 2; i <= MAX_EXPORTED_RUNS + 3; i++) logs.push(runLog(i, "plan", `{"i":${i}}`));
    const { sbx, writes } = fakeSbx();
    // run-N (the newest) is inside the kept slice(-MAX_EXPORTED_RUNS) window,
    // so its write failure genuinely exercises the skip-that-file-only path.
    const failing = `run-${MAX_EXPORTED_RUNS + 3}-plan.jsonl`;
    sbx.files.write = async (path: string, data: string) => {
      if (path.endsWith(failing)) throw new Error("e2b 500");
      writes.set(path, data);
    };
    const files = await writeHistoryFiles(sbx, logs);
    expect(files).toHaveLength(MAX_EXPORTED_RUNS - 1);
    expect(files).not.toContain("run-1-map.jsonl"); // empty jsonl → filtered
    expect(files).not.toContain(failing); // write threw → skipped, not fatal
    expect(files).toContain(`run-${MAX_EXPORTED_RUNS + 2}-plan.jsonl`);
  });
});

describe("renderHistory", () => {
  it("returns undefined when there is neither thread nor files", () => {
    expect(renderHistory(null, [])).toBeUndefined();
  });

  it("includes the thread and the grep pointer when both exist", () => {
    const out = renderHistory("**Human:** hi", ["run-1-plan.jsonl"]);
    expect(out).toContain("**Human:** hi");
    expect(out).toContain(HISTORY_DIR);
    expect(out).toContain("run-1-plan.jsonl");
  });

  it("renders thread-only and files-only variants", () => {
    expect(renderHistory("**Human:** hi", [])).toContain("**Human:** hi");
    expect(renderHistory("**Human:** hi", [])).not.toContain(HISTORY_DIR);
    expect(renderHistory(null, ["run-1-plan.jsonl"])).toContain(HISTORY_DIR);
  });
});

describe("prepareHistory", () => {
  function seededStore(): SessionStore {
    const s = new SessionStore(":memory:");
    s.upsert("as_old", "error", "iss_1");
    const run = s.createRun("as_old", "implement", "o/r");
    s.addRunEvent(run, "tool_use", { kind: "tool_use", name: "Bash", input: { command: "npm test" } });
    s.upsert("as_new", "plan", "iss_1");
    return s;
  }

  it("assembles thread + writes logs + renders the combined block", async () => {
    const store = seededStore();
    const { sbx, writes } = fakeSbx();
    const out = await prepareHistory(store, sbx, "iss_1", async () => "**Human:** old chat");
    expect(out).toContain("**Human:** old chat");
    expect(out).toContain(HISTORY_DIR);
    expect([...writes.keys()].some((k) => k.startsWith(HISTORY_DIR))).toBe(true);
    store.close();
  });

  it("returns undefined for a null issue, an unknown issue, and on store failure", async () => {
    const store = seededStore();
    const { sbx } = fakeSbx();
    expect(await prepareHistory(store, sbx, null)).toBeUndefined();
    expect(await prepareHistory(store, sbx, "iss_none")).toBeUndefined();
    store.close(); // closed DB → listByIssue throws → advisory undefined
    expect(await prepareHistory(store, sbx, "iss_1")).toBeUndefined();
  });

  it("works without a thread fetcher (logs-only)", async () => {
    const store = seededStore();
    const { sbx } = fakeSbx();
    const out = await prepareHistory(store, sbx, "iss_1");
    expect(out).toContain(HISTORY_DIR);
    expect(out).not.toContain("**Human:**");
    store.close();
  });
});
