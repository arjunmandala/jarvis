import { describe, it, expect } from "vitest";
import { extractContext, promptedBody, parseApproval } from "../../src/linear/context.ts";

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
  it("reads agentActivity.body", () => {
    expect(promptedBody({ action: "prompted", agentActivity: { body: "approve" } })).toBe("approve");
  });
});

describe("parseApproval", () => {
  it.each(["approve", "Approved!", "LGTM", "yes go ahead", "ship it", "looks good"])(
    "treats %s as approval", (t) => expect(parseApproval(t)).toBe(true),
  );
  it.each(["no", "please change the endpoint name", "not yet", "hold on"])(
    "treats %s as not-approval", (t) => expect(parseApproval(t)).toBe(false),
  );
});
