import { describe, it, expect } from "vitest";
import { planTask, implementTask } from "../../src/agent/tasks.ts";
import type { IssueContext } from "../../src/linear/context.ts";

const ctx: IssueContext = {
  agentSessionId: "as_1", organizationId: "org_1", issueId: "iss_1",
  title: "Add /health", description: "return {ok:true}", comment: "", promptContext: "<x/>",
};

describe("planTask", () => {
  it("is read-only and uses the default model", () => {
    const t = planTask(ctx);
    expect(t.model).toBe("claude-sonnet-5");
    expect(t.allowedTools).toEqual(expect.arrayContaining(["Read", "Glob", "Grep", "Skill"]));
    expect(t.allowedTools).not.toContain("Write");
    expect(t.allowedTools).not.toContain("Edit");
    expect(t.allowedTools).not.toContain("Bash");
    expect(t.goal).toContain("Add /health");
    expect(t.cwd).toBe("/home/user/repo");
  });
});

describe("implementTask", () => {
  it("uses opus for the hard task and full tools, includes the plan", () => {
    const t = implementTask(ctx, "## Plan\n- step");
    expect(t.model).toBe("claude-opus-4-8");
    expect(t.allowedTools).toEqual(expect.arrayContaining(["Bash", "Edit", "Write", "Read", "Skill", "Agent"]));
    expect(t.goal).toContain("## Plan");
    expect(t.goal).toMatch(/gh pr create/);
  });

  it("directs explicit verification before the PR", () => {
    const t = implementTask(ctx, "## Plan");
    expect(t.systemAppend).toMatch(/tests/i);
    expect(t.systemAppend).toMatch(/lint/i);
    expect(t.systemAppend).toMatch(/curl/i);
    expect(t.systemAppend).toMatch(/verification-before-completion/);
  });
});
