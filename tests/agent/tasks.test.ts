import { describe, it, expect } from "vitest";
import { planTask, implementTask, mapTask, reviseTask, reviewTask, chatTask, parseDecomposition } from "../../src/agent/tasks.ts";
import type { IssueContext } from "../../src/linear/context.ts";

const ctx: IssueContext = {
  agentSessionId: "as_1", organizationId: "org_1", issueId: "iss_1", teamId: "team_1",
  title: "Add /health", description: "return {ok:true}", comment: "", promptContext: "<x/>",
};

describe("planTask", () => {
  it("uses the default model and the shared tool set", () => {
    const t = planTask(ctx);
    expect(t.model).toBe("claude-sonnet-5");
    expect(t.allowedTools).toEqual(expect.arrayContaining(["Read", "Glob", "Grep", "Skill"]));
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

describe("implement work-branch durability", () => {
  it("pins the exact work branch, pushes incrementally, and dedupes the PR", () => {
    const t = implementTask(ctx, "Type: feature\nScope: large\n\n## Plan", undefined, "jarvis/iss_1");
    expect(t.goal).toContain("jarvis/iss_1");
    expect(t.goal).toMatch(/git checkout -B jarvis\/iss_1 origin\/jarvis\/iss_1/);
    expect(t.systemAppend).toMatch(/push .* after (each|every)/i);
    expect(t.systemAppend).toMatch(/already exists/i); // idempotent PR guidance
    expect(t.systemAppend).toMatch(/resume|continue/i); // resume-from-branch guidance
  });

  it("omits branch plumbing when no work branch is given (back-compat)", () => {
    const t = implementTask(ctx, "## Plan");
    expect(t.goal).not.toMatch(/git checkout -B/);
  });
});

describe("implement model routing (by plan Type/Scope)", () => {
  const small = "Type: feature\nScope: small\n\n## Plan\n- tweak the button";
  const large = "Type: feature\nScope: large\n\n## Plan\n- rework the dashboard";
  const refactorSmall = "Type: refactor\nScope: small\n\n## Plan\n- rename a helper";

  it("routes a small, unambiguous change to Sonnet 5 with a tighter budget", () => {
    const t = implementTask(ctx, small);
    expect(t.model).toBe("claude-sonnet-5");
    expect(t.maxBudgetUsd).toBe(3);
  });

  it("keeps large work on Opus 4.8", () => {
    const t = implementTask(ctx, large);
    expect(t.model).toBe("claude-opus-4-8");
    expect(t.maxBudgetUsd).toBe(8);
  });

  it("keeps every refactor on Opus even when scoped small (behaviour-preservation)", () => {
    expect(implementTask(ctx, refactorSmall).model).toBe("claude-opus-4-8");
  });

  it("defaults to Opus when the header is missing or garbled (no regression)", () => {
    expect(implementTask(ctx, "## Plan\n- no header").model).toBe("claude-opus-4-8");
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
    expect(t.maxTurns).toBe(20);
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
  agentSessionId: "a", organizationId: "o", issueId: "i", teamId: "team_1",
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

  it("has Bash for git (prompt-level read-only; tools are the shared permissive set)", () => {
    const t = reviewTask(ctxA, url, "the plan", null);
    expect(t.allowedTools).toContain("Bash");
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

describe("turn caps and unified tools", () => {
  it("caps turns lower now that runs are resumable", () => {
    expect(planTask(ctx).maxTurns).toBe(25);
    expect(reviewTask(ctx, "url", null, null).maxTurns).toBe(40);
    expect(mapTask().maxTurns).toBe(20);
    expect(implementTask(ctx, "## Plan").maxTurns).toBe(120);
  });

  it("plan, revise, implement and review share one permissive tool set", () => {
    const p = planTask(ctx).allowedTools;
    for (const t of [reviseTask(ctx, "p", "f"), implementTask(ctx, "p"), reviewTask(ctx, "u", null, null)]) {
      expect(t.allowedTools).toEqual(p);
    }
    expect(p).toEqual(expect.arrayContaining(["Read", "Glob", "Grep", "Bash", "Edit", "Write", "Agent", "Skill", "mcp__serena", "mcp__jarvis__ask_user"]));
  });
});

const hctx: IssueContext = {
  agentSessionId: "as_hist", organizationId: "org", issueId: "iss", teamId: "team_1",
  title: "t", description: "d", comment: "", promptContext: "",
};
const HISTORY = "Conversation from prior sessions on this issue (oldest first):\n\n**Human:** hi";

describe("history injection", () => {
  it("appends history to the goal of plan/revise/implement/review when provided", () => {
    expect(planTask(hctx, undefined, HISTORY).goal).toContain(HISTORY);
    expect(reviseTask(hctx, "old plan", "feedback", undefined, HISTORY).goal).toContain(HISTORY);
    expect(implementTask(hctx, "Type: chore\nScope: small\nplan", undefined, "jarvis/iss", HISTORY).goal).toContain(HISTORY);
    expect(reviewTask(hctx, "https://github.com/o/r/pull/1", null, null, undefined, HISTORY).goal).toContain(HISTORY);
  });

  it("omits the history section entirely when absent", () => {
    expect(planTask(hctx).goal).not.toContain("prior sessions");
    expect(reviewTask(hctx, "https://github.com/o/r/pull/1", null, null).goal).not.toContain("prior sessions");
  });

  it("never touches systemAppend (prompt-cache byte-stability)", () => {
    expect(planTask(hctx, undefined, HISTORY).systemAppend).toBe(planTask(hctx).systemAppend);
    expect(implementTask(hctx, "Type: chore\nScope: small\nplan", undefined, undefined, HISTORY).systemAppend)
      .toBe(implementTask(hctx, "Type: chore\nScope: small\nplan").systemAppend);
  });
});

describe("AgentTask.images", () => {
  it("planTask accepts an optional images array without altering goal text", () => {
    const images = [{ mediaType: "image/png", data: "abc123" }];
    const withImages = planTask(ctx, undefined, undefined, images);
    expect(withImages.images).toEqual(images);
    expect(withImages.goal).toBe(planTask(ctx).goal); // goal text is untouched by images
  });
});

describe("parseDecomposition", () => {
  it("parses a numbered Decomposition: list", () => {
    const text =
      "Decomposition:\n" +
      "1. Add the settings page — build the new /settings route and its form.\n" +
      "2. Wire the API — persist the settings server-side and validate input.\n";
    expect(parseDecomposition(text)).toEqual([
      { title: "Add the settings page", description: "build the new /settings route and its form." },
      { title: "Wire the API", description: "persist the settings server-side and validate input." },
    ]);
  });

  it("returns null for a normal Type:/Scope: plan", () => {
    expect(parseDecomposition("Type: feature\nScope: small\n\nDo the thing.")).toBeNull();
  });

  it("returns null when Decomposition: has no parseable items", () => {
    expect(parseDecomposition("Decomposition:\nsomething unstructured")).toBeNull();
  });

  it("tolerates leading whitespace before Decomposition:", () => {
    expect(parseDecomposition("  \nDecomposition:\n1. A — b.\n")).not.toBeNull();
  });
});

describe("chatTask", () => {
  it("is read-only: no Edit/Write/Bash", () => {
    const t = chatTask(ctx);
    expect(t.allowedTools).toEqual(expect.arrayContaining(["Read", "Glob", "Grep", "mcp__serena"]));
    expect(t.allowedTools).not.toContain("Edit");
    expect(t.allowedTools).not.toContain("Write");
    expect(t.allowedTools).not.toContain("Bash");
  });

  it("has a tighter turn/budget cap than planTask", () => {
    const t = chatTask(ctx);
    expect(t.maxTurns).toBeLessThan(25);
    expect(t.maxBudgetUsd).toBeLessThanOrEqual(1);
  });

  it("includes the issue in the goal and injects the repo map when provided", () => {
    const t = chatTask(ctx, "MAP");
    expect(t.goal).toContain(ctx.title);
    expect(t.goal).toContain("MAP");
  });

  it("tells the model its final message is posted verbatim as the answer", () => {
    const t = chatTask(ctx);
    expect(t.systemAppend).toMatch(/FINAL message/);
    expect(t.systemAppend).toMatch(/READ-ONLY/i);
  });
});
