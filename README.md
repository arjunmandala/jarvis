# jarvis

A coding agent for the company: a Linear issue gets assigned to Jarvis; Jarvis
clarifies, posts a plan, and on approval writes code, tests it in a sandbox,
and opens a PR for a human to approve.

See [`BUILD_PLAN.md`](./BUILD_PLAN.md) for the full design and task breakdown.

## Setup

```bash
npm install
cp .env.example .env
# fill in .env with your Linear, Anthropic, E2B, and GitHub credentials
```

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
