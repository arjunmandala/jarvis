# Jarvis — Build Plan

A coding agent for the company. A Linear issue gets assigned to Jarvis; Jarvis
clarifies, posts a plan, and on approval writes code, tests it in a sandbox, and
opens a PR for a human to approve.

## Context

We want to automate the ticket → PR loop. The insight that shapes this whole
plan: **most of the pipeline already exists.** The Claude Agent SDK provides the
autonomous loop, file tools, and subagents. The `superpowers` skills provide the
*methodology* — brainstorming, writing-plans, subagent-driven-development,
systematic-debugging, code review. E2B provides the sandbox. Linear provides the
agent surface (assign/mention/comment) via its Agent Interaction SDK.

**Jarvis is glue, not an engine.** We are not writing a planner, a debugger, or a
review engine from scratch — we wire existing pieces together and own the
orchestration, the Linear integration, and the human approval gates.

### Decisions locked

| Decision | Choice | Why |
|---|---|---|
| First deliverable | Thin vertical slice, one repo | Prove the loop end-to-end before hardening |
| Language | TypeScript | Linear SDK + Agent Interaction SDK + Claude Agent SDK are all TS-first |
| Codebase understanding | Agentic search (grep/glob/read) + generated `CLAUDE.md` + prompt caching | Cost scales with what's read per task, **not** repo size; benchmarks beat vector RAG; no sync/staleness infra |
| Vector DB / code index | **No** | Dropped industry-wide for code in 2026 (Claude Code, Cursor, Devin) |
| Code graph (Serena MCP) | Deferred | Optional cost optimizer; add only if the monorepo measurably makes the agent flail |
| Code host | GitHub (assumed) | "Raise a PR" — confirm if GitLab/Bitbucket |

### Cost note (the original concern)

Agentic search does **not** blow up on a huge repo — `grep`/`glob` return matches,
not the repo, so the repo never sits in context. Budget **~$0.5–1 per bug fix,
~$2–4 per feature** (Sonnet/Opus). The dominant cost lever is **prompt caching**
(cache reads = 10% of input price): cache the system prompt, skills, and the
`CLAUDE.md` map so repeated context is a tenth of the price.

---

## Architecture (vertical slice)

```
Linear issue assigned to Jarvis
        │  (AgentSessionEvent webhook: created)
        ▼
┌──────────────────────────────────────────────────────────┐
│ Jarvis service (TypeScript, single web server + worker)   │
│                                                            │
│  1. Webhook receiver  → verify signature, ack <10s        │
│       └─ emit `thought` activity to Linear                │
│  2. Session store (SQLite)  → phase per agentSessionId    │
│  3. Orchestrator  → drives the Claude Agent SDK loop      │
│       ├─ CLARIFY    : ask questions as Linear comments    │
│       ├─ PLAN       : post plan as a Linear artifact      │
│       │              ⟶ WAIT for human approval comment    │
│       ├─ IMPLEMENT  : Agent SDK + superpowers skills,     │
│       │              editing a repo clone inside E2B      │
│       ├─ VERIFY     : run tests / lint / start / curl     │
│       │              in the SAME E2B sandbox; loop on fail │
│       ├─ REVIEW     : review subagent over the diff; fix  │
│       └─ PR         : `gh pr create` ⟶ WAIT for human     │
└──────────────────────────────────────────────────────────┘
        │
        ▼
   GitHub PR  →  human approves & merges
```

### Where code runs

One **E2B sandbox per session**. The repo is cloned into it; the agent's
`Bash`/file edits and all verification (tests, lint, start app, curl) happen
there. Benefits: isolation of untrusted generated code, and test failures feed
straight back into the agent loop as normal tool output (no special plumbing).
The Agent SDK orchestration runs on the Jarvis host and drives the sandbox via
E2B's command/filesystem API.

> `// ponytail:` one sandbox per session, recreated each run. If sandbox spin-up
> latency hurts, pool/warm them later — not now.

---

## Components & ownership

| Component | Build vs. reuse | Notes |
|---|---|---|
| Linear webhook receiver + signature verify | **Build** (small) | `@linear/sdk`; subscribe to Agent session events |
| Agent activities (thought / comment / artifact) | **Reuse** Linear Agent Interaction SDK | Must emit `thought` within 10s of session start |
| Session/phase state | **Build** (tiny) | SQLite, keyed by `agentSessionId`. stdlib-level; no ORM |
| Agent loop, file tools, subagents | **Reuse** Claude Agent SDK (TS) | System prompt + tools + skills + goal |
| Methodology (clarify/plan/debug/review) | **Reuse** `superpowers` skills | brainstorming, writing-plans, subagent-driven-development, systematic-debugging, requesting-code-review |
| Codebase understanding | **Reuse** built-in Grep/Glob/Read + a generated `CLAUDE.md` | No index infra |
| Sandbox exec (tests/lint/curl) | **Reuse** E2B SDK | One sandbox per session |
| PR creation | **Reuse** `gh` CLI (or GitHub MCP) from inside the sandbox | Human approves |

The only real code we own: webhook receiver, session store, orchestrator state
machine, the Linear ⇄ Agent-SDK adapters, and the system prompt.

---

## Human gates (don't skip — these are the trust boundaries)

1. **Plan approval** — Jarvis posts the plan as a Linear artifact and blocks until
   a human approves (approval = a recognized comment/reaction, decided in slice).
2. **PR approval** — Jarvis opens the PR; a human reviews and merges. Jarvis never
   merges.

---

## Phases

### Phase 0 — Skeleton (walking, end-to-end, hardcoded)
- TS service: webhook endpoint, signature verify, `thought` ack within 10s.
- Register the Linear app (OAuth, `app:assignable` + `app:mentionable`, Agent
  session events webhook).
- Hardcode one repo. On assignment, clone into an E2B sandbox, run one command
  (e.g. the test suite), post the result as a Linear comment.
- **Goal:** Linear assignment → sandbox runs → comment appears. Nothing smart yet.

### Phase 1 — Clarify + Plan + gate
- Wire Claude Agent SDK with the `brainstorming` + `writing-plans` skills.
- Read issue + comments via `promptContext`; ask clarifying questions as comments.
- Post the plan as a Linear **artifact**; block on human approval.

### Phase 2 — Implement + Verify loop
- On approval, run `subagent-driven-development` against the repo in the sandbox.
- VERIFY in the same sandbox: tests, lint, start app, curl the new endpoint.
- Feed failures back into the loop (`systematic-debugging`) until green.

### Phase 3 — Review + PR
- Run a review subagent (`requesting-code-review`) over the diff; auto-fix findings.
- `gh pr create`; post the PR link to Linear; close the agent session.

### Phase 4 — Harden (only once the loop works)
- Prompt caching tuned; per-session cost logged to Linear.
- Generate/maintain `CLAUDE.md` for the target repo (architecture map).
- Secrets handling, retries, concurrent sessions, failure reporting.
- **Reassess Serena MCP** here using real token numbers — add only if justified.

---

## Tech stack

- **Runtime:** Node.js + TypeScript
- **Linear:** `@linear/sdk` + Agent Interaction SDK (Developer Preview)
- **Agent:** Claude Agent SDK (TS) — models: Opus 4.8 for hard tasks, Sonnet 4.6 default
- **Skills:** `superpowers` (already installed locally)
- **Sandbox:** E2B SDK
- **State:** SQLite (e.g. `better-sqlite3`)
- **Web:** minimal framework (Hono/Express) — pick the lighter one, no extras
- **PR:** `gh` CLI inside the sandbox

> `// ponytail:` no message queue, no k8s, no microservices in v1. Single process,
> one sandbox per session, SQLite. Scale the orchestration out only when a real
> concurrency limit is hit.

---

## Open items to confirm before Phase 0

1. **Code host** = GitHub? (assumed)
2. **Plan-approval signal** in Linear — what counts as "approved" (specific
   comment text, reaction, status change)?
3. **Secrets** — where do `ANTHROPIC_API_KEY`, `LINEAR_*`, `E2B_API_KEY`, and the
   repo deploy key / GitHub token live (env, vault)?
4. **Target repo** for the slice + its test/lint/start commands.

---

## Verification (how we know the slice works)

End-to-end acceptance for the vertical slice:

1. Create a small Linear issue (e.g. "add a `/health` endpoint returning `{ok:true}`")
   in the test repo and assign it to Jarvis.
2. Jarvis posts a `thought` within 10s, asks clarifying questions if any, then
   posts a plan artifact.
3. A human approves the plan.
4. Jarvis writes the endpoint in an E2B sandbox, runs the test suite + lint, starts
   the app, and `curl`s `/health` — all green in the sandbox logs posted to Linear.
5. A review pass runs; Jarvis opens a GitHub PR with the diff and links it on Linear.
6. The PR shows a working `/health` endpoint; a human merges.

If all six happen without manual intervention between the two gates, the slice is done.

---

## References

- Linear Agents — https://linear.app/developers/agents
- Linear Agent Interaction — https://linear.app/developers/agent-interaction
- Claude Agent SDK — https://code.claude.com/docs/en/agent-sdk/overview
- E2B — https://e2b.dev/docs
- superpowers — https://github.com/obra/superpowers
- (deferred) Serena MCP — https://github.com/oraios/serena
- Cost / prompt caching — https://platform.claude.com/docs/en/build-with-claude/prompt-caching
