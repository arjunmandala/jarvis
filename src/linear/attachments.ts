import { fetchWithAuth, type TokenSource } from "./client.ts";

// Screenshots pasted into a Linear comment/description arrive as plain
// markdown image links pointing at Linear's authenticated upload host, not a
// separate structured "attachments" field. Both extraction and download live
// here so every task builder can pull real image content out of issue text.
const IMAGE_MD_RE = /!\[[^\]]*\]\((https:\/\/uploads\.linear\.app\/[^)]+)\)/g;

// Defensive caps: a thread could in principle link dozens of large images.
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function extractImageUrls(text: string): string[] {
  const urls: string[] = [];
  for (const m of text.matchAll(IMAGE_MD_RE)) {
    if (!urls.includes(m[1])) urls.push(m[1]);
  }
  return urls.slice(0, MAX_IMAGES);
}

export interface ImageAttachment {
  mediaType: string;
  data: string;
}

// Advisory end-to-end: a failed or oversized or non-image download is skipped,
// never thrown — attachments are a bonus, not a run-blocking dependency.
export async function fetchImageAttachments(
  token: TokenSource,
  text: string,
  fetchImpl: typeof fetch = fetch,
  onUnauthorized?: () => Promise<string>,
): Promise<ImageAttachment[]> {
  const urls = extractImageUrls(text);
  const out: ImageAttachment[] = [];
  for (const url of urls) {
    try {
      const res = await fetchWithAuth(url, {}, token, fetchImpl, onUnauthorized);
      if (!res.ok) continue;
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.startsWith("image/")) continue;
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_IMAGE_BYTES) continue;
      // Strip any `;`-parameters (e.g. "image/png; charset=binary") — the
      // Messages API rejects a media_type that isn't a bare mime type.
      const mediaType = contentType.split(";")[0].trim();
      out.push({ mediaType, data: Buffer.from(buf).toString("base64") });
    } catch (err) {
      console.error(`[attachments] download failed for ${url} (advisory): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
