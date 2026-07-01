# Jarvis Vertical Slice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A TypeScript service that, when a Linear issue is assigned to it, clarifies, posts a plan for human approval, then (on approval) writes code + tests inside an E2B sandbox, verifies it, and opens a GitHub PR — driving the Claude Agent SDK and `superpowers` skills, with two human gates (plan approval, PR merge).

**Architecture:** Single Node process. Hono receives Linear `AgentSessionEvent` webhooks → verifies signature, posts a `thought` within 10s, persists phase in `node:sqlite`, and runs a phase pipeline. **Each agent run happens inside a fresh E2B sandbox** (the repo is cloned in, the Claude Agent SDK runs *there*, all edits/tests/curl/`gh` happen there). The host launches the in-sandbox agent via `commands.run`, parses its newline-delimited JSON output, and maps each event to a Linear agent activity. Human gates: plan posted as an `elicitation` (resume on the user's reply), PR opened with `gh` (a human merges).

**Tech Stack:** Node.js 24 LTS + TypeScript (native type stripping), Hono + `@hono/node-server`, `@linear/sdk` (Agent Interaction), `e2b` SDK, `@anthropic-ai/claude-agent-sdk` (runs inside the sandbox), `node:sqlite`, `node:crypto`, Vitest. Models: `claude-sonnet-5` default, `claude-opus-4-8` for hard tasks.

---

## Why this architecture (verified findings that shape it)

Every external fact below was verified against official docs during planning (mid-2026). Read these before starting — several contradict first instincts.

| Finding | Source | Consequence for the build |
|---|---|---|
| The Claude Agent SDK (`query()`) **spawns a local `claude` CLI subprocess** and operates on the **local** `cwd`. It is **not** a remote-filesystem client; there is no option to point it at an E2B filesystem over the network. | `code.claude.com/docs/en/agent-sdk/hosting` | The agent **runs inside the sandbox**, not on the host. The host launches it via `commands.run` and streams its stdout. This is the opposite of BUILD_PLAN.md's "Agent SDK drives the sandbox via E2B's API" sentence — that sentence is wrong; correct it. |
| The Agent SDK **bundles a platform-native Claude Code binary** as an optional dependency; "you don't need to install Claude Code separately." Needs **Node 18+**. | `…/agent-sdk/overview` | The sandbox only needs Node + `npm i @anthropic-ai/claude-agent-sdk`. No separate CLI install. |
| Default `systemPrompt` is **minimal** (tool-calling only) — it does NOT include Claude Code's coding/safety guidance. Use `systemPrompt: { type: "preset", preset: "claude_code", append: "…" }`. | `…/agent-sdk/modifying-system-prompts` | The runner must use the `claude_code` preset, or the agent loses coding behaviour. |
| Skills load **only from the filesystem** (`~/.claude/skills`, `./.claude/skills`) and **only when `settingSources` includes `'user'`/`'project'`**. There is no programmatic skill-registration API. | `…/agent-sdk/skills` | `superpowers` skills must be **baked into the sandbox** at `/home/user/.claude/skills`, and the runner must pass `settingSources: ["user","project"]`. |
| `commands.run` **throws `CommandExitError` on non-zero exit** (no `throwOnExitCode:false` option). | `e2b` SDK source (`commandHandle.ts`) | Wrap verification commands in try/catch on `CommandExitError`; let the *in-sandbox agent* see failures via its own Bash tool. |
| Default sandbox `timeoutMs` is **5 min** (max 1h Hobby / 24h Pro). | `e2b` SDK reference v1.13.0 | A sandbox cannot survive a human-approval wait. **One sandbox per agent run, not per session.** Phase state lives in SQLite across sandbox lifetimes. (Spec's "one sandbox per session" → "per agent run"; ponytail: pool/warm later.) |
| Linear plan approval has **no boolean/reaction API** — approval is **free-text in the `prompted` reply**, which we parse. | `linear.app/developers/agent-interaction` | Post the plan as an `elicitation`; on the next `prompted` event, parse `agentActivity.body` for an affirmative. |
| Webhook must be **ACKed within 5s**; an agent must **emit an activity within 10s** of `created` or be marked unresponsive. | `linear.app/developers/webhooks`, `/agents` | The webhook handler posts a `thought` (fast) then kicks the pipeline **without awaiting it**, and returns 200. |
| `@linear/sdk` ships `LinearWebhookClient` (`@linear/sdk/webhooks`) that verifies `Linear-Signature` (HMAC-SHA256 over the **raw** body) and dispatches `handler.on("AgentSessionEvent", cb)`. | `linear/weather-bot` sample | Use it — don't hand-roll verification for the primary path. Pass Hono's `c.req.raw` (raw, unconsumed body). |
| `node:sqlite` (`DatabaseSync`) is built-in, **RC on Node 24** (no flag since v24.15.0); native TS stripping is **Stable on Node 24** (v24.12.0+). | `nodejs.org/api/sqlite.html`, `…/typescript.html` | Use Node ≥24.15, `node:sqlite` (zero native dep), `node --watch src/index.ts` (no `tsx`). `better-sqlite3` v12+ is the fallback if RC is unacceptable. |
| `claude-sonnet-5` is the current Sonnet ID; `claude-opus-4-8` current Opus. | `platform.claude.com/…/models/overview` | BUILD_PLAN.md's "Sonnet 4.6" is stale → `claude-sonnet-5`. |

---

## Global Constraints

Every task's requirements implicitly include this section. Exact values, verbatim:

- **Runtime:** Node.js **≥ 24.15.0** (`node:sqlite` RC available without a flag; TS stripping Stable). `package.json` → `"engines": { "node": ">=24.15.0" }`, `"type": "module"`.
- **Dependencies (host), pinned floors:** `@linear/sdk@^87.0.0`, `e2b@^2.31.0`, `hono@^4.12.27`, `@hono/node-server@^2.0.6`. Dev: `vitest@^4.1.9`, `typescript@^5.8.0`, `@types/node@^24`.
- **Dependency (in-sandbox only, baked into the E2B template):** `@anthropic-ai/claude-agent-sdk@^0.3.197`. **Never imported by host code.**
- **No new deps for what stdlib covers:** webhook signature verify uses `node:crypto`; state store uses `node:sqlite`; env loading uses `node --env-file-if-exists=.env`. Do not add `dotenv`, `express`, `better-sqlite3`, `tsx`, or an HMAC library unless a task explicitly calls for it.
- **Models:** default `claude-sonnet-5`; `claude-opus-4-8` only where a task says "hard task". Never invent date-suffixed IDs.
- **Linear OAuth scopes (exact strings):** `read,write,app:assignable,app:mentionable`. Install via `actor=app` (requires a workspace admin).
- **TS config:** `module`/`moduleResolution` = `nodenext`, `target`/`lib` = `es2024`, `strict`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `rewriteRelativeImportExtensions`, `outDir: dist`, `rootDir: src`. (Native stripping erases types only — `tsc --noEmit` is the type-check; the runner has no enums/decorators.)
- **Secrets via env only (v1):** `LINEAR_ACCESS_TOKEN`, `LINEAR_WEBHOOK_SECRET`, `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `ANTHROPIC_API_KEY`, `E2B_API_KEY`, `GH_TOKEN`, `TARGET_REPO` (e.g. `owner/name`), `E2B_TEMPLATE` (template id), `PUBLIC_BASE_URL`. No vault in v1 (ponytail: env now, vault in Phase 4).
- **Two human gates are non-negotiable:** (1) plan approval before any code is written; (2) a human merges the PR. Jarvis never merges.
- **Imports use explicit extensions** (`./foo.ts`) per `nodenext` + native stripping.

---

## File Structure

Each file has one responsibility. Host code never imports `@anthropic-ai/claude-agent-sdk` — only `src/agent/runner.mjs` (which runs inside the sandbox) does.

```
jarvis/
  package.json
  tsconfig.json
  .gitignore
  .env.example
  README.md
  src/
    index.ts              # entrypoint: validate config, start the server
    config.ts             # load + validate env into a typed Config; throws on missing
    server.ts             # Hono app: GET /health, POST /webhook, GET /oauth/callback
    linear/
      client.ts           # LinearClient factory (OAuth accessToken)
      activities.ts       # post{Thought,Action,Response,Error,Elicitation} wrappers
      context.ts          # extract issue/comment text from payload; parseApproval(text)
    store/
      sessions.ts         # node:sqlite store: phase + metadata keyed by agentSessionId
    sandbox/
      session.ts          # E2B create/clone/kill; writeTaskFile; runAgent(streaming)
    agent/
      runner.mjs          # IN-SANDBOX: calls query(), prints JarvisEvent JSON lines
      events.ts           # HOST: stream-json line parser → typed JarvisEvent[]
      tasks.ts            # build the AgentTask (goal, systemAppend, model, tools) for plan/implement
    orchestrator/
      pipeline.ts         # phase machine: CLARIFY→PLAN→AWAIT_APPROVAL→IMPLEMENT→DONE
  e2b/
    build-template.ts     # one-off: build the custom E2B template (node, git, gh, SDK, skills)
  tests/                  # mirrors src/ (Vitest)
    config.test.ts
    linear/context.test.ts
    linear/activities.test.ts
    store/sessions.test.ts
    agent/events.test.ts
    agent/tasks.test.ts
    orchestrator/pipeline.test.ts
```

---

# Phase 0 — Walking skeleton (no agent yet)

**Goal:** Linear assignment → sandbox clones the repo and runs one command → result posted as a Linear comment. Proves webhook auth, the 10s ack, E2B lifecycle, and Linear activities end-to-end.

---

### Task 0.1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `README.md`

**Interfaces:**
- Produces: an installable, type-checkable project. `npm run typecheck`, `npm test`, `npm run dev` defined.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "jarvis",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24.15.0" },
  "scripts": {
    "dev": "node --env-file-if-exists=.env --watch src/index.ts",
    "start": "node --env-file-if-exists=.env src/index.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@hono/node-server": "^2.0.6",
    "@linear/sdk": "^87.0.0",
    "e2b": "^2.31.0",
    "hono": "^4.12.27"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.8.0",
    "vitest": "^4.1.9"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "es2024",
    "lib": ["es2024"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "rewriteRelativeImportExtensions": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "e2b/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: Write `.gitignore`**

```gitignore
node_modules/
dist/
.env
*.db
*.db-journal
```

- [ ] **Step 4: Write `.env.example`**

```bash
# Linear (from the OAuth app you register; LINEAR_ACCESS_TOKEN is captured via /oauth/callback once)
LINEAR_CLIENT_ID=
LINEAR_CLIENT_SECRET=
LINEAR_WEBHOOK_SECRET=
LINEAR_ACCESS_TOKEN=
# Anthropic / E2B / GitHub
ANTHROPIC_API_KEY=
E2B_API_KEY=
E2B_TEMPLATE=jarvis-agent
GH_TOKEN=
# Target repo for the slice, "owner/name"
TARGET_REPO=
# Public URL of this service (for the OAuth redirect + Linear webhook), e.g. https://jarvis.example.com
PUBLIC_BASE_URL=
PORT=3000
```

- [ ] **Step 5: Write a minimal `README.md`** documenting `npm install`, env setup, `npm run dev`, and a pointer to this plan.

- [ ] **Step 6: Install and verify the toolchain**

Run: `npm install && npm run typecheck`
Expected: install succeeds; `tsc --noEmit` prints nothing and exits 0 (no source files yet to fail).

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json .gitignore .env.example README.md package-lock.json
git commit -m "chore: scaffold jarvis project"
```

---

### Task 0.2: Typed config loader

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `export interface Config { port: number; linear: { accessToken: string; webhookSecret: string; clientId: string; clientSecret: string }; anthropicApiKey: string; e2bApiKey: string; e2bTemplate: string; ghToken: string; targetRepo: string; publicBaseUrl: string }` and `export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config` (throws `Error` listing every missing required var).

- [ ] **Step 1: Write the failing test**

```ts
// tests/config.test.ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.ts";

const full = {
  LINEAR_ACCESS_TOKEN: "tok", LINEAR_WEBHOOK_SECRET: "whsec",
  LINEAR_CLIENT_ID: "cid", LINEAR_CLIENT_SECRET: "csec",
  ANTHROPIC_API_KEY: "ak", E2B_API_KEY: "ek", E2B_TEMPLATE: "jarvis-agent",
  GH_TOKEN: "gh", TARGET_REPO: "owner/name", PUBLIC_BASE_URL: "https://x", PORT: "8080",
};

describe("loadConfig", () => {
  it("parses a full env", () => {
    const c = loadConfig(full);
    expect(c.port).toBe(8080);
    expect(c.linear.accessToken).toBe("tok");
    expect(c.targetRepo).toBe("owner/name");
  });

  it("defaults port to 3000", () => {
    const { PORT, ...noPort } = full;
    expect(loadConfig(noPort).port).toBe(3000);
  });

  it("throws listing every missing var", () => {
    expect(() => loadConfig({})).toThrowError(/LINEAR_ACCESS_TOKEN/);
    expect(() => loadConfig({})).toThrowError(/TARGET_REPO/);
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `loadConfig` not found / module missing.

- [ ] **Step 3: Implement `src/config.ts`**

```ts
export interface Config {
  port: number;
  linear: { accessToken: string; webhookSecret: string; clientId: string; clientSecret: string };
  anthropicApiKey: string;
  e2bApiKey: string;
  e2bTemplate: string;
  ghToken: string;
  targetRepo: string;
  publicBaseUrl: string;
}

const REQUIRED = [
  "LINEAR_ACCESS_TOKEN", "LINEAR_WEBHOOK_SECRET", "LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET",
  "ANTHROPIC_API_KEY", "E2B_API_KEY", "E2B_TEMPLATE", "GH_TOKEN", "TARGET_REPO", "PUBLIC_BASE_URL",
] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
  return {
    port: env.PORT ? Number(env.PORT) : 3000,
    linear: {
      accessToken: env.LINEAR_ACCESS_TOKEN!,
      webhookSecret: env.LINEAR_WEBHOOK_SECRET!,
      clientId: env.LINEAR_CLIENT_ID!,
      clientSecret: env.LINEAR_CLIENT_SECRET!,
    },
    anthropicApiKey: env.ANTHROPIC_API_KEY!,
    e2bApiKey: env.E2B_API_KEY!,
    e2bTemplate: env.E2B_TEMPLATE!,
    ghToken: env.GH_TOKEN!,
    targetRepo: env.TARGET_REPO!,
    publicBaseUrl: env.PUBLIC_BASE_URL!,
  };
}
```

> Note: `LINEAR_ACCESS_TOKEN` is required at runtime but is captured once via `/oauth/callback` (Task 0.7). For early development before you have it, set a placeholder; webhook handling that uses it will only run on real events.

- [ ] **Step 4: Run the test; verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: typed config loader with required-var validation"
```

---

### Task 0.3: SQLite session store

**Files:**
- Create: `src/store/sessions.ts`
- Test: `tests/store/sessions.test.ts`

**Interfaces:**
- Produces:
  - `export type Phase = "clarify" | "plan" | "await_approval" | "implement" | "done" | "error";`
  - `export interface SessionRow { agentSessionId: string; phase: Phase; issueId: string | null; updatedAt: string }`
  - `export class SessionStore { constructor(path: string); upsert(agentSessionId: string, phase: Phase, issueId?: string | null): void; get(agentSessionId: string): SessionRow | undefined; setPhase(agentSessionId: string, phase: Phase): void; close(): void }`
- Uses `node:sqlite` `DatabaseSync`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/store/sessions.test.ts
import { describe, it, expect } from "vitest";
import { SessionStore } from "../../src/store/sessions.ts";

describe("SessionStore", () => {
  it("upserts and reads phase", () => {
    const s = new SessionStore(":memory:");
    s.upsert("as_1", "clarify", "iss_1");
    expect(s.get("as_1")?.phase).toBe("clarify");
    expect(s.get("as_1")?.issueId).toBe("iss_1");
    s.setPhase("as_1", "plan");
    expect(s.get("as_1")?.phase).toBe("plan");
    s.close();
  });

  it("returns undefined for unknown ids", () => {
    const s = new SessionStore(":memory:");
    expect(s.get("missing")).toBeUndefined();
    s.close();
  });

  it("upsert is idempotent on the same id", () => {
    const s = new SessionStore(":memory:");
    s.upsert("as_2", "clarify");
    s.upsert("as_2", "implement");
    expect(s.get("as_2")?.phase).toBe("implement");
    s.close();
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `npx vitest run tests/store/sessions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/store/sessions.ts`**

```ts
import { DatabaseSync } from "node:sqlite";

export type Phase = "clarify" | "plan" | "await_approval" | "implement" | "done" | "error";

export interface SessionRow {
  agentSessionId: string;
  phase: Phase;
  issueId: string | null;
  updatedAt: string;
}

export class SessionStore {
  #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        agent_session_id TEXT PRIMARY KEY,
        phase            TEXT NOT NULL,
        issue_id         TEXT,
        updated_at       TEXT NOT NULL
      ) STRICT
    `);
  }

  upsert(agentSessionId: string, phase: Phase, issueId: string | null = null): void {
    this.#db
      .prepare(
        `INSERT INTO sessions (agent_session_id, phase, issue_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_session_id)
         DO UPDATE SET phase = excluded.phase,
                       issue_id = COALESCE(excluded.issue_id, sessions.issue_id),
                       updated_at = excluded.updated_at`,
      )
      .run(agentSessionId, phase, issueId, new Date().toISOString());
  }

  setPhase(agentSessionId: string, phase: Phase): void {
    this.#db
      .prepare(`UPDATE sessions SET phase = ?, updated_at = ? WHERE agent_session_id = ?`)
      .run(phase, new Date().toISOString(), agentSessionId);
  }

  get(agentSessionId: string): SessionRow | undefined {
    const row = this.#db
      .prepare(`SELECT agent_session_id, phase, issue_id, updated_at FROM sessions WHERE agent_session_id = ?`)
      .get(agentSessionId) as
      | { agent_session_id: string; phase: Phase; issue_id: string | null; updated_at: string }
      | undefined;
    if (!row) return undefined;
    return { agentSessionId: row.agent_session_id, phase: row.phase, issueId: row.issue_id, updatedAt: row.updated_at };
  }

  close(): void {
    this.#db.close();
  }
}
```

- [ ] **Step 4: Run the test; verify it passes**

Run: `npx vitest run tests/store/sessions.test.ts`
Expected: PASS (3 tests).

> If `node:sqlite` errors as experimental on your Node build, you are below 24.15.0 — upgrade. The ponytail fallback is `better-sqlite3@^12` with the identical `prepare().run()/.get()` surface; only the constructor import changes.

- [ ] **Step 5: Commit**

```bash
git add src/store/sessions.ts tests/store/sessions.test.ts
git commit -m "feat: node:sqlite session store keyed by agentSessionId"
```

---

### Task 0.4: Linear client + activity wrappers

**Files:**
- Create: `src/linear/client.ts`, `src/linear/activities.ts`
- Test: `tests/linear/activities.test.ts`

**Interfaces:**
- `src/linear/client.ts` → `export function makeLinearClient(accessToken: string): LinearClient` (from `@linear/sdk`, constructed with `{ accessToken }`).
- `src/linear/activities.ts` → an `Activities` wrapper over a `LinearClient`:
  - `export interface Activities { thought(text: string): Promise<void>; action(action: string, parameter?: string, result?: string): Promise<void>; response(body: string): Promise<void>; error(body: string): Promise<void>; elicitation(body: string): Promise<void> }`
  - `export function makeActivities(client: LinearClient, agentSessionId: string): Activities`
  - Each method calls `client.createAgentActivity({ agentSessionId, content })` with the verified `content` shapes.

- [ ] **Step 1: Write the failing test** (against the `content` shapes, using a fake client)

```ts
// tests/linear/activities.test.ts
import { describe, it, expect, vi } from "vitest";
import { makeActivities } from "../../src/linear/activities.ts";

function fakeClient() {
  const calls: any[] = [];
  return {
    calls,
    createAgentActivity: vi.fn(async (input: any) => { calls.push(input); return { success: true }; }),
  };
}

describe("makeActivities", () => {
  it("builds the verified content shapes", async () => {
    const c = fakeClient();
    const a = makeActivities(c as any, "as_1");
    await a.thought("thinking");
    await a.action("Searched", "query", "result md");
    await a.response("done");
    await a.error("boom");
    await a.elicitation("approve?");

    expect(c.calls[0]).toEqual({ agentSessionId: "as_1", content: { type: "thought", body: "thinking" } });
    expect(c.calls[1]).toEqual({ agentSessionId: "as_1", content: { type: "action", action: "Searched", parameter: "query", result: "result md" } });
    expect(c.calls[2]).toEqual({ agentSessionId: "as_1", content: { type: "response", body: "done" } });
    expect(c.calls[3]).toEqual({ agentSessionId: "as_1", content: { type: "error", body: "boom" } });
    expect(c.calls[4]).toEqual({ agentSessionId: "as_1", content: { type: "elicitation", body: "approve?" } });
  });

  it("omits optional action fields when not provided", async () => {
    const c = fakeClient();
    await makeActivities(c as any, "as_2").action("Searching");
    expect(c.calls[0].content).toEqual({ type: "action", action: "Searching" });
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `npx vitest run tests/linear/activities.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/linear/client.ts`**

```ts
import { LinearClient } from "@linear/sdk";

export function makeLinearClient(accessToken: string): LinearClient {
  // actor=app agents authenticate with the OAuth access token, NOT a personal apiKey.
  return new LinearClient({ accessToken });
}
```

- [ ] **Step 4: Implement `src/linear/activities.ts`**

```ts
import type { LinearClient } from "@linear/sdk";

export interface Activities {
  thought(text: string): Promise<void>;
  action(action: string, parameter?: string, result?: string): Promise<void>;
  response(body: string): Promise<void>;
  error(body: string): Promise<void>;
  elicitation(body: string): Promise<void>;
}

type AgentClient = Pick<LinearClient, "createAgentActivity">;

export function makeActivities(client: AgentClient, agentSessionId: string): Activities {
  const create = (content: Record<string, unknown>) =>
    client.createAgentActivity({ agentSessionId, content } as never).then(() => undefined);

  return {
    thought: (body) => create({ type: "thought", body }),
    action: (action, parameter, result) =>
      create({
        type: "action",
        action,
        ...(parameter !== undefined ? { parameter } : {}),
        ...(result !== undefined ? { result } : {}),
      }),
    response: (body) => create({ type: "response", body }),
    error: (body) => create({ type: "error", body }),
    elicitation: (body) => create({ type: "elicitation", body }),
  };
}
```

- [ ] **Step 5: Run the test; verify it passes**

Run: `npx vitest run tests/linear/activities.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/linear/client.ts src/linear/activities.ts tests/linear/activities.test.ts
git commit -m "feat: Linear client + agent-activity wrappers"
```

---

### Task 0.5: Webhook context extraction + approval parsing

**Files:**
- Create: `src/linear/context.ts`
- Test: `tests/linear/context.test.ts`

**Interfaces:**
- `export interface IssueContext { agentSessionId: string; organizationId: string; issueId: string | null; title: string; description: string; comment: string; promptContext: string }`
- `export function extractContext(payload: unknown): IssueContext` — reads the verified `AgentSessionEventWebhookPayload` fields (`agentSession.id`, `organizationId`, `agentSession.issue.{title,description}`, `agentSession.comment.body`, `agentSession.promptContext`), tolerating missing optional fields.
- `export function promptedBody(payload: unknown): string` — reads `agentActivity.body` from a `prompted` event.
- `export function parseApproval(text: string): boolean` — true if the reply is an affirmative.

- [ ] **Step 1: Write the failing test**

```ts
// tests/linear/context.test.ts
import { describe, it, expect } from "vitest";
import { extractContext, promptedBody, parseApproval } from "../../src/linear/context.ts";

describe("extractContext", () => {
  it("pulls issue + comment + promptContext", () => {
    const payload = {
      action: "created",
      organizationId: "org_1",
      agentSession: {
        id: "as_1",
        promptContext: "<issue>...</issue>",
        issue: { id: "iss_1", title: "Add /health", description: "return {ok:true}" },
        comment: { body: "please add it" },
      },
    };
    const ctx = extractContext(payload);
    expect(ctx).toEqual({
      agentSessionId: "as_1",
      organizationId: "org_1",
      issueId: "iss_1",
      title: "Add /health",
      description: "return {ok:true}",
      comment: "please add it",
      promptContext: "<issue>...</issue>",
    });
  });

  it("tolerates missing optional fields", () => {
    const ctx = extractContext({ agentSession: { id: "as_2" }, organizationId: "org_2" });
    expect(ctx.agentSessionId).toBe("as_2");
    expect(ctx.title).toBe("");
    expect(ctx.issueId).toBeNull();
  });
});

describe("promptedBody", () => {
  it("reads agentActivity.body", () => {
    expect(promptedBody({ action: "prompted", agentActivity: { body: "approve" } })).toBe("approve");
  });
});

describe("parseApproval", () => {
  it.each(["approve", "Approved!", "LGTM", "yes go ahead", "ship it", "looks good"])(
    "treats %s as approval", (t) => expect(parseApproval(t)).toBe(true),
  );
  it.each(["no", "please change the endpoint name", "not yet", "hold on"])(
    "treats %s as not-approval", (t) => expect(parseApproval(t)).toBe(false),
  );
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `npx vitest run tests/linear/context.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/linear/context.ts`**

```ts
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
  return String(activity.body ?? "");
}

// ponytail: keyword heuristic. Ceiling: misreads "do not approve" etc.
// Upgrade path: a tiny classifier call if false signals cause real trouble.
const AFFIRM = /\b(approve|approved|lgtm|ship\s*it|go\s*ahead|looks\s*good|yes)\b/i;
const NEGATE = /\b(no|not yet|hold on|don'?t|do not|reject|change|wait)\b/i;

export function parseApproval(text: string): boolean {
  if (NEGATE.test(text)) return false;
  return AFFIRM.test(text);
}
```

- [ ] **Step 4: Run the test; verify it passes**

Run: `npx vitest run tests/linear/context.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/linear/context.ts tests/linear/context.test.ts
git commit -m "feat: extract Linear issue context + parse approval replies"
```

---

### Task 0.6: E2B sandbox session helper (create / clone / run-one-command / kill)

**Files:**
- Create: `src/sandbox/session.ts`

**Interfaces:**
- Produces:
  - `export interface SandboxConfig { apiKey: string; template: string; ghToken: string; targetRepo: string }`
  - `export const REPO_DIR = "/home/user/repo";`
  - `export async function withSandbox<T>(cfg: SandboxConfig, fn: (sbx: Sandbox) => Promise<T>): Promise<T>` — creates a sandbox (1h timeout), guarantees `kill()` in `finally`.
  - `export async function cloneRepo(sbx: Sandbox, cfg: SandboxConfig): Promise<void>` — token-auth clone into `REPO_DIR`.
  - `export async function runCommand(sbx: Sandbox, cmd: string, opts?: { onStdout?: (d: string) => void; onStderr?: (d: string) => void }): Promise<{ exitCode: number; stdout: string; stderr: string }>` — never throws; converts `CommandExitError` into a normal result.

**Interfaces consumed:** `Sandbox`, `CommandExitError` from `e2b`.

- [ ] **Step 1: Implement `src/sandbox/session.ts`**

```ts
import { Sandbox, CommandExitError } from "e2b";

export interface SandboxConfig {
  apiKey: string;
  template: string;
  ghToken: string;
  targetRepo: string; // "owner/name"
}

export const REPO_DIR = "/home/user/repo";

export async function withSandbox<T>(cfg: SandboxConfig, fn: (sbx: Sandbox) => Promise<T>): Promise<T> {
  const sbx = await Sandbox.create(cfg.template, {
    apiKey: cfg.apiKey,
    timeoutMs: 60 * 60 * 1000, // 1h; one sandbox per agent run
    metadata: { app: "jarvis" },
    envs: { GH_TOKEN: cfg.ghToken },
  });
  try {
    return await fn(sbx);
  } finally {
    await sbx.kill().catch(() => undefined);
  }
}

export async function cloneRepo(sbx: Sandbox, cfg: SandboxConfig): Promise<void> {
  // Token-in-URL clone of a private repo; GH_TOKEN is also set in env for gh.
  const url = `https://x-access-token:${cfg.ghToken}@github.com/${cfg.targetRepo}.git`;
  const res = await runCommand(sbx, `git clone ${url} ${REPO_DIR}`);
  if (res.exitCode !== 0) {
    throw new Error(`git clone failed (${res.exitCode}): ${res.stderr}`);
  }
}

export async function runCommand(
  sbx: Sandbox,
  cmd: string,
  opts: { onStdout?: (d: string) => void; onStderr?: (d: string) => void } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const r = await sbx.commands.run(cmd, {
      timeoutMs: 0, // long jobs: npm ci, test suites, agent runs
      onStdout: opts.onStdout,
      onStderr: opts.onStderr,
    });
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    if (err instanceof CommandExitError) {
      return { exitCode: err.exitCode, stdout: err.stdout, stderr: err.stderr };
    }
    throw err;
  }
}
```

> No unit test here — this is a thin wrapper over a network SDK. It is exercised by the Phase 0 acceptance test (Task 0.9). The non-trivial logic (CommandExitError → result) is covered there.

- [ ] **Step 2: Type-check**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/sandbox/session.ts
git commit -m "feat: E2B sandbox lifecycle + clone + non-throwing runCommand"
```

---

### Task 0.7: Hono server — health, OAuth capture, webhook (thought ack + skeleton pipeline)

**Files:**
- Create: `src/server.ts`, `src/index.ts`

**Interfaces:**
- Consumes: `loadConfig`, `SessionStore`, `makeLinearClient`, `makeActivities`, `extractContext`, `withSandbox`, `cloneRepo`, `runCommand`, `REPO_DIR`.
- Produces: `export function makeServer(config: Config): Hono` and `src/index.ts` entrypoint.
- Routes:
  - `GET /health` → `{ ok: true }`.
  - `GET /oauth/callback` → one-time: exchange `?code=` at `https://api.linear.app/oauth/token` (with `actor=app`), print the access token to logs, return a "captured" page. (Setup only.)
  - `POST /webhook` → `LinearWebhookClient` verifies + dispatches; on `AgentSessionEvent` with `action:"created"`, post a `thought` within 10s, persist phase, then **fire the pipeline without awaiting**, and return 200 fast.

- [ ] **Step 1: Implement `src/server.ts`**

```ts
import { Hono } from "hono";
import { LinearWebhookClient } from "@linear/sdk/webhooks";
import type { Config } from "./config.ts";
import { SessionStore } from "./store/sessions.ts";
import { makeLinearClient } from "./linear/client.ts";
import { makeActivities } from "./linear/activities.ts";
import { extractContext, promptedBody, parseApproval } from "./linear/context.ts";
import { runSkeleton } from "./sandbox/session.ts"; // Phase 0 uses a skeleton run; replaced in Phase 1+

export function makeServer(config: Config): Hono {
  const app = new Hono();
  const store = new SessionStore(process.env.JARVIS_DB ?? "jarvis.db");
  const linear = makeLinearClient(config.linear.accessToken);
  const webhook = new LinearWebhookClient(config.linear.webhookSecret);
  const handler = webhook.createHandler();

  handler.on("AgentSessionEvent", async (payload: unknown) => {
    const p = payload as { action?: string };
    if (p.action === "created") {
      const ctx = extractContext(payload);
      const acts = makeActivities(linear, ctx.agentSessionId);
      // 10s rule: claim the session immediately.
      await acts.thought("On it — taking a look at this issue.");
      store.upsert(ctx.agentSessionId, "clarify", ctx.issueId);
      // Fire-and-forget the slow work; do NOT await (keeps webhook ACK < 5s).
      void runSkeletonPipeline(config, acts, ctx).catch(async (e) => {
        await acts.error(`Pipeline failed: ${String(e?.message ?? e)}`).catch(() => undefined);
      });
    } else if (p.action === "prompted") {
      // Phase 1+ resumes here on approval; Phase 0 ignores.
      void parseApproval(promptedBody(payload));
    }
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/oauth/callback", async (c) => {
    // One-time install capture. Exchanges the code for an actor=app access token.
    const code = c.req.query("code");
    if (!code) return c.text("missing ?code", 400);
    const res = await fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        redirect_uri: `${config.publicBaseUrl}/oauth/callback`,
        client_id: config.linear.clientId,
        client_secret: config.linear.clientSecret,
        grant_type: "authorization_code",
      }),
    });
    const json = (await res.json()) as { access_token?: string };
    console.log("LINEAR_ACCESS_TOKEN=", json.access_token); // copy into .env, then restart
    return c.text("Token captured — check server logs, copy into .env, restart.");
  });

  app.post("/webhook", async (c) => handler(c.req.raw)); // raw body unconsumed → signature verifies

  return app;
}

// Phase 0 skeleton: clone repo, run one command, post result. Replaced by the
// real orchestrator in Phase 1+ (Task 1.x / orchestrator/pipeline.ts).
async function runSkeletonPipeline(
  config: Config,
  acts: ReturnType<typeof makeActivities>,
  ctx: ReturnType<typeof extractContext>,
): Promise<void> {
  await runSkeleton(config, acts);
}
```

> `runSkeleton` is added to `src/sandbox/session.ts` in the next step so Phase 0 has something to call. It is deleted when `orchestrator/pipeline.ts` lands in Phase 1 (Task 1.4).

- [ ] **Step 2: Add `runSkeleton` to `src/sandbox/session.ts`**

```ts
import type { Config } from "../config.ts";
import type { Activities } from "../linear/activities.ts";

// Phase 0 only. Proves the loop: clone → run one command → post result.
export async function runSkeleton(config: Config, acts: Activities): Promise<void> {
  const sbxCfg = {
    apiKey: config.e2bApiKey, template: config.e2bTemplate,
    ghToken: config.ghToken, targetRepo: config.targetRepo,
  };
  await withSandbox(sbxCfg, async (sbx) => {
    await acts.action("Cloning", config.targetRepo);
    await cloneRepo(sbx, sbxCfg);
    await acts.action("Running", "npm test");
    const r = await runCommand(sbx, `cd ${REPO_DIR} && npm test`);
    const status = r.exitCode === 0 ? "✅ passed" : `❌ exited ${r.exitCode}`;
    await acts.response(
      `Ran \`npm test\` in a fresh sandbox — ${status}.\n\n` +
        "```\n" + (r.stdout || r.stderr).slice(-2000) + "\n```",
    );
  });
}
```

- [ ] **Step 3: Implement `src/index.ts`**

```ts
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { makeServer } from "./server.ts";

const config = loadConfig();
const app = makeServer(config);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Jarvis listening on http://localhost:${info.port}`);
});
```

- [ ] **Step 4: Type-check**

Run: `npm run typecheck`
Expected: exit 0. (If `@linear/sdk/webhooks` types complain about the `on` event name, the runtime is still correct per the verified sample; cast `payload` as shown.)

- [ ] **Step 5: Smoke-test `/health` locally**

Run (terminal A): `JARVIS_DB=:memory: LINEAR_ACCESS_TOKEN=x LINEAR_WEBHOOK_SECRET=x LINEAR_CLIENT_ID=x LINEAR_CLIENT_SECRET=x ANTHROPIC_API_KEY=x E2B_API_KEY=x E2B_TEMPLATE=x GH_TOKEN=x TARGET_REPO=o/n PUBLIC_BASE_URL=http://localhost:3000 npm start`
Run (terminal B): `curl -s localhost:3000/health`
Expected: `{"ok":true}`.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/index.ts src/sandbox/session.ts
git commit -m "feat: Hono server with health, OAuth capture, webhook thought-ack + skeleton run"
```

---

### Task 0.8: Custom E2B template (node, git, gh, Agent SDK, superpowers skills, runner)

**Files:**
- Create: `e2b/build-template.ts`, `src/agent/runner.mjs`

**Interfaces:**
- Produces an E2B template tagged `jarvis-agent` containing: Node 24, `git`, `gh`, a global/`/opt/jarvis-agent` install of `@anthropic-ai/claude-agent-sdk@^0.3.197`, the `superpowers` skills at `/home/user/.claude/skills/`, and `/opt/jarvis-agent/runner.mjs`.
- `src/agent/runner.mjs` is created here but only *used* from Phase 1 onward; baking it now keeps the template build in one place.

> Verified caveat: E2B's `base` image does **not** publish a package manifest — `git`/`node`/`gh` presence is not guaranteed. So we bake them. The `Template()` SDK (Build System 2.0) is the current path; `e2b template init` (CLI + `e2b.Dockerfile`) is the classic fallback.

- [ ] **Step 1: Write `src/agent/runner.mjs`** (runs *inside* the sandbox; emits one JSON line per event)

```js
// Runs INSIDE the E2B sandbox. Reads a task JSON, runs the Claude Agent SDK,
// and prints newline-delimited JarvisEvent JSON to stdout for the host to parse.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";

const task = JSON.parse(readFileSync(process.env.JARVIS_TASK_FILE, "utf8"));
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

try {
  for await (const message of query({
    prompt: task.goal,
    options: {
      cwd: task.cwd,
      model: task.model,
      systemPrompt: { type: "preset", preset: "claude_code", append: task.systemAppend },
      settingSources: ["user", "project"], // REQUIRED so superpowers skills load
      allowedTools: task.allowedTools,
      permissionMode: "bypassPermissions", // safe: the sandbox is the isolation boundary
      maxTurns: task.maxTurns,
      maxBudgetUsd: task.maxBudgetUsd,
    },
  })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") emit({ kind: "assistant_text", text: block.text });
        else if (block.type === "tool_use") emit({ kind: "tool_use", name: block.name, input: block.input });
      }
    } else if (message.type === "result") {
      emit({
        kind: "result",
        subtype: message.subtype,
        text: message.subtype === "success" ? message.result : null,
        costUsd: message.total_cost_usd ?? null,
        sessionId: message.session_id ?? null,
      });
    }
  }
} catch (err) {
  emit({ kind: "error", message: String(err?.message ?? err) });
  process.exit(1);
}
```

- [ ] **Step 2: Write `e2b/build-template.ts`** (one-off template builder)

```ts
import { Template } from "e2b";

// Build with: node --env-file-if-exists=.env e2b/build-template.ts
// Requires E2B_ACCESS_TOKEN (template builds) in env; E2B_API_KEY for runtime.
const template = Template()
  .fromUbuntuImage("24.04")
  .setUser("root")
  .aptInstall(["curl", "git", "ca-certificates"])
  // Node 24 (NodeSource) + gh (GitHub apt repo) — baked so cold sandboxes are ready.
  .runCmd("curl -fsSL https://deb.nodesource.com/setup_24.x | bash -")
  .aptInstall(["nodejs"])
  .runCmd(
    "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg " +
      "| dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && " +
      'echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] ' +
      'https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list',
  )
  .aptInstall(["gh"])
  // In-sandbox Agent SDK + runner under /opt/jarvis-agent
  .makeDir("/opt/jarvis-agent")
  .runCmd("cd /opt/jarvis-agent && npm init -y && npm i @anthropic-ai/claude-agent-sdk@^0.3.197")
  .copy("src/agent/runner.mjs", "/opt/jarvis-agent/runner.mjs")
  // superpowers skills available to the agent as a user setting source
  .makeDir("/home/user/.claude/skills")
  .copy("vendor/superpowers-skills", "/home/user/.claude/skills")
  .runCmd("chown -R user:user /home/user/.claude")
  .setUser("user");

await Template.build(template, "jarvis-agent", { cpuCount: 2, memoryMB: 4096 });
console.log("Built template: jarvis-agent");
```

> Provisioning the skills: copy your local `superpowers` skill directories into `vendor/superpowers-skills/` (one folder per skill, each with its `SKILL.md`) before building — at minimum `brainstorming`, `writing-plans`, `subagent-driven-development`, `systematic-debugging`, `requesting-code-review`, `test-driven-development`, `verification-before-completion`. (`git add vendor/superpowers-skills`.)

- [ ] **Step 3: Build the template**

Run: `node --env-file-if-exists=.env e2b/build-template.ts`
Expected: ends with `Built template: jarvis-agent`. Set `E2B_TEMPLATE=jarvis-agent` in `.env`.

- [ ] **Step 4: Verify the toolchain in a throwaway sandbox**

Run a one-off node REPL or script:
```
node --env-file-if-exists=.env --input-type=module -e "import {Sandbox} from 'e2b'; const s=await Sandbox.create('jarvis-agent'); for (const c of ['node --version','git --version','gh --version','ls /opt/jarvis-agent','ls /home/user/.claude/skills']) console.log(c, (await s.commands.run(c)).stdout.trim()); await s.kill();"
```
Expected: prints `v24.x`, a git version, a gh version, `runner.mjs` present, and the skill folders.

- [ ] **Step 5: Commit**

```bash
git add e2b/build-template.ts src/agent/runner.mjs vendor/superpowers-skills
git commit -m "feat: custom E2B template (node24, git, gh, agent SDK, superpowers, runner)"
```

---

### Task 0.9: Phase 0 acceptance — assignment → sandbox → comment

**Files:** none (manual end-to-end verification).

This is the gate that closes Phase 0. No code; run the real loop once.

- [ ] **Step 1: Register the Linear app**

In Linear → Settings → API → Applications → new app. Set the redirect to `${PUBLIC_BASE_URL}/oauth/callback`, set the webhook URL to `${PUBLIC_BASE_URL}/webhook`, enable the **"Agent session events"** webhook category, and request scopes `read,write,app:assignable,app:mentionable`. Copy `client_id`, `client_secret`, and the webhook signing secret into `.env`.

- [ ] **Step 2: Capture the actor=app access token**

Visit (admin account):
`https://linear.app/oauth/authorize?client_id=$LINEAR_CLIENT_ID&redirect_uri=$PUBLIC_BASE_URL/oauth/callback&response_type=code&scope=read,write,app:assignable,app:mentionable&actor=app&state=setup`
Approve. The server logs `LINEAR_ACCESS_TOKEN=…`. Paste it into `.env`, restart `npm start`.

- [ ] **Step 3: Assign a test issue to Jarvis**

Create an issue in the target repo's Linear team (e.g. "smoke test") and assign it to the Jarvis agent.
Expected, in order, on the Linear issue:
1. A `thought` ("On it…") appears within ~10s.
2. `action: Cloning` then `action: Running npm test`.
3. A `response` comment with `✅ passed` / `❌ exited N` and the tail of the output.

- [ ] **Step 4: Confirm the ACK timing** — Linear's webhook log shows a 200 within 5s. If the session is ever marked unresponsive, the `thought` is being posted too late — ensure it is `await`ed before `void runSkeletonPipeline(...)`.

- [ ] **Step 5: Commit a short run log** to `docs/superpowers/plans/` notes if useful (optional). Phase 0 is done when steps 1–4 pass without manual intervention.

---

# Phase 1 — Clarify + Plan + approval gate

**Goal:** Wire the in-sandbox Claude Agent SDK with `brainstorming` + `writing-plans`. Read issue context, ask clarifying questions if needed, post the plan as a Linear **elicitation**, and block until a human reply approves.

---

### Task 1.1: Host-side stream-json parser

**Files:**
- Create: `src/agent/events.ts`
- Test: `tests/agent/events.test.ts`

**Interfaces:**
- `export type JarvisEvent = { kind: "assistant_text"; text: string } | { kind: "tool_use"; name: string; input: unknown } | { kind: "result"; subtype: string; text: string | null; costUsd: number | null; sessionId: string | null } | { kind: "error"; message: string };`
- `export class LineParser { push(chunk: string): JarvisEvent[]; flush(): JarvisEvent[] }` — buffers partial lines across chunks, parses each complete newline-delimited JSON line, ignores non-JSON noise lines.

- [ ] **Step 1: Write the failing test**

```ts
// tests/agent/events.test.ts
import { describe, it, expect } from "vitest";
import { LineParser } from "../../src/agent/events.ts";

describe("LineParser", () => {
  it("parses whole lines", () => {
    const p = new LineParser();
    const out = p.push(JSON.stringify({ kind: "assistant_text", text: "hi" }) + "\n");
    expect(out).toEqual([{ kind: "assistant_text", text: "hi" }]);
  });

  it("buffers a line split across chunks", () => {
    const p = new LineParser();
    expect(p.push('{"kind":"tool_use","name":"Bash",')).toEqual([]);
    const out = p.push('"input":{"command":"ls"}}\n');
    expect(out).toEqual([{ kind: "tool_use", name: "Bash", input: { command: "ls" } }]);
  });

  it("ignores non-JSON noise lines", () => {
    const p = new LineParser();
    const out = p.push("npm warn something\n" + JSON.stringify({ kind: "result", subtype: "success", text: "done", costUsd: 0.4, sessionId: "s1" }) + "\n");
    expect(out).toEqual([{ kind: "result", subtype: "success", text: "done", costUsd: 0.4, sessionId: "s1" }]);
  });

  it("flush returns a trailing unterminated JSON line", () => {
    const p = new LineParser();
    p.push('{"kind":"error","message":"x"}');
    expect(p.flush()).toEqual([{ kind: "error", message: "x" }]);
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `npx vitest run tests/agent/events.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/agent/events.ts`**

```ts
export type JarvisEvent =
  | { kind: "assistant_text"; text: string }
  | { kind: "tool_use"; name: string; input: unknown }
  | { kind: "result"; subtype: string; text: string | null; costUsd: number | null; sessionId: string | null }
  | { kind: "error"; message: string };

const KINDS = new Set(["assistant_text", "tool_use", "result", "error"]);

function parseLine(line: string): JarvisEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const obj = JSON.parse(trimmed);
    return obj && KINDS.has(obj.kind) ? (obj as JarvisEvent) : null;
  } catch {
    return null;
  }
}

export class LineParser {
  #buf = "";

  push(chunk: string): JarvisEvent[] {
    this.#buf += chunk;
    const out: JarvisEvent[] = [];
    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      const ev = parseLine(line);
      if (ev) out.push(ev);
    }
    return out;
  }

  flush(): JarvisEvent[] {
    const rest = this.#buf;
    this.#buf = "";
    const ev = parseLine(rest);
    return ev ? [ev] : [];
  }
}
```

- [ ] **Step 4: Run the test; verify it passes**

Run: `npx vitest run tests/agent/events.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/events.ts tests/agent/events.test.ts
git commit -m "feat: streaming JSON line parser for in-sandbox agent events"
```

---

### Task 1.2: Agent task builder (plan vs implement)

**Files:**
- Create: `src/agent/tasks.ts`
- Test: `tests/agent/tasks.test.ts`

**Interfaces:**
- `export interface AgentTask { goal: string; cwd: string; model: string; systemAppend: string; allowedTools: string[]; maxTurns: number; maxBudgetUsd: number }`
- `export function planTask(ctx: IssueContext): AgentTask` — read-only tools, `brainstorming`/`writing-plans` directed via the goal/append, model `claude-sonnet-5`, ends by emitting the plan as its final result text. No editing tools.
- `export function implementTask(ctx: IssueContext, approvedPlan: string): AgentTask` — full tools (Bash/Edit/Write/Read/Glob/Grep/Skill/Agent), model `claude-opus-4-8` (hard task), directed to follow `subagent-driven-development` + `systematic-debugging` + `requesting-code-review`, run tests/lint/start/curl, then `gh pr create`, ending with the PR URL as its final result.

- [ ] **Step 1: Write the failing test**

```ts
// tests/agent/tasks.test.ts
import { describe, it, expect } from "vitest";
import { planTask, implementTask } from "../../src/agent/tasks.ts";
import type { IssueContext } from "../../src/linear/context.ts";

const ctx: IssueContext = {
  agentSessionId: "as_1", organizationId: "org_1", issueId: "iss_1",
  title: "Add /health", description: "return {ok:true}", comment: "", promptContext: "<x/>",
};

describe("planTask", () => {
  it("is read-only and uses the default model", () => {
    const t = planTask(ctx);
    expect(t.model).toBe("claude-sonnet-5");
    expect(t.allowedTools).toEqual(expect.arrayContaining(["Read", "Glob", "Grep", "Skill"]));
    expect(t.allowedTools).not.toContain("Write");
    expect(t.allowedTools).not.toContain("Edit");
    expect(t.allowedTools).not.toContain("Bash");
    expect(t.goal).toContain("Add /health");
    expect(t.cwd).toBe("/home/user/repo");
  });
});

describe("implementTask", () => {
  it("uses opus for the hard task and full tools, includes the plan", () => {
    const t = implementTask(ctx, "## Plan\n- step");
    expect(t.model).toBe("claude-opus-4-8");
    expect(t.allowedTools).toEqual(expect.arrayContaining(["Bash", "Edit", "Write", "Read", "Skill", "Agent"]));
    expect(t.goal).toContain("## Plan");
    expect(t.goal).toMatch(/gh pr create/);
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `npx vitest run tests/agent/tasks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/agent/tasks.ts`**

```ts
import type { IssueContext } from "../linear/context.ts";
import { REPO_DIR } from "../sandbox/session.ts";

export interface AgentTask {
  goal: string;
  cwd: string;
  model: string;
  systemAppend: string;
  allowedTools: string[];
  maxTurns: number;
  maxBudgetUsd: number;
}

const PLAN_APPEND =
  "You are Jarvis, an autonomous engineer working a Linear ticket. " +
  "Use the brainstorming and writing-plans skills. Explore the repo read-only to ground the plan in real files. " +
  "Your FINAL message must be the complete implementation plan in Markdown — that text is returned verbatim to the human for approval. " +
  "Do not write any files.";

const IMPLEMENT_APPEND =
  "You are Jarvis, an autonomous engineer. Use subagent-driven-development to implement the APPROVED plan, " +
  "test-driven-development while coding, systematic-debugging on any failure, and requesting-code-review before finishing. " +
  "Run the repo's tests and lint, start the app and curl the new behaviour to prove it works. " +
  "When green, create a branch, commit, push, and open a PR with `gh pr create --fill`. " +
  "Your FINAL message must be the PR URL.";

function issueBlock(ctx: IssueContext): string {
  return (
    `Linear issue: ${ctx.title}\n\n${ctx.description}\n\n` +
    (ctx.comment ? `Latest comment: ${ctx.comment}\n\n` : "") +
    (ctx.promptContext ? `Context:\n${ctx.promptContext}\n` : "")
  );
}

export function planTask(ctx: IssueContext): AgentTask {
  return {
    goal: `Produce an implementation plan for this issue.\n\n${issueBlock(ctx)}`,
    cwd: REPO_DIR,
    model: "claude-sonnet-5",
    systemAppend: PLAN_APPEND,
    allowedTools: ["Read", "Glob", "Grep", "Skill"],
    maxTurns: 40,
    maxBudgetUsd: 2,
  };
}

export function implementTask(ctx: IssueContext, approvedPlan: string): AgentTask {
  return {
    goal:
      `Implement the following APPROVED plan, then open a PR with \`gh pr create --fill\`.\n\n` +
      `${approvedPlan}\n\n---\nOriginal issue:\n${issueBlock(ctx)}`,
    cwd: REPO_DIR,
    model: "claude-opus-4-8", // hard task
    systemAppend: IMPLEMENT_APPEND,
    allowedTools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "Skill", "Agent"],
    maxTurns: 200,
    maxBudgetUsd: 8,
  };
}
```

- [ ] **Step 4: Run the test; verify it passes**

Run: `npx vitest run tests/agent/tasks.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/tasks.ts tests/agent/tasks.test.ts
git commit -m "feat: plan/implement agent task builders"
```

---

### Task 1.3: Run the in-sandbox agent and stream events to a callback

**Files:**
- Modify: `src/sandbox/session.ts` (add `runAgent`)

**Interfaces:**
- Consumes: `AgentTask`, `LineParser`, `JarvisEvent`.
- Produces: `export async function runAgent(sbx: Sandbox, anthropicApiKey: string, task: AgentTask, onEvent: (e: JarvisEvent) => void | Promise<void>): Promise<{ result: JarvisEvent | null; exitCode: number }>` — writes the task JSON into the sandbox, runs `/opt/jarvis-agent/runner.mjs` with `ANTHROPIC_API_KEY` + `JARVIS_TASK_FILE` env, parses stdout via `LineParser`, invokes `onEvent` per event, returns the final `result`/`error` event.

- [ ] **Step 1: Add `runAgent` to `src/sandbox/session.ts`**

```ts
import { LineParser, type JarvisEvent } from "../agent/events.ts";
import type { AgentTask } from "../agent/tasks.ts";

export async function runAgent(
  sbx: Sandbox,
  anthropicApiKey: string,
  task: AgentTask,
  onEvent: (e: JarvisEvent) => void | Promise<void>,
): Promise<{ result: JarvisEvent | null; exitCode: number }> {
  const taskPath = "/tmp/jarvis-task.json";
  await sbx.files.write(taskPath, JSON.stringify(task));

  const parser = new LineParser();
  let last: JarvisEvent | null = null;
  const pending: Promise<unknown>[] = [];

  const consume = (chunk: string) => {
    for (const ev of parser.push(chunk)) {
      if (ev.kind === "result" || ev.kind === "error") last = ev;
      pending.push(Promise.resolve(onEvent(ev)));
    }
  };

  const r = await runCommand(sbx, "node /opt/jarvis-agent/runner.mjs", {
    onStdout: consume,
    onStderr: () => undefined, // npm/agent noise; result/error come via stdout
  });
  for (const ev of parser.flush()) {
    if (ev.kind === "result" || ev.kind === "error") last = ev;
    pending.push(Promise.resolve(onEvent(ev)));
  }
  await Promise.allSettled(pending);
  return { result: last, exitCode: r.exitCode };
}
```

> `runCommand` must run with the agent's env. Update the `runCommand` call site here to pass env — adjust `runAgent` to call `sbx.commands.run("node /opt/jarvis-agent/runner.mjs", { timeoutMs: 0, envs: { ANTHROPIC_API_KEY: anthropicApiKey, JARVIS_TASK_FILE: taskPath }, onStdout: consume })` inside a `try/catch` on `CommandExitError` (mirror `runCommand`'s body) so a non-zero agent exit still returns its parsed `error` event rather than throwing.

- [ ] **Step 2: Type-check**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/sandbox/session.ts
git commit -m "feat: launch in-sandbox agent runner and stream events to host"
```

---

### Task 1.4: Orchestrator pipeline + phase machine; wire into the webhook

**Files:**
- Create: `src/orchestrator/pipeline.ts`
- Modify: `src/server.ts` (replace `runSkeletonPipeline` with the orchestrator; handle `prompted`)
- Modify: `src/sandbox/session.ts` (remove `runSkeleton` — no longer used)
- Test: `tests/orchestrator/pipeline.test.ts`

**Interfaces:**
- `export function nextPhase(current: Phase, approved: boolean): Phase` — pure transition: `clarify→plan`, `plan→await_approval`, `await_approval→(implement if approved else await_approval)`, `implement→done`. Tested in isolation.
- `export class Orchestrator { constructor(config: Config, store: SessionStore, makeActs: (id: string) => Activities); onCreated(ctx: IssueContext): Promise<void>; onPrompted(ctx: IssueContext, replyText: string): Promise<void> }` — drives sandboxes/agent runs and maps events → activities. We stash the approved plan keyed by `agentSessionId` (in the store as a column, or an in-memory map for v1).

- [ ] **Step 1: Write the failing test for `nextPhase`** (pure logic only)

```ts
// tests/orchestrator/pipeline.test.ts
import { describe, it, expect } from "vitest";
import { nextPhase } from "../../src/orchestrator/pipeline.ts";

describe("nextPhase", () => {
  it("clarify -> plan", () => expect(nextPhase("clarify", false)).toBe("plan"));
  it("plan -> await_approval", () => expect(nextPhase("plan", false)).toBe("await_approval"));
  it("await_approval stays until approved", () => {
    expect(nextPhase("await_approval", false)).toBe("await_approval");
    expect(nextPhase("await_approval", true)).toBe("implement");
  });
  it("implement -> done", () => expect(nextPhase("implement", true)).toBe("done"));
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `npx vitest run tests/orchestrator/pipeline.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/orchestrator/pipeline.ts`**

```ts
import type { Config } from "../config.ts";
import type { SessionStore, Phase } from "../store/sessions.ts";
import type { Activities } from "../linear/activities.ts";
import type { IssueContext } from "../linear/context.ts";
import { withSandbox, cloneRepo, runAgent } from "../sandbox/session.ts";
import { planTask, implementTask } from "../agent/tasks.ts";
import type { JarvisEvent } from "../agent/events.ts";

export function nextPhase(current: Phase, approved: boolean): Phase {
  switch (current) {
    case "clarify": return "plan";
    case "plan": return "await_approval";
    case "await_approval": return approved ? "implement" : "await_approval";
    case "implement": return "done";
    default: return current;
  }
}

export class Orchestrator {
  #plans = new Map<string, string>(); // agentSessionId -> approved/proposed plan text (v1; persist in Phase 4)

  constructor(
    private config: Config,
    private store: SessionStore,
    private makeActs: (agentSessionId: string) => Activities,
  ) {}

  #sbxCfg() {
    return {
      apiKey: this.config.e2bApiKey, template: this.config.e2bTemplate,
      ghToken: this.config.ghToken, targetRepo: this.config.targetRepo,
    };
  }

  #relay(acts: Activities) {
    return async (e: JarvisEvent) => {
      if (e.kind === "tool_use") {
        await acts.action(String(e.name), typeof (e.input as any)?.command === "string" ? (e.input as any).command : undefined);
      } else if (e.kind === "error") {
        await acts.error(e.message);
      }
      // assistant_text is intentionally not posted per-block (too noisy);
      // the final plan/PR text is posted from the result below.
    };
  }

  // created: clarify (implicit) -> produce plan -> post as elicitation -> await approval
  async onCreated(ctx: IssueContext): Promise<void> {
    const acts = this.makeActs(ctx.agentSessionId);
    this.store.upsert(ctx.agentSessionId, "plan", ctx.issueId);
    await acts.thought("Reading the codebase to draft a plan…");

    const { result } = await withSandbox(this.#sbxCfg(), async (sbx) => {
      await cloneRepo(sbx, this.#sbxCfg());
      return runAgent(sbx, this.config.anthropicApiKey, planTask(ctx), this.#relay(acts));
    });

    const plan = result?.kind === "result" && result.text ? result.text : null;
    if (!plan) {
      await acts.error("I couldn't produce a plan. Please add detail to the issue and re-assign me.");
      this.store.setPhase(ctx.agentSessionId, "error");
      return;
    }
    this.#plans.set(ctx.agentSessionId, plan);
    this.store.setPhase(ctx.agentSessionId, "await_approval");
    await acts.elicitation(`${plan}\n\n---\n**Reply "approve" to have me implement this**, or tell me what to change.`);
  }

  // prompted: a reply arrived while awaiting approval
  async onPrompted(ctx: IssueContext, replyText: string): Promise<void> {
    const row = this.store.get(ctx.agentSessionId);
    if (!row || row.phase !== "await_approval") return; // ignore unrelated prompts in v1
    const approved = parseApprovalGate(replyText);
    if (!approved) {
      await this.makeActs(ctx.agentSessionId).thought("Understood — not implementing yet. Tell me to 'approve' when ready.");
      return;
    }
    const acts = this.makeActs(ctx.agentSessionId);
    const plan = this.#plans.get(ctx.agentSessionId) ?? "";
    this.store.setPhase(ctx.agentSessionId, "implement");
    await acts.thought("Approved — implementing in a sandbox now.");

    const { result } = await withSandbox(this.#sbxCfg(), async (sbx) => {
      await cloneRepo(sbx, this.#sbxCfg());
      return runAgent(sbx, this.config.anthropicApiKey, implementTask(ctx, plan), this.#relay(acts));
    });

    if (result?.kind === "result" && result.text) {
      await acts.response(`Done. PR opened:\n\n${result.text}\n\n_A human review + merge closes this out._`);
      this.store.setPhase(ctx.agentSessionId, "done");
    } else {
      await acts.error(result?.kind === "error" ? result.message : "Implementation did not complete.");
      this.store.setPhase(ctx.agentSessionId, "error");
    }
  }
}

// re-export from context to avoid a circular import in tests
import { parseApproval as parseApprovalGate } from "../linear/context.ts";
```

- [ ] **Step 4: Run the `nextPhase` test; verify it passes**

Run: `npx vitest run tests/orchestrator/pipeline.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire the orchestrator into `src/server.ts`**

Replace the `handler.on("AgentSessionEvent", …)` body and delete `runSkeletonPipeline`:

```ts
import { Orchestrator } from "./orchestrator/pipeline.ts";
// ...
const orchestrator = new Orchestrator(config, store, (id) => makeActivities(linear, id));

handler.on("AgentSessionEvent", async (payload: unknown) => {
  const action = (payload as { action?: string }).action;
  const ctx = extractContext(payload);
  if (!ctx.agentSessionId) return;
  const acts = makeActivities(linear, ctx.agentSessionId);

  if (action === "created") {
    await acts.thought("On it — taking a look."); // 10s rule
    store.upsert(ctx.agentSessionId, "clarify", ctx.issueId);
    void orchestrator.onCreated(ctx).catch((e) => acts.error(String(e?.message ?? e)).catch(() => undefined));
  } else if (action === "prompted") {
    const reply = promptedBody(payload);
    void orchestrator.onPrompted(ctx, reply).catch((e) => acts.error(String(e?.message ?? e)).catch(() => undefined));
  }
});
```

Then remove the now-unused `runSkeleton` import and function from `src/sandbox/session.ts`.

- [ ] **Step 6: Type-check + full test run**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0; all Vitest suites pass.

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/pipeline.ts src/server.ts src/sandbox/session.ts tests/orchestrator/pipeline.test.ts
git commit -m "feat: orchestrator phase machine; clarify+plan+approval gate wired to webhook"
```

---

### Task 1.5: Phase 1 acceptance — plan posted, blocks on approval

**Files:** none (manual).

- [ ] **Step 1:** Assign a real small issue (e.g. "add a `/health` endpoint returning `{ok:true}`") to Jarvis.
- [ ] **Step 2:** Expect a `thought`, then within a couple of minutes an `elicitation` containing a concrete plan grounded in the repo's files, ending with the approve instruction.
- [ ] **Step 3:** Confirm Jarvis does **nothing further** until you reply (the gate holds).
- [ ] **Step 4:** Reply "please rename it to `/healthz`". Expect a `thought` acknowledging, still no code.
- [ ] **Step 5:** Phase 1 is done when the plan is sensible and the gate is respected.

---

# Phase 2 — Implement + Verify loop

The implement agent (Task 1.2/1.4) already runs inside the sandbox with `subagent-driven-development`, `test-driven-development`, and `systematic-debugging`, and VERIFY (tests/lint/start/curl) happens via its own Bash tool — failures feed back into its loop as ordinary tool output. Phase 2 is about confirming and tightening that loop.

---

### Task 2.1: Strengthen the implement directive for VERIFY

**Files:**
- Modify: `src/agent/tasks.ts` (`IMPLEMENT_APPEND`)
- Modify: `tests/agent/tasks.test.ts` (assert the new directives appear)

- [ ] **Step 1: Add a failing assertion**

```ts
// add to tests/agent/tasks.test.ts, inside the implementTask describe
it("directs explicit verification before the PR", () => {
  const t = implementTask(ctx, "## Plan");
  expect(t.systemAppend).toMatch(/tests/i);
  expect(t.systemAppend).toMatch(/lint/i);
  expect(t.systemAppend).toMatch(/curl/i);
  expect(t.systemAppend).toMatch(/verification-before-completion/);
});
```

- [ ] **Step 2: Run; verify it fails**

Run: `npx vitest run tests/agent/tasks.test.ts`
Expected: FAIL on the `verification-before-completion` assertion.

- [ ] **Step 3: Update `IMPLEMENT_APPEND`**

```ts
const IMPLEMENT_APPEND =
  "You are Jarvis, an autonomous engineer. Use subagent-driven-development to implement the APPROVED plan, " +
  "test-driven-development while coding, and systematic-debugging on any failure. " +
  "VERIFY before claiming success (verification-before-completion): run the repo's tests and lint, " +
  "start the app and curl the new behaviour to prove it works; loop until everything is green. " +
  "Then use requesting-code-review on the diff and fix what it finds. " +
  "Finally create a branch, commit, push, and open a PR with `gh pr create --fill`. " +
  "Your FINAL message must be the PR URL.";
```

- [ ] **Step 4: Run; verify it passes**

Run: `npx vitest run tests/agent/tasks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/tasks.ts tests/agent/tasks.test.ts
git commit -m "feat: explicit verify-before-PR directive in implement task"
```

---

### Task 2.2: Phase 2 acceptance — implement to green in the sandbox

**Files:** none (manual). Continue the `/healthz` issue from Phase 1.

- [ ] **Step 1:** Reply "approve" on the plan.
- [ ] **Step 2:** Watch `action` activities stream: editing files, `npm test`, `npm run lint`, `npm start`, `curl …/healthz`.
- [ ] **Step 3:** Confirm that when a test fails mid-run, the agent's subsequent `action`s show it debugging and re-running — i.e. failures fed back into the loop.
- [ ] **Step 4:** Phase 2 is done when the agent reaches green in the sandbox without host intervention. (The PR itself is Phase 3.)

---

# Phase 3 — Review + PR

Review (`requesting-code-review`) and `gh pr create` are already in the implement directive. Phase 3 confirms the PR lands and is linked back to Linear, and closes the session.

---

### Task 3.1: Post the PR link as the final `response`

Already implemented in `Orchestrator.onPrompted` (the final `acts.response(... PR opened ...)` and `setPhase("done")`). No new code — verify the path.

- [ ] **Step 1:** Confirm `runAgent`'s returned `result.text` is the PR URL (the implement directive ends with "FINAL message must be the PR URL"). If the agent appends prose, the whole final message is posted — acceptable for v1.
- [ ] **Step 2:** Confirm the Linear session reads as **complete** after the `response` (Linear infers terminal state from the last activity — no explicit terminate call exists).

- [ ] **Step 3: Commit** (if any tightening was needed)

```bash
git add -A && git commit -m "chore: confirm PR-link response closes the session"
```

---

### Task 3.2: Phase 3 acceptance — the full slice (the BUILD_PLAN.md acceptance test)

**Files:** none (manual). This is the definition of done for the vertical slice.

- [ ] **Step 1:** Create issue "add a `/health` endpoint returning `{ok:true}`" in the test repo; assign to Jarvis.
- [ ] **Step 2:** `thought` within 10s; clarifying `elicitation`/plan posted as an artifact-style comment.
- [ ] **Step 3:** A human approves the plan.
- [ ] **Step 4:** Jarvis writes the endpoint in an E2B sandbox, runs tests + lint, starts the app, and `curl`s `/health` — all green in the activity log.
- [ ] **Step 5:** A review pass runs; Jarvis opens a GitHub PR and links it on Linear.
- [ ] **Step 6:** The PR shows a working `/health`; a human merges.

Slice is done when steps 1–6 happen with no manual intervention **between the two gates**.

---

# Phase 4 — Harden (only once the loop works)

Each task here is independent and optional-until-needed. Do not start Phase 4 until Phase 3 acceptance passes.

---

### Task 4.1: Per-session cost logging to Linear

**Files:** Modify `src/orchestrator/pipeline.ts`.

- [ ] **Step 1:** In `#relay`/result handling, accumulate `result.costUsd` from the plan and implement runs.
- [ ] **Step 2:** Append `_Cost: $X.XX_` to the final `response`.
- [ ] **Step 3:** Sanity-check against the budget note (~$0.5–1/bug, ~$2–4/feature). Commit.

---

### Task 4.2: Prompt caching for the agent system prompt

**Files:** `src/agent/runner.mjs`, `e2b/build-template.ts`.

- [ ] **Step 1:** Keep `systemPrompt` byte-stable across runs (the `claude_code` preset + a stable `append`) so the SDK's prompt cache hits. Set `excludeDynamicSections: true` (requires SDK ≥ 0.2.98) on the preset so per-machine context doesn't bust the cache.
- [ ] **Step 2:** Confirm via the result's `usage` that cache reads are non-zero on the 2nd+ turn. (Cache reads bill ~0.1× input.) Commit.

---

### Task 4.3: Generate/maintain `CLAUDE.md` for the target repo

**Files:** new `src/agent/tasks.ts` entry `mapTask`, orchestrator wiring.

- [ ] **Step 1:** Add a one-off "map" agent run that writes a `CLAUDE.md` architecture map into the repo if absent (read-mostly), cached and reused on later runs to cut exploration cost.
- [ ] **Step 2:** Gate it behind a flag; only run when the repo has no `CLAUDE.md`. Commit.

---

### Task 4.4: Persist plans + phase recovery; concurrency

**Files:** `src/store/sessions.ts`, `src/orchestrator/pipeline.ts`.

- [ ] **Step 1:** Add a `plan TEXT` column to the `sessions` table; replace the in-memory `#plans` map with the store (survives restarts).
- [ ] **Step 2:** Confirm concurrent sessions are independent (each its own sandbox; SQLite writes are serialized by `DatabaseSync`). Add a simple in-flight guard keyed by `agentSessionId` to avoid double-processing duplicate webhooks.
- [ ] **Step 3:** Commit.

---

### Task 4.5: Secrets, retries, failure reporting

**Files:** `src/config.ts`, `src/orchestrator/pipeline.ts`.

- [ ] **Step 1:** Move tokens from env to a secrets manager (or at least scope `GH_TOKEN` to a fine-grained PAT with only the target repo + `Contents: Read and write`). Use short-lived tokens where possible.
- [ ] **Step 2:** Add bounded retries around transient E2B/Linear failures; on terminal failure, always post a Linear `error` activity with the request/run id.
- [ ] **Step 3:** Commit.

---

### Task 4.6: Reassess Serena MCP (deferred)

**Files:** none (decision).

- [ ] **Step 1:** Using real token numbers from Phase 4.1 cost logs, decide whether the monorepo makes the agent flail enough to justify a code-graph MCP. Add only if justified. Document the decision.

---

## Self-Review (run against BUILD_PLAN.md)

**Spec coverage:**
- Webhook receiver + signature verify + `thought` ack < 10s → Tasks 0.4–0.7 (LinearWebhookClient, 10s thought, fire-and-forget). ✅
- App registration (OAuth `actor=app`, `app:assignable`+`app:mentionable`, agent session events) → Task 0.9 step 1–2; scopes in Global Constraints. ✅
- Session/phase state (SQLite, keyed by `agentSessionId`, no ORM) → Task 0.3 (`node:sqlite`). ✅
- Orchestrator state machine (CLARIFY/PLAN/IMPLEMENT/VERIFY/REVIEW/PR) → Task 1.4 (`nextPhase`, `Orchestrator`); VERIFY/REVIEW folded into the implement agent's own loop (Tasks 2.1, 3.1). ✅
- Reuse Claude Agent SDK + superpowers skills → Tasks 0.8 (skills baked into template), 1.2/1.3 (in-sandbox runner, preset + settingSources). ✅
- Codebase understanding via Grep/Glob/Read + generated CLAUDE.md, no index → plan task uses read tools; CLAUDE.md is Task 4.3. ✅
- One E2B sandbox + run tests/lint/curl there → Tasks 0.6, 1.3; **corrected** to one sandbox *per agent run* with the verified reason (5-min timeout vs human wait). ✅
- PR via `gh` from inside the sandbox; human approves → Tasks 0.8 (gh baked), 1.2/2.1 (directive), 3.1 (PR link). ✅
- Two human gates → plan `elicitation` (Task 1.4) + human merge (Task 3.2). ✅
- Acceptance test (6 steps) → Task 3.2 verbatim. ✅
- Open items (code host=GitHub, approval signal, secrets, target repo) → GitHub assumed (gh); approval = parsed `prompted` reply (Task 0.5); secrets via env now / manager in 4.5; target repo via `TARGET_REPO`. ✅

**Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N". Every code step shows complete code; every command shows expected output. The two manual-only tasks (0.6/1.3 integration) are explicitly justified (thin network wrappers) and covered by acceptance tests. ✅

**Type consistency:** `Phase` (store) reused by `nextPhase`. `IssueContext` (context.ts) consumed by `tasks.ts` and `pipeline.ts`. `JarvisEvent`/`LineParser` (events.ts) consumed by `runAgent` and `Orchestrator`. `AgentTask` (tasks.ts) consumed by `runAgent`. `Activities` (activities.ts) consumed by `pipeline.ts`. `REPO_DIR` defined once in `session.ts`, imported by `tasks.ts`. `makeActivities` signature stable. ✅

**Deliberate ponytail simplifications (with upgrade paths):** single process, no queue (Phase 4.4 adds durability); in-memory `#plans` (Phase 4.4 persists); env secrets (Phase 4.5); sandbox per run, not pooled (warm pool later); keyword approval heuristic (classifier later); `node:sqlite` RC (`better-sqlite3` fallback noted).
