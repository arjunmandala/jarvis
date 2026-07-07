import { describe, it, expect, vi } from "vitest";
import { extractImageUrls, fetchImageAttachments } from "../../src/linear/attachments.ts";
import { extractAttachmentUrls, fetchAttachments, routeAttachment } from "../../src/linear/attachments.ts";

describe("extractImageUrls", () => {
  it("finds uploads.linear.app image links in markdown", () => {
    const text = "See this bug: ![screenshot](https://uploads.linear.app/abc/def.png) thanks";
    expect(extractImageUrls(text)).toEqual(["https://uploads.linear.app/abc/def.png"]);
  });

  it("ignores non-linear image links and dedupes repeats", () => {
    const text =
      "![x](https://example.com/pic.png) ![y](https://uploads.linear.app/a.png) ![z](https://uploads.linear.app/a.png)";
    expect(extractImageUrls(text)).toEqual(["https://uploads.linear.app/a.png"]);
  });

  it("caps at 5 urls", () => {
    const urls = Array.from({ length: 8 }, (_, i) => `https://uploads.linear.app/${i}.png`);
    const text = urls.map((u) => `![img](${u})`).join(" ");
    expect(extractImageUrls(text)).toHaveLength(5);
  });

  it("returns an empty array for plain text", () => {
    expect(extractImageUrls("just a regular comment")).toEqual([]);
  });
});

function imgResponse(bytes: number, contentType = "image/png"): Response {
  return new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": contentType } });
}

describe("fetchImageAttachments", () => {
  it("downloads found images with the auth header and base64-encodes them", async () => {
    const fetchImpl = vi.fn(async () => imgResponse(4));
    const text = "![x](https://uploads.linear.app/a.png)";
    const out = await fetchImageAttachments("token-1", text, fetchImpl as unknown as typeof fetch);
    expect(out).toHaveLength(1);
    expect(out[0].mediaType).toBe("image/png");
    expect(typeof out[0].data).toBe("string");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://uploads.linear.app/a.png");
    expect(init.headers).toMatchObject({ authorization: "Bearer token-1" });
  });

  it("skips a download that fails, without throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 403 }));
    const text = "![x](https://uploads.linear.app/a.png)";
    const out = await fetchImageAttachments("token-1", text, fetchImpl as unknown as typeof fetch);
    expect(out).toEqual([]);
  });

  it("sanitizes a content-type with parameters down to the bare media type", async () => {
    const fetchImpl = vi.fn(async () => imgResponse(4, "image/png; charset=binary"));
    const out = await fetchImageAttachments("token-1", "![x](https://uploads.linear.app/a.png)", fetchImpl as unknown as typeof fetch);
    expect(out).toHaveLength(1);
    expect(out[0].mediaType).toBe("image/png");
  });

  it("skips a non-image content-type", async () => {
    const fetchImpl = vi.fn(async () => imgResponse(4, "text/html"));
    const out = await fetchImageAttachments("token-1", "![x](https://uploads.linear.app/a.png)", fetchImpl as unknown as typeof fetch);
    expect(out).toEqual([]);
  });

  it("returns an empty array when there are no image links", async () => {
    const fetchImpl = vi.fn();
    expect(await fetchImageAttachments("token-1", "no images here", fetchImpl as unknown as typeof fetch)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns all 5 images even when a preceding non-image attachment link is present (image-only cap, not mixed-attachment cap)", async () => {
    const fetchImpl = vi.fn(async (url: string) => (url.endsWith(".pdf") ? imgResponse(4, "application/pdf") : imgResponse(4, "image/png")));
    const text =
      "[r](https://uploads.linear.app/r.pdf) " +
      Array.from({ length: 5 }, (_, i) => `![img${i}](https://uploads.linear.app/${i}.png)`).join(" ");
    const out = await fetchImageAttachments("token-1", text, fetchImpl as unknown as typeof fetch);
    expect(out).toHaveLength(5);
    expect(out.every((a) => a.mediaType === "image/png")).toBe(true);
  });

  it("on a 401, refreshes and retries the download with the fresh token", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(imgResponse(4));
    const onUnauthorized = vi.fn(async () => "fresh-token");
    const out = await fetchImageAttachments(
      () => "stale-token",
      "![x](https://uploads.linear.app/a.png)",
      fetchImpl as unknown as typeof fetch,
      onUnauthorized,
    );
    expect(out).toHaveLength(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    const retryInit = fetchImpl.mock.calls[1][1] as RequestInit;
    expect(retryInit.headers).toMatchObject({ authorization: "Bearer fresh-token" });
  });
});

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
});
