import type { Config } from "../config.ts";
import type { SessionStore, Phase } from "../store/sessions.ts";
import type { Activities } from "../linear/activities.ts";
import type { IssueContext } from "../linear/context.ts";
import { APPROVAL_FOOTER } from "../linear/context.ts";
import { withSandbox, cloneRepo, runAgent, watchDetached, type AgentSandbox } from "../sandbox/session.ts";
import { Sandbox } from "e2b";
import { planTask, implementTask, mapTask } from "../agent/tasks.ts";
import type { JarvisEvent } from "../agent/events.ts";

// Phase 4.1: surface the run's dollar cost inline in the Linear activity when
// the result carries one; omitted (not "$n/a") when unknown.
export function costLine(result: JarvisEvent | null): string {
  if (result?.kind !== "result" || result.costUsd == null) return "";
  return `\n\n_Cost: $${result.costUsd.toFixed(4)}_`;
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

  #logUsage(label: string, result: JarvisEvent | null): void {
    if (result?.kind !== "result") return;
    const u = result.usage ?? {};
    const inTok = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const cost = result.costUsd != null ? `$${result.costUsd.toFixed(4)}` : "n/a";
    console.log(
      `[cost] ${label} ${result.subtype} — cost=${cost} turns=${result.numTurns ?? "?"} ` +
        `tokens in=${inTok} (cache_read=${u.cache_read_input_tokens ?? 0}) out=${u.output_tokens ?? 0}`,
    );
  }

  #relay(acts: Activities) {
    return async (e: JarvisEvent) => {
      try {
        if (e.kind === "tool_use") {
          const param = toolParameter(e.input) || String(e.name);
          console.log(`[agent] tool_use ${e.name} → ${param.slice(0, 120)}`);
          // Linear requires action activities to carry a non-empty `parameter`.
          await acts.action(String(e.name), param);
        } else if (e.kind === "error") {
          console.error(`[agent] error: ${e.message}`);
          await acts.error(e.message);
        } else if (e.kind === "assistant_text") {
          console.log(`[agent] text: ${e.text.slice(0, 120).replace(/\n/g, " ")}`);
        }
        // assistant_text is logged (above) but intentionally not posted per-block
        // to Linear (too noisy); the final plan/PR text is posted from the result.
      } catch (err) {
        // A single failed activity post must not crash the run.
        console.error(`[relay] failed to post activity for ${e.kind}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
  }

  // created: clarify (implicit) -> produce plan -> post as elicitation -> await approval
  async onCreated(ctx: IssueContext): Promise<void> {
    const acts = this.#makeActs(ctx.agentSessionId);
    this.#store.upsert(ctx.agentSessionId, "plan", ctx.issueId);
    console.log(`[phase] ${ctx.agentSessionId} → plan (cloning + drafting)`);
    await acts.thought("Reading the codebase to draft a plan…");

    const { result } = await withSandbox(this.#sbxCfg(), async (sbx) => {
      this.#store.setSandbox(ctx.agentSessionId, sbx.sandboxId);
      await cloneRepo(sbx, this.#sbxCfg());

      let map = this.#store.getRepoMap(this.#config.targetRepo);
      if (!map) {
        await acts.thought("First time in this repo — mapping it for faster future runs…");
        try {
          const { result: mapResult } = await runAgent(sbx, this.#config.anthropicApiKey, mapTask(), this.#relay(acts));
          this.#logUsage(`map ${ctx.agentSessionId}`, mapResult);
          if (mapResult?.kind === "result" && mapResult.text && mapResult.text.trim()) {
            map = mapResult.text;
            this.#store.setRepoMap(this.#config.targetRepo, map);
          }
        } catch (err) {
          // Mapping is an optimization only — any failure must never fail the session.
          console.error(`[map] ${ctx.agentSessionId} repo map generation failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return runAgent(sbx, this.#config.anthropicApiKey, planTask(ctx, map), this.#relay(acts));
    });

    await this.#finishPlan(ctx.agentSessionId, acts, result);
  }

  // Everything after the plan run: persist the plan, post the elicitation, and
  // advance to await_approval — or fail loud if no plan was produced. Called
  // from onCreated and, after a restart, from reconcile.
  async #finishPlan(agentSessionId: string, acts: Activities, result: JarvisEvent | null): Promise<void> {
    this.#logUsage(`plan ${agentSessionId}`, result);
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
    if (!approved) {
      console.log(`[phase] ${ctx.agentSessionId} reply parsed as NOT approval — staying in await_approval`);
      // Elicitation puts the session back into "awaiting input" instead of "working".
      await acts.elicitation("Understood — not implementing yet. Reply 'approve' when ready, or 'stop' to cancel.");
      return;
    }
    let plan = row.plan;
    if (!plan || !plan.trim()) {
      plan = await recoverPlan(this.#store, ctx.agentSessionId, this.#fetchPlan);
    }
    if (!plan || !plan.trim()) {
      console.error(`[phase] ${ctx.agentSessionId} approved but plan is missing — refusing to implement blind`);
      await this.#failLoud(
        ctx.agentSessionId, acts,
        "I lost the plan for this session (likely a restart before it was saved). Re-assign the issue and I'll plan again.",
      );
      return;
    }
    this.#store.setPhase(ctx.agentSessionId, "implement");
    console.log(`[phase] ${ctx.agentSessionId} → implement (approved)`);
    await acts.thought("Approved — implementing in a sandbox now.");

    const map = this.#store.getRepoMap(this.#config.targetRepo);
    const { result } = await withSandbox(this.#sbxCfg(), async (sbx) => {
      this.#store.setSandbox(ctx.agentSessionId, sbx.sandboxId);
      await cloneRepo(sbx, this.#sbxCfg());
      return runAgent(sbx, this.#config.anthropicApiKey, implementTask(ctx, plan, map), this.#relay(acts));
    });

    await this.#finishImplement(ctx.agentSessionId, acts, result);
  }

  // Everything after the implement run: post the PR (done) or the failure
  // (error). Called from onPrompted and, after a restart, from reconcile.
  async #finishImplement(agentSessionId: string, acts: Activities, result: JarvisEvent | null): Promise<void> {
    this.#logUsage(`implement ${agentSessionId}`, result);
    const text = result?.kind === "result" && result.text ? result.text.trim() : "";
    if (text.startsWith("PR_FAILED:")) {
      console.error(`[phase] ${agentSessionId} → error (PR creation failed: ${text.slice(0, 100)})`);
      await this.#failLoud(agentSessionId, acts, `PR could not be opened: ${text.slice("PR_FAILED:".length).trim()}`);
    } else if (result?.kind === "result" && result.text) {
      console.log(`[phase] ${agentSessionId} → done (PR: ${result.text.slice(0, 100)})`);
      try {
        await acts.response(`Done. PR opened:\n\n${result.text}\n\n_A human review + merge closes this out._${costLine(result)}`);
      } catch (err) {
        console.error(`[phase] ${agentSessionId} failed to post done activity: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.#store.setPhase(agentSessionId, "done");
      }
    } else {
      console.error(`[phase] ${agentSessionId} → error (implement did not complete)`);
      await this.#failLoud(agentSessionId, acts, result?.kind === "error" ? result.message : "Implementation did not complete.");
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
  // cannot double-run it — onPrompted only acts in phase await_approval, and
  // reconciled rows are in plan/implement until #finish* moves them.
  async reconcile(): Promise<void> {
    const rows = this.#store.listByPhase("plan", "implement");
    if (rows.length === 0) return;
    console.log(`[reconcile] ${rows.length} in-flight session(s) to reconcile`);
    await Promise.allSettled(
      rows.map(async (row) => {
        const id = row.agentSessionId;
        const acts = this.#makeActs(id);
        try {
          if (!row.sandboxId) {
            console.log(`[reconcile] ${id} phase=${row.phase} has no sandboxId — failing loud`);
            await this.#failLoud(
              id, acts,
              "A restart interrupted this run before its sandbox was recorded — re-assign the issue to retry.",
            );
            return;
          }
          console.log(`[reconcile] ${id} phase=${row.phase} re-attaching to sandbox ${row.sandboxId}`);
          let sbx: Reconnected;
          try {
            sbx = await this.#connect(row.sandboxId);
          } catch (err) {
            console.error(`[reconcile] ${id} connect failed: ${err instanceof Error ? err.message : String(err)}`);
            await this.#failLoud(id, acts, "A restart interrupted this run — re-assign the issue to retry.");
            return;
          }
          try {
            const result = await watchDetached(sbx);
            if (!result) {
              console.log(`[reconcile] ${id} no result recovered from sandbox — failing loud`);
              await this.#failLoud(id, acts, "A restart interrupted this run — re-assign the issue to retry.");
              return;
            }
            console.log(`[reconcile] ${id} recovered result (${result.kind}) — finishing phase=${row.phase}`);
            if (row.phase === "plan") {
              await this.#finishPlan(id, acts, result);
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
import { parseApproval as parseApprovalGate, parseStop as parseStopGate } from "../linear/context.ts";
