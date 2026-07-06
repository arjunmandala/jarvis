# Fluid conversational planning: replace the regex approval gate with a self-directing agent

Date: 2026-07-06
Status: approved design, pre-implementation

## Problem

Jarvis feels mechanical, not like a dev you talk to. The root cause is that the
planning conversation is run by a keyword state machine, not by a mind holding the
thread:

- **Approval is a regex.** `parseApproval`/`parseStop` (`src/linear/context.ts:50-68`)
  decide the `await_approval → implement` transition by matching `\b(approve|lgtm|
  ship it)\b`. "yeah go for it", "fine do it", a plan question, or a correction all
  fall into the same `else` bucket and get force-fed to `reviseTask`, which *rewrites
  the plan* even when the human only asked a question.
- **Every reply is re-classified in isolation.** `onPrompted` (`pipeline.ts:605`)
  and the `clarify`-phase `classifyIntent` fork treat each message as a fresh bucketing
  problem. Nothing holds the conversation — it's amnesiac between replies.
- **It's passive.** It waits at gates; it never asks a follow-up, pushes back, or
  decides on its own to go look at the code before answering.

The `ponytail:` comment already at `context.ts:46` names the ceiling and the upgrade
path ("a tiny classifier call if false signals cause real trouble"). This design takes
that upgrade further than a classifier: it dissolves the gate into agent judgment.

## What we're building

One conversational agent holds the entire pre-implementation thread. It decides, per
reply, whether to answer from context, websearch, go read the code, revise the plan,
or **start implementing** — with no regex and no separate router. The human never types
a magic word; the agent recognizes agreement the way a colleague does.

This is the **b2** decision from brainstorming: **the agent decides when the plan is
ironed out and calls `implement` itself.** There is no structural `await_approval` gate.
This deliberately loosens the "Plan approval" human gate in CLAUDE.md from a
*deterministic keyword check* to *agent discretion* — see Risks.

The PR-merge human gate is **untouched**: Jarvis still opens PRs and never merges.

## Architecture

### One agent, one `session_id`, two execution tiers

The agent is a single persona with continuous memory. Each incoming reply runs one turn,
in one of two tiers that **the agent selects itself** by what it does:

```
reply arrives
  → Tier 0: host-side turn (no sandbox), resume session_id
      tools = { reply, websearch, webfetch, ask_clarifying, need_repo }
      if the turn just replies/searches → post it, done. No sandbox.
      if the turn emits `need_repo` or decides to implement → escalate:
  → Tier 1: sandbox turn — clone repo, resume the SAME session_id
      tools = full ALL_REPO_TOOLS (Read/Grep/serena/Bash/Edit/Write/…)
      answers code questions, revises the plan, or runs implement.
```

Routing is one line host-side, not a classifier:

```
if turn.action in { need_repo, implement }: run Tier 1
else: post turn.reply
```

`need_repo` is the dev pulling up the code. The agent chooses the tier by acting; the
host only reacts to the structured action it emits.

### The split line is the trust boundary

Tier 0 runs the Agent SDK **on the host** (the SDK does not require E2B — sandboxing
exists to isolate *untrusted generated code*, and a reason-or-websearch turn executes
none). The hard rule that makes this safe:

> **Tier 0's toolset must never include Bash/Edit/Write or any repo-touching tool.**

Anything that runs code or edits the repo → Tier 1 (sandbox). Pure reasoning + web →
Tier 0 (host). This one line is simultaneously the security boundary and the cost
boundary — that's why the split is principled, not a latency hack.

### Two memories, one authoritative

| Store | Role | Availability |
|---|---|---|
| **Linear thread** (`makeThreadFetcher`) | **canonical** conversation | always, host-side, cheap |
| **SDK `session_id` transcript** | accelerator: the agent's private reasoning | only when resumed |

Every turn (either tier) already gets the Linear thread fed in as context. So Tier 0
answering three questions without ever resuming the transcript cannot cause drift: when
a Tier 1 turn finally resumes the transcript, the thread backfills anything it missed.
The two stores never need transactional sync — one is authoritative, the other is a
cache. This is what lets Tier 0 skip the SDK-session machinery entirely for simple
replies.

### Capturing `session_id` (the C-ready seam)

`runner.mjs` already emits `session_id` on the result (`runner.mjs:200`) and currently
discards it. This design **persists it as a new `sdkSessionId` column on `sessions`** and resumes it
across re-assignments via the existing `findResumableByIssue` lookup (which already
returns the latest prior session for an issue) — no new table. It is passed back into the
SDK on the next turn to resume. This is the single new capability the whole design rests on, and it is also
exactly what a future "extend the conversation across implement/review" (option C from
brainstorming) would need — so building it now makes C a continuation, not a migration.
C is explicitly **out of scope** here; we stop the persistent conversation at the
plan/implement boundary.

## State machine changes

`clarify` and `await_approval` **collapse into one conversational phase** (reuse
`clarify`; retire `await_approval` as a resting state). The phase no longer gates on a
keyword:

```
BEFORE:  clarify → plan → await_approval ⇄ plan → implement → done
AFTER:   converse (clarify) ──[agent calls implement]──> implement → done
                 └── stays in converse across answers, searches, plan revisions ──┘
```

- `onCreated`: start the conversation (post the agent's opening turn — a plan, a
  question, or an answer, as it decides). No forced `planTask`.
- `onPrompted`: append the reply, run one turn (Tier 0 first). Delete the
  `parseApproval`/`parseStop`/`reviseTask` three-way branch entirely.
- `steer` (mid-run comment while Tier 1 is live): unchanged — still injects into the
  live sandbox via the inbox.
- Decomposition, resume (`findResumableByIssue`), and the done-session follow-up split
  remain, but the follow-up `revise`/`review` classifier is superseded by the same
  agent turn (it decides).

`parseStop` is **kept** — an explicit "stop/cancel" is a deterministic kill of a live
run and should not depend on agent judgment. `parseApproval` is **deleted**.

## Error handling

- **Tier 0 host turn fails** (SDK/API error): fail soft to posting an apology activity
  and leaving the phase in `converse`; the human can reply again. Never silently drop —
  a webhook that emits nothing trips Linear's 10s unresponsive rule (existing invariant).
- **`session_id` resume fails / transcript gone**: fall back to a fresh session seeded
  with the Linear thread (which is canonical anyway). Log `[session] resume miss`. The
  conversation degrades to thread-only memory, never breaks.
- **b2 false-positive guard**: the agent's `implement` action is only honored if a plan
  has been posted to the thread at least once (it cannot implement a plan the human
  never saw). When the agent is *unsure* whether the human agreed, its instruction is to
  `ask_clarifying`, not to implement. This is the one behavioral guardrail on removing
  the deterministic gate — see Risks.
- **Per-issue lock**: two replies arriving close together must not both resume the same
  `session_id`. Reuse/extend the existing in-memory `inflight` set, keyed by `issueId`,
  to serialize turns per issue.

## Testing

- **Unit (host-side, no sandbox — matches existing suite conventions):**
  - Tier-0 routing: a turn emitting `reply` posts and does not spin a sandbox; a turn
    emitting `need_repo`/`implement` escalates. (Fake the SDK turn result.)
  - `implement` action ignored when no plan has been posted yet (false-positive guard).
  - `parseStop` still kills a live run; `parseApproval` is gone (delete its tests).
  - Session resume: a saved `session_id` is passed on the next turn; a resume miss falls
    back to thread-only without throwing.
- **Conversation fidelity**: a scripted thread — question → answer (Tier 0, no sandbox)
  → correction → revised plan (Tier 1) → "yeah do it" (implement) — asserts the phase
  path and that only the code-touching turns used a sandbox.
- E2B `AgentSandbox` faked via the existing structural interface; no real network.

## Out of scope

- **Option C** (persistent conversation across implement/review). The `session_id` seam
  is built for it; extending past the plan boundary is a later, separate spec.
- Sandbox pooling / warm sandboxes (still `ponytail:` deferred).
- Cross-issue memory.

## Risks

- **b2 loosens a documented human gate.** CLAUDE.md lists "Plan approval" as a gate not
  to bypass in code. This design bypasses the *deterministic* form of it by the user's
  explicit request, replacing it with agent discretion + the false-positive guard above.
  The failure mode to watch: the agent starts implementing when the human was still
  thinking. Mitigations are the plan-must-exist gate and the ask-when-unsure instruction;
  there is no deterministic backstop by design. This is a deliberate, owner-approved
  trade of determinism for conversational feel.
- **Cost/latency of resume.** Tier 1 turns resume a growing transcript; lean on SDK
  context compaction. Tier 0 keeps the common case off the sandbox entirely, which is
  the primary cost control.
- **Two runtimes for one agent.** Running the SDK host-side (Tier 0) and in-sandbox
  (Tier 1) means two execution paths for one persona. The tool-split rule keeps them
  honest, but it is the main added complexity to keep an eye on.
