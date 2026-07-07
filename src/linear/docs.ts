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
