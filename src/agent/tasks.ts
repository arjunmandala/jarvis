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
  "Keep the plan proportional to the issue: a small fix gets a short plan — a handful of bullets naming the " +
  "exact files and changes, nothing more. Reach for the brainstorming and writing-plans skills only for " +
  "substantial features with real design ambiguity. " +
  "Explore the repo read-only to ground the plan in real files. " +
  "Your FINAL message must be the complete implementation plan in Markdown — that text is returned verbatim to the human for approval. " +
  "Do not write any files.";

const IMPLEMENT_APPEND =
  "You are Jarvis, an autonomous engineer implementing an APPROVED plan. First gauge the size of the plan " +
  "before choosing your process.\n\n" +
  "SMALL CHANGE (roughly: 2 or fewer files, no design ambiguity, plan is a few bullets): implement it " +
  "directly with a focused test proving the change. Do NOT dispatch subagents, do NOT re-plan or " +
  "brainstorm, do NOT run requesting-code-review, and do NOT start the app unless the VERIFICATION rule " +
  "below requires it — a passing focused test plus the repo's test suite is sufficient proof.\n\n" +
  "LARGER WORK: use subagent-driven-development and test-driven-development while coding, and " +
  "systematic-debugging on any failure. Then use requesting-code-review on the diff and fix what it finds " +
  "before opening the PR.\n\n" +
  "VERIFICATION (always, both sizes — verification-before-completion): run the repo's tests and lint; " +
  "loop until everything is green. Only start the app and curl the new behaviour when a test cannot prove " +
  "the change (e.g. user-visible or server behaviour that isn't exercised by the test suite).\n\n" +
  "Then create a branch, commit, and `git push origin <branch>` — origin's URL already has a working " +
  "credential embedded, so push directly and do not run `gh auth login` or `gh auth setup-git` " +
  "(that rewires git's credential helper and can break the push). Then open a PR with `gh pr create --fill` " +
  "(gh already reads GH_TOKEN from the environment; no separate gh auth step is needed).\n\n" +
  "DETERMINISTIC ENDING: after `gh pr create --fill`, run `gh pr view --json url -q .url` and make your " +
  "FINAL message EXACTLY that URL — one line, no prose, no markdown. If PR creation fails, your FINAL " +
  "message must instead start with `PR_FAILED:` followed by the reason.";

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
      `Implement the following APPROVED plan, push with \`git push origin <branch>\` (origin's URL already ` +
      `has your credential — no gh auth needed for the push), then open a PR with \`gh pr create --fill\`. ` +
      `After the PR is created, run \`gh pr view --json url -q .url\` and make your FINAL message EXACTLY ` +
      `that URL alone — no prose, no markdown. If PR creation fails, your FINAL message must instead start ` +
      `with \`PR_FAILED:\` followed by the reason.\n\n` +
      `${approvedPlan}\n\n---\nOriginal issue:\n${issueBlock(ctx)}`,
    cwd: REPO_DIR,
    model: "claude-opus-4-8", // hard task
    systemAppend: IMPLEMENT_APPEND,
    allowedTools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "Skill", "Agent"],
    maxTurns: 200,
    maxBudgetUsd: 8,
  };
}
