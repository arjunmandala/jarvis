// Failure-pattern + economics report over run telemetry. Usage: npm run report
// Prints the console summary AND writes a self-contained HTML dashboard
// (jarvis-report.html — gitignored).
import "./logger.ts";
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  gatherReport, percentile, cacheHitRate, approvalDwellsMs, createdToPrMs,
  type ReportData,
} from "./report/data.ts";
import { renderHtml } from "./report/html.ts";

const db = new DatabaseSync(process.env.JARVIS_DB ?? "jarvis.db", { readOnly: true });
const data = gatherReport(db);
db.close();

printConsole(data);

const htmlPath = resolve("jarvis-report.html");
writeFileSync(htmlPath, renderHtml(data));
console.log(`\nHTML dashboard: file://${htmlPath.replace(/\\/g, "/")}`);

function fmtDur(ms: number | null): string {
  if (ms == null) return "n/a";
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtRate(rate: number | null): string {
  return rate == null ? "n/a" : `${Math.round(rate * 100)}%`;
}

function printConsole(d: ReportData): void {
  console.log("=== Runs by task type and outcome ===");
  const byOutcome = new Map<string, { n: number; cost: number }>();
  for (const r of d.runs) {
    const key = `${r.taskType} / ${r.outcome ?? "(open)"}`;
    const cur = byOutcome.get(key) ?? { n: 0, cost: 0 };
    cur.n += 1;
    cur.cost += r.costUsd ?? 0;
    byOutcome.set(key, cur);
  }
  for (const [key, v] of [...byOutcome.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${key}: ${v.n} runs ($${v.cost.toFixed(4)})`);
  }

  console.log("\n=== Cost economics (by task type) ===");
  // cost_usd is the only cumulative-truthful figure Claude Code returns; tokens
  // are summed across turns in the runner. A low cache-hit rate means the prompt
  // cache keeps missing (re-writing the prefix at the 1.25x write premium) — the
  // lever is fewer/faster turns and a smaller prefix, not the model.
  const types = [...new Set(d.runs.map((r) => r.taskType))];
  const econ = types
    .map((t) => {
      const rs = d.runs.filter((r) => r.taskType === t && r.costUsd != null);
      const durations = d.runs.filter((r) => r.taskType === t && r.durationMs != null).map((r) => r.durationMs!);
      const cost = rs.reduce((s, r) => s + (r.costUsd ?? 0), 0);
      return {
        t, n: rs.length, cost,
        costAvg: rs.length ? cost / rs.length : 0,
        turnsAvg: rs.length ? rs.reduce((s, r) => s + (r.numTurns ?? 0), 0) / rs.length : 0,
        p50: percentile(durations, 50), p90: percentile(durations, 90),
        cr: rs.reduce((s, r) => s + r.cacheRead, 0), cw: rs.reduce((s, r) => s + r.cacheWrite, 0),
      };
    })
    .filter((e) => e.n > 0)
    .sort((a, b) => b.cost - a.cost);
  if (econ.length === 0) {
    console.log("  (no completed runs with cost recorded)");
  } else {
    console.log("  task          runs   $total   $/run  turns/run   dur p50   dur p90  cache hit");
    for (const e of econ) {
      console.log(
        `  ${e.t.padEnd(12)} ${String(e.n).padStart(4)}  ${("$" + e.cost.toFixed(4)).padStart(8)} ` +
          `${("$" + e.costAvg.toFixed(4)).padStart(7)} ${e.turnsAvg.toFixed(1).padStart(9)}  ` +
          `${fmtDur(e.p50).padStart(8)}  ${fmtDur(e.p90).padStart(8)}  ${fmtRate(cacheHitRate(e.cr, e.cw)).padStart(9)}`,
      );
    }
    console.log(`  total spend: $${econ.reduce((s, e) => s + e.cost, 0).toFixed(4)}`);
    const cr = econ.reduce((s, e) => s + e.cr, 0);
    const cw = econ.reduce((s, e) => s + e.cw, 0);
    if (cr + cw > 0) {
      console.log(
        `  cache write/read ratio: ${(cw / Math.max(cr, 1)).toFixed(2)} ` +
          `(high ⇒ prompt-cache misses — trim the prefix / keep turns under the 5-min TTL)`,
      );
    }
  }

  console.log("\n=== Success by model (implement routing) ===");
  const models = [...new Set(d.runs.filter((r) => r.model != null && r.outcome != null).map((r) => r.model!))];
  if (models.length === 0) console.log("  (no model data yet — recorded from this release on)");
  for (const m of models) {
    const rs = d.runs.filter((r) => r.model === m && r.outcome != null);
    const ok = rs.filter((r) => r.outcome === "success").length;
    const cost = rs.reduce((s, r) => s + (r.costUsd ?? 0), 0);
    console.log(
      `  ${m.padEnd(18)} ${String(rs.length).padStart(4)} runs  ${fmtRate(ok / rs.length).padStart(5)} success  $${(cost / rs.length).toFixed(4)}/run`,
    );
  }

  console.log("\n=== Host timings (sandbox lifecycle) ===");
  const labels = [...new Set(d.timings.map((t) => t.label))];
  if (labels.length === 0) console.log("  (none recorded yet)");
  for (const l of labels) {
    const ms = d.timings.filter((t) => t.label === l).map((t) => t.ms);
    console.log(`  ${l.padEnd(14)} n=${String(ms.length).padStart(3)}  p50=${fmtDur(percentile(ms, 50))}  p90=${fmtDur(percentile(ms, 90))}`);
  }

  console.log("\n=== Human-gate latency ===");
  const dwells = approvalDwellsMs(d.phaseEvents);
  const e2e = createdToPrMs(d.phaseEvents, d.sessionsWithPr);
  console.log(`  approval wait: n=${dwells.length}  p50=${fmtDur(percentile(dwells, 50))}  p90=${fmtDur(percentile(dwells, 90))}`);
  console.log(`  created→PR:    n=${e2e.length}  p50=${fmtDur(percentile(e2e, 50))}  p90=${fmtDur(percentile(e2e, 90))}`);

  console.log("\n=== Failed tool results, grouped (top 30) ===");
  if (d.failureGroups.length === 0) console.log("  (none recorded)");
  for (const g of d.failureGroups) console.log(`  ${String(g.n).padStart(4)}×  ${g.key}`);

  console.log("\n=== Non-success runs (latest 10, last 3 events each) ===");
  if (d.failedRuns.length === 0) console.log("  (none)");
  for (const r of d.failedRuns) {
    console.log(`  run ${r.id} [${r.taskType}] ${r.outcome}${r.error ? ` — ${r.error.slice(0, 120)}` : ""}`);
    for (const e of r.lastEvents) console.log(`     ${e.ts} ${e.type} ${e.payload.slice(0, 140)}`);
  }
}
