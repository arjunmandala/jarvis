export interface IssueContext {
  agentSessionId: string;
  organizationId: string;
  issueId: string | null;
  title: string;
  description: string;
  comment: string;
  promptContext: string;
}

function asRecord(x: unknown): Record<string, unknown> {
  return x && typeof x === "object" ? (x as Record<string, unknown>) : {};
}

export function extractContext(payload: unknown): IssueContext {
  const p = asRecord(payload);
  const session = asRecord(p.agentSession);
  const issue = asRecord(session.issue);
  const comment = asRecord(session.comment);
  return {
    agentSessionId: String(session.id ?? ""),
    organizationId: String(p.organizationId ?? ""),
    issueId: issue.id ? String(issue.id) : null,
    title: String(issue.title ?? ""),
    description: String(issue.description ?? ""),
    comment: String(comment.body ?? ""),
    promptContext: String(session.promptContext ?? ""),
  };
}

export function promptedBody(payload: unknown): string {
  const activity = asRecord(asRecord(payload).agentActivity);
  const content = asRecord(activity.content);
  // Linear nests the user's reply under agentActivity.content.body; tolerate
  // the flatter shapes too.
  const raw = content.body ?? content.text ?? activity.body ?? activity.text ?? "";
  return String(raw);
}

// ponytail: keyword heuristic. Ceiling: misreads "do not approve" etc.
// Upgrade path: a tiny classifier call if false signals cause real trouble.
const AFFIRM = /\b(approve|approved|lgtm|ship\s*it|go\s*ahead|looks\s*good|yes)\b/i;
const NEGATE = /\b(no|not yet|hold on|don'?t|do not|reject|change|wait)\b/i;

export function parseApproval(text: string): boolean {
  if (NEGATE.test(text)) return false;
  return AFFIRM.test(text);
}
