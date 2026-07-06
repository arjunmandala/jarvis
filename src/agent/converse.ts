import type { IssueContext } from "../linear/context.ts";
import { REPO_DIR } from "../sandbox/session.ts";
import type { AgentTask } from "./tasks.ts";

export type ConverseAction = "reply" | "need_repo" | "plan" | "implement" | "stop";
const VERBS = new Set<ConverseAction>(["reply", "need_repo", "plan", "implement", "stop"]);

// The agent's final message starts with `ACTION: <verb>` on its own line; the
// rest is the body (the reply to post, or the plan text). Mirrors the repo's
// existing final-message-prefix routing (parseDecomposition, PR_URL_RE). A
// missing or unknown verb is a safe "reply" — we just post the text verbatim.
// ponytail: prefix parse, not a classifier. Ceiling: the agent forgets the tag
// on an implement/need_repo turn and it reads as a plain reply — surfaced to the
// human, who simply nudges again. Upgrade path: an SDK tool the agent must call.
export function parseConverseAction(text: string): { action: ConverseAction; body: string } {
  const m = /^\s*ACTION:\s*([A-Za-z_]+)\s*(?:\n|$)/.exec(text);
  const verb = m?.[1]?.toLowerCase() as ConverseAction | undefined;
  if (m && verb && VERBS.has(verb)) {
    return { action: verb, body: text.slice(m[0].length).trim() };
  }
  return { action: "reply", body: text.trim() };
}

// Fixed, byte-stable protocol text appended to the converse system prompt.
export const CONVERSE_APPEND =
  "\n\nYou are Jarvis, a senior engineer talking through a Linear ticket with a human before any code is " +
  "written. Hold the conversation like a colleague: answer what they actually asked, push back when " +
  "you disagree, ask a follow-up when something is genuinely ambiguous. Do not force every message into a " +
  "plan.\n\n" +
  "PROTOCOL: your FINAL message MUST begin with one line, exactly `ACTION: <verb>`, where <verb> is one of:\n" +
  "- `reply` — you answered from context or the web / asked a follow-up. The rest of your message is posted " +
  "to the human verbatim.\n" +
  "- `need_repo` — you cannot answer or plan without reading the actual code. The rest is a short note to the " +
  "human ('let me pull up the code'); you will be re-run with full repo access.\n" +
  "- `plan` — the rest of your message is a complete implementation plan (start it with the `Type:`/`Scope:` " +
  "lines). Post it and keep talking; do NOT treat it as approved.\n" +
  "- `implement` — the human has clearly agreed to a plan you already posted. The rest is a one-line " +
  "acknowledgement. Only use this when they actually said go; if you are unsure, use `reply` and ask.\n" +
  "- `stop` — the human asked to stop. The rest is a brief sign-off.\n\n" +
  "Never emit `implement` unless a plan has already been posted in this conversation and the human agreed to it.";
