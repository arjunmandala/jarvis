import { randomUUID } from "node:crypto";

export interface RunTokenClaims { agentSessionId: string; issueId: string | null }

// The host mints a random bearer token per agent run, held only in memory (like
// the orchestrator's #live map) and revoked when the run finishes. The Linear
// OAuth token never enters the sandbox; a token resolves only to its run's
// issue, so a compromised sandbox can at worst read that issue's docs/thread/runs.
export class RunTokenRegistry {
  #tokens = new Map<string, RunTokenClaims>();
  mint(claims: RunTokenClaims): string {
    const token = randomUUID();
    this.#tokens.set(token, claims);
    return token;
  }
  resolve(token: string): RunTokenClaims | undefined {
    return this.#tokens.get(token);
  }
  revoke(token: string): void {
    this.#tokens.delete(token);
  }
}
