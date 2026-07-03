export const APPROVAL_FOOTER =
  '\n\n---\n**Reply "approve" to have me implement this**, or tell me what to change.';

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

export const ASK_BRANCH =
  "Which branch should I work from? Reply with the branch name " +
  '(e.g. `branch: feature/foo`), or just the name by itself.';

// ponytail: keyword heuristic, same style as parseApproval/parseStop above.
const BRANCH_KEYWORD = /\bbranch\s*:\s*(\S+)/i;
const TRAILING_PUNCT = /[.,;:]+$/;

export function parseBranchKeyword(text: string): string | null {
  const m = BRANCH_KEYWORD.exec(text);
  return m ? m[1].replace(TRAILING_PUNCT, "") || null : null;
}

// Used only when a reply is answering "which branch?" directly — accepts
// either the branch: keyword or a bare branch name as the first token.
export function parseBranchAnswer(text: string): string | null {
  const keyword = parseBranchKeyword(text);
  if (keyword) return keyword;
  const first = text.trim().split(/\s+/)[0] ?? "";
  return first.replace(TRAILING_PUNCT, "") || null;
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
