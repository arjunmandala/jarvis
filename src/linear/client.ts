import { LinearClient } from "@linear/sdk";
import { APPROVAL_FOOTER } from "./context.ts";

export function makeLinearClient(accessToken: string): LinearClient {
  // actor=app agents authenticate with the OAuth access token, NOT a personal apiKey.
  return new LinearClient({ accessToken });
}

const PLAN_QUERY = `query($id: String!) { agentSession(id: $id) { activities(first: 250) { nodes { content { __typename ... on AgentActivityElicitationContent { body } } } } } }`;

interface ElicitationNode {
  content?: { __typename?: string; body?: string } | null;
}

interface PlanQueryResponse {
  data?: {
    agentSession?: {
      activities?: {
        nodes?: ElicitationNode[];
      } | null;
    } | null;
  } | null;
  errors?: unknown;
}

/**
 * Recover the last-posted plan for an agent session directly from Linear —
 * used when our local DB lost it (e.g. a restart between plan-save and
 * approval). Finds elicitation activities whose body carries APPROVAL_FOOTER
 * (this excludes the "not implementing yet" re-elicitations, which don't),
 * takes the last one, and strips the footer.
 */
export function makePlanFetcher(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): (agentSessionId: string) => Promise<string | null> {
  return async (agentSessionId: string): Promise<string | null> => {
    try {
      const res = await fetchImpl("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ query: PLAN_QUERY, variables: { id: agentSessionId } }),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as PlanQueryResponse;
      if (json.errors) return null;
      const nodes = json.data?.agentSession?.activities?.nodes ?? [];
      const bodies = nodes
        .filter((n) => n.content?.__typename === "AgentActivityElicitationContent")
        .map((n) => n.content?.body ?? "")
        .filter((body) => body.includes(APPROVAL_FOOTER));
      if (bodies.length === 0) return null;
      const last = bodies[bodies.length - 1];
      const stripped = last.slice(0, last.lastIndexOf(APPROVAL_FOOTER)).trim();
      return stripped || null;
    } catch {
      return null;
    }
  };
}
