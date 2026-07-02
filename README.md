# jarvis

A coding agent for the company: a Linear issue gets assigned to Jarvis; Jarvis
clarifies, posts a plan, and on approval writes code, tests it in a sandbox,
and opens a PR for a human to approve.

See [`BUILD_PLAN.md`](./BUILD_PLAN.md) for the full design and task breakdown, and
[`CLAUDE.md`](./CLAUDE.md) for a deeper architecture map (protocol details, phase
state machine, module responsibilities).

```
Linear issue assigned  ──►  webhook  ──►  Orchestrator  ──►  E2B sandbox
                                              │                  │
                                        clarify → plan           │  clone repo,
                                              │                  │  run Claude Agent SDK,
                                        ⇩ human approves plan     │  run tests/lint,
                                              │                  │  git push + gh pr create
                                          implement  ─────────────┘
                                              │
                                          GitHub PR  ──►  human reviews & merges
```

## Project layout

```
src/
├── index.ts              # entrypoint: load config, start the Hono server
├── server.ts              # Linear webhook receiver + routing + /oauth/callback
├── config.ts               # env var loading/validation
├── report.ts                # `npm run report` — failure-pattern mining over jarvis.db
├── orchestrator/
│   └── pipeline.ts            # the phase state machine (clarify→plan→implement→done)
├── agent/
│   ├── tasks.ts                 # prompt/task builders (plan / revise / implement / map)
│   ├── events.ts                 # newline-delimited JSON event parsing
│   └── runner.mjs                 # runs INSIDE the E2B sandbox (Claude Agent SDK loop)
├── sandbox/
│   └── session.ts                  # E2B lifecycle, host↔sandbox file/stream protocol
├── linear/
│   ├── client.ts                    # LinearClient + plan-recovery GraphQL query
│   ├── activities.ts                 # thought/action/response/error/elicitation posts
│   └── context.ts                     # webhook payload parsing, approve/stop parsing
└── store/
    └── sessions.ts                    # SQLite: sessions, repo_maps, runs, run_events

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
| `LINEAR_ACCESS_TOKEN` | app-actor OAuth token, captured once via `/oauth/callback` (see below) |
| `ANTHROPIC_API_KEY` | Claude Agent SDK calls made inside the sandbox |
| `E2B_API_KEY` / `E2B_TEMPLATE` | sandbox provisioning (`E2B_TEMPLATE=jarvis-agent`) |
| `GH_TOKEN` | clone + push + `gh pr create` against `TARGET_REPO` |
| `TARGET_REPO` | the repo Jarvis works in, `owner/name` |
| `PUBLIC_BASE_URL` | this service's public URL, for the OAuth redirect + webhook delivery |
| `PORT` | server port (default `3000`) |

## One-time Linear OAuth capture

After registering the Linear app, visit the app's authorize URL to grant it
access. Linear redirects to `/oauth/callback`, which exchanges the code for
an access token and displays `LINEAR_ACCESS_TOKEN=...` once in the response
body — copy that value into `.env` as `LINEAR_ACCESS_TOKEN` and restart the
server. The token is never written to the server logs, so this response page
is the only place you can retrieve it.

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
```
