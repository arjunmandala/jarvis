import { describe, it, expect, vi } from "vitest";
import { fetchTeamStates, resolveTargetState } from "../../src/linear/workflow.ts";
import { SessionStore } from "../../src/store/sessions.ts";

describe("fetchTeamStates", () => {
  it("fetches and caches on first call", async () => {
    const store = new SessionStore(":memory:");
    const nodes = [{ id: "s1", name: "Todo", type: "unstarted" }];
    const client = { workflowStates: vi.fn(async () => ({ nodes })) };
    const result = await fetchTeamStates(client as never, store, "team_1");
    expect(result).toEqual(nodes);
    expect(client.workflowStates).toHaveBeenCalledTimes(1);
    store.close();
  });

  it("uses the cache on the second call, no second fetch", async () => {
    const store = new SessionStore(":memory:");
    const nodes = [{ id: "s1", name: "Todo", type: "unstarted" }];
    const client = { workflowStates: vi.fn(async () => ({ nodes })) };
    await fetchTeamStates(client as never, store, "team_1");
    await fetchTeamStates(client as never, store, "team_1");
    expect(client.workflowStates).toHaveBeenCalledTimes(1);
    store.close();
  });

  it("returns an empty array on failure, never throws", async () => {
    const store = new SessionStore(":memory:");
    const client = { workflowStates: vi.fn(async () => { throw new Error("boom"); }) };
    expect(await fetchTeamStates(client as never, store, "team_1")).toEqual([]);
    store.close();
  });
});

describe("resolveTargetState", () => {
  const states = [
    { id: "s1", name: "Todo", type: "unstarted" },
    { id: "s2", name: "In Progress", type: "started" },
    { id: "s3", name: "In Review", type: "started" },
    { id: "s4", name: "Done", type: "completed" },
  ];

  it("returns undefined when no state matches the category", async () => {
    const noCompleted = states.filter((s) => s.type !== "completed");
    expect(await resolveTargetState("key", noCompleted, "done")).toBeUndefined();
  });

  it("returns the single match directly, no fetch call", async () => {
    const fetchImpl = vi.fn();
    const result = await resolveTargetState("key", states, "done", fetchImpl as unknown as typeof fetch);
    expect(result).toBe("s4");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("prefers a review-named state for pr_opened without calling the model", async () => {
    const fetchImpl = vi.fn();
    const result = await resolveTargetState("key", states, "pr_opened", fetchImpl as unknown as typeof fetch);
    expect(result).toBe("s3");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("disambiguates plan_start among 2+ started states via the classifier", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: "In Progress" }] }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    );
    const result = await resolveTargetState("key", states, "plan_start", fetchImpl as unknown as typeof fetch);
    expect(result).toBe("s2");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
