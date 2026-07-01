import type { IssueContext } from "../linear/context.ts";
import { REPO_DIR } from "../sandbox/session.ts";

export interface AgentTask {
  goal: string;
  cwd: string;
  model: string;
  systemAppend: string;
  allowedTools: string[];
  maxTurns: number;
  maxBudgetUsd: number;
}

const PLAN_APPEND =
  "You are Jarvis, an autonomous engineer working a Linear ticket. " +
  "Use the brainstorming and writing-plans skills. Explore the repo read-only to ground the plan in real files. " +
  "Your FINAL message must be the complete implementation plan in Markdown — that text is returned verbatim to the human for approval. " +
  "Do not write any files.";

const IMPLEMENT_APPEND =
  "You are Jarvis, an autonomous engineer. Use subagent-driven-development to implement the APPROVED plan, " +
  "test-driven-development while coding, systematic-debugging on any failure, and requesting-code-review before finishing. " +
  "Run the repo's tests and lint, start the app and curl the new behaviour to prove it works. " +
  "When green, create a branch, commit, push, and open a PR with `gh pr create --fill`. " +
  "Your FINAL message must be the PR URL.";

function issueBlock(ctx: IssueContext): string {
  return (
    `Linear issue: ${ctx.title}\n\n${ctx.description}\n\n` +
    (ctx.comment ? `Latest comment: ${ctx.comment}\n\n` : "") +
    (ctx.promptContext ? `Context:\n${ctx.promptContext}\n` : "")
  );
}

export function planTask(ctx: IssueContext): AgentTask {
  return {
    goal: `Produce an implementation plan for this issue.\n\n${issueBlock(ctx)}`,
    cwd: REPO_DIR,
    model: "claude-sonnet-5",
    systemAppend: PLAN_APPEND,
    allowedTools: ["Read", "Glob", "Grep", "Skill"],
    maxTurns: 40,
    maxBudgetUsd: 2,
  };
}

export function implementTask(ctx: IssueContext, approvedPlan: string): AgentTask {
  return {
    goal:
      `Implement the following APPROVED plan, then open a PR with \`gh pr create --fill\`.\n\n` +
      `${approvedPlan}\n\n---\nOriginal issue:\n${issueBlock(ctx)}`,
    cwd: REPO_DIR,
    model: "claude-opus-4-8", // hard task
    systemAppend: IMPLEMENT_APPEND,
    allowedTools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "Skill", "Agent"],
    maxTurns: 200,
    maxBudgetUsd: 8,
  };
}
