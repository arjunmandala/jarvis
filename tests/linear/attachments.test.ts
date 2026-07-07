import { describe, it, expect, vi } from "vitest";
import { extractAttachmentUrls, fetchAttachments, routeAttachment } from "../../src/linear/attachments.ts";

function res(bytes: number, contentType: string): Response {
  return new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": contentType } });
}

describe("extractAttachmentUrls", () => {
  it("finds image, plain-link, and bare uploads.linear.app urls, deduped", () => {
    const text =
      "![img](https://uploads.linear.app/a.png) [doc](https://uploads.linear.app/b.pdf) " +
      "raw https://uploads.linear.app/c.csv and dup https://uploads.linear.app/a.png";
    expect(extractAttachmentUrls(text)).toEqual([
      "https://uploads.linear.app/a.png",
      "https://uploads.linear.app/b.pdf",
      "https://uploads.linear.app/c.csv",
    ]);
  });
});

describe("routeAttachment", () => {
  it("routes by content type", () => {
    expect(routeAttachment({ url: "", filename: "", mediaType: "image/png", data: "" })).toBe("image");
    expect(routeAttachment({ url: "", filename: "", mediaType: "application/pdf", data: "" })).toBe("pdf");
    expect(routeAttachment({ url: "", filename: "", mediaType: "text/csv", data: "" })).toBe("text");
    expect(routeAttachment({ url: "", filename: "", mediaType: "application/json", data: "" })).toBe("text");
    expect(routeAttachment({ url: "", filename: "", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data: "" })).toBe("binary");
  });
});

describe("fetchAttachments", () => {
  it("downloads all formats and records filename + mediaType, skipping oversized", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith(".pdf")) return res(10, "application/pdf");
      if (url.endsWith(".csv")) return res(6 * 1024 * 1024, "text/csv"); // oversized → skipped
      return res(4, "image/png");
    });
    const text = "![i](https://uploads.linear.app/a.png) [d](https://uploads.linear.app/b.pdf) https://uploads.linear.app/c.csv";
    const out = await fetchAttachments("tok", text, fetchImpl as unknown as typeof fetch);
    expect(out.map((a) => a.mediaType)).toEqual(["image/png", "application/pdf"]);
    expect(out[1].filename).toBe("b.pdf");
  });

  it("on a 401, refreshes and retries the download with the fresh token", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(res(4, "image/png"));
    const onUnauthorized = vi.fn(async () => "fresh-token");
    const out = await fetchAttachments(
      () => "stale-token",
      "![x](https://uploads.linear.app/a.png)",
      fetchImpl as unknown as typeof fetch,
      onUnauthorized,
    );
    expect(out).toHaveLength(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    const firstInit = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(firstInit.headers).toMatchObject({ authorization: "Bearer stale-token" });
    const retryInit = fetchImpl.mock.calls[1][1] as RequestInit;
    expect(retryInit.headers).toMatchObject({ authorization: "Bearer fresh-token" });
  });

  it("sanitizes a path-traversal-y filename so no /, \\, or .. survives (defends the ATTACHMENTS_DIR join)", async () => {
    const fetchImpl = vi.fn(async () => res(4, "application/pdf"));
    const out = await fetchAttachments(
      "tok",
      "[r](https://uploads.linear.app/..%2f..%2fetc)",
      fetchImpl as unknown as typeof fetch,
    );
    expect(out).toHaveLength(1);
    expect(out[0].filename).not.toMatch(/[/\\]/);
    expect(out[0].filename).not.toContain("..");
    expect(out[0].filename.length).toBeGreaterThan(0);
  });

  it("falls back to a safe default when the decoded filename is just dot-dot", async () => {
    const fetchImpl = vi.fn(async () => res(4, "application/pdf"));
    const out = await fetchAttachments(
      "tok",
      "[r](https://uploads.linear.app/%2e%2e)",
      fetchImpl as unknown as typeof fetch,
    );
    expect(out).toHaveLength(1);
    expect(out[0].filename).not.toMatch(/[/\\]/);
    expect(out[0].filename).not.toContain("..");
  });
});
