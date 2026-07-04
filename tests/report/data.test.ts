import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionStore } from "../../src/store/sessions.ts";
import {
  gatherReport, percentile, cacheHitRate, approvalDwellsMs, createdToPrMs,
  type PhaseEvent,
} from "../../src/report/data.ts";

describe("pure aggregates", () => {
  it("percentile uses nearest-rank and handles edges", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([10], 50)).toBe(10);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 90)).toBe(4);
    expect(percentile([3, 1, 2], 100)).toBe(3); // unsorted input is fine
  });

  it("cacheHitRate is read/(read+write), null with no cache traffic", () => {
    expect(cacheHitRate(0, 0)).toBeNull();
    expect(cacheHitRate(300, 100)).toBe(0.75);
  });

  it("approvalDwellsMs measures each await_approval entry until the next transition", () => {
    const t = (s: number) => new Date(s * 1000).toISOString();
    const events: PhaseEvent[] = [
      { sessionId: "a", ts: t(0), label: "plan" },
      { sessionId: "a", ts: t(10), label: "await_approval" },
      { sessionId: "a", ts: t(70), label: "plan" }, // revision loop
      { sessionId: "a", ts: t(80), label: "await_approval" },
      { sessionId: "a", ts: t(200), label: "implement" },
      { sessionId: "b", ts: t(0), label: "await_approval" }, // still waiting — no dwell
    ];
    expect(approvalDwellsMs(events)).toEqual([60_000, 120_000]);
  });

  it("createdToPrMs measures first event → done for PR sessions, skipping inherited-PR resumes", () => {
    const t = (s: number) => new Date(s * 1000).toISOString();
    const events: PhaseEvent[] = [
      { sessionId: "a", ts: t(0), label: "plan" },
      { sessionId: "a", ts: t(500), label: "done" },
      { sessionId: "resume", ts: t(0), label: "done" }, // born done — excluded
      { sessionId: "nopr", ts: t(0), label: "plan" },
      { sessionId: "nopr", ts: t(30), label: "done" }, // no PR — excluded
    ];
    expect(createdToPrMs(events, ["a", "resume"])).toEqual([500_000]);
  });
});

describe("gatherReport", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reads runs, timings, phase events, and failure groups from a seeded DB", () => {
    dir = mkdtempSync(join(tmpdir(), "report-test-"));
    const path = join(dir, "jarvis.db");
    const s = new SessionStore(path);
    s.upsert("as_g1", "plan", "iss");
    s.setPhase("as_g1", "await_approval");
    s.setPhase("as_g1", "done");
    s.setPrUrl("as_g1", "https://github.com/o/r/pull/1");
    s.addTiming("as_g1", "clone", 900);
    const runId = s.createRun("as_g1", "implement", "o/r", "claude-sonnet-5", "high");
    s.addRunEvent(runId, "tool_result", { tool: "Bash", isError: true, content: "npm ERR! boom\nstack" });
    s.finishRun(runId, {
      outcome: "success", costUsd: 2.5, numTurns: 40,
      tokensIn: 100, tokensOut: 200, tokensCacheRead: 3000, tokensCacheWrite: 1000, error: null,
    });
    s.close();

    const db = new DatabaseSync(path, { readOnly: true });
    const data = gatherReport(db);
    db.close();

    expect(data.runs).toHaveLength(1);
    expect(data.runs[0]).toMatchObject({ taskType: "implement", model: "claude-sonnet-5", outcome: "success" });
    expect(data.runs[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(data.timings).toEqual([{ label: "clone", ms: 900 }]);
    expect(data.phaseEvents.map((e) => e.label)).toEqual(["plan", "await_approval", "done"]);
    expect(data.sessionsWithPr).toEqual(["as_g1"]);
    expect(data.failureGroups).toEqual([{ key: "Bash: npm ERR! boom", n: 1 }]);
    expect(data.failedRuns).toEqual([]);
  });
});
