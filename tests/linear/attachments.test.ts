import { describe, it, expect, vi } from "vitest";
import { extractImageUrls, fetchImageAttachments } from "../../src/linear/attachments.ts";

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
