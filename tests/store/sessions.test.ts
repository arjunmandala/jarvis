import { describe, it, expect, afterEach } from "vitest";
import { SessionStore } from "../../src/store/sessions.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it("stores and returns the sandbox id, including clearing back to null", () => {
    const s = new SessionStore(":memory:");
    s.upsert("as_4", "implement", "iss_4");
    expect(s.get("as_4")?.sandboxId).toBeNull();
    s.setSandbox("as_4", "sbx_1");
    expect(s.get("as_4")?.sandboxId).toBe("sbx_1");
    s.setSandbox("as_4", null);
    expect(s.get("as_4")?.sandboxId).toBeNull();
    s.close();
  });

  it("listByPhase returns only rows matching the given phases", () => {
    const s = new SessionStore(":memory:");
    s.upsert("as_p1", "plan");
    s.upsert("as_p2", "implement");
    s.upsert("as_p3", "clarify");
    s.upsert("as_p4", "plan");
    const rows = s.listByPhase("plan", "implement");
    expect(rows.map((r) => r.agentSessionId).sort()).toEqual(["as_p1", "as_p2", "as_p4"]);
    s.close();
  });

  describe("repo maps", () => {
    it("returns undefined when no map is stored for the repo", () => {
      const s = new SessionStore(":memory:");
      expect(s.getRepoMap("owner/repo")).toBeUndefined();
      s.close();
    });

    it("set then get roundtrips the map", () => {
      const s = new SessionStore(":memory:");
      s.setRepoMap("owner/repo", "# Map\n\n- src/foo.ts: does foo");
      expect(s.getRepoMap("owner/repo")).toBe("# Map\n\n- src/foo.ts: does foo");
      s.close();
    });

    it("upsert overwrites an existing map for the same repo", () => {
      const s = new SessionStore(":memory:");
      s.setRepoMap("owner/repo", "first map");
      s.setRepoMap("owner/repo", "second map");
      expect(s.getRepoMap("owner/repo")).toBe("second map");
      s.close();
    });
  });

  describe("migration", () => {
    let dir: string;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("opening a store twice on the same path does not throw", () => {
      dir = mkdtempSync(join(tmpdir(), "sessions-test-"));
      const path = join(dir, "sessions.db");
      const s1 = new SessionStore(path);
      s1.upsert("as_m1", "clarify");
      s1.close();

      let s2: SessionStore | undefined;
      expect(() => {
        s2 = new SessionStore(path);
      }).not.toThrow();
      expect(s2?.get("as_m1")?.phase).toBe("clarify");
      s2?.close();
    });
  });
});
