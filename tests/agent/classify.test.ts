import { describe, it, expect, vi } from "vitest";
import { classifyIntent, pickWorkflowState } from "../../src/agent/classify.ts";

function textResponse(text: string): Response {
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("classifyIntent", () => {
  it("returns chat when the model says chat", async () => {
    const fetchImpl = vi.fn(async () => textResponse("chat"));
    const result = await classifyIntent("key", "explain this function", fetchImpl as unknown as typeof fetch);
    expect(result).toBe("chat");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers).toMatchObject({ "x-api-key": "key" });
    const body = JSON.parse(init.body as string);
    expect(body.model).toMatch(/haiku/);
  });

  it("returns change when the model says change", async () => {
    const fetchImpl = vi.fn(async () => textResponse("change"));
    expect(await classifyIntent("key", "add a rate limiter", fetchImpl as unknown as typeof fetch)).toBe("change");
  });

  it("defaults to change on any failure (safer fallback than silently skipping work)", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 }));
    expect(await classifyIntent("key", "text", fetchImpl as unknown as typeof fetch)).toBe("change");
  });

  it("defaults to change when fetch throws", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("network"); });
    expect(await classifyIntent("key", "text", fetchImpl as unknown as typeof fetch)).toBe("change");
  });
});

describe("pickWorkflowState", () => {
  it("returns the candidate the model names", async () => {
    const fetchImpl = vi.fn(async () => textResponse("In Review"));
    const result = await pickWorkflowState(
      "key", "PR opened for review", ["In Progress", "In Review"], fetchImpl as unknown as typeof fetch,
    );
    expect(result).toBe("In Review");
  });

  it("falls back to the first candidate if the model's answer doesn't match any", async () => {
    const fetchImpl = vi.fn(async () => textResponse("Something else entirely"));
    const result = await pickWorkflowState(
      "key", "PR opened for review", ["In Progress", "In Review"], fetchImpl as unknown as typeof fetch,
    );
    expect(result).toBe("In Progress");
  });

  it("falls back to the first candidate on failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 }));
    const result = await pickWorkflowState("key", "x", ["A", "B"], fetchImpl as unknown as typeof fetch);
    expect(result).toBe("A");
  });
});
