// Failure-pattern report over run telemetry. Usage: npm run report
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.env.JARVIS_DB ?? "jarvis.db", { readOnly: true });

console.log("=== Runs by task type and outcome ===");
const outcomes = db
  .prepare(
    `SELECT task_type, COALESCE(outcome, '(interrupted)') AS outcome, COUNT(*) AS n,
            ROUND(SUM(COALESCE(cost_usd, 0)), 4) AS cost
     FROM runs GROUP BY task_type, outcome ORDER BY n DESC`,
  )
  .all() as { task_type: string; outcome: string; n: number; cost: number }[];
for (const r of outcomes) console.log(`  ${r.task_type} / ${r.outcome}: ${r.n} runs ($${r.cost})`);

console.log("\n=== Failed tool results, grouped (top 30) ===");
const rows = db.prepare(`SELECT payload FROM run_events WHERE type = 'tool_result'`).all() as { payload: string }[];
const counts = new Map<string, number>();
for (const { payload } of rows) {
  try {
    const p = JSON.parse(payload) as { tool?: string | null; isError?: boolean; content?: string };
    if (!p.isError) continue;
    const firstLine = String(p.content ?? "").split("\n").find((l) => l.trim()) ?? "";
    const key = `${p.tool ?? "?"}: ${firstLine.slice(0, 120)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  } catch {
    // unparseable payload — skip
  }
}
const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
if (top.length === 0) console.log("  (none recorded)");
for (const [key, n] of top) console.log(`  ${String(n).padStart(4)}×  ${key}`);

console.log("\n=== Non-success runs (latest 10, last 3 events each) ===");
const errs = db
  .prepare(
    `SELECT id, task_type, outcome, error FROM runs
     WHERE outcome IS NOT NULL AND outcome != 'success'
     ORDER BY id DESC LIMIT 10`,
  )
  .all() as { id: number; task_type: string; outcome: string; error: string | null }[];
if (errs.length === 0) console.log("  (none)");
for (const r of errs) {
  console.log(`  run ${r.id} [${r.task_type}] ${r.outcome}${r.error ? ` — ${r.error.slice(0, 120)}` : ""}`);
  const evs = db
    .prepare(`SELECT ts, type, payload FROM run_events WHERE run_id = ? ORDER BY id DESC LIMIT 3`)
    .all(r.id) as { ts: string; type: string; payload: string }[];
  for (const e of evs.reverse()) console.log(`     ${e.ts} ${e.type} ${e.payload.slice(0, 140)}`);
}

db.close();
