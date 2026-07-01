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

## Development

```bash
npm run dev        # run the server with a file watcher, loading .env
npm run typecheck  # tsc --noEmit
npm test           # run the test suite once
npm run test:watch # run the test suite in watch mode
```
