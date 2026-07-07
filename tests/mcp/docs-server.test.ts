import { describe, it, expect } from "vitest";
import { RunTokenRegistry } from "../../src/mcp/docs-server.ts";

describe("RunTokenRegistry", () => {
  it("mints unique tokens that resolve to their claims and revoke cleanly", () => {
    const reg = new RunTokenRegistry();
    const t1 = reg.mint({ agentSessionId: "A", issueId: "iss_1" });
    const t2 = reg.mint({ agentSessionId: "B", issueId: "iss_2" });
    expect(t1).not.toBe(t2);
    expect(reg.resolve(t1)).toEqual({ agentSessionId: "A", issueId: "iss_1" });
    reg.revoke(t1);
    expect(reg.resolve(t1)).toBeUndefined();
    expect(reg.resolve(t2)).toEqual({ agentSessionId: "B", issueId: "iss_2" });
    expect(reg.resolve("bogus")).toBeUndefined();
  });
});
