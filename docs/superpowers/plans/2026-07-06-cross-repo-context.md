# Cross-Repo Targeting (Three-Tier Repo Resolver) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one Jarvis process serve more than one GitHub repository by resolving the target repo per-issue from Linear's own signals, falling back to today's single `TARGET_REPO`.

**Architecture:** A repo is resolved **once per session** in `onCreated` through three tiers — (1) a GitHub branch/PR already linked to the Linear issue, (2) Linear's `issueRepositorySuggestions` ranking over an operator-configured candidate list, (3) the `TARGET_REPO` default — then persisted on the session row (`sessions.repo`) and read everywhere via a `#repoFor()` helper. With no `CANDIDATE_REPOS` configured, the resolver short-circuits to `TARGET_REPO` and behavior is byte-identical to today (zero API calls added).

**Tech Stack:** TypeScript on Node ≥ 24.15 (`node:sqlite`), raw `fetch` GraphQL against Linear (no SDK queries — matches `makePlanFetcher`/`makeParentFetcher` pattern), vitest.

## Why these three tiers (verified facts)

- Linear agents are only ever triggered on **issues** (delegation/@mention) — never on projects/initiatives — so per-issue resolution is the only shape that fits. ([agent-interaction](https://linear.app/developers/agent-interaction))
- Linear has **no default repo per team or project**, and the `AgentSessionEvent` payload carries **no git data** — so a fresh issue has no structural repo signal; a fallback default is unavoidable. ([docs/github](https://linear.app/docs/github))
- Once a branch/PR **is** linked (branch-name match or PR magic words), it surfaces on the issue as an attachment with `sourceType: "github"`. There is **no typed PullRequest object** — parse owner/name from the attachment `url`, never from the unstable `metadata` JSON. One issue can link PRs across several repos. ([docs/github](https://linear.app/docs/github), [developers/attachments](https://linear.app/developers/attachments))
- `issueRepositorySuggestions` is Linear's purpose-built bootstrap for coding agents: you pass a candidate repo list, Linear LLM-ranks it with confidence scores. It does **not** enumerate repos — the candidate list is ours. ([changelog](https://linear.app/changelog/page/2))

## Global Constraints

- `CANDIDATE_REPOS` is a new **optional** env var: comma-separated `owner/name` list. Absent/empty ⇒ resolver returns `TARGET_REPO` immediately; **no new network calls, no behavior change** for existing deployments.
- **Trust boundary (do not simplify away):** the resolved repo is interpolated into a clone URL (`src/sandbox/session.ts:64`) and its code runs in a sandbox that holds `GH_TOKEN` in env. Every tier's output MUST be validated against the allowlist `{TARGET_REPO} ∪ CANDIDATE_REPOS`; anything else falls through. `CANDIDATE_REPOS` entries are validated as `owner/name` at boot (fail fast, like `REQUIRED`).
- `GH_TOKEN` must have access to every repo in `CANDIDATE_REPOS` (operator responsibility; document in `.env.example`).
- All Linear fetchers are **advisory** — any error logs and falls through; a repo-resolution failure must never block a session. Log tag: `[repo]`.
- Repo conventions: `.ts` import extensions; per-run content in `goal` not `systemAppend`; hand-rolled guarded `ALTER TABLE` migrations; tests fake E2B/Linear via constructor seams (no network).
- Every existing call site that passes `this.#config.targetRepo` for a *session-scoped* purpose must switch to the resolved repo — otherwise `repo_maps` (PK = repo string) records one repo's architecture map under another repo's key.
- Out of scope: multi-repo cloning into one sandbox, embeddings/retrieval, cross-issue memory, free-text `repo:` directives in issue text, per-repo tokens.

---

### Task 1: Config — `CANDIDATE_REPOS`

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `Config.candidateRepos: string[]` (validated `owner/name` entries; `[]` when unset). Later tasks read `config.candidateRepos` and `config.targetRepo`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/config.test.ts` (reuse the file's existing helper for a full valid env — every existing test builds one; follow its local pattern):

```ts
describe("candidateRepos", () => {
  it("defaults to [] when CANDIDATE_REPOS is unset", () => {
    const cfg = loadConfig(validEnv());
    expect(cfg.candidateRepos).toEqual([]);
  });

  it("parses a comma-separated list, trimming whitespace", () => {
    const cfg = loadConfig({ ...validEnv(), CANDIDATE_REPOS: "acme/frontend, acme/backend" });
    expect(cfg.candidateRepos).toEqual(["acme/frontend", "acme/backend"]);
  });

  it("throws on entries that are not owner/name", () => {
    expect(() => loadConfig({ ...validEnv(), CANDIDATE_REPOS: "acme/frontend,https://github.com/x/y" }))
      .toThrow(/CANDIDATE_REPOS/);
  });
});
```

(If the file has no shared `validEnv()` helper, inline the same env object literal its existing tests use.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `candidateRepos` does not exist on `Config`.

- [ ] **Step 3: Implement**

In `src/config.ts`, add to the interface (after `targetRepo: string;`, line 8):

```ts
  // Repos Jarvis may target beyond targetRepo. Optional; empty = single-repo
  // mode, resolver short-circuits to targetRepo with zero extra API calls.
  candidateRepos: string[];
```

Add above `loadConfig`:

```ts
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// Trust boundary: these strings end up in a git clone URL. Validate shape at
// boot and fail fast, same posture as the REQUIRED check above.
function parseCandidateRepos(raw: string | undefined): string[] {
  if (!raw) return [];
  const repos = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = repos.filter((r) => !REPO_RE.test(r));
  if (bad.length > 0) {
    throw new Error(`CANDIDATE_REPOS entries must be "owner/name": ${bad.join(", ")}`);
  }
  return repos;
}
```

Add to the returned object (after `targetRepo: env.TARGET_REPO!,`, line 38):

```ts
    candidateRepos: parseCandidateRepos(env.CANDIDATE_REPOS),
```

Append to `.env.example`:

```bash
# Optional: extra repos Jarvis may target (comma-separated owner/name).
# GH_TOKEN must have push access to all of them. Unset = single-repo mode.
# CANDIDATE_REPOS=acme/frontend,acme/backend
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/config.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts .env.example tests/config.test.ts
git commit -m "feat(config): optional CANDIDATE_REPOS allowlist for multi-repo"
```

---

### Task 2: Store — `sessions.repo` column

**Files:**
- Modify: `src/store/sessions.ts`
- Test: `tests/store/sessions.test.ts`

**Interfaces:**
- Produces: `SessionRow.repo: string | null`; `SessionStore.setRepo(agentSessionId: string, repo: string): void`. Mirrors `workBranch`/`setWorkBranch` exactly.

- [ ] **Step 1: Write the failing test**

Append to `tests/store/sessions.test.ts` (same in-memory-store setup the file's other setter tests use):

```ts
it("setRepo persists and round-trips through get and findResumableByIssue", () => {
  store.upsert("as_repo1", "clarify", "issue-r1");
  store.setRepo("as_repo1", "acme/backend");
  expect(store.get("as_repo1")?.repo).toBe("acme/backend");
  store.upsert("as_repo1", "done", "issue-r1");
  store.setPlan("as_repo1", "a plan");
  expect(store.findResumableByIssue("issue-r1", "other")?.repo).toBe("acme/backend");
});

it("repo is null for sessions that never set one", () => {
  store.upsert("as_repo2", "clarify", "issue-r2");
  expect(store.get("as_repo2")?.repo).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/store/sessions.test.ts`
Expected: FAIL — `setRepo` is not a function.

- [ ] **Step 3: Implement**

In `src/store/sessions.ts`:

1. `SessionRow` (line 19-31) — add after `workBranch: string | null;`:

```ts
  // Resolved target repo ("owner/name") for this session; null = pre-feature
  // rows and single-repo mode, callers fall back to config.targetRepo.
  repo: string | null;
```

2. Migration block (after the `sdk_session_id` guard, line 96-98) — same guarded pattern:

```ts
    if (!cols.some((c) => c.name === "repo")) {
      this.#db.exec(`ALTER TABLE sessions ADD COLUMN repo TEXT`);
    }
```

3. Setter (next to `setWorkBranch`, line 371-375):

```ts
  setRepo(agentSessionId: string, repo: string): void {
    this.#db
      .prepare(`UPDATE sessions SET repo = ?, updated_at = ? WHERE agent_session_id = ?`)
      .run(repo, new Date().toISOString(), agentSessionId);
  }
```

4. Row mapping — there are **four** places that map a raw row to `SessionRow` (grep `workBranch: row.work_branch` → lines ≈413, 447, 480, 504). At each, add `repo: row.repo,` beside it, and add `repo: string | null;` to each inline raw-row type annotation in the same functions (grep `work_branch: string | null` for the spots).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/store/sessions.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/store/sessions.ts tests/store/sessions.test.ts
git commit -m "feat(store): sessions.repo column for per-session repo resolution"
```

---

### Task 3: Linear client — Tier 1 fetcher (`makeRepoLinksFetcher`)

**Files:**
- Modify: `src/linear/client.ts`
- Test: `tests/linear/client.test.ts`

**Interfaces:**
- Consumes: `TokenSource`, `fetchWithAuth` (both already in `client.ts`).
- Produces: `makeRepoLinksFetcher(token, fetchImpl?, onUnauthorized?): (issueId: string) => Promise<string[]>` — deduped `owner/name` list of GitHub repos linked to the issue; `[]` on any error (advisory). Also exports `parseGithubRepoFromUrl(url: string): string | null` for unit testing.

- [ ] **Step 1: Write the failing tests**

Append to `tests/linear/client.test.ts` (mirror the file's existing `makeParentFetcher` tests — they show the fake-`fetch` pattern):

```ts
describe("parseGithubRepoFromUrl", () => {
  it("parses PR, branch, and bare repo URLs", () => {
    expect(parseGithubRepoFromUrl("https://github.com/acme/backend/pull/42")).toBe("acme/backend");
    expect(parseGithubRepoFromUrl("https://github.com/acme/back.end/tree/jarvis/eng-1")).toBe("acme/back.end");
    expect(parseGithubRepoFromUrl("https://github.com/acme/backend")).toBe("acme/backend");
  });
  it("rejects non-github and malformed URLs", () => {
    expect(parseGithubRepoFromUrl("https://gitlab.com/acme/backend/pull/1")).toBeNull();
    expect(parseGithubRepoFromUrl("https://github.com/acme")).toBeNull();
  });
});

describe("makeRepoLinksFetcher", () => {
  const attachment = (sourceType: string, url: string) => ({ sourceType, url });
  const okResponse = (nodes: unknown[]) =>
    new Response(JSON.stringify({ data: { issue: { attachments: { nodes } } } }), { status: 200 });

  it("returns deduped owner/name repos from github attachments only", async () => {
    const fakeFetch = vi.fn(async () => okResponse([
      attachment("github", "https://github.com/acme/backend/pull/42"),
      attachment("github", "https://github.com/acme/backend/pull/43"),
      attachment("github", "https://github.com/acme/frontend/pull/7"),
      attachment("slack", "https://slack.com/archives/C1/p1"),
    ]));
    const fetchRepoLinks = makeRepoLinksFetcher("tok", fakeFetch as unknown as typeof fetch);
    expect(await fetchRepoLinks("issue-1")).toEqual(["acme/backend", "acme/frontend"]);
    const body = JSON.parse((fakeFetch.mock.calls[0] as unknown[])[1]!.body as string);
    expect(body.variables).toEqual({ id: "issue-1" });
  });

  it("returns [] on HTTP failure, GraphQL errors, and throw", async () => {
    const cases: Array<() => Promise<Response>> = [
      async () => new Response("nope", { status: 500 }),
      async () => new Response(JSON.stringify({ errors: [{ message: "bad" }] }), { status: 200 }),
      async () => { throw new Error("network down"); },
    ];
    for (const impl of cases) {
      const fetchRepoLinks = makeRepoLinksFetcher("tok", vi.fn(impl) as unknown as typeof fetch);
      expect(await fetchRepoLinks("issue-1")).toEqual([]);
    }
  });
});
```

Add `parseGithubRepoFromUrl, makeRepoLinksFetcher` to the file's import from `../../src/linear/client.ts`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/linear/client.test.ts`
Expected: FAIL — exports don't exist.

- [ ] **Step 3: Implement**

In `src/linear/client.ts`, after `makeParentFetcher` (line 152):

```ts
const REPO_LINKS_QUERY = `query($id: String!) { issue(id: $id) { attachments(first: 50) { nodes { sourceType url } } } }`;

interface RepoLinksQueryResponse {
  data?: {
    issue?: {
      attachments?: { nodes?: { sourceType?: string | null; url?: string | null }[] } | null;
    } | null;
  } | null;
  errors?: unknown;
}

// Linear exposes no typed PullRequest object — repo identity is parsed from the
// attachment URL, NOT from the untyped metadata JSON (whose shape Linear may
// change). Matches https://github.com/owner/name followed by /, #, ?, or end.
const GITHUB_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:[/#?]|$)/;

export function parseGithubRepoFromUrl(url: string): string | null {
  const m = GITHUB_URL_RE.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Tier 1 of repo resolution: the GitHub branches/PRs Linear has linked to an
 * issue (attachments with sourceType "github"), as deduped "owner/name" strings.
 * Same advisory contract as the other fetchers: [] on any error. Callers MUST
 * validate results against the configured allowlist before cloning.
 */
export function makeRepoLinksFetcher(
  token: TokenSource,
  fetchImpl: typeof fetch = fetch,
  onUnauthorized?: () => Promise<string>,
): (issueId: string) => Promise<string[]> {
  return async (issueId: string): Promise<string[]> => {
    try {
      const res = await fetchWithAuth(
        "https://api.linear.app/graphql",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: REPO_LINKS_QUERY, variables: { id: issueId } }),
        },
        token,
        fetchImpl,
        onUnauthorized,
      );
      if (!res.ok) return [];
      const json = (await res.json()) as RepoLinksQueryResponse;
      if (json.errors) return [];
      const nodes = json.data?.issue?.attachments?.nodes ?? [];
      const repos = nodes
        .filter((n) => n.sourceType === "github" && n.url)
        .map((n) => parseGithubRepoFromUrl(n.url!))
        .filter((r): r is string => r !== null);
      return [...new Set(repos)];
    } catch {
      return [];
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/linear/client.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/linear/client.ts tests/linear/client.test.ts
git commit -m "feat(linear): makeRepoLinksFetcher reads github repos linked to an issue"
```

---

### Task 4: Linear client — Tier 2 fetcher (`makeRepoSuggester`)

**Files:**
- Modify: `src/linear/client.ts`
- Test: `tests/linear/client.test.ts`

**Interfaces:**
- Produces: `makeRepoSuggester(token, fetchImpl?, onUnauthorized?): (issueId: string, agentSessionId: string, candidates: string[]) => Promise<string | null>` — the highest-confidence candidate per Linear's `issueRepositorySuggestions`, or `null` (advisory).

- [ ] **Step 1: Verify the live schema first (the query is new; do not trust this plan's spelling)**

`issueRepositorySuggestions` is a recent Linear addition. Confirm field/arg names by introspection before coding. Get a token: read the `oauth_tokens` row from the dev DB, or use `LINEAR_ACCESS_TOKEN` from `.env`.

```bash
curl -s https://api.linear.app/graphql \
  -H "Authorization: Bearer $LINEAR_TOKEN" -H "content-type: application/json" \
  -d '{"query":"{ __type(name: \"Query\") { fields { name args { name type { kind name ofType { kind name ofType { name } } } } } } }"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const f=JSON.parse(s).data.__type.fields.filter(x=>/epositor/i.test(x.name));console.log(JSON.stringify(f,null,2))})"
```

Expected: a field named `issueRepositorySuggestions` with args `issueId`, `agentSessionId`, `candidateRepositories` (input objects with `hostname`, `repositoryFullName`). Also introspect the return type the same way (`__type(name: "...")` on the payload type it names). **If names differ, adjust `REPO_SUGGEST_QUERY` in Step 4 to match reality and note the correction in the commit message.**

- [ ] **Step 2: Write the failing tests**

Append to `tests/linear/client.test.ts`:

```ts
describe("makeRepoSuggester", () => {
  const okResponse = (suggestions: unknown[]) =>
    new Response(JSON.stringify({ data: { issueRepositorySuggestions: { suggestions } } }), { status: 200 });

  it("returns the highest-confidence suggestion that is in the candidate list", async () => {
    const fakeFetch = vi.fn(async () => okResponse([
      { repositoryFullName: "acme/frontend", hostname: "github.com", confidence: 0.4 },
      { repositoryFullName: "acme/backend", hostname: "github.com", confidence: 0.9 },
      { repositoryFullName: "evil/other", hostname: "github.com", confidence: 1.0 },
    ]));
    const suggest = makeRepoSuggester("tok", fakeFetch as unknown as typeof fetch);
    const repo = await suggest("issue-1", "as-1", ["acme/frontend", "acme/backend"]);
    expect(repo).toBe("acme/backend");
    const body = JSON.parse((fakeFetch.mock.calls[0] as unknown[])[1]!.body as string);
    expect(body.variables.issueId).toBe("issue-1");
    expect(body.variables.agentSessionId).toBe("as-1");
    expect(body.variables.candidateRepositories).toEqual([
      { hostname: "github.com", repositoryFullName: "acme/frontend" },
      { hostname: "github.com", repositoryFullName: "acme/backend" },
    ]);
  });

  it("returns null on empty suggestions, HTTP failure, GraphQL errors, and throw", async () => {
    const impls: Array<() => Promise<Response>> = [
      async () => okResponse([]),
      async () => new Response("nope", { status: 500 }),
      async () => new Response(JSON.stringify({ errors: [{ message: "bad" }] }), { status: 200 }),
      async () => { throw new Error("network down"); },
    ];
    for (const impl of impls) {
      const suggest = makeRepoSuggester("tok", vi.fn(impl) as unknown as typeof fetch);
      expect(await suggest("issue-1", "as-1", ["acme/backend"])).toBeNull();
    }
  });
});
```

Add `makeRepoSuggester` to the import.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/linear/client.test.ts`
Expected: FAIL — `makeRepoSuggester` is not exported.

- [ ] **Step 4: Implement**

In `src/linear/client.ts`, after `makeRepoLinksFetcher`:

```ts
// Verified against live schema introspection on <date you ran Task 4 Step 1>.
const REPO_SUGGEST_QUERY = `query($issueId: String!, $agentSessionId: String, $candidateRepositories: [IssueRepositorySuggestionCandidateInput!]) { issueRepositorySuggestions(issueId: $issueId, agentSessionId: $agentSessionId, candidateRepositories: $candidateRepositories) { suggestions { repositoryFullName hostname confidence } } }`;

interface RepoSuggestQueryResponse {
  data?: {
    issueRepositorySuggestions?: {
      suggestions?: { repositoryFullName?: string | null; hostname?: string | null; confidence?: number | null }[] | null;
    } | null;
  } | null;
  errors?: unknown;
}

/**
 * Tier 2 of repo resolution: Linear LLM-ranks OUR candidate repos for an issue
 * (issueRepositorySuggestions — built for coding agents; it ranks the supplied
 * list, it does not enumerate repos). Returns the highest-confidence candidate,
 * filtered to the supplied list (never trust a repo we didn't offer). Advisory:
 * null on any error or empty result.
 */
export function makeRepoSuggester(
  token: TokenSource,
  fetchImpl: typeof fetch = fetch,
  onUnauthorized?: () => Promise<string>,
): (issueId: string, agentSessionId: string, candidates: string[]) => Promise<string | null> {
  return async (issueId, agentSessionId, candidates) => {
    try {
      const res = await fetchWithAuth(
        "https://api.linear.app/graphql",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: REPO_SUGGEST_QUERY,
            variables: {
              issueId,
              agentSessionId,
              candidateRepositories: candidates.map((r) => ({ hostname: "github.com", repositoryFullName: r })),
            },
          }),
        },
        token,
        fetchImpl,
        onUnauthorized,
      );
      if (!res.ok) return null;
      const json = (await res.json()) as RepoSuggestQueryResponse;
      if (json.errors) return null;
      const suggestions = json.data?.issueRepositorySuggestions?.suggestions ?? [];
      const best = suggestions
        .filter((s): s is { repositoryFullName: string; confidence: number | null } =>
          typeof s.repositoryFullName === "string" && candidates.includes(s.repositoryFullName))
        .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
      return best?.repositoryFullName ?? null;
    } catch {
      return null;
    }
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/linear/client.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/linear/client.ts tests/linear/client.test.ts
git commit -m "feat(linear): makeRepoSuggester wraps issueRepositorySuggestions"
```

---

### Task 5: Orchestrator — resolve once, read everywhere

**Files:**
- Modify: `src/orchestrator/pipeline.ts`
- Modify: `src/server.ts`
- Modify: `CLAUDE.md`
- Test: `tests/orchestrator/pipeline.test.ts`

**Interfaces:**
- Consumes: `Config.candidateRepos` (Task 1), `SessionStore.setRepo` / `SessionRow.repo` (Task 2), `makeRepoLinksFetcher` / `makeRepoSuggester` (Tasks 3-4).
- Produces: two new optional constructor args on `Orchestrator` (appended after `fetchParent`, keeping the positional-seam pattern): `fetchRepoLinks?: (issueId: string) => Promise<string[]>` and `suggestRepo?: (issueId: string, agentSessionId: string, candidates: string[]) => Promise<string | null>`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/orchestrator/pipeline.test.ts`. Extend the file's `makeOrchWithFakeSandbox` helper with two new optional seams `fetchRepoLinks` / `suggestRepo`, passed through as the two new trailing constructor args (exactly how the `fetchParent` seam was added — copy that wiring). To enable multi-repo mode in a test, pass a config whose `candidateRepos` is non-empty (the helper builds a `Config` literal; add `candidateRepos: []` to its default and let tests override).

```ts
describe("repo resolution (three tiers)", () => {
  it("tier 1: uses a linked github repo from the allowlist and records it everywhere", async () => {
    const fetchRepoLinks = vi.fn(async () => ["acme/backend"]);
    const suggestRepo = vi.fn(async () => null);
    const { orch, store } = makeOrchWithFakeSandbox({
      candidateRepos: ["acme/backend"], fetchRepoLinks, suggestRepo,
    });
    await orch.onCreated(ctx("as_r1", "issue-r1"));
    expect(store.get("as_r1")?.repo).toBe("acme/backend");
    expect(suggestRepo).not.toHaveBeenCalled(); // tier 1 won, tier 2 skipped
  });

  it("tier 1 result NOT in the allowlist falls through (never clone an unlisted repo)", async () => {
    const fetchRepoLinks = vi.fn(async () => ["evil/other"]);
    const suggestRepo = vi.fn(async () => null);
    const { orch, store } = makeOrchWithFakeSandbox({
      candidateRepos: ["acme/backend"], fetchRepoLinks, suggestRepo,
    });
    await orch.onCreated(ctx("as_r2", "issue-r2"));
    expect(store.get("as_r2")?.repo).toBe(TEST_TARGET_REPO); // fell to tier 3
  });

  it("tier 2: uses the suggestion when nothing is linked", async () => {
    const { orch, store } = makeOrchWithFakeSandbox({
      candidateRepos: ["acme/backend", "acme/frontend"],
      fetchRepoLinks: vi.fn(async () => []),
      suggestRepo: vi.fn(async () => "acme/frontend"),
    });
    await orch.onCreated(ctx("as_r3", "issue-r3"));
    expect(store.get("as_r3")?.repo).toBe("acme/frontend");
  });

  it("single-repo mode (no candidateRepos): resolver short-circuits, fetchers never called", async () => {
    const fetchRepoLinks = vi.fn(async () => []);
    const { orch, store } = makeOrchWithFakeSandbox({ fetchRepoLinks });
    await orch.onCreated(ctx("as_r4", "issue-r4"));
    expect(store.get("as_r4")?.repo).toBe(TEST_TARGET_REPO);
    expect(fetchRepoLinks).not.toHaveBeenCalled();
  });

  it("resume: a new session for the same issue inherits the prior session's repo", async () => {
    const { orch, store } = makeOrchWithFakeSandbox({
      candidateRepos: ["acme/backend"],
      fetchRepoLinks: vi.fn(async () => ["acme/backend"]),
    });
    await orch.onCreated(ctx("as_r5", "issue-r5"));
    store.setPlan("as_r5", "Type: feature\nScope: small\n\na plan");
    store.upsert("as_r5", "await_approval", "issue-r5");
    await orch.onCreated(ctx("as_r6", "issue-r5")); // re-assignment, same issue
    expect(store.get("as_r6")?.repo).toBe("acme/backend");
  });
});
```

(`ctx(sessionId, issueId)` and `TEST_TARGET_REPO` = whatever the file's existing helpers/constants are named — reuse them, don't invent parallel ones. Throwing-fetcher coverage: add one more case with `fetchRepoLinks: vi.fn(async () => { throw new Error("boom"); })` asserting fallback to `TEST_TARGET_REPO` and that `onCreated` still lands in `clarify`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/orchestrator/pipeline.test.ts -t "repo resolution"`
Expected: FAIL — constructor/seams don't exist yet.

- [ ] **Step 3: Implement in `src/orchestrator/pipeline.ts`**

1. Fields (after `#fetchParent`, line 117):

```ts
  // Tier 1 + tier 2 of per-session repo resolution (see #resolveRepo). Both
  // advisory; absent in tests that don't care.
  #fetchRepoLinks?: (issueId: string) => Promise<string[]>;
  #suggestRepo?: (issueId: string, agentSessionId: string, candidates: string[]) => Promise<string | null>;
```

2. Constructor params (appended after `fetchParent`, line 140) and assignments (after line 154):

```ts
    fetchRepoLinks?: (issueId: string) => Promise<string[]>,
    suggestRepo?: (issueId: string, agentSessionId: string, candidates: string[]) => Promise<string | null>,
```
```ts
    this.#fetchRepoLinks = fetchRepoLinks;
    this.#suggestRepo = suggestRepo;
```

3. Resolver + reader (next to `#workBranchFor`, line 195):

```ts
  // Per-session target repo, resolved once at session birth (onCreated) and
  // persisted on the row. Three tiers, each validated against the allowlist
  // {targetRepo} ∪ candidateRepos — the resolved string goes into a clone URL
  // and the sandbox holds GH_TOKEN, so an unlisted repo is never accepted:
  //   1. a GitHub branch/PR Linear already linked to the issue
  //   2. Linear's issueRepositorySuggestions ranking of our candidates
  //   3. config.targetRepo
  // ponytail: single-repo mode (no CANDIDATE_REPOS) returns targetRepo with no
  // API calls — today's deployments are byte-identical. Multiple linked repos:
  // first match wins, logged; upgrade to an ask_user elicitation if it bites.
  async #resolveRepo(ctx: IssueContext): Promise<string> {
    const fallback = this.#config.targetRepo;
    if (this.#config.candidateRepos.length === 0) return fallback;
    const allowed = new Set([fallback, ...this.#config.candidateRepos]);
    try {
      if (ctx.issueId && this.#fetchRepoLinks) {
        const linked = (await this.#fetchRepoLinks(ctx.issueId)).filter((r) => allowed.has(r));
        if (linked.length > 0) {
          if (linked.length > 1) {
            console.log(`[repo] ${ctx.agentSessionId} multiple linked repos (${linked.join(", ")}) — using ${linked[0]}`);
          }
          return linked[0];
        }
      }
      if (ctx.issueId && this.#suggestRepo) {
        const suggested = await this.#suggestRepo(ctx.issueId, ctx.agentSessionId, [...allowed]);
        if (suggested && allowed.has(suggested)) return suggested;
      }
    } catch (err) {
      console.error(`[repo] ${ctx.agentSessionId} repo resolution failed (advisory): ${err instanceof Error ? err.message : String(err)}`);
    }
    return fallback;
  }

  // The session's resolved repo everywhere a repo string is needed. Null row or
  // pre-feature row (repo column null) falls back to the global default.
  #repoFor(agentSessionId: string): string {
    return this.#store.get(agentSessionId)?.repo ?? this.#config.targetRepo;
  }
```

4. `#sbxCfg` (line 177-189) — change the `targetRepo:` line to:

```ts
      ghToken: this.#config.ghToken,
      targetRepo: sessionId === undefined ? this.#config.targetRepo : this.#repoFor(sessionId),
```

5. Swap every session-scoped `this.#config.targetRepo` (the `repo_maps`-leak fix — all have a session id in scope):
   - line 337 (`#trackedRun`): `this.#store.createRun(sessionId, taskType, this.#repoFor(sessionId), ...)`
   - line 454 (`#runConverseTurn`): `this.#store.getRepoMap(this.#repoFor(ctx.agentSessionId))`
   - lines 541 + 548 (`#runPlan`): `this.#store.getRepoMap(this.#repoFor(ctx.agentSessionId))` / `this.#store.setRepoMap(this.#repoFor(ctx.agentSessionId), map)`
   - line 721 (`#runImplement`): `this.#store.getRepoMap(this.#repoFor(ctx.agentSessionId))`
   - line 843 (`#runReview`): `this.#store.getRepoMap(this.#repoFor(ctx.agentSessionId))`

   After this, `grep -n "config.targetRepo" src/orchestrator/pipeline.ts` must show only `#resolveRepo`, `#repoFor`, and `#sbxCfg`'s no-session branch.

6. `onCreated` — resolve at session birth and inherit on resume:
   - Fresh path: immediately after `this.#store.upsert(ctx.agentSessionId, "clarify", ctx.issueId);` (line 437):

```ts
    this.#store.setRepo(ctx.agentSessionId, await this.#resolveRepo(ctx));
```

   - All three resume branches (after each branch's `upsert`, lines ≈395, 414, 429 — beside the existing `setPlan`/`setBranch` copies):

```ts
      this.#store.setRepo(ctx.agentSessionId, prior.repo ?? (await this.#resolveRepo(ctx)));
```

   (Inheriting `prior.repo` keeps a resumed implementation on the repo its work branch was pushed to; re-resolving there could silently switch repos mid-issue.)

- [ ] **Step 4: Wire `src/server.ts`**

Extend the import (line 5) with `makeRepoLinksFetcher, makeRepoSuggester`, and append two constructor args after `makeParentFetcher(...)` (line 48):

```ts
    makeRepoLinksFetcher(getToken, fetch, onUnauthorized),
    makeRepoSuggester(getToken, fetch, onUnauthorized),
```

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run && npm run typecheck`
Expected: all tests PASS (including the 5+ new ones), typecheck clean.

- [ ] **Step 6: Update `CLAUDE.md`**

In **Runtime prerequisites**, extend the `.env` line: `TARGET_REPO` (`owner/name`), *optional `CANDIDATE_REPOS` (comma-separated `owner/name`) to let Jarvis target multiple repos*. In **Architecture**, add one short paragraph under the sandbox section:

```markdown
### Repo resolution (multi-repo)

The target repo is resolved once per session in `onCreated` (`#resolveRepo`) and
stored on the session row: (1) a GitHub branch/PR Linear already linked to the
issue (`makeRepoLinksFetcher` — attachment URLs, `sourceType === "github"`),
(2) Linear's `issueRepositorySuggestions` ranking of the configured
`CANDIDATE_REPOS` (`makeRepoSuggester`), (3) the `TARGET_REPO` default. Every
tier is validated against `{TARGET_REPO} ∪ CANDIDATE_REPOS` — the string goes
into a clone URL, so an unlisted repo is never accepted. Resumed sessions
inherit the prior session's repo. With `CANDIDATE_REPOS` unset the resolver
short-circuits to `TARGET_REPO` (no extra API calls — single-repo deployments
are unchanged). All session-scoped repo reads go through `#repoFor()`, so
`repo_maps`/`runs.repo` key by the resolved repo, not the global default.
```

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/pipeline.ts src/server.ts CLAUDE.md tests/orchestrator/pipeline.test.ts
git commit -m "feat(orchestrator): three-tier per-session repo resolution"
```

---

## Risks / open questions

1. **`issueRepositorySuggestions` schema drift** — the query is new and this plan's spelling comes from docs, not introspection. Task 4 Step 1 exists precisely to catch this; the tier fails soft to `TARGET_REPO` even if the query breaks later.
2. **Multiple linked repos on one issue** — legitimate (a feature with frontend + backend PRs). v1 takes the first allowlisted match and logs. If this misfires in practice, upgrade: post an `ask_user` elicitation listing the linked repos.
3. **Repo maps for new candidate repos** — the first session against a new repo pays the one-time `mapTask` cost (existing behavior, now keyed correctly per repo by the call-site swap).
4. **`GH_TOKEN` scope** — one token must reach all candidate repos. Per-repo tokens are out of scope (`// ponytail:` it if it ever matters).

## Explicitly out of scope

- **Multi-repo cloning into one sandbox** (read context from a second repo). Revisit only when tier 1 starts showing real issues linked to PRs across several repos — the resolver's logs will surface that evidence for free.
- **Cross-issue retrieval / search tooling** — dropped entirely; same-issue history (`src/history/history.ts`) already covers resumption, and repo discovery is served exactly by the tiers above.
- **Embeddings, FTS, initiatives/projects as scopes, free-text `repo:` directives, per-repo tokens.**
