import { DatabaseSync } from "node:sqlite";

export type Phase = "clarify" | "plan" | "await_approval" | "implement" | "review" | "done" | "error";

export interface SessionRow {
  agentSessionId: string;
  phase: Phase;
  issueId: string | null;
  branch: string | null;
  workBranch: string | null;
  plan: string | null;
  sandboxId: string | null;
  prUrl: string | null;
  review: string | null;
  updatedAt: string;
}

export interface RunFinish {
  outcome: string;
  costUsd: number | null;
  numTurns: number | null;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  error: string | null;
}

// One prior run's telemetry, packaged for export into the sandbox as a JSONL
// file (see src/history/history.ts). jsonl is the raw run_events stream.
export interface RunLog {
  runId: number;
  taskType: string;
  startedAt: string;
  outcome: string | null;
  jsonl: string;
}

export class SessionStore {
  #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        agent_session_id TEXT PRIMARY KEY,
        phase            TEXT NOT NULL,
        issue_id         TEXT,
        updated_at       TEXT NOT NULL
      ) STRICT
    `);
    // Migration: pre-existing dev DBs lack the plan column (no ADD COLUMN IF NOT EXISTS in SQLite).
    const cols = this.#db.prepare(`SELECT name FROM pragma_table_info('sessions')`).all() as { name: string }[];
    if (!cols.some((c) => c.name === "plan")) {
      this.#db.exec(`ALTER TABLE sessions ADD COLUMN plan TEXT`);
    }
    if (!cols.some((c) => c.name === "sandbox_id")) {
      this.#db.exec(`ALTER TABLE sessions ADD COLUMN sandbox_id TEXT`);
    }
    if (!cols.some((c) => c.name === "pr_url")) {
      this.#db.exec(`ALTER TABLE sessions ADD COLUMN pr_url TEXT`);
    }
    if (!cols.some((c) => c.name === "review")) {
      this.#db.exec(`ALTER TABLE sessions ADD COLUMN review TEXT`);
    }
    if (!cols.some((c) => c.name === "branch")) {
      this.#db.exec(`ALTER TABLE sessions ADD COLUMN branch TEXT`);
    }
    if (!cols.some((c) => c.name === "work_branch")) {
      this.#db.exec(`ALTER TABLE sessions ADD COLUMN work_branch TEXT`);
    }
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS repo_maps (
        repo       TEXT PRIMARY KEY,
        map        TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT
    `);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_session_id  TEXT NOT NULL,
        task_type         TEXT NOT NULL,
        repo              TEXT,
        started_at        TEXT NOT NULL,
        ended_at          TEXT,
        outcome           TEXT,
        cost_usd          REAL,
        num_turns         INTEGER,
        tokens_in         INTEGER,
        tokens_out        INTEGER,
        tokens_cache_read INTEGER,
        error             TEXT
      ) STRICT
    `);
    // Migration: older DBs lack tokens_cache_write (cache-creation is the main
    // cost driver, so the report needs it broken out from tokens_in).
    const runCols = this.#db.prepare(`SELECT name FROM pragma_table_info('runs')`).all() as { name: string }[];
    if (!runCols.some((c) => c.name === "tokens_cache_write")) {
      this.#db.exec(`ALTER TABLE runs ADD COLUMN tokens_cache_write INTEGER`);
    }
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS run_events (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id  INTEGER NOT NULL,
        ts      TEXT NOT NULL,
        type    TEXT NOT NULL,
        payload TEXT NOT NULL
      ) STRICT
    `);
  }

  getRepoMap(repo: string): string | undefined {
    const row = this.#db.prepare(`SELECT map FROM repo_maps WHERE repo = ?`).get(repo) as
      | { map: string }
      | undefined;
    return row?.map;
  }

  setRepoMap(repo: string, map: string): void {
    this.#db
      .prepare(
        `INSERT INTO repo_maps (repo, map, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(repo)
         DO UPDATE SET map = excluded.map, updated_at = excluded.updated_at`,
      )
      .run(repo, map, new Date().toISOString());
  }

  createRun(agentSessionId: string, taskType: string, repo: string | null): number {
    const r = this.#db
      .prepare(`INSERT INTO runs (agent_session_id, task_type, repo, started_at) VALUES (?, ?, ?, ?)`)
      .run(agentSessionId, taskType, repo, new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  addRunEvent(runId: number, type: string, payload: unknown): void {
    this.#db
      .prepare(`INSERT INTO run_events (run_id, ts, type, payload) VALUES (?, ?, ?, ?)`)
      .run(runId, new Date().toISOString(), type, JSON.stringify(payload));
  }

  finishRun(runId: number, f: RunFinish): void {
    this.#db
      .prepare(
        `UPDATE runs SET ended_at = ?, outcome = ?, cost_usd = ?, num_turns = ?,
                tokens_in = ?, tokens_out = ?, tokens_cache_read = ?, tokens_cache_write = ?, error = ?
         WHERE id = ?`,
      )
      .run(
        new Date().toISOString(), f.outcome, f.costUsd, f.numTurns,
        f.tokensIn, f.tokensOut, f.tokensCacheRead, f.tokensCacheWrite, f.error, runId,
      );
  }

  upsert(agentSessionId: string, phase: Phase, issueId: string | null = null): void {
    this.#db
      .prepare(
        `INSERT INTO sessions (agent_session_id, phase, issue_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_session_id)
         DO UPDATE SET phase = excluded.phase,
                       issue_id = COALESCE(excluded.issue_id, sessions.issue_id),
                       updated_at = excluded.updated_at`,
      )
      .run(agentSessionId, phase, issueId, new Date().toISOString());
  }

  setPhase(agentSessionId: string, phase: Phase): void {
    this.#db
      .prepare(`UPDATE sessions SET phase = ?, updated_at = ? WHERE agent_session_id = ?`)
      .run(phase, new Date().toISOString(), agentSessionId);
  }

  setPlan(agentSessionId: string, plan: string): void {
    this.#db
      .prepare(`UPDATE sessions SET plan = ?, updated_at = ? WHERE agent_session_id = ?`)
      .run(plan, new Date().toISOString(), agentSessionId);
  }

  setSandbox(agentSessionId: string, sandboxId: string | null): void {
    this.#db
      .prepare(`UPDATE sessions SET sandbox_id = ?, updated_at = ? WHERE agent_session_id = ?`)
      .run(sandboxId, new Date().toISOString(), agentSessionId);
  }

  setPrUrl(agentSessionId: string, prUrl: string): void {
    this.#db
      .prepare(`UPDATE sessions SET pr_url = ?, updated_at = ? WHERE agent_session_id = ?`)
      .run(prUrl, new Date().toISOString(), agentSessionId);
  }

  setReview(agentSessionId: string, review: string): void {
    this.#db
      .prepare(`UPDATE sessions SET review = ?, updated_at = ? WHERE agent_session_id = ?`)
      .run(review, new Date().toISOString(), agentSessionId);
  }

  setBranch(agentSessionId: string, branch: string): void {
    this.#db
      .prepare(`UPDATE sessions SET branch = ?, updated_at = ? WHERE agent_session_id = ?`)
      .run(branch, new Date().toISOString(), agentSessionId);
  }

  setWorkBranch(agentSessionId: string, workBranch: string): void {
    this.#db
      .prepare(`UPDATE sessions SET work_branch = ?, updated_at = ? WHERE agent_session_id = ?`)
      .run(workBranch, new Date().toISOString(), agentSessionId);
  }

  get(agentSessionId: string): SessionRow | undefined {
    const row = this.#db
      .prepare(
        `SELECT agent_session_id, phase, issue_id, branch, work_branch, plan, sandbox_id, pr_url, review, updated_at FROM sessions WHERE agent_session_id = ?`,
      )
      .get(agentSessionId) as
      | {
          agent_session_id: string;
          phase: Phase;
          issue_id: string | null;
          branch: string | null;
          work_branch: string | null;
          plan: string | null;
          sandbox_id: string | null;
          pr_url: string | null;
          review: string | null;
          updated_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      agentSessionId: row.agent_session_id,
      phase: row.phase,
      issueId: row.issue_id,
      branch: row.branch,
      workBranch: row.work_branch,
      plan: row.plan,
      sandboxId: row.sandbox_id,
      prUrl: row.pr_url,
      review: row.review,
      updatedAt: row.updated_at,
    };
  }

  listByPhase(...phases: Phase[]): SessionRow[] {
    const placeholders = phases.map(() => "?").join(", ");
    const rows = this.#db
      .prepare(
        `SELECT agent_session_id, phase, issue_id, branch, work_branch, plan, sandbox_id, pr_url, review, updated_at FROM sessions WHERE phase IN (${placeholders})`,
      )
      .all(...phases) as {
      agent_session_id: string;
      phase: Phase;
      issue_id: string | null;
      branch: string | null;
      work_branch: string | null;
      plan: string | null;
      sandbox_id: string | null;
      pr_url: string | null;
      review: string | null;
      updated_at: string;
    }[];
    return rows.map((row) => ({
      agentSessionId: row.agent_session_id,
      phase: row.phase,
      issueId: row.issue_id,
      branch: row.branch,
      workBranch: row.work_branch,
      plan: row.plan,
      sandboxId: row.sandbox_id,
      prUrl: row.pr_url,
      review: row.review,
      updatedAt: row.updated_at,
    }));
  }

  // The resume seam. Re-assigning an issue mints a NEW agentSessionId, so durable
  // state must be recoverable by issue, not by session id. Returns the latest
  // OTHER session for this issue that got far enough to save a plan.
  findResumableByIssue(issueId: string, excludeSessionId: string): SessionRow | null {
    const row = this.#db
      .prepare(
        `SELECT agent_session_id, phase, issue_id, branch, work_branch, plan, sandbox_id, pr_url, review, updated_at
         FROM sessions
         WHERE issue_id = ? AND agent_session_id != ?
           AND plan IS NOT NULL AND TRIM(plan) != ''
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(issueId, excludeSessionId) as
      | {
          agent_session_id: string; phase: Phase; issue_id: string | null;
          branch: string | null; work_branch: string | null; plan: string | null;
          sandbox_id: string | null; pr_url: string | null; review: string | null; updated_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      agentSessionId: row.agent_session_id, phase: row.phase, issueId: row.issue_id,
      branch: row.branch, workBranch: row.work_branch, plan: row.plan,
      sandboxId: row.sandbox_id, prUrl: row.pr_url, review: row.review, updatedAt: row.updated_at,
    };
  }

  // Session memory: every session for an issue (including the asking one),
  // oldest-first — the source list for thread assembly and log export.
  listByIssue(issueId: string): SessionRow[] {
    const rows = this.#db
      .prepare(
        `SELECT agent_session_id, phase, issue_id, branch, work_branch, plan, sandbox_id, pr_url, review, updated_at
         FROM sessions WHERE issue_id = ? ORDER BY updated_at ASC`,
      )
      .all(issueId) as {
      agent_session_id: string; phase: Phase; issue_id: string | null;
      branch: string | null; work_branch: string | null; plan: string | null;
      sandbox_id: string | null; pr_url: string | null; review: string | null; updated_at: string;
    }[];
    return rows.map((row) => ({
      agentSessionId: row.agent_session_id, phase: row.phase, issueId: row.issue_id,
      branch: row.branch, workBranch: row.work_branch, plan: row.plan,
      sandboxId: row.sandbox_id, prUrl: row.pr_url, review: row.review, updatedAt: row.updated_at,
    }));
  }

  // Raw event stream per run, oldest run first. payload is already a JSON
  // string in the DB — splice it in verbatim instead of parse/re-stringify.
  getRunLogsBySession(agentSessionId: string): RunLog[] {
    const runs = this.#db
      .prepare(`SELECT id, task_type, started_at, outcome FROM runs WHERE agent_session_id = ? ORDER BY id ASC`)
      .all(agentSessionId) as { id: number; task_type: string; started_at: string; outcome: string | null }[];
    return runs.map((r) => {
      const events = this.#db
        .prepare(`SELECT ts, type, payload FROM run_events WHERE run_id = ? ORDER BY id ASC`)
        .all(r.id) as { ts: string; type: string; payload: string }[];
      const jsonl = events
        .map((e) => `{"ts":${JSON.stringify(e.ts)},"type":${JSON.stringify(e.type)},"payload":${e.payload}}`)
        .join("\n");
      return { runId: r.id, taskType: r.task_type, startedAt: r.started_at, outcome: r.outcome, jsonl };
    });
  }

  close(): void {
    this.#db.close();
  }
}
