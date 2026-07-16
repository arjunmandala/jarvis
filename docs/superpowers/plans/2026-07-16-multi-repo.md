# Multi-Repo Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route each Jarvis session to one of several registered GitHub repos (registry + precedence rules + human backstop), replacing the single hardcoded `TARGET_REPO`.

**Architecture:** A `repos.json` registry (with `TARGET_REPO` fallback) loads into `Config.repos`. A pure `resolveRepo()` precedence function picks the repo per session: pinned-on-session > `Repo:` line in issue body > unique Linear-team mapping > single-entry registry > unresolved (agent/human decides in clarify). The repo is pinned on the `sessions` row, re-parsed from each plan's `Repo:` header, inherited verbatim on resume, and threaded into sandbox clone/map/run bookkeeping. Cross-repo changes stay decomposition-only. Spec: `docs/superpowers/specs/2026-07-16-multi-repo-design.md`.

**Tech Stack:** TypeScript (Node ≥ 24.15, `node:sqlite`, `node:fs`), vitest. No new dependencies.

## Global Constraints

- `.ts` imports use explicit `.ts` extensions (`moduleResolution: nodenext`) — follow existing style.
- Repo names are a **trust boundary**: they are interpolated into `git clone https://…@github.com/<repo>.git` (`src/sandbox/session.ts:70`). Validate with `isValidRepoName` BEFORE storing or passing anywhere, never after — same posture as `isValidBranchName` (`src/linear/context.ts:73-85`).
- An unregistered repo is **never routable**, from any source (issue body, plan header, config typo).
- `systemAppend` strings stay fixed byte-stable text — per-run content (registry block, repo names) goes in `goal` only.
- No behavior change for single-repo deployments: `TARGET_REPO` alone must keep working exactly as today.
- Tests: no network, no real e2b — existing fakes only. Run `npm run typecheck` and `npx vitest run <file>` per task; full `npm test` at the end.
- Mark deliberate ceilings with `// ponytail:` comments naming the upgrade path.

---

### Task 1: Repo registry module (`src/repos.ts`)

**Files:**
- Create: `src/repos.ts`
- Test: `tests/repos.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module; `node:fs` only).
- Produces (used by Tasks 2, 5, 6):
  - `interface RepoEntry { repo: string; description: string; linearTeams?: string[]; token?: string }`
  - `isValidRepoName(name: string): boolean`
  - `loadRegistry(env: NodeJS.ProcessEnv): RepoEntry[]` — throws if no repos configured
  - `findRepo(registry: RepoEntry[], name: string | null | undefined): RepoEntry | null`
  - `parseRepoLine(text: string): string | null`
  - `resolveRepo(input: { registry: RepoEntry[]; pinned?: string | null; issueText?: string; teamId?: string | null; teamKey?: string | null }): RepoEntry | null`
  - `renderRegistry(registry: RepoEntry[], current?: string | null): string`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/repos.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadRegistry, findRepo, parseRepoLine, resolveRepo, renderRegistry, isValidRepoName,
  type RepoEntry,
} from "../src/repos.ts";

const REG: RepoEntry[] = [
  { repo: "acme/api", description: "Billing API", linearTeams: ["team_api", "API"] },
  { repo: "acme/web", description: "Web frontend", linearTeams: ["team_web"] },
  { repo: "acme/lib", description: "Shared types", token: "ghp_scoped" },
];

describe("isValidRepoName", () => {
  it("accepts owner/name", () => {
    expect(isValidRepoName("acme/billing-api")).toBe(true);
    expect(isValidRepoName("a-b/c.d_e")).toBe(true);
  });
  it("rejects shell/URL metacharacters and malformed names", () => {
    for (const bad of ["", "acme", "acme/", "/x", "a b/c", "acme/x;rm", "a/b/c", "acme/x$(y)", "-a/b", "acme/../x"]) {
      expect(isValidRepoName(bad), bad).toBe(false);
    }
  });
});

describe("loadRegistry", () => {
  it("loads repos.json via REPOS_CONFIG", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-repos-"));
    const p = join(dir, "repos.json");
    writeFileSync(p, JSON.stringify(REG));
    const reg = loadRegistry({ REPOS_CONFIG: p });
    expect(reg.map((r) => r.repo)).toEqual(["acme/api", "acme/web", "acme/lib"]);
    rmSync(dir, { recursive: true, force: true });
  });
  it("falls back to TARGET_REPO as a single-entry registry", () => {
    const reg = loadRegistry({ TARGET_REPO: "acme/solo" });
    expect(reg).toEqual([{ repo: "acme/solo", description: "acme/solo" }]);
  });
  it("prefers repos.json over TARGET_REPO when both exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-repos-"));
    const p = join(dir, "repos.json");
    writeFileSync(p, JSON.stringify([REG[0]]));
    const reg = loadRegistry({ REPOS_CONFIG: p, TARGET_REPO: "acme/solo" });
    expect(reg.map((r) => r.repo)).toEqual(["acme/api"]);
    rmSync(dir, { recursive: true, force: true });
  });
  it("throws when nothing is configured", () => {
    expect(() => loadRegistry({})).toThrowError(/TARGET_REPO|repos\.json/);
  });
  it("throws on an invalid repo name in repos.json (trust boundary)", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-repos-"));
    const p = join(dir, "repos.json");
    writeFileSync(p, JSON.stringify([{ repo: "acme/x;rm -rf", description: "evil" }]));
    expect(() => loadRegistry({ REPOS_CONFIG: p })).toThrowError(/invalid repo/i);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("parseRepoLine", () => {
  it("finds a Repo: line anywhere in the text", () => {
    expect(parseRepoLine("Some intro\nRepo: acme/api\nmore")).toBe("acme/api");
  });
  it("returns null when absent or malformed", () => {
    expect(parseRepoLine("no repo here")).toBeNull();
    expect(parseRepoLine("Repo: not a repo !!")).toBeNull();
  });
});

describe("resolveRepo precedence", () => {
  it("pinned wins over everything", () => {
    expect(resolveRepo({ registry: REG, pinned: "acme/lib", issueText: "Repo: acme/web", teamId: "team_api" })?.repo).toBe("acme/lib");
  });
  it("a pinned name no longer in the registry is ignored, not fatal", () => {
    expect(resolveRepo({ registry: REG, pinned: "acme/gone", teamId: "team_web" })?.repo).toBe("acme/web");
  });
  it("issue-body Repo: line wins over team mapping", () => {
    expect(resolveRepo({ registry: REG, issueText: "Repo: acme/lib", teamId: "team_api" })?.repo).toBe("acme/lib");
  });
  it("an unregistered issue-body repo does NOT route (poisoning guard) — falls through to team", () => {
    expect(resolveRepo({ registry: REG, issueText: "Repo: evil/injected", teamId: "team_web" })?.repo).toBe("acme/web");
  });
  it("unique team match routes, by id or key", () => {
    expect(resolveRepo({ registry: REG, teamId: "team_web" })?.repo).toBe("acme/web");
    expect(resolveRepo({ registry: REG, teamKey: "API" })?.repo).toBe("acme/api");
  });
  it("ambiguous team (or no team) with multi-entry registry resolves to null", () => {
    const two: RepoEntry[] = [
      { repo: "a/x", description: "x", linearTeams: ["t1"] },
      { repo: "a/y", description: "y", linearTeams: ["t1"] },
    ];
    expect(resolveRepo({ registry: two, teamId: "t1" })).toBeNull();
    expect(resolveRepo({ registry: REG })).toBeNull();
  });
  it("single-entry registry always resolves to it", () => {
    expect(resolveRepo({ registry: [REG[0]], teamId: "unknown" })?.repo).toBe("acme/api");
  });
});

describe("renderRegistry", () => {
  it("is empty for a single-entry registry", () => {
    expect(renderRegistry([REG[0]])).toBe("");
  });
  it("lists all repos and marks the current target", () => {
    const block = renderRegistry(REG, "acme/web");
    expect(block).toContain("acme/api — Billing API");
    expect(block).toContain("acme/web — Web frontend (current target)");
    expect(block).toContain("Registered repositories");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/repos.test.ts`
Expected: FAIL — cannot resolve `../src/repos.ts`.

- [ ] **Step 3: Implement `src/repos.ts`**

```ts
import { readFileSync, existsSync } from "node:fs";

// One registered target repository. `linearTeams` entries match the Linear
// team's id OR key. `token` overrides the global GH_TOKEN for this repo
// (keeps token scoping possible — see the spec's Security section).
export interface RepoEntry {
  repo: string; // "owner/name"
  description: string;
  linearTeams?: string[];
  token?: string;
}

// Trust boundary: repo names are interpolated into the git clone URL
// (src/sandbox/session.ts cloneRepo). Validate BEFORE storing or passing —
// never after. Mirrors isValidBranchName in src/linear/context.ts.
const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidRepoName(name: string): boolean {
  return REPO_NAME_RE.test(name) && !name.includes("..");
}

// repos.json (path via REPOS_CONFIG, default ./repos.json) is the registry;
// TARGET_REPO alone becomes a single-entry registry so existing single-repo
// deployments change nothing.
export function loadRegistry(env: NodeJS.ProcessEnv = process.env): RepoEntry[] {
  const path = env.REPOS_CONFIG ?? "repos.json";
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as RepoEntry[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error(`${path} must be a non-empty JSON array of {repo, description}`);
    }
    for (const e of parsed) {
      if (!e || typeof e.repo !== "string" || !isValidRepoName(e.repo)) {
        throw new Error(`invalid repo name in ${path}: ${JSON.stringify(e?.repo)}`);
      }
      if (typeof e.description !== "string" || !e.description) e.description = e.repo;
    }
    return parsed;
  }
  if (env.TARGET_REPO) {
    if (!isValidRepoName(env.TARGET_REPO)) throw new Error(`invalid repo name in TARGET_REPO: ${env.TARGET_REPO}`);
    return [{ repo: env.TARGET_REPO, description: env.TARGET_REPO }];
  }
  throw new Error("No repos configured: provide repos.json (or REPOS_CONFIG) or TARGET_REPO");
}

export function findRepo(registry: RepoEntry[], name: string | null | undefined): RepoEntry | null {
  if (!name) return null;
  return registry.find((e) => e.repo === name) ?? null;
}

// First `Repo: owner/name` line in the text (issue bodies and plan headers both
// use this — a plan's Repo: header is just this line within the first 400 chars).
const REPO_LINE_RE = /^\s*Repo:\s*([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\s*$/im;

export function parseRepoLine(text: string): string | null {
  const m = REPO_LINE_RE.exec(text);
  return m && isValidRepoName(m[1]) ? m[1] : null;
}

// Routing precedence (spec: docs/superpowers/specs/2026-07-16-multi-repo-design.md).
// `pinned` first: it encodes the latest human-visible decision (plan header or
// resume inheritance). Every source is validated against the registry — an
// unregistered name never routes, it falls through (poisoning guard).
export function resolveRepo(input: {
  registry: RepoEntry[];
  pinned?: string | null;
  issueText?: string;
  teamId?: string | null;
  teamKey?: string | null;
}): RepoEntry | null {
  const pinned = findRepo(input.registry, input.pinned);
  if (pinned) return pinned;
  const named = input.issueText ? findRepo(input.registry, parseRepoLine(input.issueText)) : null;
  if (named) return named;
  const teams = [input.teamId, input.teamKey].filter(Boolean) as string[];
  const byTeam = input.registry.filter((e) => e.linearTeams?.some((t) => teams.includes(t)));
  if (byTeam.length === 1) return byTeam[0];
  if (input.registry.length === 1) return input.registry[0];
  return null;
}

// Goal-text block listing the registry so the converse/plan agent knows the
// landscape (and can pick via the plan's `Repo:` header). Per-run goal content,
// never systemAppend. Empty for single-repo setups — zero prompt change there.
// ponytail: flat list; cap/summarize if registries reach dozens of repos —
// upgrade path is a get_repo_map tool on the docs MCP server.
export function renderRegistry(registry: RepoEntry[], current?: string | null): string {
  if (registry.length <= 1) return "";
  const lines = registry.map((e) => `- ${e.repo} — ${e.description}${e.repo === current ? " (current target)" : ""}`);
  return `\n\n## Registered repositories\nThis workspace has multiple repos. The current target is marked; a plan's \`Repo:\` header line may name any repo listed here (and only these).\n${lines.join("\n")}\n`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/repos.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/repos.ts tests/repos.test.ts
git commit -m "feat(repos): registry, validation, and pure routing precedence"
```

---

### Task 2: Config loads the registry (`src/config.ts`)

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: `loadRegistry`, `RepoEntry` from Task 1.
- Produces: `Config.repos: RepoEntry[]` replaces `Config.targetRepo`. `TARGET_REPO` leaves the `REQUIRED` list (the registry loader enforces at-least-one-repo instead). Everything else unchanged.

- [ ] **Step 1: Update the tests (existing file)**

In `tests/config.test.ts`: replace the `expect(c.targetRepo).toBe("owner/name")` assertion and the `/TARGET_REPO/` missing-var assertion with:

```ts
  it("synthesizes a single-entry registry from TARGET_REPO", () => {
    const c = loadConfig(full);
    expect(c.repos).toEqual([{ repo: "owner/name", description: "owner/name" }]);
  });

  it("throws when neither repos.json nor TARGET_REPO is configured", () => {
    const { TARGET_REPO, ...noRepo } = full;
    // REPOS_CONFIG points at a nonexistent path so a real ./repos.json on the
    // dev machine can't leak into the test.
    expect(() => loadConfig({ ...noRepo, REPOS_CONFIG: "/nonexistent/repos.json" })).toThrowError(/TARGET_REPO|repos\.json/);
  });
```

Also update the `throws listing every missing var` test: drop the `/TARGET_REPO/` expectation (keep `/LINEAR_CLIENT_ID/`), and pass `REPOS_CONFIG: "/nonexistent/repos.json"` there too.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `c.repos` is undefined.

- [ ] **Step 3: Implement**

In `src/config.ts`:

```ts
import { loadRegistry, type RepoEntry } from "./repos.ts";

export interface Config {
  port: number;
  linear: { accessToken?: string; webhookSecret: string; clientId: string; clientSecret: string };
  anthropicApiKey: string;
  e2bApiKey: string;
  e2bTemplate: string;
  ghToken: string;
  repos: RepoEntry[];
  publicBaseUrl: string;
}
```

Remove `"TARGET_REPO"` from `REQUIRED`. In the returned object replace `targetRepo: env.TARGET_REPO!,` with `repos: loadRegistry(env),`.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/config.test.ts` → PASS.
Run: `npm run typecheck` → expected to FAIL in `src/orchestrator/pipeline.ts` (5 uses of `config.targetRepo`) — that's Task 6's job. Note the exact errors; do not fix them here. If anything OTHER than `targetRepo` usages fails, fix it here.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(config): Config.repos registry replaces targetRepo (TARGET_REPO stays as fallback)"
```

---

### Task 3: `repo` column on sessions (`src/store/sessions.ts`)

**Files:**
- Modify: `src/store/sessions.ts`
- Test: `tests/store/sessions.test.ts`

**Interfaces:**
- Consumes: existing `SessionStore` patterns (hand-rolled `ALTER TABLE` migration guarded by `pragma_table_info`, see `sessions.ts:80-102`).
- Produces: `SessionRow.repo: string | null`; `setRepo(agentSessionId: string, repo: string | null): void`. `repo` must come back from **every** method returning a `SessionRow` (`get`, `findResumableByIssue`, and the phase-list query `reconcile()` uses — search for every `work_branch` read; add `repo: row.repo` alongside each).

- [ ] **Step 1: Write the failing tests** (append to `tests/store/sessions.test.ts`)

```ts
  it("stores and returns the repo, including through findResumableByIssue", () => {
    const s = new SessionStore(":memory:");
    s.upsert("as_r1", "clarify", "iss_r");
    expect(s.get("as_r1")?.repo).toBeNull();
    s.setRepo("as_r1", "acme/api");
    expect(s.get("as_r1")?.repo).toBe("acme/api");
    s.setPhase("as_r1", "implement");
    const prior = s.findResumableByIssue("iss_r", "as_other");
    expect(prior?.repo).toBe("acme/api");
    s.close();
  });

  it("migrates a pre-repo DB by adding the column", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-db-"));
    const p = join(dir, "t.db");
    const s1 = new SessionStore(p);
    s1.upsert("as_m", "clarify");
    s1.close();
    const s2 = new SessionStore(p); // reopening must not throw and must expose repo
    expect(s2.get("as_m")?.repo).toBeNull();
    s2.close();
    rmSync(dir, { recursive: true, force: true });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/store/sessions.test.ts`
Expected: FAIL — `setRepo` is not a function.

- [ ] **Step 3: Implement**

In the constructor's sessions-migration block (after the `sdk_session_id` guard at `sessions.ts:100-102`), add:

```ts
    if (!cols.some((c) => c.name === "repo")) {
      this.#db.exec(`ALTER TABLE sessions ADD COLUMN repo TEXT`);
    }
```

Add to `SessionRow`: `repo: string | null;`

Add the setter (next to `setWorkBranch`, `sessions.ts:375`):

```ts
  setRepo(agentSessionId: string, repo: string | null): void {
    this.#db.prepare(`UPDATE sessions SET repo = ?, updated_at = ? WHERE agent_session_id = ?`)
      .run(repo, new Date().toISOString(), agentSessionId);
  }
```

Add `repo: row.repo,` to every row→`SessionRow` mapping (the objects that currently map `workBranch: row.work_branch` — there are at least three: `get`, `findResumableByIssue`, and the reconcile phase-list query around lines 417/451/484/508; update all of them).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/store/sessions.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/sessions.ts tests/store/sessions.test.ts
git commit -m "feat(store): repo column on sessions with migration and setter"
```

---

### Task 4: `teamKey` on IssueContext (`src/linear/context.ts`)

**Files:**
- Modify: `src/linear/context.ts:36-53` (`extractContext`)
- Test: `tests/linear/context.test.ts`

**Interfaces:**
- Consumes: webhook payload shape (`issue.team.{id,key}`).
- Produces: `IssueContext.teamKey: string | null` — used by Task 6's routing. (`parseRepoLine` already exists in `src/repos.ts`; nothing repo-related is added here.)

- [ ] **Step 1: Write the failing test** (append to `tests/linear/context.test.ts`, matching its existing payload-fixture style)

```ts
  it("extracts teamKey alongside teamId", () => {
    const ctx = extractContext({
      organizationId: "org",
      agentSession: { id: "as_1", issue: { id: "i1", title: "t", team: { id: "team_1", key: "ENG" } } },
    });
    expect(ctx.teamId).toBe("team_1");
    expect(ctx.teamKey).toBe("ENG");
  });

  it("teamKey is null when absent", () => {
    const ctx = extractContext({ agentSession: { id: "as_1", issue: {} } });
    expect(ctx.teamKey).toBeNull();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/linear/context.test.ts`
Expected: FAIL — `teamKey` undefined vs "ENG".

- [ ] **Step 3: Implement**

In `IssueContext` add `teamKey: string | null;` (after `teamId`). In `extractContext`'s return add:

```ts
    teamKey: team.key ? String(team.key) : null,
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/linear/context.test.ts` → PASS.
Also run `npm run typecheck` — if other modules construct `IssueContext` literals (tests, host-turn fixtures), add `teamKey: null` where required.

- [ ] **Step 5: Commit**

```bash
git add src/linear/context.ts tests/linear/context.test.ts
git commit -m "feat(linear): extract teamKey from webhook payload for repo routing"
```

---

### Task 5: `Repo:` plan header + registry block in prompts (`src/agent/tasks.ts`, `src/agent/converse.ts`)

**Files:**
- Modify: `src/agent/tasks.ts` (PLAN_APPEND contract text ~line 64; `planTask`/`reviseTask` goal + signature)
- Modify: `src/agent/converse.ts` (CONVERSE_APPEND protocol text line 36-37; `converseTask` goal + signature)
- Test: `tests/agent/tasks.test.ts`, `tests/agent/converse.test.ts`

**Interfaces:**
- Consumes: `renderRegistry` output (a pre-rendered string) from Task 1 — task builders take it as text, they never see `RepoEntry[]`.
- Produces: `planTask`, `reviseTask`, `converseTask` each gain a trailing optional param `registryText?: string`, appended verbatim at the end of the goal. The plan contract becomes `Type:` / `Scope:` / optional `Repo:` — parsed downstream by `parseRepoLine(plan.slice(0, 400))` (Task 6), so **no new parser here**.

- [ ] **Step 1: Write the failing tests**

Append to `tests/agent/tasks.test.ts` (match its existing builder-call style — pass the same fixture `ctx` the file already uses):

```ts
  it("planTask appends registryText to the goal and instructs the Repo: header", () => {
    const t = planTask(ctx, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      "\n\n## Registered repositories\n- acme/api — Billing API\n");
    expect(t.goal).toContain("Registered repositories");
    expect(t.systemAppend).toContain("Repo:"); // contract line documented in PLAN_APPEND
  });
```

(Adjust the positional `undefined`s to `planTask`'s actual arity — `registryText` goes last. If the file has a helper for building tasks, use it.)

Append to `tests/agent/converse.test.ts`:

```ts
  it("converseTask appends registryText to the goal", () => {
    const t = converseTask(ctx, "hello", undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      "\n\n## Registered repositories\n- acme/api — Billing API\n");
    expect(t.goal).toContain("Registered repositories");
  });

  it("converseTask goal is unchanged when registryText is absent (single-repo)", () => {
    const t = converseTask(ctx, "hello");
    expect(t.goal).not.toContain("Registered repositories");
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/agent/tasks.test.ts tests/agent/converse.test.ts`
Expected: FAIL — extra argument / missing goal content.

- [ ] **Step 3: Implement**

In `src/agent/tasks.ts`:

1. PLAN_APPEND's contract lines (~line 64-65) currently document `Type:` and `Scope:`. Extend the same sentence block with:

```
"`Repo: <owner/name>` — REQUIRED third line when more than one repository is registered (pick from the " +
"Registered repositories list in your goal; never any other repo). Omit it in single-repo workspaces.\n" +
```

2. In PLAN_APPEND's "DECOMPOSE IF TOO BIG" paragraph (~line 70), append one sentence:

```
"When sub-issues target different repositories, include a `Repo: owner/name` line inside each item's description."
```

3. `planTask` and `reviseTask`: add trailing optional param `registryText?: string`; in each goal template append `${registryText ?? ""}` after the last existing block (after `${attachmentsBlock(...)}` or whatever the final block is in that builder).

In `src/agent/converse.ts`:

4. CONVERSE_APPEND line 36-37 — change the `plan` verb description from "(start it with the `Type:`/`Scope:` lines)" to "(start it with the `Type:`/`Scope:` lines, plus a `Repo: owner/name` line when multiple repositories are registered)".

5. `converseTask`: add trailing optional param `registryText?: string`; append `${registryText ?? ""}` after `${attachmentsBlock(attachmentNote)}` in the goal (line 62).

These `systemAppend` edits change the fixed text ONCE and it stays byte-stable after — the per-run registry list itself is goal-only, preserving the prompt-cache rule.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/agent/tasks.test.ts tests/agent/converse.test.ts` → PASS.
Run: `npm run typecheck` — still only the known `pipeline.ts` `targetRepo` errors from Task 2.

- [ ] **Step 5: Commit**

```bash
git add src/agent/tasks.ts src/agent/converse.ts tests/agent/tasks.test.ts tests/agent/converse.test.ts
git commit -m "feat(agent): Repo: plan-header contract + registry block in converse/plan goals"
```

---

### Task 6: Orchestrator routing + per-repo sandbox config (`src/orchestrator/pipeline.ts`)

This is the integration task — it also fixes the `targetRepo` typecheck breaks left by Task 2.

**Files:**
- Modify: `src/orchestrator/pipeline.ts` (`#sbxCfg` :191-203, `onCreated` :435-521, `#runConverseTurn` :526-570, `#dispatchConverse` :573-593, `#trackedRun`'s `createRun` :419, the `getRepoMap` sites :545/:633/:816/:941, `#runImplement` :804)
- Test: `tests/orchestrator/pipeline.test.ts`

**Interfaces:**
- Consumes: `resolveRepo`, `findRepo`, `parseRepoLine`, `renderRegistry`, `RepoEntry` (Task 1); `config.repos` (Task 2); `store.setRepo` / `SessionRow.repo` (Task 3); `ctx.teamKey` (Task 4); `registryText` params (Task 5).
- Produces: user-visible behavior — sessions route per the precedence; implement refuses without a resolved repo; resume inherits the prior repo; sandbox clones the session's repo with its per-repo token.

- [ ] **Step 1: Add a private resolver + repo-aware `#sbxCfg`**

Add to the Orchestrator class (near `#workBranchFor`, :209):

```ts
  // Resolve this session's repo entry per the spec's precedence. Reads the pin
  // from the store; falls back to issue text, team, then single-entry registry.
  #repoFor(ctx: IssueContext): RepoEntry | null {
    return resolveRepo({
      registry: this.#config.repos,
      pinned: this.#store.get(ctx.agentSessionId)?.repo,
      issueText: `${ctx.title}\n${ctx.description}`,
      teamId: ctx.teamId,
      teamKey: ctx.teamKey,
    });
  }
```

Change `#sbxCfg(sessionId?: string)` to `#sbxCfg(sessionId: string | undefined, repo: RepoEntry)` and inside it replace

```ts
      ghToken: this.#config.ghToken, targetRepo: this.#config.targetRepo,
```

with

```ts
      ghToken: repo.token ?? this.#config.ghToken, targetRepo: repo.repo,
```

Update every `#sbxCfg(...)` call site to pass the resolved entry (each caller resolves once via `#repoFor(ctx)` — or receives the entry as a parameter — and reuses it for `#sbxCfg`, `getRepoMap`, and `createRun`). Import `resolveRepo, findRepo, parseRepoLine, renderRegistry, type RepoEntry` from `../repos.ts`.

- [ ] **Step 2: Pin at creation, inherit on resume**

In `onCreated`:

- In each of the three resume branches (prior.prUrl :475, implement/error :494, plan/await_approval :509), directly after the existing `this.#store.setPlan(ctx.agentSessionId, prior.plan);` line (or the `upsert` for the prUrl branch), add:

```ts
      if (prior.repo) this.#store.setRepo(ctx.agentSessionId, prior.repo);
```

(Inherited verbatim — never re-derived; a stale pin no longer in the registry is ignored by `resolveRepo` at use time.)

- After the fresh-session `this.#store.upsert(ctx.agentSessionId, "clarify", ctx.issueId);` (:519), add:

```ts
    const routed = this.#repoFor(ctx);
    if (routed) this.#store.setRepo(ctx.agentSessionId, routed.repo);
```

- [ ] **Step 3: Route the converse turn**

In `#runConverseTurn`'s `need_repo` branch (:543-563):

```ts
      if (action === "need_repo") {
        const repo = this.#repoFor(ctx);
        if (!repo) {
          const names = this.#config.repos.map((e) => `\`${e.repo}\``).join(", ");
          await acts.response(`Which repository is this about? Registered: ${names}. Tell me and I'll take a look.`);
          return; // stays in clarify
        }
        await acts.thought("Let me pull up the code…");
        const map = this.#store.getRepoMap(repo.repo);
        const sbxCfg = this.#sbxCfg(ctx.agentSessionId, repo);
        const result = await withSandbox(sbxCfg, async (sbx) => {
          ...
```

(keep the body identical otherwise, using `sbxCfg` for both the `withSandbox` and `cloneRepo` calls). Pass the registry block into `converseTask` as its new trailing arg:

```ts
          converseTask(ctx, userMessage, map, hist, images, docsContext, docsMcp, documents, note,
            renderRegistry(this.#config.repos, repo.repo))
```

Also pass `renderRegistry(this.#config.repos, this.#store.get(ctx.agentSessionId)?.repo)` into the Tier 0 `#runHostTurn` options if `runHostTurn` composes its own goal from these params — follow how `docsContext` flows there and thread `registryText` the same way (its builder appends it like Task 5's).

- [ ] **Step 4: Parse the plan header; guard implement**

In `#dispatchConverse`:

- `action === "plan"` branch (:586-590) — pin the header repo before storing:

```ts
    if (action === "plan") {
      const headerRepo = parseRepoLine(body.slice(0, 400));
      if (headerRepo && findRepo(this.#config.repos, headerRepo)) {
        this.#store.setRepo(ctx.agentSessionId, headerRepo);
      } else if (headerRepo) {
        // Unregistered name in a plan header: never pin it (poisoning guard).
        console.error(`[route] ${ctx.agentSessionId} plan names unregistered repo ${headerRepo} — ignoring`);
      }
      this.#store.setPlan(ctx.agentSessionId, body);
      await acts.response(`${body}${costSuffix}`);
      return;
    }
```

- `action === "implement"` branch (:574-585) — after the existing no-plan guard, add the no-repo guard:

```ts
      const repo = this.#repoFor(ctx);
      if (!repo) {
        const names = this.#config.repos.map((e) => `\`${e.repo}\``).join(", ");
        await acts.response(`I can't start: no target repository is agreed for this issue. Registered: ${names}. Add a \`Repo:\` line to the plan (or tell me which) and say go again.`);
        return; // stays in clarify
      }
```

and pass `repo` through to `#runImplement` (add a `repo: RepoEntry` parameter to `#runImplement`; inside it replace its `getRepoMap(this.#config.targetRepo)` (:816) and `#sbxCfg(...)` uses with `repo`, same for the review-path site :941 and the map-building site :633 — each resolves via `#repoFor(ctx)` or takes the entry as a param; a null resolution in those non-implement paths falls back to `this.#config.repos[0]` with a `console.error("[route] …unresolved, falling back…")` so advisory paths never hard-fail).

- [ ] **Step 5: Record the run's repo**

At `createRun` (:419) replace `this.#config.targetRepo` with:

```ts
      this.#store.get(sessionId)?.repo ?? this.#config.repos[0].repo
```

- [ ] **Step 6: Update pipeline tests**

`npx vitest run tests/orchestrator/pipeline.test.ts` will show which fixtures break (the fake config's `targetRepo` field must become `repos: [{ repo: "owner/name", description: "owner/name" }]`). Fix fixtures, then add cases following the file's existing fake-orchestrator helpers:

1. **Implement refused when unresolved:** registry with two entries, no team match, no pin; drive a session to a stored plan and dispatch `ACTION: implement`; assert the posted response contains "no target repository" and phase stays `clarify`.
2. **Plan header pins:** dispatch `ACTION: plan` whose body starts `Type: feature\nScope: small\nRepo: acme/web\n…` with `acme/web` registered; assert `store.get(session)?.repo === "acme/web"`.
3. **Unregistered header ignored:** same, with `Repo: evil/injected`; assert `repo` stays null and the plan is still stored.
4. **Resume inherits:** create a prior session row with `repo = "acme/web"`, phase `implement`, a plan and workBranch; fire `onCreated` for a new session on the same issue; assert the new session's row has `repo === "acme/web"`.
5. **Per-repo token reaches the sandbox:** registry entry with `token: "ghp_scoped"`; capture the cfg passed to the fake `withSandbox`/`Sandbox` (however the fakes expose it) and assert `ghToken === "ghp_scoped"` and `targetRepo` is the entry's repo.

- [ ] **Step 7: Typecheck + full suite**

Run: `npm run typecheck` → clean (the Task 2 breaks are now fixed).
Run: `npm test` → PASS.

- [ ] **Step 8: Commit**

```bash
git add src/orchestrator/pipeline.ts tests/orchestrator/pipeline.test.ts
git commit -m "feat(orchestrator): per-session repo routing, plan-header pinning, per-repo sandbox token"
```

---

### Task 7: Docs + example registry

**Files:**
- Create: `repos.json.example`
- Modify: `README.md` (Setup table + new section), `.env.example`, `CLAUDE.md` (Runtime prerequisites + architecture notes referencing `TARGET_REPO`)

- [ ] **Step 1: `repos.json.example`**

```json
[
  {
    "repo": "acme/billing-api",
    "description": "Billing service — Stripe integration, invoicing",
    "linearTeams": ["BIL"],
    "token": null
  },
  {
    "repo": "acme/web",
    "description": "Customer-facing web app (Next.js)",
    "linearTeams": ["WEB", "DES"]
  }
]
```

- [ ] **Step 2: README**

- Setup table: change the `TARGET_REPO` row to "single-repo shortcut; see Multi-repo" and add a `REPOS_CONFIG` row (path to `repos.json`, optional).
- New `## Multi-repo` section covering: the registry fields (`repo`, `description`, `linearTeams` matching team id **or** key, `token`); routing precedence (issue-body `Repo:` line → plan `Repo:` header → unique team match → single-entry registry → Jarvis asks); the plan's `Repo:` header as the human-visible routing decision; cross-repo work = decomposition into per-repo sub-issues with merge order stated in the PRs (v1 limitation: lockstep API+consumer changes verify against the sibling's `main`); **security note**: the GitHub token enters the sandbox, so a global `GH_TOKEN` across many repos widens blast radius — prefer per-repo `token` entries; upgrade path is GitHub-App installation tokens; the zero-code alternative for ≤2 repos (one Jarvis deployment per repo as separate Linear agents).

- [ ] **Step 3: `.env.example`**

Update the `TARGET_REPO` comment: `# Target repo (single-repo mode). For multiple repos, create repos.json (see repos.json.example) — it takes precedence.` Add `# REPOS_CONFIG=repos.json` beneath it.

- [ ] **Step 4: CLAUDE.md**

Update "Runtime prerequisites" (`TARGET_REPO` → registry) and add two sentences in the Architecture section pointing at `src/repos.ts` + the spec for the precedence rules.

- [ ] **Step 5: Final verification + commit**

Run: `npm run typecheck && npm test` → both clean.

```bash
git add repos.json.example README.md .env.example CLAUDE.md
git commit -m "docs: multi-repo registry, routing precedence, token-scoping guidance"
```
