import { describe, it, expect, vi } from "vitest";
import { makeActivities } from "../../src/linear/activities.ts";

function fakeClient() {
  const calls: any[] = [];
  return {
    calls,
    createAgentActivity: vi.fn(async (input: any) => { calls.push(input); return { success: true }; }),
  };
}

describe("makeActivities", () => {
  it("builds the verified content shapes", async () => {
    const c = fakeClient();
    const a = makeActivities(c as any, "as_1");
    await a.thought("thinking");
    await a.action("Searched", "query", "result md");
    await a.response("done");
    await a.error("boom");
    await a.elicitation("approve?");

    expect(c.calls[0]).toEqual({ agentSessionId: "as_1", content: { type: "thought", body: "thinking" } });
    expect(c.calls[1]).toEqual({ agentSessionId: "as_1", content: { type: "action", action: "Searched", parameter: "query", result: "result md" } });
    expect(c.calls[2]).toEqual({ agentSessionId: "as_1", content: { type: "response", body: "done" } });
    expect(c.calls[3]).toEqual({ agentSessionId: "as_1", content: { type: "error", body: "boom" } });
    expect(c.calls[4]).toEqual({ agentSessionId: "as_1", content: { type: "elicitation", body: "approve?" } });
  });

  it("defaults parameter to the action label when not provided (Linear requires a non-empty parameter)", async () => {
    const c = fakeClient();
    await makeActivities(c as any, "as_2").action("Searching");
    expect(c.calls[0].content).toEqual({ type: "action", action: "Searching", parameter: "Searching" });
  });
});
