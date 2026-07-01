import { DatabaseSync } from "node:sqlite";

export type Phase = "clarify" | "plan" | "await_approval" | "implement" | "done" | "error";

export interface SessionRow {
  agentSessionId: string;
  phase: Phase;
  issueId: string | null;
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

  get(agentSessionId: string): SessionRow | undefined {
    const row = this.#db
      .prepare(`SELECT agent_session_id, phase, issue_id, updated_at FROM sessions WHERE agent_session_id = ?`)
      .get(agentSessionId) as
      | { agent_session_id: string; phase: Phase; issue_id: string | null; updated_at: string }
      | undefined;
    if (!row) return undefined;
    return { agentSessionId: row.agent_session_id, phase: row.phase, issueId: row.issue_id, updatedAt: row.updated_at };
  }

  close(): void {
    this.#db.close();
  }
}
