import type { Config } from "../config.ts";
import type { SessionStore, Phase } from "../store/sessions.ts";
import type { Activities } from "../linear/activities.ts";
import type { IssueContext } from "../linear/context.ts";
import { withSandbox, cloneRepo, runAgent } from "../sandbox/session.ts";
import { planTask, implementTask } from "../agent/tasks.ts";
import type { JarvisEvent } from "../agent/events.ts";

export function nextPhase(current: Phase, approved: boolean): Phase {
  switch (current) {
    case "clarify": return "plan";
    case "plan": return "await_approval";
    case "await_approval": return approved ? "implement" : "await_approval";
    case "implement": return "done";
    default: return current;
  }
}

export class Orchestrator {
  #plans = new Map<string, string>(); // agentSessionId -> approved/proposed plan text (v1; persist in Phase 4)
  #config: Config;
  #store: SessionStore;
  #makeActs: (agentSessionId: string) => Activities;

  constructor(
    config: Config,
    store: SessionStore,
    makeActs: (agentSessionId: string) => Activities,
  ) {
    this.#config = config;
    this.#store = store;
    this.#makeActs = makeActs;
  }

  #sbxCfg() {
    return {
      apiKey: this.#config.e2bApiKey, template: this.#config.e2bTemplate,
      ghToken: this.#config.ghToken, targetRepo: this.#config.targetRepo,
    };
  }

  #relay(acts: Activities) {
    return async (e: JarvisEvent) => {
      if (e.kind === "tool_use") {
        await acts.action(String(e.name), typeof (e.input as any)?.command === "string" ? (e.input as any).command : undefined);
      } else if (e.kind === "error") {
        await acts.error(e.message);
      }
      // assistant_text is intentionally not posted per-block (too noisy);
      // the final plan/PR text is posted from the result below.
    };
  }

  // created: clarify (implicit) -> produce plan -> post as elicitation -> await approval
  async onCreated(ctx: IssueContext): Promise<void> {
    const acts = this.#makeActs(ctx.agentSessionId);
    this.#store.upsert(ctx.agentSessionId, "plan", ctx.issueId);
    await acts.thought("Reading the codebase to draft a plan…");

    const { result } = await withSandbox(this.#sbxCfg(), async (sbx) => {
      await cloneRepo(sbx, this.#sbxCfg());
      return runAgent(sbx, this.#config.anthropicApiKey, planTask(ctx), this.#relay(acts));
    });

    const plan = result?.kind === "result" && result.text ? result.text : null;
    if (!plan) {
      await acts.error("I couldn't produce a plan. Please add detail to the issue and re-assign me.");
      this.#store.setPhase(ctx.agentSessionId, "error");
      return;
    }
    this.#plans.set(ctx.agentSessionId, plan);
    this.#store.setPhase(ctx.agentSessionId, "await_approval");
    await acts.elicitation(`${plan}\n\n---\n**Reply "approve" to have me implement this**, or tell me what to change.`);
  }

  // prompted: a reply arrived while awaiting approval
  async onPrompted(ctx: IssueContext, replyText: string): Promise<void> {
    const row = this.#store.get(ctx.agentSessionId);
    if (!row || row.phase !== "await_approval") return; // ignore unrelated prompts in v1
    const approved = parseApprovalGate(replyText);
    if (!approved) {
      await this.#makeActs(ctx.agentSessionId).thought("Understood — not implementing yet. Tell me to 'approve' when ready.");
      return;
    }
    const acts = this.#makeActs(ctx.agentSessionId);
    const plan = this.#plans.get(ctx.agentSessionId) ?? "";
    this.#store.setPhase(ctx.agentSessionId, "implement");
    await acts.thought("Approved — implementing in a sandbox now.");

    const { result } = await withSandbox(this.#sbxCfg(), async (sbx) => {
      await cloneRepo(sbx, this.#sbxCfg());
      return runAgent(sbx, this.#config.anthropicApiKey, implementTask(ctx, plan), this.#relay(acts));
    });

    if (result?.kind === "result" && result.text) {
      await acts.response(`Done. PR opened:\n\n${result.text}\n\n_A human review + merge closes this out._`);
      this.#store.setPhase(ctx.agentSessionId, "done");
    } else {
      await acts.error(result?.kind === "error" ? result.message : "Implementation did not complete.");
      this.#store.setPhase(ctx.agentSessionId, "error");
    }
  }
}

// re-export from context to avoid a circular import in tests
import { parseApproval as parseApprovalGate } from "../linear/context.ts";
