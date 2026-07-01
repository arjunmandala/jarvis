import type { LinearClient } from "@linear/sdk";

export interface Activities {
  thought(text: string): Promise<void>;
  action(action: string, parameter?: string, result?: string): Promise<void>;
  response(body: string): Promise<void>;
  error(body: string): Promise<void>;
  elicitation(body: string): Promise<void>;
}

type AgentClient = Pick<LinearClient, "createAgentActivity">;

export function makeActivities(client: AgentClient, agentSessionId: string): Activities {
  const create = (content: Record<string, unknown>) =>
    client.createAgentActivity({ agentSessionId, content } as never).then(() => undefined);

  return {
    thought: (body) => create({ type: "thought", body }),
    action: (action, parameter, result) =>
      create({
        type: "action",
        action,
        ...(parameter !== undefined ? { parameter } : {}),
        ...(result !== undefined ? { result } : {}),
      }),
    response: (body) => create({ type: "response", body }),
    error: (body) => create({ type: "error", body }),
    elicitation: (body) => create({ type: "elicitation", body }),
  };
}
