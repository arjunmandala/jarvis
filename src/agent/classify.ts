// Cheap host-side Claude calls (Haiku, no E2B sandbox) for two narrow decisions:
// chat-vs-change routing (src/orchestrator/pipeline.ts) and workflow-state
// disambiguation (src/linear/workflow.ts). Raw fetch to the Messages API — no
// SDK dependency, matching src/linear/client.ts's raw GraphQL fetch pattern.

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const CLASSIFY_MODEL = "claude-haiku-4-5-20251001";

interface MessagesResponse {
  content?: { type: string; text?: string }[];
}

async function askClassifier(
  apiKey: string,
  system: string,
  userText: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLASSIFY_MODEL,
        max_tokens: 20,
        system,
        messages: [{ role: "user", content: userText.slice(0, 8000) }],
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as MessagesResponse;
    const text = json.content?.find((b) => b.type === "text")?.text;
    return text ? text.trim() : null;
  } catch {
    return null;
  }
}

const INTENT_SYSTEM =
  "Classify the Linear issue or message below as exactly one word. Reply `chat` if it is a question, " +
  'explanation request, or review-only ask that needs no code change (e.g. "explain X", "why does Y ' +
  'happen", "review this diff"). Reply `change` if it asks for a code change, bug fix, feature, or ' +
  "refactor. Reply with exactly one word: chat or change. No punctuation, no other text.";

// ponytail: LLM heuristic, not a hard classifier — same ceiling as
// parseApproval/parseStop in src/linear/context.ts. Upgrade path: a manual
// escalation phrase fallback if misclassification proves costly in practice.
// Any failure (network, bad response, ambiguous reply) defaults to "change" —
// the safer failure mode is the existing plan/approve/implement pipeline, not
// silently answering a real work request as if it were a question.
export async function classifyIntent(
  apiKey: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<"chat" | "change"> {
  const word = await askClassifier(apiKey, INTENT_SYSTEM, text, fetchImpl);
  return word?.toLowerCase().startsWith("chat") ? "chat" : "change";
}

// Disambiguates among 2+ same-category workflow state names (see
// src/linear/workflow.ts). Falls back to the first candidate on any failure or
// unrecognized reply — still a valid state in the right category.
export async function pickWorkflowState(
  apiKey: string,
  transitionLabel: string,
  candidateNames: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const system =
    `A Linear issue is transitioning: "${transitionLabel}". Pick the single best-matching status name ` +
    `from this exact list, reply with that name verbatim and nothing else: ${candidateNames.join(", ")}`;
  const picked = await askClassifier(apiKey, system, transitionLabel, fetchImpl);
  const match = picked ? candidateNames.find((n) => n.toLowerCase() === picked.toLowerCase().trim()) : undefined;
  return match ?? candidateNames[0];
}
