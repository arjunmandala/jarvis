# jarvis

A coding agent for the company: a Linear issue gets assigned to Jarvis; Jarvis
talks it through, posts a plan, and once you agree writes code, tests it in a
sandbox, and opens a PR for a human to review and merge.

See [`BUILD_PLAN.md`](./BUILD_PLAN.md) for the full design and task breakdown, and
[`CLAUDE.md`](./CLAUDE.md) for a deeper architecture map (protocol details, phase
state machine, module responsibilities).

```
Linear issue assigned  ──►  webhook  ──►  Orchestrator  ──►  E2B sandbox
                                              │                  │
                              converse ⇄ (answer / websearch / plan)
                                              │                  │  clone repo,
                              ⇩ agent sees the human agree → implement
                                              │                  │  run Claude Agent SDK,
                                          implement  ────────────┤  run tests/lint,
                                              │                  │  git push + gh pr create
                                          GitHub PR  ────────────┘
                                              │
                                          human reviews & merges
```

## Project layout

```
src/
├── index.ts              # entrypoint: load config, start the Hono server
├── server.ts             # Linear webhook receiver + routing + /oauth/callback + /mcp/docs
├── config.ts             # env var loading/validation
├── logger.ts             # console.log/error tag-coloring patch
├── report.ts             # `npm run report` entrypoint
├── report/
│   ├── data.ts           # gathers report data from jarvis.db (failure patterns, economics)
│   └── html.ts           # renders the jarvis-report.html dashboard
├── orchestrator/
│   └── pipeline.ts       # the phase state machine (converse (clarify)→implement→done)
├── agent/
│   ├── tasks.ts          # task builders (map / plan / revise / implement / review / converse)
│   ├── converse.ts       # ACTION protocol parser + Tier 1 (sandboxed) converse task builder
│   ├── host-turn.ts      # Tier 0 (no-sandbox) host-side converse turn
│   ├── classify.ts       # host-side Haiku classifiers (revise-vs-review, workflow state)
│   ├── events.ts         # newline-delimited JSON event parsing
│   └── runner.mjs        # runs INSIDE the E2B sandbox (Claude Agent SDK loop)
├── sandbox/
│   └── session.ts        # E2B lifecycle, host↔sandbox file/stream protocol
├── history/
│   └── history.ts        # same-issue memory: thread text + prior run streams into the sandbox
├── mcp/
│   └── docs-server.ts    # issue-scoped docs MCP (search_documents/get_document/get_thread/get_run_events) over POST /mcp/docs
├── linear/
│   ├── client.ts         # LinearClient + plan/thread/parent-recovery GraphQL queries
│   ├── activities.ts     # thought/action/response/error/elicitation posts
│   ├── context.ts        # webhook payload parsing, stop parsing
│   ├── token-manager.ts  # auto-renewing Linear app-actor OAuth token
│   ├── workflow.ts       # moves the Linear issue's status as phases advance
│   ├── attachments.ts    # downloads Linear file uploads (images/PDFs/files), routed by content type
│   └── docs.ts           # Linear docs GraphQL + up-front doc-context assembly
└── store/
    └── sessions.ts       # SQLite: sessions, repo_maps, runs, run_events, session_events, team_states, oauth_tokens

e2b/build-template.ts   # builds the `jarvis-agent` E2B template (bakes in runner.mjs)
tests/                  # vitest, mirrors src/ layout
```

## Setup

```bash
npm install
cp .env.example .env
# fill in .env with your Linear, Anthropic, E2B, and GitHub credentials
```

| Variable | Purpose |
|---|---|
| `LINEAR_CLIENT_ID` / `LINEAR_CLIENT_SECRET` | Linear OAuth app credentials |
| `LINEAR_WEBHOOK_SECRET` | verifies inbound Linear webhook signatures |
| `LINEAR_ACCESS_TOKEN` | *optional* bootstrap seed only; the live app-actor token is renewed automatically and stored in SQLite (see below) |
| `ANTHROPIC_API_KEY` | Claude Agent SDK calls made inside the sandbox |
| `E2B_API_KEY` / `E2B_TEMPLATE` | sandbox provisioning (`E2B_TEMPLATE=jarvis-agent`) |
| `GH_TOKEN` | clone + push + `gh pr create` against `TARGET_REPO` |
| `TARGET_REPO` | the repo Jarvis works in, `owner/name` |
| `PUBLIC_BASE_URL` | this service's public URL, for the OAuth redirect + webhook delivery |
| `PORT` | server port (default `3000`) |

## Linear OAuth token — automatic renewal

The Linear app-actor token is managed automatically. `LinearTokenManager`
(`src/linear/token-manager.ts`) uses the `client_credentials` grant with your
`LINEAR_CLIENT_ID`/`LINEAR_CLIENT_SECRET` to mint a ~30-day token, persists it in
SQLite (`oauth_tokens` table), renews it a day before expiry (retrying on a bounded
backoff, never crashing), and forces a refresh on any `401`. There is **no** manual
`.env` copy step and no restart.

`LINEAR_ACCESS_TOKEN` in `.env` is optional — a one-time bootstrap seed used only for
the very first run before a token row exists. You can also bootstrap by visiting the
registered app's authorize URL: Linear redirects to `/oauth/callback`, which exchanges
the code and **persists** the token straight to the store (the response page confirms
it's saved and live; the token itself is never logged).

## Deploying runner changes

`src/agent/runner.mjs` executes inside the E2B sandbox, baked into the
`jarvis-agent` template — the host never uploads it at runtime. **Any change to
runner.mjs requires rebuilding the template before (re)starting the host:**

```bash
node --env-file-if-exists=.env e2b/build-template.ts
```

Until the rebuild ships, sandboxes run the old runner. In particular, the
durable-runs recovery path (boot reconciliation reading `/tmp/jarvis-result.json`)
is inert with an old-template runner: interrupted sessions fail loud
("re-assign to retry") instead of recovering.

## Development

```bash
npm run dev        # run the server with a file watcher, loading .env
npm run typecheck  # tsc --noEmit
npm test           # run the test suite once
npm run test:watch # run the test suite in watch mode
npm run report     # failure-pattern + economics report (console + jarvis-report.html)
```
