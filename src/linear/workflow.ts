import type { LinearClient } from "@linear/sdk";
import type { SessionStore, TeamState } from "../store/sessions.ts";
import { pickWorkflowState } from "../agent/classify.ts";

export type { TeamState };

type StatesClient = Pick<LinearClient, "workflowStates">;

/** Fetch a team's workflow states, cached in SQLite (a team's states rarely
 * change). Advisory: any failure returns [] so a status nudge never blocks a run. */
export async function fetchTeamStates(
  client: StatesClient,
  store: Pick<SessionStore, "getTeamStates" | "setTeamStates">,
  teamId: string,
): Promise<TeamState[]> {
  const cached = store.getTeamStates(teamId);
  if (cached) return cached;
  try {
    const connection = await client.workflowStates({ filter: { team: { id: { eq: teamId } } } } as never);
    const states: TeamState[] = connection.nodes.map((n: { id: string; name: string; type: string }) => ({
      id: n.id, name: n.name, type: n.type,
    }));
    store.setTeamStates(teamId, states);
    return states;
  } catch (err) {
    console.error(`[workflow] fetchTeamStates failed for team ${teamId} (advisory): ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// Jarvis moments that move the issue's status. `type` is Linear's standardized
// state category — stable across teams even though display names ("In
// Progress" vs "Doing") differ. Deliberately no "error" transition: don't fake
// a status Jarvis isn't confident about.
export type Transition = "plan_start" | "implement_start" | "pr_opened" | "done";

const CATEGORY: Record<Transition, string> = {
  plan_start: "started",
  implement_start: "started",
  pr_opened: "started",
  done: "completed",
};

const LABEL: Record<Transition, string> = {
  plan_start: "planning started",
  implement_start: "implementation starting",
  pr_opened: "PR opened for review",
  done: "work finished",
};

/**
 * Pick the target state id for a transition among a team's states.
 * 0 matches -> undefined (team removed that category — skip, not fatal).
 * 1 match -> it, no extra call. 2+ -> prefer a name containing "review" for
 * pr_opened (cheap, no model call); otherwise ask the classifier to
 * disambiguate among the candidate names.
 */
export async function resolveTargetState(
  apiKey: string,
  states: TeamState[],
  transition: Transition,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const category = CATEGORY[transition];
  const candidates = states.filter((s) => s.type === category);
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0].id;
  if (transition === "pr_opened") {
    const reviewLike = candidates.find((s) => /review/i.test(s.name));
    if (reviewLike) return reviewLike.id;
  }
  const pickedName = await pickWorkflowState(apiKey, LABEL[transition], candidates.map((s) => s.name), fetchImpl);
  return candidates.find((s) => s.name === pickedName)?.id ?? candidates[0].id;
}
