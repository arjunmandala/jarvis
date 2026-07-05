import { LinearClient } from "@linear/sdk";
import { APPROVAL_FOOTER } from "./context.ts";

export function makeLinearClient(accessToken: string): LinearClient {
  // actor=app agents authenticate with the OAuth access token, NOT a personal apiKey.
  return new LinearClient({ accessToken });
}

// A live access token, either fixed (tests) or resolved per-request from the
// token manager (production, so a rotation is picked up without rebuilding the
// consumer).
export type TokenSource = string | (() => string);

function resolveToken(src: TokenSource): string {
  return typeof src === "function" ? src() : src;
}

// Attach a fresh Bearer token to `init` and call `fetchImpl`. On a 401, if an
// `onUnauthorized` hook is provided, refresh the token and retry once — the
// automatic-renewal safety margin means this should rarely be needed, but it
// closes the gap when a token is revoked early.
export async function fetchWithAuth(
  url: string,
  init: RequestInit,
  token: TokenSource,
  fetchImpl: typeof fetch,
  onUnauthorized?: () => Promise<string>,
): Promise<Response> {
  const withAuth = (t: string): RequestInit => ({
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${t}` },
  });
  const res = await fetchImpl(url, withAuth(resolveToken(token)));
  if (res.status === 401 && onUnauthorized) {
    const fresh = await onUnauthorized();
    return fetchImpl(url, withAuth(fresh));
  }
  return res;
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
  token: TokenSource,
  fetchImpl: typeof fetch = fetch,
  onUnauthorized?: () => Promise<string>,
): (agentSessionId: string) => Promise<string | null> {
  return async (agentSessionId: string): Promise<string | null> => {
    try {
      const res = await fetchWithAuth(
        "https://api.linear.app/graphql",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: PLAN_QUERY, variables: { id: agentSessionId } }),
        },
        token,
        fetchImpl,
        onUnauthorized,
      );
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

const THREAD_QUERY = `query($id: String!) { agentSession(id: $id) { activities(first: 250) { nodes { content { __typename ... on AgentActivityPromptContent { body } ... on AgentActivityResponseContent { body } ... on AgentActivityErrorContent { body } ... on AgentActivityElicitationContent { body } } } } } }`;

// Visible-thread speakers only. thought/action are telemetry noise — the raw
// run logs exported into the sandbox cover "what did the agent actually do".
const THREAD_LABELS: Record<string, string> = {
  AgentActivityPromptContent: "Human",
  AgentActivityResponseContent: "Jarvis",
  AgentActivityErrorContent: "Jarvis (error)",
  AgentActivityElicitationContent: "Jarvis (plan/question)",
};

interface ThreadQueryResponse {
  data?: {
    agentSession?: {
      activities?: { nodes?: ElicitationNode[] } | null;
    } | null;
  } | null;
  errors?: unknown;
}

/**
 * Fetch one agent session's visible conversation from Linear as Markdown —
 * the "session memory" thread injected into later runs on the same issue.
 * Same failure contract as makePlanFetcher: null on any error (advisory).
 * ponytail: first 250 activities, no pagination — a session that big has
 * bigger problems; add cursor paging if one ever hits the cap.
 */
export function makeThreadFetcher(
  token: TokenSource,
  fetchImpl: typeof fetch = fetch,
  onUnauthorized?: () => Promise<string>,
): (agentSessionId: string) => Promise<string | null> {
  return async (agentSessionId: string): Promise<string | null> => {
    try {
      const res = await fetchWithAuth(
        "https://api.linear.app/graphql",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: THREAD_QUERY, variables: { id: agentSessionId } }),
        },
        token,
        fetchImpl,
        onUnauthorized,
      );
      if (!res.ok) return null;
      const json = (await res.json()) as ThreadQueryResponse;
      if (json.errors) return null;
      const nodes = json.data?.agentSession?.activities?.nodes ?? [];
      const blocks = nodes
        .map((n) => {
          const label = n.content?.__typename ? THREAD_LABELS[n.content.__typename] : undefined;
          const body = n.content?.body?.trim();
          return label && body ? `**${label}:** ${body}` : null;
        })
        .filter((b): b is string => b !== null);
      return blocks.length > 0 ? blocks.join("\n\n") : null;
    } catch {
      return null;
    }
  };
}
