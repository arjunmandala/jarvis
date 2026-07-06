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

// ponytail: keyword heuristic. Ceiling: still guessable, e.g. sarcasm.
// Upgrade path: a tiny classifier call if false signals cause real trouble.
// A strong approval verb wins even alongside other negation words ("approve,
// but don't use X"), UNLESS the approval itself is negated ("do not approve").
const APPROVE = /\b(approv(?:e|ed)|lgtm|ship\s*it)\b/i;
const APPROVE_NEGATED = /\b(?:don'?t|do\s*not|not|never|no)\s+approv/i;
const SOFT_AFFIRM = /\b(yes|go\s*ahead|looks\s*good|sounds\s*good|proceed)\b/i;
const SOFT_NEGATE = /\b(no|not yet|hold on|wait|reject|change|stop)\b/i;

export function parseApproval(text: string): boolean {
  if (APPROVE.test(text) && !APPROVE_NEGATED.test(text)) return true;
  if (SOFT_NEGATE.test(text)) return false;
  return SOFT_AFFIRM.test(text);
}

// "stop"/"cancel" while awaiting approval closes the session for good
// (rejections like "hold on" merely keep it waiting).
const STOP = /\b(stop|cancel|abort|never\s?mind)\b/i;
const STOP_NEGATED = /\b(?:don'?t|do\s*not)\s+(?:stop|cancel|abort)/i;

export function parseStop(text: string): boolean {
  return STOP.test(text) && !STOP_NEGATED.test(text);
}

// A reply on a DONE session with an open PR: does it ask for code CHANGES
// (a rejection, "fix this", "address the comments") or is it a review/question?
// A change request routes back into implement on the existing work branch — the
// open PR updates when the new commits are pushed (GitHub's native behavior, no
// Linear↔GitHub wiring). Anything else stays on the read-only review path.
// Biased NARROW on purpose: a false positive spends a whole implement run
// ($3-8), while a false negative just yields a review the human can re-ask.
// ponytail: keyword heuristic, same ceiling as parseApproval — sarcasm/edge
// phrasing slips through. Upgrade path: a tiny classifier call if misroutes bite.
const CHANGE_REQUEST =
  /\b(fix|redo|revise|rework|reject(?:ed)?|address\s+(?:the\s+)?(?:pr\s+)?comments?|make\s+(?:the\s+|these\s+)?changes?|change\s+it|doesn'?t\s+work|does\s+not\s+work|don'?t\s+work|is\s+wrong|not\s+right|not\s+working)\b/i;

export function parseChangeRequest(text: string): boolean {
  if (parseStop(text)) return false;
  return CHANGE_REQUEST.test(text);
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
