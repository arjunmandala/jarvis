import { describe, it, expect } from "vitest";
import { planTask, implementTask, mapTask } from "../../src/agent/tasks.ts";
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

  it("keeps plan size proportional to the issue", () => {
    const t = planTask(ctx);
    expect(t.systemAppend).toMatch(/proportional/i);
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

  it("scales effort to change size and ends with a deterministic PR URL", () => {
    const t = implementTask(ctx, "## Plan");
    expect(t.systemAppend).toMatch(/gh pr view --json url/);
    expect(t.systemAppend).toMatch(/do not dispatch subagents/i);
    expect(t.systemAppend).toMatch(/gh auth login/);
  });

  it("injects the repo map into the goal when provided", () => {
    const t = implementTask(ctx, "## Plan", "MAP");
    expect(t.goal).toContain("MAP");
    expect(t.goal).toMatch(/Repository map/);
  });

  it("is byte-identical to the no-map goal when repoMap is absent", () => {
    const withMap = implementTask(ctx, "## Plan");
    const withoutMap = implementTask(ctx, "## Plan", undefined);
    expect(withMap.goal).toBe(withoutMap.goal);
    expect(withMap.goal).not.toMatch(/Repository map/);
  });
});

describe("planTask repo map injection", () => {
  it("injects the repo map into the goal when provided", () => {
    const t = planTask(ctx, "MAP");
    expect(t.goal).toContain("MAP");
    expect(t.goal).toMatch(/Repository map/);
  });

  it("is byte-identical to previous behavior when repoMap is absent", () => {
    const withoutArg = planTask(ctx);
    const withUndefined = planTask(ctx, undefined);
    expect(withoutArg.goal).toBe(withUndefined.goal);
    expect(withoutArg.goal).not.toMatch(/Repository map/);
  });
});

describe("mapTask", () => {
  it("is read-only, uses the default model, and targets the repo cwd", () => {
    const t = mapTask();
    expect(t.model).toBe("claude-sonnet-5");
    expect(t.allowedTools).toEqual(expect.arrayContaining(["Read", "Glob", "Grep"]));
    expect(t.allowedTools).not.toContain("Write");
    expect(t.allowedTools).not.toContain("Edit");
    expect(t.allowedTools).not.toContain("Bash");
    expect(t.cwd).toBe("/home/user/repo");
    expect(t.goal).toMatch(/map/i);
    expect(t.maxTurns).toBe(30);
    expect(t.maxBudgetUsd).toBe(1);
  });
});
