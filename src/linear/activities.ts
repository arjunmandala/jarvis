import type { LinearClient } from "@linear/sdk";

export interface Activities {
  thought(text: string): Promise<void>;
  action(action: string, parameter?: string, result?: string): Promise<void>;
  response(body: string): Promise<void>;
  error(body: string): Promise<void>;
  elicitation(body: string): Promise<void>;
}

type AgentClient = Pick<LinearClient, "createAgentActivity">;

const RETRY_DELAYS_MS = [1000, 5000];

async function withRetry<T>(fn: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length) throw err;
      await sleep(RETRY_DELAYS_MS[attempt]);
      attempt++;
    }
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function makeActivities(
  client: AgentClient,
  agentSessionId: string,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Activities {
  const create = (content: Record<string, unknown>) =>
    client.createAgentActivity({ agentSessionId, content } as never).then(() => undefined);

  // response/error/elicitation gate phase transitions, so a dropped post can wedge
  // the session — retry them. thought/action are high-volume telemetry that callers
  // already tolerate failures for, so they stay one-shot.
  const createWithRetry = (content: Record<string, unknown>) => withRetry(() => create(content), sleep);

  return {
    thought: (body) => create({ type: "thought", body }),
    action: (action, parameter, result) =>
      create({
        type: "action",
        action,
        // Linear rejects action activities without a non-empty `parameter`.
        parameter: parameter && parameter.trim() ? parameter : action,
        ...(result !== undefined ? { result } : {}),
      }),
    response: (body) => createWithRetry({ type: "response", body }),
    error: (body) => createWithRetry({ type: "error", body }),
    elicitation: (body) => createWithRetry({ type: "elicitation", body }),
  };
}
