import { query } from "@anthropic-ai/claude-agent-sdk";
import type { IssueContext } from "../linear/context.ts";
import { issueBlock, historyBlock } from "./tasks.ts";
import { CONVERSE_APPEND, parseConverseAction, type ConverseAction } from "./converse.ts";

// The only tools a host turn may use: web lookups. NEVER add Bash/Edit/Write —
// this SDK call runs on the host, not in the sandbox, so a repo/exec tool would
// execute against the host filesystem. Enforced by BOTH the allowlist and the
// canUseTool deny gate below (defense in depth).
const HOST_TOOLS = ["WebSearch", "WebFetch"];
const HOST_TOOLS_SET = new Set(HOST_TOOLS);

export interface HostTurnResult {
  text: string;
  action: ConverseAction;
  body: string;
  sessionId: string | null;
  costUsd: number | null;
}

type SdkMessage = {
  type: string;
  subtype?: string;
  result?: string | null;
  total_cost_usd?: number | null;
  session_id?: string | null;
  message?: { content?: { type: string; text?: string }[] };
};
type QueryFn = (args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<SdkMessage>;

// Tier 0: run one conversational turn in-process on the host with no sandbox and
// a web-only toolset. Returns the parsed ACTION. If the agent needs the repo it
// returns action="need_repo" and the caller escalates to a Tier 1 sandbox turn.
export async function runHostTurn(opts: {
  apiKey: string;
  ctx: IssueContext;
  userMessage: string;
  history?: string;
  queryFn?: QueryFn;
}): Promise<HostTurnResult> {
  const run = opts.queryFn ?? (query as unknown as QueryFn);
  const prompt =
    `The human's latest message:\n${opts.userMessage}\n\n` +
    `Respond per the PROTOCOL. You do NOT have repo access in this turn — if you must read the code to ` +
    `answer or plan, emit ACTION: need_repo.\n\n---\n${issueBlock(opts.ctx)}${historyBlock(opts.history)}`;

  process.env.ANTHROPIC_API_KEY = opts.apiKey; // SDK reads it from env, same as the sandbox runner

  let finalText = "";
  let sessionId: string | null = null;
  let costUsd: number | null = null;

  for await (const message of run({
    prompt,
    options: {
      model: "claude-sonnet-5",
      systemPrompt: { type: "preset", preset: "claude_code", append: CONVERSE_APPEND, excludeDynamicSections: true },
      allowedTools: HOST_TOOLS,
      permissionMode: "default",
      canUseTool: async (name: string) =>
        HOST_TOOLS_SET.has(name) ? { behavior: "allow" as const } : { behavior: "deny" as const },
      maxTurns: 8,
      maxBudgetUsd: 0.5,
      effort: "medium",
    },
  })) {
    if (message.type === "assistant") {
      for (const block of message.message?.content ?? []) {
        if (block.type === "text" && block.text) finalText = block.text;
      }
    } else if (message.type === "result") {
      if (message.subtype === "success" && typeof message.result === "string") finalText = message.result;
      costUsd = message.total_cost_usd ?? null;
      sessionId = message.session_id ?? null;
    }
  }

  const { action, body } = parseConverseAction(finalText);
  return { text: finalText, action, body, sessionId, costUsd };
}
