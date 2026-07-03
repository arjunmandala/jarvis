import type { Config } from "../config.ts";
import type { SessionStore, Phase, SessionRow } from "../store/sessions.ts";
import type { Activities } from "../linear/activities.ts";
import type { IssueContext } from "../linear/context.ts";
import { APPROVAL_FOOTER, isValidBranchName } from "../linear/context.ts";
import { withSandbox, cloneRepo, runAgent, watchDetached, injectMessage, runCommand, REPO_DIR, type AgentSandbox } from "../sandbox/session.ts";
import { Sandbox } from "e2b";
import { planTask, implementTask, mapTask, reviseTask, reviewTask } from "../agent/tasks.ts";
import type { AgentTask } from "../agent/tasks.ts";
import type { JarvisEvent } from "../agent/events.ts";

// Phase 4.1: surface the run's dollar cost inline in the Linear activity when
// the result carries one; omitted (not "$n/a") when unknown.
export function costLine(result: JarvisEvent | null): string {
  if (result?.kind !== "result" || result.costUsd == null) return "";
  return `\n\n_Cost: $${result.costUsd.toFixed(4)}_`;
}

// A PR URL is a single-line http(s) URL. Anything else — notably a markdown
// review report that a self-review run wrote over RESULT_FILE — must never be
// stored as pr_url or announced as the PR.
export const PR_URL_RE = /^https?:\/\/\S+$/;

// Self-review trigger: a diff bigger than either bound gets an automatic
// review pass before the PR is announced. Deterministic, no model call.
export const REVIEW_MAX_FILES = 5;
export const REVIEW_MAX_LINES = 200;

// Parses `git diff --shortstat` output, e.g.
// " 12 files changed, 340 insertions(+), 12 deletions(-)".
// Unparseable input returns false — no review rather than a spurious one.
export function diffExceedsThreshold(shortstat: string): boolean {
  const files = Number(/(\d+) files? changed/.exec(shortstat)?.[1] ?? 0);
  const insertions = Number(/(\d+) insertions?\(\+\)/.exec(shortstat)?.[1] ?? 0);
  const deletions = Number(/(\d+) deletions?\(-\)/.exec(shortstat)?.[1] ?? 0);
  return files > REVIEW_MAX_FILES || insertions + deletions > REVIEW_MAX_LINES;
}

export function nextPhase(current: Phase, approved: boolean): Phase {
  switch (current) {
    case "clarify": return "plan";
    case "plan": return "await_approval";
    case "await_approval": return approved ? "implement" : "await_approval";
    case "implement": return "done";
    default: return current;
  }
}

// A readable, non-empty detail for an agent tool_use — Linear action activities
// require a `parameter`. Prefer the most descriptive field per tool, else the
// stringified input; caller falls back to the tool name if this is empty.
export function toolParameter(input: unknown): string {
  const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  for (const key of ["command", "file_path", "path", "pattern", "query", "skill", "url", "description"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  const json = JSON.stringify(input);
  return json && json !== "{}" && json !== "null" ? json.slice(0, 200) : "";
}

// Extracted so it can be unit-tested without entering withSandbox/e2b: fetches
// a missing plan via `fetchPlan`, persists it, and returns it — or null if
// there's nothing to recover. Used by onPrompted before the missing-plan
// error path.
export async function recoverPlan(
  store: Pick<SessionStore, "setPlan">,
  agentSessionId: string,
  fetchPlan: ((id: string) => Promise<string | null>) | undefined,
): Promise<string | null> {
  if (!fetchPlan) return null;
  const recovered = await fetchPlan(agentSessionId);
  if (!recovered || !recovered.trim()) return null;
  console.log(`[recover] ${agentSessionId} recovered plan from Linear (${recovered.length} chars)`);
  store.setPlan(agentSessionId, recovered);
  return recovered;
}

// A connected sandbox we can watch and then kill — the seam reconcile() needs.
type Reconnected = AgentSandbox & { kill(): Promise<unknown> };

export class Orchestrator {
  #config: Config;
  #store: SessionStore;
  #makeActs: (agentSessionId: string) => Activities;
  #fetchPlan?: (agentSessionId: string) => Promise<string | null>;
  #connect: (sandboxId: string) => Promise<Reconnected>;
  // Live runs: comments arriving while a run executes are injected into its
  // sandbox (steering). In-memory like the server's inflight set — a restart
  // loses steering ability for that run, which reconcile already fails/recovers.
  #live = new Map<string, { sbx: AgentSandbox; kill: () => Promise<unknown>; replyPending: boolean; runId: number | null }>();

  hasLive(agentSessionId: string): boolean {
    return this.#live.has(agentSessionId);
  }

  constructor(
    config: Config,
    store: SessionStore,
    makeActs: (agentSessionId: string) => Activities,
    fetchPlan?: (agentSessionId: string) => Promise<string | null>,
    connect?: (sandboxId: string) => Promise<Reconnected>,
  ) {
    this.#config = config;
    this.#store = store;
    this.#makeActs = makeActs;
    this.#fetchPlan = fetchPlan;
    // Default: a real e2b reconnect. Tests inject a fake so nothing touches e2b/network.
    this.#connect =
      connect ??
      ((sandboxId) => Sandbox.connect(sandboxId, { apiKey: this.#config.e2bApiKey }) as Promise<Reconnected>);
  }

  #sbxCfg() {
    return {
      apiKey: this.#config.e2bApiKey, template: this.#config.e2bTemplate,
      ghToken: this.#config.ghToken, targetRepo: this.#config.targetRepo,
    };
  }

  // Deterministic per-issue work branch so a resumed run finds the pushed commits.
  // ponytail: slug of the Linear issue id; falls back to the session id if the
  // issue id is missing or produces an invalid ref. Upgrade to the human-readable
  // issue identifier (ENG-123) if the webhook payload ever carries it.
  #workBranchFor(issueId: string | null, agentSessionId: string): string {
    const seed = (issueId ?? agentSessionId).replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
    const candidate = `jarvis/${seed || agentSessionId}`;
    return isValidBranchName(candidate) ? candidate : `jarvis/${agentSessionId}`;
  }

  #record(runId: number | null, e: JarvisEvent): void {
    if (runId == null) return;
    try {
      this.#store.addRunEvent(runId, e.kind, e);
    } catch (err) {
      console.error(`[telemetry] addRunEvent failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  #logUsage(label: string, result: JarvisEvent | null, runId?: number | null): void {
    if (result?.kind === "result") {
      const u = result.usage ?? {};
      const inTok = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      const cost = result.costUsd != null ? `$${result.costUsd.toFixed(4)}` : "n/a";
      console.log(
        `[cost] ${label} ${result.subtype} — cost=${cost} turns=${result.numTurns ?? "?"} ` +
          `tokens in=${inTok} (cache_read=${u.cache_read_input_tokens ?? 0}) out=${u.output_tokens ?? 0}`,
      );
    }
    if (runId == null) return;
    try {
      const outcome =
        result == null ? "no_result"
        : result.kind === "error" ? "error"
        : result.kind !== "result" ? "no_result"
        : result.text?.trim().startsWith("PR_FAILED:") ? "pr_failed"
        : result.subtype;
      const u = result?.kind === "result" ? result.usage ?? {} : {};
      this.#store.finishRun(runId, {
        outcome,
        costUsd: result?.kind === "result" ? result.costUsd : null,
        numTurns: result?.kind === "result" ? (result.numTurns ?? null) : null,
        tokensIn: u.input_tokens ?? 0, // uncached input; cache tokens tracked separately below
        tokensOut: u.output_tokens ?? 0,
        tokensCacheRead: u.cache_read_input_tokens ?? 0,
        tokensCacheWrite: u.cache_creation_input_tokens ?? 0,
        error: result?.kind === "error" ? result.message : null,
      });
    } catch (err) {
      console.error(`[telemetry] finishRun failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  #relay(acts: Activities, sessionId: string, runId: number | null) {
    return async (e: JarvisEvent) => {
      this.#record(runId, e);
      try {
        if (e.kind === "tool_use") {
          const param = toolParameter(e.input) || String(e.name);
          console.log(`[agent] tool_use ${e.name} → ${param.slice(0, 120)}`);
          // Linear requires action activities to carry a non-empty `parameter`.
          await acts.action(String(e.name), param);
        } else if (e.kind === "ask_user") {
          console.log(`[agent] ask_user: ${e.question.slice(0, 120)}`);
          const live = this.#live.get(sessionId);
          if (live) live.replyPending = true;
          await acts.elicitation(
            `**Jarvis asks:**\n\n${e.question}\n\n_Reply within 10 minutes — after that I proceed on my best judgment._`,
          );
        } else if (e.kind === "error") {
          console.error(`[agent] error: ${e.message}`);
          await acts.error(e.message);
        } else if (e.kind === "assistant_text") {
          console.log(`[agent] text: ${e.text.slice(0, 120).replace(/\n/g, " ")}`);
          // Normally not posted per-block (too noisy) — but the first text after
          // a steering message or ask_user answer is the agent's reply: post it.
          const live = this.#live.get(sessionId);
          if (live?.replyPending && e.text.trim()) {
            live.replyPending = false;
            await acts.response(e.text);
          }
        }
        // tool_result is recorded above but never posted — pure telemetry.
      } catch (err) {
        // A single failed activity post must not crash the run.
        console.error(`[relay] failed to post activity for ${e.kind}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
  }

  // Runs one agent task with telemetry (runs row + events) and live-steering
  // registration. Sandbox lifetime is managed by the caller's withSandbox.
  async #trackedRun(
    sessionId: string,
    taskType: string,
    sbx: Sandbox,
    task: AgentTask,
    acts: Activities,
  ): Promise<JarvisEvent | null> {
    let runId: number | null = null;
    try {
      runId = this.#store.createRun(sessionId, taskType, this.#config.targetRepo);
    } catch (err) {
      console.error(`[telemetry] createRun failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.#live.set(sessionId, { sbx, kill: () => sbx.kill(), replyPending: false, runId });
    try {
      const { result } = await runAgent(sbx, this.#config.anthropicApiKey, task, this.#relay(acts, sessionId, runId));
      this.#logUsage(`${taskType} ${sessionId}`, result, runId);
      return result;
    } finally {
      this.#live.delete(sessionId);
    }
  }

  // created: clarify (implicit) -> produce plan (against the repo's default
  // branch) -> post as elicitation -> await approval
  async onCreated(ctx: IssueContext): Promise<void> {
    const acts = this.#makeActs(ctx.agentSessionId);

    // Re-assigning an issue mints a NEW agentSessionId. Recover durable state from
    // the latest prior session for this issue that saved a plan, so we don't
    // re-plan (or redo implemented work) from scratch.
    const prior = ctx.issueId ? this.#store.findResumableByIssue(ctx.issueId, ctx.agentSessionId) : null;
    if (prior?.plan) {
      // The prior session's run may still be executing (issue re-assigned mid-run).
      // Starting a second run here would push concurrently to the same deterministic
      // work branch — refuse and let the live run finish. Must run BEFORE any
      // prior-row mutation below (retiring a live prior would break its reconcile).
      if (this.hasLive(prior.agentSessionId)) {
        console.log(`[phase] ${ctx.agentSessionId} prior session ${prior.agentSessionId} is still live — not starting a second run`);
        this.#store.upsert(ctx.agentSessionId, "done", ctx.issueId);
        await acts.response(
          "A previous run for this issue is still working — I'll let it finish rather than start a second, conflicting one. " +
            "Re-assign the issue once it's done if you need another pass.",
        );
        return;
      }
      const workBranch = prior.workBranch ?? this.#workBranchFor(ctx.issueId, ctx.agentSessionId);
      // Retire the (not-live) prior row so boot reconciliation ignores it: it
      // still points at a now-stale sandboxId in a run phase, and reconcile()
      // would otherwise re-attach to a defunct sandbox, fail, and post a stray
      // error activity to the dead prior Linear session.
      const retirePrior = () => {
        this.#store.setPhase(prior.agentSessionId, "done");
        this.#store.setSandbox(prior.agentSessionId, null);
      };
      // Already finished with a PR — point the new session at it rather than redo
      // the work. `prior.prUrl` (not `phase === "done"`) is the test: the transient
      // `review` phase also always carries a prUrl and must not fall through to a
      // full re-plan that discards the open PR.
      if (prior.prUrl) {
        retirePrior();
        this.#store.upsert(ctx.agentSessionId, "done", ctx.issueId);
        // Copy the durable context (not just prUrl) so a later done-follow-up on
        // the new session can review against the plan/branch, not plan=null.
        this.#store.setPlan(ctx.agentSessionId, prior.plan);
        if (prior.branch) this.#store.setBranch(ctx.agentSessionId, prior.branch);
        this.#store.setWorkBranch(ctx.agentSessionId, workBranch);
        this.#store.setPrUrl(ctx.agentSessionId, prior.prUrl);
        await acts.response(`This issue already has an open PR from a previous run:\n\n${prior.prUrl}`);
        return;
      }
      // Approved and attempted — resume implementation from the pushed branch, no
      // re-plan, no re-approval. `phase === "error"` alone is NOT sufficient: a
      // failed REVISE run also lands in "error" while the plan column still holds
      // the previous UNAPPROVED plan. `#runImplement` is the only caller of
      // setWorkBranch, so `prior.workBranch` is the true "implementation started"
      // discriminator — gate error-phase resume on it, or an unapproved plan would
      // auto-implement (bypassing human gate #1).
      if (prior.phase === "implement" || (prior.phase === "error" && prior.workBranch)) {
        retirePrior();
        this.#store.upsert(ctx.agentSessionId, "implement", ctx.issueId);
        this.#store.setPlan(ctx.agentSessionId, prior.plan);
        if (prior.branch) this.#store.setBranch(ctx.agentSessionId, prior.branch);
        this.#store.setWorkBranch(ctx.agentSessionId, workBranch);
        await acts.thought("Picking up where the previous run left off — resuming from the saved plan and pushed commits…");
        await this.#runImplement(ctx, acts, prior.plan, prior.branch, workBranch);
        return;
      }
      // Planned but never approved — reuse the plan, skip straight to approval.
      // A "plan"-phase prior (revision run interrupted mid-flight) carries a stale
      // sandboxId and is in reconcile's phase list — retire it like the others.
      // An "error"-phase prior WITHOUT a workBranch (a failed revise run) also lands
      // here: its plan was never approved, so it must be re-approved, not implemented.
      if (prior.phase === "await_approval" || prior.phase === "plan" || prior.phase === "error") {
        retirePrior();
        this.#store.upsert(ctx.agentSessionId, "await_approval", ctx.issueId);
        this.#store.setPlan(ctx.agentSessionId, prior.plan);
        if (prior.branch) this.#store.setBranch(ctx.agentSessionId, prior.branch);
        await acts.elicitation(`${prior.plan}${APPROVAL_FOOTER}`);
        return;
      }
    }

    this.#store.upsert(ctx.agentSessionId, "plan", ctx.issueId);
    await this.#runPlan(ctx, acts, null);
  }

  // Called from onCreated: clone -> one-time repo map -> plan.
  async #runPlan(ctx: IssueContext, acts: Activities, branch: string | null): Promise<void> {
    console.log(`[phase] ${ctx.agentSessionId} → plan (cloning + drafting)`);
    await acts.thought("Reading the codebase to draft a plan…");

    let cloneFailed = false;
    const result = await withSandbox(this.#sbxCfg(), async (sbx) => {
      this.#store.setSandbox(ctx.agentSessionId, sbx.sandboxId);
      try {
        await cloneRepo(sbx, this.#sbxCfg(), branch);
      } catch (err) {
        cloneFailed = true;
        console.error(`[phase] ${ctx.agentSessionId} clone failed for branch ${branch ?? "(default)"}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }

      let map = this.#store.getRepoMap(this.#config.targetRepo);
      if (!map) {
        await acts.thought("First time in this repo — mapping it for faster future runs…");
        try {
          const mapResult = await this.#trackedRun(ctx.agentSessionId, "map", sbx, mapTask(), acts);
          if (mapResult?.kind === "result" && mapResult.text && mapResult.text.trim()) {
            map = mapResult.text;
            this.#store.setRepoMap(this.#config.targetRepo, map);
          }
        } catch (err) {
          // Mapping is an optimization only — any failure must never fail the session.
          console.error(`[map] ${ctx.agentSessionId} repo map generation failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return this.#trackedRun(ctx.agentSessionId, "plan", sbx, planTask(ctx, map), acts);
    });

    if (cloneFailed) {
      this.#store.setSandbox(ctx.agentSessionId, null);
      await this.#failLoud(ctx.agentSessionId, acts, "I couldn't clone the repository. Re-assign the issue to retry.");
      return;
    }

    await this.#finishPlan(ctx.agentSessionId, acts, result);
  }

  // Everything after the plan run: persist the plan, post the elicitation, and
  // advance to await_approval — or fail loud if no plan was produced. Called
  // from onCreated and, after a restart, from reconcile.
  async #finishPlan(agentSessionId: string, acts: Activities, result: JarvisEvent | null): Promise<void> {
    // A mid-run "stop" (steer) already closed the session; don't overwrite done
    // with error/await_approval when the killed run's null result lands here.
    if (this.#store.get(agentSessionId)?.phase === "done") return;
    const plan = result?.kind === "result" && result.text ? result.text : null;
    console.log(`[phase] ${agentSessionId} plan run finished (plan=${plan ? plan.length + " chars" : "NONE"})`);
    if (!plan) {
      await this.#failLoud(agentSessionId, acts, "I couldn't produce a plan. Please add detail to the issue and re-assign me.");
      return;
    }
    this.#store.setPlan(agentSessionId, plan);
    this.#store.setPhase(agentSessionId, "await_approval");
    await acts.elicitation(`${plan}${APPROVAL_FOOTER}${costLine(result)}`);
  }

  // prompted: a reply arrived while awaiting approval.
  // Contract: every path logs AND posts an activity — a session that receives
  // a prompt and emits nothing is marked unresponsive by Linear (10s rule).
  async onPrompted(ctx: IssueContext, replyText: string): Promise<void> {
    const acts = this.#makeActs(ctx.agentSessionId);
    const row = this.#store.get(ctx.agentSessionId);

    if (!row || row.phase !== "await_approval") {
      // Terminal activities only — a `thought` would leave Linear stuck on "working".
      const phase = row?.phase ?? "unknown";
      if (phase === "done" && row?.prUrl) {
        await this.#onDoneFollowUp(ctx, row, replyText, acts);
        return;
      }
      console.log(`[skip] ${ctx.agentSessionId} prompted but phase=${phase} — replying with status`);
      if (phase === "done") {
        await acts.response("This task is already done — re-assign the issue to start something new.");
      } else {
        await acts.error(
          `This session is in state \`${phase}\` and can't continue (it was likely interrupted). ` +
            `Re-assign the issue to me to start over.`,
        );
      }
      return;
    }
    const approved = parseApprovalGate(replyText);
    if (!approved && parseStopGate(replyText)) {
      console.log(`[phase] ${ctx.agentSessionId} stop requested — closing session`);
      try {
        await acts.response("Stopped. Re-assign the issue when you want me to plan again.");
      } catch (err) {
        console.error(`[phase] ${ctx.agentSessionId} failed to post stop activity: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.#store.setPhase(ctx.agentSessionId, "done");
      }
      return;
    }
    // Hoisted above the approved/not-approved branch: both the revision path
    // (feedback) and the implement path (approved) need the current plan.
    let plan = row.plan;
    if (!plan || !plan.trim()) {
      plan = await recoverPlan(this.#store, ctx.agentSessionId, this.#fetchPlan);
    }
    if (!plan || !plan.trim()) {
      console.error(`[phase] ${ctx.agentSessionId} plan is missing — refusing to proceed blind`);
      await this.#failLoud(
        ctx.agentSessionId, acts,
        "I lost the plan for this session (likely a restart before it was saved). Re-assign the issue and I'll plan again.",
      );
      return;
    }

    if (!approved) {
      console.log(`[phase] ${ctx.agentSessionId} reply parsed as feedback — revising the plan`);
      // Same phase as the original plan run so boot reconciliation recovers a
      // revision run exactly like a plan run (re-attaches, calls #finishPlan).
      this.#store.setPhase(ctx.agentSessionId, "plan");
      await acts.thought("Revising the plan per your feedback…");

      const map = this.#store.getRepoMap(this.#config.targetRepo);
      const result = await withSandbox(this.#sbxCfg(), async (sbx) => {
        this.#store.setSandbox(ctx.agentSessionId, sbx.sandboxId);
        await cloneRepo(sbx, this.#sbxCfg(), row.branch);
        return this.#trackedRun(ctx.agentSessionId, "revise", sbx, reviseTask(ctx, plan, replyText, map), acts);
      });

      await this.#finishPlan(ctx.agentSessionId, acts, result);
      return;
    }

    await acts.thought("Approved — implementing in a sandbox now.");
    await this.#runImplement(ctx, acts, plan, row.branch, this.#workBranchFor(ctx.issueId, ctx.agentSessionId));
    return;
  }

  // Clone the base branch, run implement against the pinned work branch, self-review,
  // finish. Shared by onPrompted (fresh approval) and onCreated (resume). Preserves
  // the approved-path semantics verbatim — the only additions are pinning the work
  // branch (setWorkBranch) and threading it into implementTask.
  async #runImplement(
    ctx: IssueContext,
    acts: Activities,
    plan: string,
    baseBranch: string | null,
    workBranch: string,
  ): Promise<void> {
    this.#store.setPhase(ctx.agentSessionId, "implement");
    this.#store.setWorkBranch(ctx.agentSessionId, workBranch);
    console.log(`[phase] ${ctx.agentSessionId} → implement (branch ${workBranch})`);

    const map = this.#store.getRepoMap(this.#config.targetRepo);
    let review: string | null = null;
    const result = await withSandbox(this.#sbxCfg(), async (sbx) => {
      this.#store.setSandbox(ctx.agentSessionId, sbx.sandboxId);
      await cloneRepo(sbx, this.#sbxCfg(), baseBranch);
      const r = await this.#trackedRun(ctx.agentSessionId, "implement", sbx, implementTask(ctx, plan, map, workBranch), acts);
      // Persist the PR URL BEFORE self-review: the review run deletes and
      // rewrites RESULT_FILE, so a restart (or stop) during self-review would
      // otherwise lose the PR — or worse, reconcile would recover the review
      // report and feed it to #finishImplement as if it were the PR URL.
      const prText = r?.kind === "result" && r.text ? r.text.trim() : "";
      if (PR_URL_RE.test(prText)) this.#store.setPrUrl(ctx.agentSessionId, prText);
      review = await this.#maybeSelfReview(ctx, sbx, r, plan, map, acts);
      return r;
    });

    await this.#finishImplement(ctx.agentSessionId, acts, result, review);
  }

  // A comment arrived while a run is live. stop kills it; anything else is
  // injected into the running agent's inbox and its next reply posts back.
  async steer(ctx: IssueContext, replyText: string): Promise<void> {
    const acts = this.#makeActs(ctx.agentSessionId);
    const live = this.#live.get(ctx.agentSessionId);
    if (!live) {
      await acts.response("That run just finished — I couldn't pass your message to it. Reply again and I'll handle it.");
      return;
    }
    if (parseStopGate(replyText)) {
      console.log(`[steer] ${ctx.agentSessionId} stop requested mid-run — killing sandbox`);
      this.#store.setPhase(ctx.agentSessionId, "done");
      await acts.response("Stopped mid-run. Re-assign the issue to start over.");
      await live.kill().catch(() => undefined);
      return;
    }
    this.#record(live.runId, { kind: "user_message", text: replyText });
    live.replyPending = true;
    try {
      await injectMessage(live.sbx, replyText);
    } catch (err) {
      live.replyPending = false;
      await acts.error(`I couldn't pass your message to the running agent: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    await acts.thought("Got it — passing your message to the running agent.");
  }

  // Everything after the implement run: post the PR (done) or the failure
  // (error). Called from onPrompted and, after a restart, from reconcile.
  async #finishImplement(
    agentSessionId: string,
    acts: Activities,
    result: JarvisEvent | null,
    review: string | null = null,
  ): Promise<void> {
    // A mid-run "stop" (steer) already closed the session; don't overwrite done
    // with error/await_approval when the killed run's null result lands here.
    if (this.#store.get(agentSessionId)?.phase === "done") return;
    const text = result?.kind === "result" && result.text ? result.text.trim() : "";
    if (text.startsWith("PR_FAILED:")) {
      console.error(`[phase] ${agentSessionId} → error (PR creation failed: ${text.slice(0, 100)})`);
      await this.#failLoud(agentSessionId, acts, `PR could not be opened: ${text.slice("PR_FAILED:".length).trim()}`);
    } else if (result?.kind === "result" && result.text && PR_URL_RE.test(text)) {
      console.log(`[phase] ${agentSessionId} → done (PR: ${result.text.slice(0, 100)})`);
      this.#store.setPrUrl(agentSessionId, text);
      if (review) this.#store.setReview(agentSessionId, review);
      try {
        await acts.response(`Done. PR opened:\n\n${result.text}\n\n_A human review + merge closes this out._${costLine(result)}`);
        if (review) await acts.response(`**Self-review of the diff** (advisory — the PR is unchanged):\n\n${review}`);
      } catch (err) {
        console.error(`[phase] ${agentSessionId} failed to post done activity: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.#store.setPhase(agentSessionId, "done");
      }
    } else if (result?.kind === "result" && result.text) {
      // A result that isn't a single-line URL (e.g. a self-review report that
      // overwrote RESULT_FILE and got recovered by reconcile) is NOT a PR.
      console.error(`[phase] ${agentSessionId} → error (implement finished without a PR URL: ${text.slice(0, 100).replace(/\n/g, " ")})`);
      await this.#failLoud(agentSessionId, acts, "Implement finished without a PR URL. Re-assign the issue to retry, or check GitHub — the PR may already exist.");
    } else {
      console.error(`[phase] ${agentSessionId} → error (implement did not complete)`);
      await this.#failLoud(agentSessionId, acts, result?.kind === "error" ? result.message : "Implementation did not complete.");
    }
  }

  // A reply on a finished session that has a PR: conversational follow-up.
  // "stop" closes politely; anything else runs a review agent against the PR
  // diff with the user's message as steering ("review this" reviews; a
  // question gets answered in the diff's context).
  async #onDoneFollowUp(ctx: IssueContext, row: SessionRow, replyText: string, acts: Activities): Promise<void> {
    if (parseStopGate(replyText)) {
      console.log(`[phase] ${ctx.agentSessionId} done follow-up: stop — staying done`);
      await acts.response("Understood — closing this out. The PR is waiting on human review.");
      return;
    }
    console.log(`[phase] ${ctx.agentSessionId} done → review (follow-up on ${row.prUrl})`);
    this.#store.setPhase(ctx.agentSessionId, "review");
    // Fire-and-forget: thought is one-shot telemetry, and a rejection here
    // (outside the try/catch) would wedge the session in `review`.
    void acts.thought("Looking at the PR diff…").catch(() => {});
    const map = this.#store.getRepoMap(this.#config.targetRepo);
    let result: JarvisEvent | null = null;
    try {
      result = await withSandbox(this.#sbxCfg(), async (sbx) => {
        this.#store.setSandbox(ctx.agentSessionId, sbx.sandboxId);
        await cloneRepo(sbx, this.#sbxCfg(), row.branch);
        return this.#trackedRun(ctx.agentSessionId, "review", sbx, reviewTask(ctx, row.prUrl!, row.plan, replyText, map), acts);
      });
    } catch (err) {
      console.error(`[review] ${ctx.agentSessionId} review run failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.#finishReview(ctx.agentSessionId, acts, result);
  }

  // Review always returns the session to done — a failed review is retryable
  // by replying again, never a wedged `error` session.
  async #finishReview(agentSessionId: string, acts: Activities, result: JarvisEvent | null): Promise<void> {
    // A mid-run "stop" (steer) already set the session to done and killed the
    // sandbox — don't post a contradictory error when the killed run's null
    // result lands here. (Early return, so the finally's setPhase never runs.)
    if (this.#store.get(agentSessionId)?.phase === "done") return;
    const report = result?.kind === "result" && result.text ? result.text : null;
    try {
      if (report) {
        console.log(`[phase] ${agentSessionId} review → done (${report.length} chars)`);
        this.#store.setReview(agentSessionId, report);
        await acts.response(`${report}${costLine(result)}`);
      } else {
        console.error(`[phase] ${agentSessionId} review produced no report`);
        await acts.error("I couldn't complete the review — reply again to retry.");
      }
    } catch (err) {
      console.error(`[review] ${agentSessionId} failed to post review activity: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.#store.setPhase(agentSessionId, "done");
    }
  }

  // Self-review: after an implement run that produced a PR, size the diff in
  // the SAME sandbox (branch still checked out); over threshold, run a review
  // task and return its report. Advisory only — every failure path returns
  // null and never throws, and the PR announcement is unaffected.
  async #maybeSelfReview(
    ctx: IssueContext,
    sbx: Sandbox,
    result: JarvisEvent | null,
    plan: string,
    map: string | undefined,
    acts: Activities,
  ): Promise<string | null> {
    const prUrl = result?.kind === "result" && result.text ? result.text.trim() : "";
    if (!prUrl.startsWith("http")) return null;
    try {
      const stat = await runCommand(sbx, `cd ${REPO_DIR} && git diff origin/HEAD... --shortstat`);
      if (stat.exitCode !== 0 || !diffExceedsThreshold(stat.stdout)) return null;
      await acts.thought("Big diff — running a self-review before handing off…");
      const r = await this.#trackedRun(ctx.agentSessionId, "review", sbx, reviewTask(ctx, prUrl, plan, null, map), acts);
      return r?.kind === "result" && r.text ? r.text : null;
    } catch (err) {
      console.error(`[review] ${ctx.agentSessionId} self-review failed (advisory, continuing): ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  // Marks a session failed locally even if the Linear post itself fails (e.g.
  // "Entity not found: AgentSession" for a session Linear no longer knows about) —
  // otherwise the row stays in plan/implement and reconcile retries it forever.
  async #failLoud(id: string, acts: Activities, message: string): Promise<void> {
    try {
      await acts.error(message);
    } catch (err) {
      console.error(`[reconcile] ${id} failed to post error activity: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.#store.setPhase(id, "error");
    }
  }

  // Boot reconciliation: on startup, no in-flight session should be left hanging.
  // For every row still in a run phase (plan/implement), either recover it by
  // re-attaching to its sandbox, or fail it loud so the human can re-assign.
  // Race note: a `prompted` webhook arriving while a session is being reconciled
  // cannot double-run it — onPrompted only acts in phase await_approval (plus
  // done-with-PR follow-ups, which require phase=done), and reconciled rows stay
  // in plan/implement/review until #finish* moves them.
  async reconcile(): Promise<void> {
    const rows = this.#store.listByPhase("plan", "implement", "review");
    if (rows.length === 0) return;
    console.log(`[reconcile] ${rows.length} in-flight session(s) to reconcile`);
    await Promise.allSettled(
      rows.map(async (row) => {
        const id = row.agentSessionId;
        const acts = this.#makeActs(id);
        // review is advisory: recover to done (retryable by replying), not error
        const fail = (message: string) =>
          row.phase === "review" ? this.#finishReview(id, acts, null) : this.#failLoud(id, acts, message);
        // implement-phase failures get resume guidance instead of "start over" —
        // Task 4's findResumableByIssue picks this up on the next `created` webhook.
        const failImplement = (why: string) =>
          this.#failLoud(
            id,
            acts,
            `${why} Re-assign to resume from the saved plan and pushed branch — no re-planning needed.`,
          );
        const failStuck =
          row.phase === "implement"
            ? (why: string) => failImplement(why)
            : (why: string) => fail(`${why} Re-assign the issue to retry.`);
        try {
          if (!row.sandboxId) {
            console.log(`[reconcile] ${id} phase=${row.phase} has no sandboxId — failing loud`);
            await failStuck("A restart interrupted this run before its sandbox was recorded.");
            return;
          }
          console.log(`[reconcile] ${id} phase=${row.phase} re-attaching to sandbox ${row.sandboxId}`);
          let sbx: Reconnected;
          try {
            sbx = await this.#connect(row.sandboxId);
          } catch (err) {
            console.error(`[reconcile] ${id} connect failed: ${err instanceof Error ? err.message : String(err)}`);
            await failStuck("A restart interrupted this run.");
            return;
          }
          try {
            const result = await watchDetached(sbx);
            if (!result) {
              console.log(`[reconcile] ${id} no result recovered from sandbox — failing loud`);
              await failStuck("A restart interrupted this run.");
              return;
            }
            console.log(`[reconcile] ${id} recovered result (${result.kind}) — finishing phase=${row.phase}`);
            this.#logUsage(`reconcile ${id}`, result);
            if (row.phase === "plan") {
              await this.#finishPlan(id, acts, result);
            } else if (row.phase === "review") {
              await this.#finishReview(id, acts, result);
            } else {
              await this.#finishImplement(id, acts, result);
            }
          } finally {
            await sbx.kill().catch(() => undefined);
          }
        } catch (err) {
          console.error(`[reconcile] ${id} reconciliation failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );
  }
}

// re-export from context to avoid a circular import in tests
import {
  parseApproval as parseApprovalGate,
  parseStop as parseStopGate,
} from "../linear/context.ts";
