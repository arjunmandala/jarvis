import { describe, it, expect, vi } from "vitest";
import { makePlanFetcher, makeThreadFetcher } from "../../src/linear/client.ts";
import { APPROVAL_FOOTER } from "../../src/linear/context.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function elicitationNode(body: string) {
  return { content: { __typename: "AgentActivityElicitationContent", body } };
}

describe("makePlanFetcher", () => {
  it("returns the plan text with the footer stripped (happy path)", async () => {
    const plan = "Do the thing.";
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: { agentSession: { activities: { nodes: [elicitationNode(`${plan}${APPROVAL_FOOTER}`)] } } },
      }),
    );
    const fetchPlan = makePlanFetcher("token-123", fetchImpl as unknown as typeof fetch);
    const result = await fetchPlan("as_1");
    expect(result).toBe(plan);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe("https://api.linear.app/graphql");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authorization: "Bearer token-123" });
    const body = JSON.parse(init.body as string);
    expect(body.variables).toEqual({ id: "as_1" });
    expect(body.query).toContain("agentSession(id: $id)");
  });

  it("picks the last elicitation whose body contains the footer, ignoring re-elicitations without it", async () => {
    const plan = "Second plan version.";
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: {
          agentSession: {
            activities: {
              nodes: [
                elicitationNode(`First plan.${APPROVAL_FOOTER}`),
                elicitationNode("Understood — not implementing yet. Reply 'approve' when ready, or 'stop' to cancel."),
                elicitationNode(`${plan}${APPROVAL_FOOTER}`),
              ],
            },
          },
        },
      }),
    );
    const fetchPlan = makePlanFetcher("token-123", fetchImpl as unknown as typeof fetch);
    const result = await fetchPlan("as_2");
    expect(result).toBe(plan);
  });

  it("returns null when there are no sessions/activities", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { agentSession: null } }));
    const fetchPlan = makePlanFetcher("token-123", fetchImpl as unknown as typeof fetch);
    expect(await fetchPlan("missing")).toBeNull();
  });

  it("returns null on HTTP failure", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ errors: ["boom"] }, 500));
    const fetchPlan = makePlanFetcher("token-123", fetchImpl as unknown as typeof fetch);
    expect(await fetchPlan("as_3")).toBeNull();
  });

  it("returns null on GraphQL errors", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ errors: [{ message: "bad query" }] }));
    const fetchPlan = makePlanFetcher("token-123", fetchImpl as unknown as typeof fetch);
    expect(await fetchPlan("as_4")).toBeNull();
  });

  it("returns null when no elicitation body contains the footer", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: { agentSession: { activities: { nodes: [elicitationNode("no footer here")] } } },
      }),
    );
    const fetchPlan = makePlanFetcher("token-123", fetchImpl as unknown as typeof fetch);
    expect(await fetchPlan("as_5")).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const fetchPlan = makePlanFetcher("token-123", fetchImpl as unknown as typeof fetch);
    expect(await fetchPlan("as_6")).toBeNull();
  });

  it("on a 401, refreshes the token and retries once with the fresh one", async () => {
    const plan = "Recovered after refresh.";
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ errors: ["unauthorized"] }, 401))
      .mockResolvedValueOnce(
        jsonResponse({ data: { agentSession: { activities: { nodes: [elicitationNode(`${plan}${APPROVAL_FOOTER}`)] } } } }),
      );
    const onUnauthorized = vi.fn(async () => "fresh-token");
    const fetchPlan = makePlanFetcher("stale-token", fetchImpl as unknown as typeof fetch, onUnauthorized);
    expect(await fetchPlan("as_401")).toBe(plan);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    const firstAuth = calls[0][1].headers as Record<string, string>;
    const retryAuth = calls[1][1].headers as Record<string, string>;
    expect(firstAuth.authorization).toBe("Bearer stale-token");
    expect(retryAuth.authorization).toBe("Bearer fresh-token");
  });

  it("accepts a token getter (live token source)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { agentSession: { activities: { nodes: [] } } } }),
    );
    const fetchPlan = makePlanFetcher(() => "getter-token", fetchImpl as unknown as typeof fetch);
    await fetchPlan("as_g");
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const auth = init.headers as Record<string, string>;
    expect(auth.authorization).toBe("Bearer getter-token");
  });
});

function contentNode(typename: string, body: string) {
  return { content: { __typename: typename, body } };
}

describe("makeThreadFetcher", () => {
  it("renders prompts and responses as a labelled Markdown thread, in order", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: {
          agentSession: {
            activities: {
              nodes: [
                contentNode("AgentActivityPromptContent", "please fix the login bug"),
                contentNode("AgentActivityThoughtContent", "internal musing — must be skipped"),
                contentNode("AgentActivityElicitationContent", "Type: bug\nScope: small\n1. fix it"),
                contentNode("AgentActivityPromptContent", "approve"),
                contentNode("AgentActivityErrorContent", "PR could not be opened: tests failed"),
                contentNode("AgentActivityResponseContent", "Done. PR opened."),
              ],
            },
          },
        },
      }),
    );
    const fetchThread = makeThreadFetcher("token-123", fetchImpl as unknown as typeof fetch);
    const thread = await fetchThread("as_t1");
    expect(thread).toBe(
      "**Human:** please fix the login bug\n\n" +
        "**Jarvis (plan/question):** Type: bug\nScope: small\n1. fix it\n\n" +
        "**Human:** approve\n\n" +
        "**Jarvis (error):** PR could not be opened: tests failed\n\n" +
        "**Jarvis:** Done. PR opened.",
    );
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("https://api.linear.app/graphql");
    expect(JSON.parse(call[1].body as string).variables).toEqual({ id: "as_t1" });
  });

  it("returns null when the session has no renderable activities", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: {
          agentSession: {
            activities: { nodes: [contentNode("AgentActivityThoughtContent", "only noise")] },
          },
        },
      }),
    );
    const fetchThread = makeThreadFetcher("token-123", fetchImpl as unknown as typeof fetch);
    expect(await fetchThread("as_t2")).toBeNull();
  });

  it("returns null on HTTP failure, GraphQL errors, missing session, and thrown fetch", async () => {
    const cases: Array<() => Promise<Response>> = [
      async () => jsonResponse({ data: {} }, 500),
      async () => jsonResponse({ errors: [{ message: "bad" }] }),
      async () => jsonResponse({ data: { agentSession: null } }),
      async () => { throw new Error("network down"); },
    ];
    for (const impl of cases) {
      const fetchThread = makeThreadFetcher("token-123", vi.fn(impl) as unknown as typeof fetch);
      expect(await fetchThread("as_t3")).toBeNull();
    }
  });
});
