import { fetchWithAuth, type TokenSource } from "./client.ts";

const GRAPHQL = "https://api.linear.app/graphql";

// A generous safety ceiling for a single doc fetch. Only pathological docs hit
// it; a hit returns an explicit marker so the agent knows to page, never a
// silent cut. ponytail: char count, not tokens — the point is "never hallucinate
// the missing part", not a precise token budget.
export const DOC_FETCH_CEILING = 100_000;

export interface DocSearchResult { id: string; title: string; project: string | null; snippet: string }
export interface DocContent { id: string; title: string; content: string }

/** Slice `content` from `offset`; if more than `ceiling` chars remain, cut at the
 *  ceiling and append `marker(nextOffset)`. Under the ceiling → returned verbatim. */
export function sliceWithMarker(
  content: string,
  offset: number,
  ceiling: number,
  marker: (nextOffset: number) => string,
): string {
  const start = Math.max(0, offset);
  const slice = content.slice(start, start + ceiling);
  const nextOffset = start + ceiling;
  return nextOffset < content.length ? `${slice}${marker(nextOffset)}` : slice;
}

async function gql<T>(
  token: TokenSource,
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: typeof fetch,
  onUnauthorized?: () => Promise<string>,
): Promise<T | null> {
  try {
    const res = await fetchWithAuth(
      GRAPHQL,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }) },
      token, fetchImpl, onUnauthorized,
    );
    if (!res.ok) {
      console.error(`[docs] gql non-200 (advisory): ${res.status}`);
      return null;
    }
    const json = (await res.json()) as { data?: T; errors?: unknown };
    if (json.errors || !json.data) {
      console.error(`[docs] gql error (advisory): ${JSON.stringify(json.errors).slice(0, 200)}`);
      return null;
    }
    return json.data;
  } catch (err) {
    console.error(`[docs] gql failed (advisory): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

const SEARCH_QUERY =
  `query($q: String!, $first: Int!) { searchDocuments(term: $q, first: $first) { nodes { id title project { name } content } } }`;

const DOC_QUERY = `query($id: String!) { document(id: $id) { id title content } }`;

interface SearchData { searchDocuments?: { nodes?: { id: string; title?: string; project?: { name?: string } | null; content?: string }[] } }

/** Search workspace documents. Advisory: [] on any failure. */
export async function searchDocuments(
  token: TokenSource,
  query: string,
  opts: { first?: number; fetchImpl?: typeof fetch; onUnauthorized?: () => Promise<string> } = {},
): Promise<DocSearchResult[]> {
  const data = await gql<SearchData>(token, SEARCH_QUERY, { q: query, first: opts.first ?? 20 }, opts.fetchImpl ?? fetch, opts.onUnauthorized);
  const nodes = data?.searchDocuments?.nodes ?? [];
  return nodes.map((n) => ({
    id: n.id,
    title: n.title ?? "",
    project: n.project?.name ?? null,
    // A short one-line snippet; the agent pulls the full doc via get_document.
    snippet: (n.content ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
  }));
}

interface DocData { document?: { id: string; title?: string; content?: string } | null }

/** Fetch one document's markdown content. Advisory: null on any failure/missing. */
export async function getDocumentContent(
  token: TokenSource,
  id: string,
  opts: { fetchImpl?: typeof fetch; onUnauthorized?: () => Promise<string> } = {},
): Promise<DocContent | null> {
  const data = await gql<DocData>(token, DOC_QUERY, { id }, opts.fetchImpl ?? fetch, opts.onUnauthorized);
  const d = data?.document;
  if (!d?.id) return null;
  return { id: d.id, title: d.title ?? "", content: d.content ?? "" };
}

// Full-content injection budget (Issue.documents + pasted docs + project
// overview). ponytail: char cap, keep-what-fits with a per-doc marker — the
// remaining project docs go in as a one-line index instead of body.
export const DOC_CONTEXT_CAP = 15_000;

const DOC_LINK_RE = /linear\.app\/[^/\s]+\/document\/[^)\s]*-([A-Za-z0-9]+)/g;

/** slugId is the trailing token after the last '-' in a Linear document URL. */
export function extractPastedDocSlugs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(DOC_LINK_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

export interface IssueDocsBundle {
  fullDocs: { id: string; title: string; content: string }[];
  projectContent: { id: string; title: string; content: string } | null;
  projectDocIndex: { id: string; title: string }[];
}

// One combined query: the ticket's attached docs, its project overview + name,
// and the project's remaining docs (for the index). Pasted-link docs are resolved
// separately by slugId and merged into fullDocs.
const ISSUE_DOCS_QUERY =
  `query($id: String!) { issue(id: $id) {
     documents { nodes { id title content } }
     project { id name content documents { nodes { id title } } }
   } }`;
const DOC_BY_SLUG_QUERY = `query($slug: String!) { documents(filter: { slugId: { eq: $slug } }, first: 1) { nodes { id title content } } }`;

/** Render the injected block. Full docs are emitted until the cap; the doc that
 *  overflows is cut with a marker naming its id, and any later full docs fall to
 *  the index. Project docs not already shown appear as one-line index entries. */
export function renderDocContext(bundle: IssueDocsBundle, cap: number = DOC_CONTEXT_CAP): string | undefined {
  const shownIds = new Set<string>();
  const sections: string[] = [];
  let used = 0;
  const emit = (id: string, title: string, content: string) => {
    shownIds.add(id);
    const header = `### ${title} (id: ${id})\n`;
    const remaining = cap - used - header.length;
    if (remaining <= 0) {
      sections.push(`${header}[truncated — full doc: get_document("${id}")]`);
      return;
    }
    if (content.length > remaining) {
      sections.push(`${header}${content.slice(0, remaining)}\n[truncated — full doc: get_document("${id}")]`);
      used = cap;
    } else {
      sections.push(`${header}${content}`);
      used += header.length + content.length;
    }
  };

  if (bundle.projectContent) emit(bundle.projectContent.id, `Project overview: ${bundle.projectContent.title}`, bundle.projectContent.content);
  for (const d of bundle.fullDocs) emit(d.id, d.title, d.content);

  const index = bundle.projectDocIndex.filter((d) => !shownIds.has(d.id));
  if (index.length > 0) {
    sections.push(
      `Other project documents (fetch with get_document when relevant):\n` +
        index.map((d) => `- ${d.title} (id: ${d.id})`).join("\n"),
    );
  }
  if (sections.length === 0) return undefined;
  return `Linear documents attached to this ticket and project:\n\n${sections.join("\n\n")}`;
}

/** Assemble the up-front doc context for an issue. Advisory: undefined on any
 *  failure or when there's nothing to inject. */
export async function assembleDocContext(
  token: TokenSource,
  issueId: string | null,
  issueText: string,
  opts: { fetchImpl?: typeof fetch; onUnauthorized?: () => Promise<string> } = {},
): Promise<string | undefined> {
  if (!issueId) return undefined;
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const data = await gql<{ issue?: {
      documents?: { nodes?: { id: string; title?: string; content?: string }[] };
      project?: { id: string; name?: string; content?: string; documents?: { nodes?: { id: string; title?: string }[] } } | null;
    } }>(token, ISSUE_DOCS_QUERY, { id: issueId }, fetchImpl, opts.onUnauthorized);
    if (!data?.issue) return undefined;

    const fullDocs = (data.issue.documents?.nodes ?? []).map((d) => ({ id: d.id, title: d.title ?? "", content: d.content ?? "" }));

    // Resolve pasted doc links (dedupe against already-attached docs).
    const seen = new Set(fullDocs.map((d) => d.id));
    for (const slug of extractPastedDocSlugs(issueText)) {
      const sd = await gql<{ documents?: { nodes?: { id: string; title?: string; content?: string }[] } }>(token, DOC_BY_SLUG_QUERY, { slug }, fetchImpl, opts.onUnauthorized);
      const node = sd?.documents?.nodes?.[0];
      if (node && !seen.has(node.id)) { seen.add(node.id); fullDocs.push({ id: node.id, title: node.title ?? "", content: node.content ?? "" }); }
    }

    const proj = data.issue.project;
    const projectContent = proj?.content ? { id: proj.id, title: proj.name ?? "Project", content: proj.content } : null;
    const projectDocIndex = (proj?.documents?.nodes ?? []).map((d) => ({ id: d.id, title: d.title ?? "" }));

    return renderDocContext({ fullDocs, projectContent, projectDocIndex });
  } catch (err) {
    console.error(`[docs] assembleDocContext failed (advisory): ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
