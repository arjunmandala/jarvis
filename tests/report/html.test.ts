import { describe, it, expect } from "vitest";
import { renderHtml } from "../../src/report/html.ts";
import type { ReportData } from "../../src/report/data.ts";

const DATA: ReportData = {
  generatedAt: "2026-07-04T00:00:00.000Z",
  runs: [
    {
      id: 1, taskType: "implement", startedAt: "2026-07-01T00:00:00.000Z",
      endedAt: "2026-07-01T00:10:00.000Z", outcome: "success", costUsd: 2.5, numTurns: 40,
      tokensOut: 100, cacheRead: 3000, cacheWrite: 1000, model: "claude-sonnet-5",
      effort: "high", error: null, durationMs: 600_000,
    },
    {
      id: 2, taskType: "plan", startedAt: "2026-07-02T00:00:00.000Z", endedAt: null,
      outcome: "interrupted", costUsd: null, numTurns: null, tokensOut: 0, cacheRead: 0,
      cacheWrite: 0, model: null, effort: null, error: null, durationMs: null,
    },
  ],
  timings: [
    { label: "clone", ms: 900 },
    { label: "sandbox_create", ms: 4000 },
  ],
  phaseEvents: [
    { sessionId: "a", ts: "2026-07-01T00:00:00.000Z", label: "plan" },
    { sessionId: "a", ts: "2026-07-01T00:05:00.000Z", label: "await_approval" },
    { sessionId: "a", ts: "2026-07-01T01:00:00.000Z", label: "implement" },
    { sessionId: "a", ts: "2026-07-01T02:00:00.000Z", label: "done" },
  ],
  sessionsWithPr: ["a"],
  failureGroups: [{ key: "Bash: npm ERR! boom", n: 3 }],
  failedRuns: [
    { id: 2, taskType: "plan", outcome: "interrupted", error: "<script>alert(1)</script>", lastEvents: [] },
  ],
};

describe("renderHtml", () => {
  it("renders a self-contained dashboard with all sections", () => {
    const html = renderHtml(DATA);
    expect(html).toContain("<svg");
    for (const section of [
      "Cost by task type", "Outcomes by task type", "Run duration", "Host timings",
      "Cache hit rate", "Cost over time", "By model", "Recent failures", "Runs",
    ]) {
      expect(html).toContain(section);
    }
    // self-contained: no external fetches of any kind
    expect(html).not.toMatch(/<(script|link|img)[^>]*(src|href)=/);
  });

  it("escapes HTML in data-derived strings", () => {
    const html = renderHtml(DATA);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders the empty state without throwing", () => {
    const html = renderHtml({
      generatedAt: "t", runs: [], timings: [], phaseEvents: [],
      sessionsWithPr: [], failureGroups: [], failedRuns: [],
    });
    expect(html).toContain("no data yet");
  });
});
