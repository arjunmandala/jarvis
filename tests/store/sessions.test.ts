import { describe, it, expect } from "vitest";
import { SessionStore } from "../../src/store/sessions.ts";

describe("SessionStore", () => {
  it("upserts and reads phase", () => {
    const s = new SessionStore(":memory:");
    s.upsert("as_1", "clarify", "iss_1");
    expect(s.get("as_1")?.phase).toBe("clarify");
    expect(s.get("as_1")?.issueId).toBe("iss_1");
    s.setPhase("as_1", "plan");
    expect(s.get("as_1")?.phase).toBe("plan");
    s.close();
  });

  it("returns undefined for unknown ids", () => {
    const s = new SessionStore(":memory:");
    expect(s.get("missing")).toBeUndefined();
    s.close();
  });

  it("upsert is idempotent on the same id", () => {
    const s = new SessionStore(":memory:");
    s.upsert("as_2", "clarify");
    s.upsert("as_2", "implement");
    expect(s.get("as_2")?.phase).toBe("implement");
    s.close();
  });
});
