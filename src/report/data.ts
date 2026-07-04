// Report data layer: read-only queries + pure aggregate helpers. Every query
// tolerates an old DB (missing columns/tables) — the report must degrade, not
// throw, against a not-yet-migrated jarvis.db (migrations only run when the
// server's SessionStore starts).
import type { DatabaseSync } from "node:sqlite";

export interface RunRow {
  id: number;
  taskType: string;
  startedAt: string;
  endedAt: string | null;
  outcome: string | null;
  costUsd: number | null;
  numTurns: number | null;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  model: string | null;
  effort: string | null;
  error: string | null;
  durationMs: number | null;
}

export interface PhaseEvent {
  sessionId: string;
  ts: string;
  label: string;
}

export interface TimingRow {
  label: string;
  ms: number;
}

export interface FailureGroup {
  key: string;
  n: number;
}

export interface FailedRun {
  id: number;
  taskType: string;
  outcome: string;
  error: string | null;
  lastEvents: { ts: string; type: string; payload: string }[];
}

export interface ReportData {
  generatedAt: string;
  runs: RunRow[];
  timings: TimingRow[];
  phaseEvents: PhaseEvent[];
  sessionsWithPr: string[];
  failureGroups: FailureGroup[];
  failedRuns: FailedRun[];
}

// Table names are our own literals, never user input.
function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function hasTable(db: DatabaseSync, table: string): boolean {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) != null;
}

export function gatherReport(db: DatabaseSync): ReportData {
  const runCols = tableColumns(db, "runs");
  const col = (name: string, fallback: string) => (runCols.has(name) ? name : fallback);
  const runs = (
    db
      .prepare(
        `SELECT id, task_type, started_at, ended_at, outcome, cost_usd, num_turns,
                COALESCE(tokens_out, 0) AS tokens_out,
                COALESCE(tokens_cache_read, 0) AS cache_read,
                COALESCE(${col("tokens_cache_write", "0")}, 0) AS cache_write,
                ${col("model", "NULL")} AS model,
                ${col("effort", "NULL")} AS effort,
                error
         FROM runs ORDER BY id ASC`,
      )
      .all() as {
      id: number; task_type: string; started_at: string; ended_at: string | null;
      outcome: string | null; cost_usd: number | null; num_turns: number | null;
      tokens_out: number; cache_read: number; cache_write: number;
      model: string | null; effort: string | null; error: string | null;
    }[]
  ).map((r) => ({
    id: r.id, taskType: r.task_type, startedAt: r.started_at, endedAt: r.ended_at,
    outcome: r.outcome, costUsd: r.cost_usd, numTurns: r.num_turns,
    tokensOut: r.tokens_out, cacheRead: r.cache_read, cacheWrite: r.cache_write,
    model: r.model, effort: r.effort, error: r.error,
    durationMs: r.ended_at ? Date.parse(r.ended_at) - Date.parse(r.started_at) : null,
  }));

  let timings: TimingRow[] = [];
  let phaseEvents: PhaseEvent[] = [];
  if (hasTable(db, "session_events")) {
    timings = db
      .prepare(`SELECT label, ms FROM session_events WHERE kind = 'timing' AND ms IS NOT NULL ORDER BY id ASC`)
      .all() as unknown as TimingRow[];
    phaseEvents = (
      db
        .prepare(`SELECT agent_session_id, ts, label FROM session_events WHERE kind = 'phase' ORDER BY id ASC`)
        .all() as { agent_session_id: string; ts: string; label: string }[]
    ).map((e) => ({ sessionId: e.agent_session_id, ts: e.ts, label: e.label }));
  }

  const sessionsWithPr = tableColumns(db, "sessions").has("pr_url")
    ? (
        db.prepare(`SELECT agent_session_id FROM sessions WHERE pr_url IS NOT NULL`).all() as {
          agent_session_id: string;
        }[]
      ).map((r) => r.agent_session_id)
    : [];

  // Failed tool_results grouped by tool + first content line — the failure miner.
  const counts = new Map<string, number>();
  const payloads = db.prepare(`SELECT payload FROM run_events WHERE type = 'tool_result'`).all() as {
    payload: string;
  }[];
  for (const { payload } of payloads) {
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
  const failureGroups = [...counts.entries()]
    .map(([key, n]) => ({ key, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 30);

  const failedRuns = (
    db
      .prepare(
        `SELECT id, task_type, outcome, error FROM runs
         WHERE outcome IS NOT NULL AND outcome != 'success'
         ORDER BY id DESC LIMIT 10`,
      )
      .all() as { id: number; task_type: string; outcome: string; error: string | null }[]
  ).map((r) => {
    const evs = db
      .prepare(`SELECT ts, type, payload FROM run_events WHERE run_id = ? ORDER BY id DESC LIMIT 3`)
      .all(r.id) as { ts: string; type: string; payload: string }[];
    return { id: r.id, taskType: r.task_type, outcome: r.outcome, error: r.error, lastEvents: evs.reverse() };
  });

  return {
    generatedAt: new Date().toISOString(),
    runs, timings, phaseEvents, sessionsWithPr, failureGroups, failedRuns,
  };
}

// Nearest-rank percentile over unsorted input. p in [0,100]. null on empty.
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

// Fraction of cached-prefix tokens served from cache. null when no cache traffic.
export function cacheHitRate(cacheRead: number, cacheWrite: number): number | null {
  const total = cacheRead + cacheWrite;
  return total === 0 ? null : cacheRead / total;
}

// Human-gate dwell: each time a session enters await_approval, the clock runs
// until its next phase change. Sessions still waiting contribute nothing.
export function approvalDwellsMs(events: PhaseEvent[]): number[] {
  const dwells: number[] = [];
  for (const evs of groupBySession(events).values()) {
    for (let i = 0; i < evs.length - 1; i++) {
      if (evs[i].label === "await_approval") dwells.push(Date.parse(evs[i + 1].ts) - Date.parse(evs[i].ts));
    }
  }
  return dwells;
}

// created→PR wall clock per session that produced a PR: first phase event to the
// first 'done' after it. Sessions born straight into 'done' (a resume that
// inherited a prior PR) are excluded — their e2e time belongs to the original.
export function createdToPrMs(events: PhaseEvent[], sessionsWithPr: string[]): number[] {
  const withPr = new Set(sessionsWithPr);
  const out: number[] = [];
  for (const [sessionId, evs] of groupBySession(events)) {
    if (!withPr.has(sessionId) || evs.length === 0 || evs[0].label === "done") continue;
    const done = evs.find((e) => e.label === "done");
    if (done) out.push(Date.parse(done.ts) - Date.parse(evs[0].ts));
  }
  return out;
}

function groupBySession(events: PhaseEvent[]): Map<string, PhaseEvent[]> {
  const m = new Map<string, PhaseEvent[]>();
  for (const e of events) {
    const list = m.get(e.sessionId);
    if (list) list.push(e);
    else m.set(e.sessionId, [e]);
  }
  return m;
}
