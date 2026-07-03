import { describe, it, expect } from "vitest";
import { extractContext, promptedBody, parseApproval, parseStop, isValidBranchName } from "../../src/linear/context.ts";

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

describe("parseApproval", () => {
  it.each([
    "approve",
    "Approved!",
    "LGTM",
    "yes go ahead",
    "ship it",
    "looks good",
    "approve, and dont use the llm because there is no env for you", // approve wins over trailing "dont"/"no"
    "approved — but keep the diff small",
  ])("treats %s as approval", (t) => expect(parseApproval(t)).toBe(true));
  it.each([
    "no",
    "please change the endpoint name",
    "not yet",
    "hold on",
    "do not approve this",
    "don't approve yet",
  ])("treats %s as not-approval", (t) => expect(parseApproval(t)).toBe(false));
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
