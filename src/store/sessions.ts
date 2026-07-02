import { DatabaseSync } from "node:sqlite";

export type Phase = "clarify" | "plan" | "await_approval" | "implement" | "done" | "error";

export interface SessionRow {
  agentSessionId: string;
  phase: Phase;
  issueId: string | null;
  plan: string | null;
  sandboxId: string | null;
  updatedAt: string;
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
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS repo_maps (
        repo       TEXT PRIMARY KEY,
        map        TEXT NOT NULL,
        updated_at TEXT NOT NULL
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

  get(agentSessionId: string): SessionRow | undefined {
    const row = this.#db
      .prepare(
        `SELECT agent_session_id, phase, issue_id, plan, sandbox_id, updated_at FROM sessions WHERE agent_session_id = ?`,
      )
      .get(agentSessionId) as
      | {
          agent_session_id: string;
          phase: Phase;
          issue_id: string | null;
          plan: string | null;
          sandbox_id: string | null;
          updated_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      agentSessionId: row.agent_session_id,
      phase: row.phase,
      issueId: row.issue_id,
      plan: row.plan,
      sandboxId: row.sandbox_id,
      updatedAt: row.updated_at,
    };
  }

  listByPhase(...phases: Phase[]): SessionRow[] {
    const placeholders = phases.map(() => "?").join(", ");
    const rows = this.#db
      .prepare(
        `SELECT agent_session_id, phase, issue_id, plan, sandbox_id, updated_at FROM sessions WHERE phase IN (${placeholders})`,
      )
      .all(...phases) as {
      agent_session_id: string;
      phase: Phase;
      issue_id: string | null;
      plan: string | null;
      sandbox_id: string | null;
      updated_at: string;
    }[];
    return rows.map((row) => ({
      agentSessionId: row.agent_session_id,
      phase: row.phase,
      issueId: row.issue_id,
      plan: row.plan,
      sandboxId: row.sandbox_id,
      updatedAt: row.updated_at,
    }));
  }

  close(): void {
    this.#db.close();
  }
}
