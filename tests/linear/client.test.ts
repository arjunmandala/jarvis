import { describe, it, expect, vi } from "vitest";
import { makePlanFetcher } from "../../src/linear/client.ts";
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
});
