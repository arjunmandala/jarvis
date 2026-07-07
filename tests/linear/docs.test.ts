import { describe, it, expect, vi } from "vitest";
import {
  sliceWithMarker, DOC_FETCH_CEILING, searchDocuments, getDocumentContent,
  extractPastedDocSlugs, renderDocContext, assembleDocContext, DOC_CONTEXT_CAP,
} from "../../src/linear/docs.ts";

function gqlResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("sliceWithMarker", () => {
  it("returns full content untouched when under the ceiling", () => {
    expect(sliceWithMarker("hello world", 0, 100, (n) => `[cut ${n}]`)).toBe("hello world");
  });
  it("slices from offset and appends the marker when content exceeds offset+ceiling", () => {
    const body = "0123456789";
    const out = sliceWithMarker(body, 2, 3, (n) => `[cut ${n}]`);
    expect(out).toBe("234[cut 5]");
  });
  it("no marker when the slice reaches the end exactly", () => {
    expect(sliceWithMarker("0123456789", 5, 5, (n) => `[cut ${n}]`)).toBe("56789");
  });
});

describe("searchDocuments", () => {
  it("maps nodes to id/title/project/snippet", async () => {
    const fetchImpl = vi.fn(async () =>
      gqlResponse({ searchDocuments: { nodes: [
        { id: "d1", title: "Runbook", project: { name: "Infra" }, content: "line one\nline two\nline three" },
        { id: "d2", title: "Spec", project: null, content: "" },
      ] } }),
    );
    const out = await searchDocuments("tok", "runbook", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toEqual([
      { id: "d1", title: "Runbook", project: "Infra", snippet: "line one line two line three" },
      { id: "d2", title: "Spec", project: null, snippet: "" },
    ]);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ authorization: "Bearer tok" });
  });
  it("returns [] on a GraphQL error or non-200 (advisory)", async () => {
    expect(await searchDocuments("t", "q", { fetchImpl: (async () => new Response("", { status: 500 })) as unknown as typeof fetch })).toEqual([]);
    const errBody = (async () => new Response(JSON.stringify({ errors: [{ message: "nope" }] }), { status: 200 })) as unknown as typeof fetch;
    expect(await searchDocuments("t", "q", { fetchImpl: errBody })).toEqual([]);
  });
});

describe("getDocumentContent", () => {
  it("returns id/title/content", async () => {
    const fetchImpl = (async () => gqlResponse({ document: { id: "d1", title: "T", content: "BODY" } })) as unknown as typeof fetch;
    expect(await getDocumentContent("t", "d1", { fetchImpl })).toEqual({ id: "d1", title: "T", content: "BODY" });
  });
  it("returns null when the document is missing or the call fails", async () => {
    expect(await getDocumentContent("t", "d1", { fetchImpl: (async () => gqlResponse({ document: null })) as unknown as typeof fetch })).toBeNull();
    expect(await getDocumentContent("t", "d1", { fetchImpl: (async () => new Response("", { status: 500 })) as unknown as typeof fetch })).toBeNull();
  });
});

describe("extractPastedDocSlugs", () => {
  it("pulls the slugId from pasted Linear document links", () => {
    const text = "see https://linear.app/acme/document/design-notes-9f8e7d6c5b4a and https://linear.app/acme/document/rfc-1234abcd";
    expect(extractPastedDocSlugs(text)).toEqual(["9f8e7d6c5b4a", "1234abcd"]);
  });
  it("returns [] with no doc links", () => {
    expect(extractPastedDocSlugs("nothing here")).toEqual([]);
  });
});

describe("renderDocContext", () => {
  it("emits full docs, project overview, and an index of the rest", () => {
    const out = renderDocContext({
      fullDocs: [{ id: "d1", title: "Runbook", content: "step one" }],
      projectContent: { id: "p1", title: "Project", content: "overview text" },
      projectDocIndex: [{ id: "d9", title: "Old ADR" }],
    })!;
    expect(out).toContain("Runbook");
    expect(out).toContain("step one");
    expect(out).toContain("overview text");
    expect(out).toContain("Old ADR");
    expect(out).toContain("get_document");
  });
  it("labels a doc cut with a get_document marker naming the id", () => {
    const big = "x".repeat(DOC_CONTEXT_CAP + 500);
    const out = renderDocContext({ fullDocs: [{ id: "dBIG", title: "Big", content: big }], projectContent: null, projectDocIndex: [] })!;
    expect(out).toContain('[truncated — full doc: get_document("dBIG")]');
  });
  it("returns undefined when there is nothing to inject", () => {
    expect(renderDocContext({ fullDocs: [], projectContent: null, projectDocIndex: [] })).toBeUndefined();
  });
  it("cuts a later doc once the cap is partially exhausted (monotonic)", () => {
    // Header length for the exact format renderDocContext emits.
    const headerLen = (title: string, id: string) => `### ${title} (id: ${id})\n`.length;
    const HEADROOM = 40; // chars of budget left after doc 1

    // Doc 1: short title, "fits" branch, sized so `used` lands at cap - HEADROOM
    // (a PARTIAL value — not 0, not cap — which is where the bug manifests).
    const t1 = "A", id1 = "d1";
    const content1 = "a".repeat(DOC_CONTEXT_CAP - HEADROOM - headerLen(t1, id1));

    // Doc 2: LONG title whose header alone exceeds HEADROOM → hits the
    // `remaining <= 0` (marker-only) branch. On the OLD code this branch left
    // `used` at doc-1's partial value; the fix sets `used = cap` here.
    const t2 = "L".repeat(60), id2 = "d2"; // header ≈ 74 > HEADROOM
    expect(headerLen(t2, id2)).toBeGreaterThan(HEADROOM);

    // Doc 3: short title + small unique body. On OLD code `used` is still partial
    // so `remaining` is positive and doc 3 fits → FULL body shown. With the fix
    // `used == cap` → doc 3 is marker-only.
    const t3 = "C", id3 = "d3";
    const body3 = "DOC3BODY_UNIQUE";
    expect(body3.length).toBeLessThan(HEADROOM - headerLen(t3, id3)); // fits on OLD code

    const out = renderDocContext({
      fullDocs: [
        { id: id1, title: t1, content: content1 },
        { id: id2, title: t2, content: "irrelevant" },
        { id: id3, title: t3, content: body3 },
      ],
      projectContent: null,
      projectDocIndex: [],
    })!;
    expect(out).not.toContain(body3);              // full body cut only WITH the fix
    expect(out).toContain(`get_document("${id3}")`); // doc 3 is marker-only
  });
});

describe("assembleDocContext", () => {
  it("returns undefined for a null issue and never throws on fetch failure", async () => {
    expect(await assembleDocContext("t", null, "")).toBeUndefined();
    const bad = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    expect(await assembleDocContext("t", "iss_1", "text", { fetchImpl: bad })).toBeUndefined();
  });
});
