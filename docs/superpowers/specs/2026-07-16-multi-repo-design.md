# Multi-repo support — design

**Date:** 2026-07-16
**Status:** approved (stress-tested in conversation; v1 scope settled for open-source release with unknown adopters)

## Problem

Jarvis is hardcoded to one repository (`TARGET_REPO` env var, `config.targetRepo`
threaded through the orchestrator and sandbox clone). Real teams have many repos.
Two questions must be answered per session: **which repo does this issue concern**,
and **how does the agent know what other repos exist and how they relate**.

## Design principles (what this design refuses to trade)

1. **Durability**: one session = one repo = one work branch = one PR. Resume,
   `reconcile()`, `workBranch`, and `#finishImplement` invariants stay untouched.
2. **The merge gate**: humans merge. Cross-repo sequencing is therefore a human
   concern at merge time, not an orchestration problem in code.
3. **Existing seams over new machinery**: plan-header contract (`Type:`/`Scope:`),
   `repo_maps` cache, the `Decomposition:` escape hatch, and the clarify loop
   already solve most of this.

## The registry

A `repos.json` file (path via `REPOS_CONFIG`, default `./repos.json`):

```json
[
  {
    "repo": "acme/billing-api",
    "description": "Billing service — Stripe integration, invoicing",
    "linearTeams": ["BIL", "PLAT"],
    "token": null
  }
]
```

- `repo` — `owner/name`, required.
- `description` — one line, injected into agent context, required.
- `linearTeams` — optional Linear team keys/ids mapped to this repo.
- `token` — optional per-repo GitHub token overriding the global `GH_TOKEN`.

**Fallback:** if no `repos.json` exists, `TARGET_REPO` becomes a single-entry
registry (description defaults to the repo name). Existing deployments change
nothing. `TARGET_REPO` becomes optional in config when `repos.json` is present.

## Routing

Precedence, first match wins. **Every candidate is validated against the
registry — an unregistered repo is never routable, from any source.** A match
that fails validation falls through to the next rule; if nothing routes, the
session asks the human in clarify (existing resting state) and refuses to
implement until a registered repo is pinned.

1. **Repo named in the issue body** — a line `Repo: owner/name`. This is how
   decomposition sub-issues carry their target (a sub-issue's team may map
   elsewhere; explicit intent wins). Registry validation is the anti-poisoning
   gate: an issue body naming an unregistered repo does not route.
2. **`Repo:` plan header** — the plan contract grows a third fixed line
   (`Type:` / `Scope:` / `Repo:`), parsed by the same header-parsing approach
   as `routeImplement`. Re-parsed on every plan revision, so the repo stays
   revisable until implement starts.
3. **Team mapping** — the issue's team looked up in the registry.
   `linearTeams` entries match against the team **id or key**; `IssueContext`
   already extracts `teamId` and gains `teamKey` (both are on the webhook
   payload's `issue.team`). Unique match → routed deterministically, no
   tokens spent.
4. **Agent choice** — with multiple candidates (or none), the converse/plan
   agent picks, informed by the registry context block (below), and declares
   via the `Repo:` plan header. The human reading the plan during clarify is
   the backstop; a misroute costs one conversational turn.

## Session lifecycle

- `sessions` gains a `repo` column (hand-rolled `ALTER TABLE` migration guarded
  by `pragma_table_info`, existing pattern).
- Pinned when routing first resolves; revisable until phase=implement (each
  plan revision re-parses the header).
- **Inherited verbatim through `findResumableByIssue`** — a resumed session
  copies the prior session's repo; it is never re-derived from a team mapping
  that may have changed since.
- `createRun` records the session's repo (already takes a repo argument).
- A repo switch after work was pushed orphans the old repo's
  `jarvis/<issueId>` branch. Accepted litter; no cleanup machinery.

## Cross-repo knowledge

- The target repo's full cached map (`repo_maps`, already keyed by repo) is
  injected as today.
- Every converse/plan goal additionally gets a **registry block**: one line per
  registered repo (`owner/name — description`), marking the current target.
  Per-run goal content, so prompt-cache-safe (never in `systemAppend`).
- Ceiling (`ponytail:` comment): at dozens of repos the block needs a cap;
  upgrade path is a `get_repo_map(repo)` tool on the existing docs MCP server
  (`src/mcp/docs-server.ts`), same seam as `get_thread`/`get_run_events`.
- No dependency graph. Relationships live in the maps' own prose.

## Cross-repo changes

Decomposition only. A change spanning repos routes through the existing
`Decomposition:` path: one sub-issue per repo, each body carrying its
`Repo: owner/name` line, each arriving as its own `created` webhook and running
the normal single-repo pipeline to its own PR. Merge sequencing is prose in the
plan and PR descriptions — humans own merging.

**Documented v1 limitation:** tightly-coupled lockstep changes (API change +
consumer) get sub-issues that implement against the sibling repo's `main`, so
the consumer side verifies against a world that predates the API change.
Upgrade path (named in a `ponytail:` comment): sibling-branch cloning — the
dependent sub-issue's sandbox additionally clones the sibling repo checked out
at its `jarvis/<parent-issue>` work branch, read-only, restoring honest
verification with zero orchestration. Not built until a real adopter hits it.

## Security

- The GitHub token enters the sandbox (implement pushes and runs
  `gh pr create` from inside). Multi-repo widens the blast radius of a global
  `GH_TOKEN`; the per-repo `token` registry field keeps scoping possible.
  README documents the trade-off.
- Upgrade path (`ponytail:` comment): a GitHub App minting short-lived
  single-repo installation tokens per run — same pattern as the docs-MCP
  short-lived bearer tokens.
- Registry validation (Routing above) is a trust-boundary check, not optional:
  issue bodies are writable by anyone with Linear access.

## Explicitly not building

- Merge orchestration / cross-repo atomicity (humans sequence at merge)
- Multi-repo sandboxes / multi-PR sessions (breaks durability invariants)
- Dependency graph or service catalog (maps carry the relationships)
- Learned/classifier routing (team mapping + plan header + human backstop;
  a Haiku classifier à la `classifyPrRevision` is the cheap upgrade if
  ambiguous routing gets annoying)
- Zero-code alternative, documented for small setups: run one Jarvis
  deployment per repo as separate Linear agents. Right answer at ≤2 repos.

## Touch points (implementation sketch)

| Where | Change |
|---|---|
| `src/config.ts` | load `repos.json` (or synthesize from `TARGET_REPO`); `Config.repos: RepoEntry[]` |
| `src/store/sessions.ts` | `repo` column + migration; carry through resume queries |
| `src/linear/context.ts` | parse `Repo:` line from issue body |
| `src/agent/tasks.ts` | plan contract gains `Repo:` header; registry block appended to goals; parse header alongside `routeImplement` |
| `src/orchestrator/pipeline.ts` | resolve repo via precedence at `onCreated`/plan time; use session repo (not `config.targetRepo`) for clone, maps, runs; decomposition writes `Repo:` into sub-issue bodies |
| `src/sandbox/session.ts` | `cloneRepo` takes repo + token from the session's registry entry |
| `README.md` | registry docs, blast-radius warning, per-repo-deployment alternative |

## Testing

- Registry loading: `repos.json`, `TARGET_REPO` fallback, both, neither (error).
- Routing precedence: each rule, fall-through, unregistered-repo rejection
  (including a poisoned issue body).
- Plan header parsing: present, absent, garbled, revised mid-clarify.
- Resume: repo inherited from prior session, not re-derived.
- Decomposition: sub-issue bodies carry `Repo:` lines.
- All via the existing fake-`AgentSandbox` pattern — no network.
