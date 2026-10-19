# Jarvis

<p align="center"><img src="assets/banner.png" alt="Jarvis" width="720"></p>

A coding agent that works from Linear. Assign a Linear issue to Jarvis and it
talks the issue through with you, posts a plan, and once you agree, writes the
code and tests it in an isolated E2B sandbox, then opens a GitHub pull request.
A human always reviews and merges; Jarvis never merges.

Jarvis does not reimplement a planner, debugger or review engine. It wires
together the **Claude Agent SDK** (the autonomous loop), **E2B** (sandboxing),
**Linear** (the agent surface) and **GitHub** (the PR). The code in this repo is
the webhook receiver, the session store, the orchestrator state machine, the
Linear ⇄ Agent SDK adapters and the system prompts.

```
Linear issue assigned ──► webhook ──► Orchestrator ──► E2B sandbox
                                          │                │
                          converse ⇄ (answer / web search / plan)
                                          │                │  clone repo,
                          human agrees to the plan → implement
                                          │                │  run Claude Agent SDK,
                                      implement ───────────┤  run tests/lint,
                                          │                │  git push + gh pr create
                                      GitHub PR ───────────┘
                                          │
                                  human reviews & merges
```

## Features

- **Conversational planning in Linear.** Each turn either answers, searches the
  web, drafts/revises a plan, or decides that a posted plan has been agreed.
  Cheap turns run host-side with no sandbox; turns that need the code run in a
  sandbox with the repo cloned.
- **Deterministic phase state machine** (`clarify → implement → done`, plus
  `review` and `error`), stored in SQLite and keyed by Linear's agent session.
  Jarvis refuses to implement a plan the human never saw, and a `stop` reply
  kills the run.
- **One E2B sandbox per run.** All edits, tool calls and verification
  (tests, lint, start, curl) happen inside the sandbox, not on the host.
- **Live steering.** Comments posted while a run is in progress are injected
  into the running agent; answers to the agent's questions go the same way.
- **Durable, resumable runs.** Work is pushed to a deterministic
  `jarvis/<issueId>` branch after each meaningful step. After a crash or restart,
  Jarvis reattaches to the sandbox or resumes from the saved plan and the pushed
  branch instead of starting over.
- **PR follow-ups.** Replies on a finished issue are classified as a change
  request (update the open PR in place) or a question/review request
  (report only).
- **Model routing and budgets.** Small changes go to a cheaper model, large or
  refactor work to a stronger one, each with turn and cost caps.
- **Context from Linear.** Pasted files (images, PDFs, other files), Linear
  documents and the issue's conversation history are passed to the agent. An
  issue-scoped docs MCP endpoint lets the sandbox fetch more on demand; the
  Linear OAuth token never enters the sandbox.
- **Issue status sync.** Moves the Linear issue's workflow state as phases
  advance.
- **Telemetry and reporting.** Every run's cost, tokens, outcome and raw event
  stream are stored; `npm run report` produces a failure-pattern and cost report
  (console + `jarvis-report.html`).
- **Automatic Linear token renewal** via the `client_credentials` grant,
  persisted in SQLite and refreshed on expiry or any `401`.

## Stack

TypeScript on Node.js 24 (`node:sqlite`, no build step), Hono, Claude Agent SDK,
E2B, Linear SDK + GraphQL, GitHub CLI, SQLite, Vitest.

## Project layout

```
src/
├── index.ts              # entrypoint: load config, start the Hono server
├── server.ts             # /webhook (Linear), /oauth/callback, /mcp/docs, /health
├── config.ts             # env var loading/validation
├── orchestrator/
│   └── pipeline.ts       # phase state machine, resume/reconcile, steering
├── agent/
│   ├── tasks.ts          # task builders (map / plan / revise / implement / review)
│   ├── converse.ts       # ACTION protocol parser + sandboxed converse task
│   ├── host-turn.ts      # host-side (no sandbox) converse turn
│   ├── classify.ts       # small host-side classifiers (revise vs review, workflow state)
│   ├── events.ts         # newline-delimited JSON event parsing
│   └── runner.mjs        # runs INSIDE the E2B sandbox (Claude Agent SDK loop)
├── sandbox/session.ts    # E2B lifecycle, host ⇄ sandbox file/stream protocol
├── history/history.ts    # same-issue memory for each run
├── mcp/docs-server.ts    # issue-scoped docs MCP over POST /mcp/docs
├── linear/               # client, activities, webhook context, token manager,
│                         # workflow status, attachments, docs
├── store/sessions.ts     # SQLite tables: sessions, runs, run events, tokens, ...
├── report.ts, report/    # `npm run report`
e2b/build-template.ts     # builds the `jarvis-agent` E2B template (bakes in runner.mjs)
vendor/                   # agent skills baked into the sandbox template
tests/                    # Vitest, mirrors src/
```

[`CLAUDE.md`](./CLAUDE.md) has the detailed architecture: request flow, the
host ⇄ sandbox protocol, task table, persistence and conventions.

## Setup

Prerequisites: Node.js ≥ 24.15, an E2B account, an Anthropic API key, a GitHub
token that can push to and open PRs on the target repo, and a Linear OAuth app
with agent (app actor) access.

```bash
npm install
cp .env.example .env      # fill in the values below; never commit .env
node --env-file-if-exists=.env e2b/build-template.ts   # build the jarvis-agent sandbox template
npm start
```

Expose the server at `PUBLIC_BASE_URL` and point the Linear app's webhook at
`<PUBLIC_BASE_URL>/webhook` and its OAuth redirect at
`<PUBLIC_BASE_URL>/oauth/callback`.

### Environment variables

| Variable | Purpose |
|---|---|
| `LINEAR_CLIENT_ID` / `LINEAR_CLIENT_SECRET` | Linear OAuth app credentials (also used for automatic token renewal) |
| `LINEAR_WEBHOOK_SECRET` | verifies inbound Linear webhook signatures |
| `LINEAR_ACCESS_TOKEN` | optional one-time bootstrap token; the live token is renewed automatically and stored in SQLite |
| `ANTHROPIC_API_KEY` | Claude Agent SDK calls inside the sandbox and host-side classifiers |
| `E2B_API_KEY` | sandbox provisioning |
| `E2B_TEMPLATE` | sandbox template name (`jarvis-agent`) |
| `GH_TOKEN` | clone, push and `gh pr create` on `TARGET_REPO` |
| `TARGET_REPO` | the repo Jarvis works in, `owner/name` |
| `PUBLIC_BASE_URL` | this service's public URL (OAuth redirect + webhook) |
| `PORT` | server port (default `3000`) |

See [`.env.example`](./.env.example) for a template with placeholders.

### Changing the sandbox runner

`src/agent/runner.mjs` is baked into the `jarvis-agent` E2B template; the host
does not upload it at runtime. After changing it, rebuild the template before
restarting the host:

```bash
node --env-file-if-exists=.env e2b/build-template.ts
```

## Development

```bash
npm run dev        # server with file watcher, loads .env
npm run typecheck  # tsc --noEmit
npm test           # Vitest suite (E2B and network are faked; no real calls)
npm run test:watch
npm run report     # failure-pattern + cost report
```

## Third-party skills

`vendor/` contains agent skills that are copied into the sandbox, from
[obra/superpowers](https://github.com/obra/superpowers),
[getponytail/ponytail](https://github.com/getponytail/ponytail) and Anthropic's
`frontend-design` skill (Apache 2.0, see its `LICENSE.txt`). They remain under
their original licenses.
