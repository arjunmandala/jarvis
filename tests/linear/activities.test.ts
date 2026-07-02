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

describe("makeActivities retry (terminal activities)", () => {
  function flakyClient(failCount: number) {
    const calls: any[] = [];
    let attempts = 0;
    return {
      calls,
      createAgentActivity: vi.fn(async (input: any) => {
        calls.push(input);
        attempts++;
        if (attempts <= failCount) throw new Error(`fail ${attempts}`);
        return { success: true };
      }),
    };
  }

  it("response retries on failure and resolves after eventual success (3 calls made)", async () => {
    const c = flakyClient(2);
    const sleep = vi.fn(async () => undefined);
    const a = makeActivities(c as any, "as_r", sleep);
    await a.response("done");
    expect(c.calls.length).toBe(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 1000);
    expect(sleep).toHaveBeenNthCalledWith(2, 5000);
  });

  it("response rejects after 3 attempts when failing persistently", async () => {
    const c = flakyClient(Infinity);
    const sleep = vi.fn(async () => undefined);
    const a = makeActivities(c as any, "as_r2", sleep);
    await expect(a.response("done")).rejects.toThrow("fail 3");
    expect(c.calls.length).toBe(3);
  });

  it("error retries like response", async () => {
    const c = flakyClient(2);
    const sleep = vi.fn(async () => undefined);
    const a = makeActivities(c as any, "as_e", sleep);
    await a.error("boom");
    expect(c.calls.length).toBe(3);
  });

  it("elicitation retries like response", async () => {
    const c = flakyClient(2);
    const sleep = vi.fn(async () => undefined);
    const a = makeActivities(c as any, "as_el", sleep);
    await a.elicitation("approve?");
    expect(c.calls.length).toBe(3);
  });

  it("action does not retry (one-shot, rejects immediately)", async () => {
    const c = flakyClient(1);
    const sleep = vi.fn(async () => undefined);
    const a = makeActivities(c as any, "as_a", sleep);
    await expect(a.action("Searched", "query")).rejects.toThrow("fail 1");
    expect(c.calls.length).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("thought does not retry (one-shot, rejects immediately)", async () => {
    const c = flakyClient(1);
    const sleep = vi.fn(async () => undefined);
    const a = makeActivities(c as any, "as_t", sleep);
    await expect(a.thought("thinking")).rejects.toThrow("fail 1");
    expect(c.calls.length).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
