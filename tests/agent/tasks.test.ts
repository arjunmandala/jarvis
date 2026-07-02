import { describe, it, expect } from "vitest";
import { planTask, implementTask, mapTask, reviseTask, reviewTask } from "../../src/agent/tasks.ts";
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

describe("reviseTask", () => {
  const previousPlan = "## Plan\n- do the thing";
  const feedback = "please use approach B instead";

  it("matches planTask's model/tools/budgets and reuses PLAN_APPEND byte-identically", () => {
    const t = reviseTask(ctx, previousPlan, feedback);
    const p = planTask(ctx);
    expect(t.model).toBe(p.model);
    expect(t.allowedTools).toEqual(p.allowedTools);
    expect(t.maxTurns).toBe(p.maxTurns);
    expect(t.maxBudgetUsd).toBe(p.maxBudgetUsd);
    expect(t.cwd).toBe(p.cwd);
    expect(t.systemAppend).toBe(p.systemAppend);
  });

  it("goal includes the feedback, the previous plan, and the issue title", () => {
    const t = reviseTask(ctx, previousPlan, feedback);
    expect(t.goal).toContain(feedback);
    expect(t.goal).toContain(previousPlan);
    expect(t.goal).toContain("Add /health");
  });

  it("injects the repo map into the goal when provided", () => {
    const t = reviseTask(ctx, previousPlan, feedback, "MAP");
    expect(t.goal).toContain("MAP");
    expect(t.goal).toMatch(/Repository map/);
  });

  it("goal without repoMap is stable and has no repo-map header", () => {
    const withoutArg = reviseTask(ctx, previousPlan, feedback);
    const withUndefined = reviseTask(ctx, previousPlan, feedback, undefined);
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

describe("conversational directives", () => {
  it("plan, revise and implement allow the ask_user tool; map does not", () => {
    expect(planTask(ctx).allowedTools).toContain("mcp__jarvis__ask_user");
    expect(reviseTask(ctx, "p", "f").allowedTools).toContain("mcp__jarvis__ask_user");
    expect(implementTask(ctx, "p").allowedTools).toContain("mcp__jarvis__ask_user");
    expect(mapTask().allowedTools).not.toContain("mcp__jarvis__ask_user");
  });

  it("plan and implement prompts explain steering and ask_user restraint", () => {
    for (const t of [planTask(ctx), implementTask(ctx, "p")]) {
      expect(t.systemAppend).toMatch(/ask_user/);
      expect(t.systemAppend).toMatch(/steer/i);
    }
  });
});

const ctxA: IssueContext = {
  agentSessionId: "a", organizationId: "o", issueId: "i",
  title: "Title A", description: "Desc A", comment: "", promptContext: "",
};
const ctxB: IssueContext = { ...ctxA, title: "Different title", description: "Different desc" };

describe("type-aware prompts", () => {
  it("plan append demands the Type: contract line", () => {
    expect(planTask(ctxA).systemAppend).toContain("Type:");
    expect(planTask(ctxA).systemAppend).toMatch(/bug/);
    expect(planTask(ctxA).systemAppend).toMatch(/refactor/);
  });

  it("appends are byte-stable across different issues (prompt-cache invariant)", () => {
    expect(planTask(ctxA).systemAppend).toBe(planTask(ctxB).systemAppend);
    expect(implementTask(ctxA, "plan").systemAppend).toBe(implementTask(ctxB, "other plan").systemAppend);
    expect(planTask(ctxA).systemAppend).not.toContain("Title A");
  });
});

describe("tool allowlists", () => {
  it("plan and revise get Bash + web + serena", () => {
    for (const t of [planTask(ctxA), reviseTask(ctxA, "p", "f")]) {
      expect(t.allowedTools).toContain("Bash");
      expect(t.allowedTools).toContain("WebSearch");
      expect(t.allowedTools).toContain("WebFetch");
      expect(t.allowedTools).toContain("mcp__serena");
    }
  });

  it("implement gets web + serena", () => {
    const t = implementTask(ctxA, "p");
    expect(t.allowedTools).toContain("WebSearch");
    expect(t.allowedTools).toContain("WebFetch");
    expect(t.allowedTools).toContain("mcp__serena");
  });
});

describe("reviewTask", () => {
  const url = "https://github.com/o/r/pull/9";

  it("is read-only: no Edit/Write, has Bash for git", () => {
    const t = reviewTask(ctxA, url, "the plan", null);
    expect(t.allowedTools).toContain("Bash");
    expect(t.allowedTools).not.toContain("Edit");
    expect(t.allowedTools).not.toContain("Write");
  });

  it("puts per-run content in goal, keeps append byte-stable", () => {
    const a = reviewTask(ctxA, url, "plan text", "please check error handling");
    const b = reviewTask(ctxB, "https://github.com/o/r/pull/10", null, null);
    expect(a.goal).toContain(url);
    expect(a.goal).toContain("plan text");
    expect(a.goal).toContain("please check error handling");
    expect(a.systemAppend).toBe(b.systemAppend);
  });

  it("uses sonnet and instructs report-only", () => {
    const t = reviewTask(ctxA, url, null, null);
    expect(t.model).toBe("claude-sonnet-5");
    expect(t.systemAppend).toContain("Report only");
  });
});
