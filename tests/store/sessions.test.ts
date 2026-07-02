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

  it("stores and returns the plan text", () => {
    const s = new SessionStore(":memory:");
    s.upsert("as_3", "await_approval", "iss_3");
    expect(s.get("as_3")?.plan).toBeNull();
    s.setPlan("as_3", "1. do the thing\n2. test it");
    expect(s.get("as_3")?.plan).toBe("1. do the thing\n2. test it");
    s.close();
  });

  it("setPlan on unknown id is a no-op", () => {
    const s = new SessionStore(":memory:");
    s.setPlan("missing", "plan");
    expect(s.get("missing")).toBeUndefined();
    s.close();
  });
});
