export const APPROVAL_FOOTER =
  '\n\n---\n**Reply "approve" to have me implement this**, or tell me what to change.';

export interface IssueContext {
  agentSessionId: string;
  organizationId: string;
  issueId: string | null;
  teamId: string | null;
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
  const team = asRecord(issue.team);
  const comment = asRecord(session.comment);
  return {
    agentSessionId: String(session.id ?? ""),
    organizationId: String(p.organizationId ?? ""),
    issueId: issue.id ? String(issue.id) : null,
    teamId: team.id ? String(team.id) : null,
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

// "stop"/"cancel" while awaiting approval closes the session for good
// (rejections like "hold on" merely keep it waiting).
const STOP = /\b(stop|cancel|abort|never\s?mind)\b/i;
const STOP_NEGATED = /\b(?:don'?t|do\s*not)\s+(?:stop|cancel|abort)/i;

export function parseStop(text: string): boolean {
  return STOP.test(text) && !STOP_NEGATED.test(text);
}

// Trust boundary: this string is interpolated into `git clone -b <name> ...`
// (see cloneRepo in src/sandbox/session.ts). Validate BEFORE storing or
// passing it anywhere near a shell command — never after.
const BRANCH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function isValidBranchName(name: string): boolean {
  return (
    BRANCH_NAME_RE.test(name) &&
    !name.includes("..") &&
    !name.endsWith("/") &&
    !name.endsWith(".lock")
  );
}
