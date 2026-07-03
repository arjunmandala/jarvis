// Failure-pattern report over run telemetry. Usage: npm run report
import "./logger.ts";
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

console.log("\n=== Cost economics (by task type) ===");
// cost_usd is the only cumulative-truthful figure Claude Code returns; tokens are
// now summed across turns in the runner. cache_write ≫ cache_read means the prompt
// cache keeps missing (re-writing the whole prefix at the 1.25x write premium) —
// the lever there is fewer/faster turns and a smaller prefix, not the model.
// tokens_cache_write is added by a migration that only runs when the server
// (SessionStore) starts; a read-only report against a not-yet-migrated DB must
// tolerate its absence.
const hasCacheWrite = (db.prepare(`SELECT name FROM pragma_table_info('runs')`).all() as { name: string }[]).some(
  (c) => c.name === "tokens_cache_write",
);
const cwExpr = hasCacheWrite ? "SUM(COALESCE(tokens_cache_write, 0))" : "0";
const econ = db
  .prepare(
    `SELECT task_type,
            COUNT(*) AS n,
            ROUND(SUM(COALESCE(cost_usd, 0)), 4) AS cost,
            ROUND(AVG(COALESCE(cost_usd, 0)), 4) AS cost_avg,
            ROUND(AVG(COALESCE(num_turns, 0)), 1) AS turns_avg,
            SUM(COALESCE(tokens_out, 0)) AS out,
            SUM(COALESCE(tokens_cache_read, 0)) AS cr,
            ${cwExpr} AS cw
     FROM runs WHERE cost_usd IS NOT NULL
     GROUP BY task_type ORDER BY cost DESC`,
  )
  .all() as { task_type: string; n: number; cost: number; cost_avg: number; turns_avg: number; out: number; cr: number; cw: number }[];
if (econ.length === 0) {
  console.log("  (no completed runs with cost recorded)");
} else {
  console.log("  task          runs   $total   $/run  turns/run    out_tok  cache_read  cache_write");
  let totalCost = 0;
  for (const r of econ) {
    totalCost += r.cost;
    console.log(
      `  ${r.task_type.padEnd(12)} ${String(r.n).padStart(4)}  ${("$" + r.cost.toFixed(4)).padStart(8)} ` +
        `${("$" + r.cost_avg.toFixed(4)).padStart(7)} ${String(r.turns_avg).padStart(9)}  ` +
        `${String(r.out).padStart(9)}  ${String(r.cr).padStart(10)}  ${String(r.cw).padStart(11)}`,
    );
  }
  console.log(`  total spend: $${totalCost.toFixed(4)}`);
  const cr = econ.reduce((s, r) => s + r.cr, 0);
  const cw = econ.reduce((s, r) => s + r.cw, 0);
  if (cr + cw > 0) {
    console.log(
      `  cache write/read ratio: ${(cw / Math.max(cr, 1)).toFixed(2)} ` +
        `(high ⇒ prompt-cache misses — trim the prefix / keep turns under the 5-min TTL)`,
    );
  }
}

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
