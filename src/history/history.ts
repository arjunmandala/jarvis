import type { AgentSandbox } from "../sandbox/session.ts";
import type { SessionStore, RunLog } from "../store/sessions.ts";

// Where prior runs' raw event logs land inside the sandbox. Outside REPO_DIR
// (/home/user/repo) so the agent can't accidentally commit them; inside
// /home/user so the default sandbox user can write there.
export const HISTORY_DIR = "/home/user/jarvis-history";

// Injected-thread budget. ponytail: char cap with keep-the-tail truncation,
// no summarisation — upgrade to an LLM summary pass if long threads start
// costing real prompt tokens.
export const THREAD_CHAR_CAP = 20_000;

// Export bounds. ponytail: newest N runs, tail-sliced files — a tail slice can
// cut the first line mid-JSON, which grep tolerates; upgrade to line-aligned
// slicing if it ever confuses an agent.
export const MAX_EXPORTED_RUNS = 10;
export const MAX_FILE_BYTES = 1_000_000;

export type ThreadFetcher = (agentSessionId: string) => Promise<string | null>;

/** Concatenate each session's visible thread, oldest-first; cap keeping the newest tail. */
export async function assembleThread(
  sessionIds: string[],
  fetchThread: ThreadFetcher,
  cap: number = THREAD_CHAR_CAP,
): Promise<string | null> {
  const parts: string[] = [];
  for (const id of sessionIds) {
    try {
      const t = await fetchThread(id);
      if (t && t.trim()) parts.push(t.trim());
    } catch (err) {
      console.error(`[history] thread fetch failed for ${id} (advisory): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (parts.length === 0) return null;
  let out = parts.join("\n\n---\n\n");
  if (out.length > cap) {
    const dropped = out.length - cap;
    out = `[older conversation truncated — call get_thread(offset=${dropped}) for the earlier messages]\n${out.slice(-cap)}`;
  }
  return out;
}

/** Write the newest runs' JSONL into the sandbox; per-file failures skip that file only. */
export async function writeHistoryFiles(sbx: AgentSandbox, logs: RunLog[]): Promise<string[]> {
  const recent = logs.filter((l) => l.jsonl).slice(-MAX_EXPORTED_RUNS);
  const written: string[] = [];
  for (const log of recent) {
    const name = `run-${log.runId}-${log.taskType}.jsonl`;
    let data = log.jsonl;
    if (data.length > MAX_FILE_BYTES) {
      const dropped = data.length - MAX_FILE_BYTES;
      data =
        `[truncated: first ${dropped} bytes dropped — call get_run_events(runId=${log.runId}, offset=0) for the full stream]\n` +
        data.slice(-MAX_FILE_BYTES);
    }
    try {
      await sbx.files.write(`${HISTORY_DIR}/${name}`, data);
      written.push(name);
    } catch (err) {
      console.error(`[history] write ${name} failed (advisory): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return written;
}

/** The goal-injectable history block: thread text + a grep pointer at the exported logs. */
export function renderHistory(thread: string | null, files: string[], olderRunsExist = false): string | undefined {
  const sections: string[] = [];
  if (thread) {
    sections.push(`Conversation from prior sessions on this issue (oldest first):\n\n${thread}`);
  }
  if (files.length > 0) {
    const older = olderRunsExist
      ? ` Older runs beyond these are not exported — call get_run_events(runId=…) to fetch any of them.`
      : "";
    sections.push(
      `Raw event logs from prior runs are in ${HISTORY_DIR}/ (${files.join(", ")}). ` +
        `Each line is one JSON event (tool_use, tool_result, assistant_text, result). ` +
        `Grep them when you need what a past run actually did — files edited, commands run, ` +
        `test output, failure messages. Do not read them wholesale and never commit them.${older}`,
    );
  }
  if (sections.length === 0) return undefined;
  return sections.join("\n\n");
}

// ponytail: same-issue scope only — history never crosses issues. Upgrade
// path if scope ever widens: a host-side retrieval tool (cross-issue search),
// not more goal injection.
/**
 * The one-call entry point for the orchestrator: gather this issue's prior
 * sessions, fetch their visible threads, export their run logs into the
 * sandbox, and render the goal block. Advisory end-to-end — any failure
 * returns undefined and the run proceeds without history.
 */
export async function prepareHistory(
  store: Pick<SessionStore, "listByIssue" | "getRunLogsBySession">,
  sbx: AgentSandbox,
  issueId: string | null,
  fetchThread?: ThreadFetcher,
): Promise<string | undefined> {
  if (!issueId) return undefined;
  try {
    const sessions = store.listByIssue(issueId);
    if (sessions.length === 0) return undefined;
    const ids = sessions.map((s) => s.agentSessionId);
    const thread = fetchThread ? await assembleThread(ids, fetchThread) : null;
    const logs = ids.flatMap((id) => store.getRunLogsBySession(id));
    const files = await writeHistoryFiles(sbx, logs);
    const olderRunsExist = logs.filter((l) => l.jsonl).length > MAX_EXPORTED_RUNS;
    return renderHistory(thread, files, olderRunsExist);
  } catch (err) {
    console.error(`[history] prepareHistory failed (advisory): ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
