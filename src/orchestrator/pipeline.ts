import type { Config } from "../config.ts";
import type { SessionStore, Phase } from "../store/sessions.ts";
import type { Activities } from "../linear/activities.ts";
import type { IssueContext } from "../linear/context.ts";
import { APPROVAL_FOOTER } from "../linear/context.ts";
import { withSandbox, cloneRepo, runAgent } from "../sandbox/session.ts";
import { planTask, implementTask } from "../agent/tasks.ts";
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

export class Orchestrator {
  #config: Config;
  #store: SessionStore;
  #makeActs: (agentSessionId: string) => Activities;
  #fetchPlan?: (agentSessionId: string) => Promise<string | null>;

  constructor(
    config: Config,
    store: SessionStore,
    makeActs: (agentSessionId: string) => Activities,
    fetchPlan?: (agentSessionId: string) => Promise<string | null>,
  ) {
    this.#config = config;
    this.#store = store;
    this.#makeActs = makeActs;
    this.#fetchPlan = fetchPlan;
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
      return runAgent(sbx, this.#config.anthropicApiKey, planTask(ctx), this.#relay(acts));
    });

    this.#logUsage(`plan ${ctx.agentSessionId}`, result);
    const plan = result?.kind === "result" && result.text ? result.text : null;
    console.log(`[phase] ${ctx.agentSessionId} plan run finished (plan=${plan ? plan.length + " chars" : "NONE"})`);
    if (!plan) {
      await acts.error("I couldn't produce a plan. Please add detail to the issue and re-assign me.");
      this.#store.setPhase(ctx.agentSessionId, "error");
      return;
    }
    this.#store.setPlan(ctx.agentSessionId, plan);
    this.#store.setPhase(ctx.agentSessionId, "await_approval");
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
      await acts.response("Stopped. Re-assign the issue when you want me to plan again.");
      this.#store.setPhase(ctx.agentSessionId, "done");
      return;
    }
    if (!approved) {
      console.log(`[phase] ${ctx.agentSessionId} reply parsed as NOT approval — staying in await_approval`);
      // Elicitation puts the session back into "awaiting input" instead of "working".
      await acts.elicitation("Understood — not implementing yet. Reply 'approve' when ready, or 'stop' to cancel.");
      return;
    }
    let plan = row.plan;
    if ((!plan || !plan.trim()) && this.#fetchPlan) {
      const recovered = await this.#fetchPlan(ctx.agentSessionId);
      if (recovered && recovered.trim()) {
        console.log(`[recover] ${ctx.agentSessionId} recovered plan from Linear (${recovered.length} chars)`);
        this.#store.setPlan(ctx.agentSessionId, recovered);
        plan = recovered;
      }
    }
    if (!plan || !plan.trim()) {
      console.error(`[phase] ${ctx.agentSessionId} approved but plan is missing — refusing to implement blind`);
      await acts.error(
        "I lost the plan for this session (likely a restart before it was saved). Re-assign the issue and I'll plan again.",
      );
      this.#store.setPhase(ctx.agentSessionId, "error");
      return;
    }
    this.#store.setPhase(ctx.agentSessionId, "implement");
    console.log(`[phase] ${ctx.agentSessionId} → implement (approved)`);
    await acts.thought("Approved — implementing in a sandbox now.");

    const { result } = await withSandbox(this.#sbxCfg(), async (sbx) => {
      this.#store.setSandbox(ctx.agentSessionId, sbx.sandboxId);
      await cloneRepo(sbx, this.#sbxCfg());
      return runAgent(sbx, this.#config.anthropicApiKey, implementTask(ctx, plan), this.#relay(acts));
    });

    this.#logUsage(`implement ${ctx.agentSessionId}`, result);
    if (result?.kind === "result" && result.text) {
      console.log(`[phase] ${ctx.agentSessionId} → done (PR: ${result.text.slice(0, 100)})`);
      await acts.response(`Done. PR opened:\n\n${result.text}\n\n_A human review + merge closes this out._${costLine(result)}`);
      this.#store.setPhase(ctx.agentSessionId, "done");
    } else {
      console.error(`[phase] ${ctx.agentSessionId} → error (implement did not complete)`);
      await acts.error(result?.kind === "error" ? result.message : "Implementation did not complete.");
      this.#store.setPhase(ctx.agentSessionId, "error");
    }
  }
}

// re-export from context to avoid a circular import in tests
import { parseApproval as parseApprovalGate, parseStop as parseStopGate } from "../linear/context.ts";
