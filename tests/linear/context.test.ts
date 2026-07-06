import { describe, it, expect } from "vitest";
import {
  extractContext,
  promptedBody,
  parseStop,
  isValidBranchName,
} from "../../src/linear/context.ts";

describe("extractContext", () => {
  it("pulls issue + comment + promptContext", () => {
    const payload = {
      action: "created",
      organizationId: "org_1",
      agentSession: {
        id: "as_1",
        promptContext: "<issue>...</issue>",
        issue: { id: "iss_1", title: "Add /health", description: "return {ok:true}" },
        comment: { body: "please add it" },
      },
    };
    const ctx = extractContext(payload);
    expect(ctx).toEqual({
      agentSessionId: "as_1",
      organizationId: "org_1",
      issueId: "iss_1",
      teamId: null,
      title: "Add /health",
      description: "return {ok:true}",
      comment: "please add it",
      promptContext: "<issue>...</issue>",
    });
  });

  it("tolerates missing optional fields", () => {
    const ctx = extractContext({ agentSession: { id: "as_2" }, organizationId: "org_2" });
    expect(ctx.agentSessionId).toBe("as_2");
    expect(ctx.title).toBe("");
    expect(ctx.issueId).toBeNull();
  });

  it("pulls the team id when present", () => {
    const payload = {
      organizationId: "org_1",
      agentSession: {
        id: "as_1",
        issue: { id: "iss_1", title: "t", description: "d", team: { id: "team_1" } },
      },
    };
    const ctx = extractContext(payload);
    expect(ctx.teamId).toBe("team_1");
  });

  it("teamId is null when missing", () => {
    const ctx = extractContext({ agentSession: { id: "as_2" } });
    expect(ctx.teamId).toBeNull();
  });

  it("reads a nested issue.parent when the payload carries one", () => {
    const ctx = extractContext({
      organizationId: "org_1",
      agentSession: {
        id: "as_1",
        issue: {
          id: "iss_child",
          title: "child",
          description: "d",
          parent: { id: "iss_parent", title: "Epic", description: "the epic body" },
        },
      },
    });
    expect(ctx.parentId).toBe("iss_parent");
    expect(ctx.parentTitle).toBe("Epic");
    expect(ctx.parentDescription).toBe("the epic body");
  });

  it("leaves parent fields undefined for a top-level issue", () => {
    const ctx = extractContext({
      agentSession: { id: "as_1", issue: { id: "iss_1", title: "t", description: "d" } },
    });
    expect(ctx.parentId).toBeUndefined();
    expect(ctx.parentTitle).toBeUndefined();
    expect(ctx.parentDescription).toBeUndefined();
  });
});

describe("promptedBody", () => {
  it("reads agentActivity.content.body (real Linear shape)", () => {
    expect(promptedBody({ action: "prompted", agentActivity: { content: { type: "prompt", body: "approve" } } })).toBe("approve");
  });
  it("returns empty when there is no reply text", () => {
    expect(promptedBody({ action: "prompted", agentActivity: { content: {} } })).toBe("");
  });
  it("reads agentActivity.body", () => {
    expect(promptedBody({ action: "prompted", agentActivity: { body: "approve" } })).toBe("approve");
  });
});

describe("parseStop", () => {
  it.each(["stop", "STOP", "cancel this", "abort", "never mind", "nevermind"])(
    "treats %s as stop",
    (t) => expect(parseStop(t)).toBe(true),
  );
  it.each(["approve", "don't stop", "hold on", "change the approach"])(
    "treats %s as not-stop",
    (t) => expect(parseStop(t)).toBe(false),
  );
});


describe("isValidBranchName", () => {
  it.each(["main", "feature/foo", "release-1.2.0", "hotfix_123"])(
    "accepts %s",
    (n) => expect(isValidBranchName(n)).toBe(true),
  );
  it.each(["", "-flag", "has space", "a..b", "a/", "a;rm -rf /", "$(whoami)"])(
    "rejects %s",
    (n) => expect(isValidBranchName(n)).toBe(false),
  );
});
