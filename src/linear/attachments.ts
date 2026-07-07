import { fetchWithAuth, type TokenSource } from "./client.ts";

// Attachments (screenshots and files) arrive as markdown links to Linear's
// authenticated upload host. Images use ![](), files use [](); tolerate bare
// URLs too. All extraction + download lives here.
const UPLOAD_URL_RE = /https:\/\/uploads\.linear\.app\/[^\s)]+/g;

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export interface FileAttachment { url: string; filename: string; mediaType: string; data: string }
export interface ImageAttachment { mediaType: string; data: string }

/** Every distinct uploads.linear.app URL in `text`, capped. */
export function extractAttachmentUrls(text: string): string[] {
  const urls: string[] = [];
  for (const m of text.matchAll(UPLOAD_URL_RE)) {
    const url = m[0].replace(/[),.]+$/, ""); // strip trailing punctuation from bare URLs
    if (!urls.includes(url)) urls.push(url);
  }
  return urls.slice(0, MAX_ATTACHMENTS);
}

// Image-only extraction: used by fetchImageAttachments so the 5-item cap
// applies to images alone, not to a mix of images/files/bare URLs.
const IMAGE_MD_RE = /!\[[^\]]*\]\((https:\/\/uploads\.linear\.app\/[^)]+)\)/g;
export function extractImageUrls(text: string): string[] {
  const urls: string[] = [];
  for (const m of text.matchAll(IMAGE_MD_RE)) if (!urls.includes(m[1])) urls.push(m[1]);
  return urls.slice(0, MAX_ATTACHMENTS);
}

function filenameOf(url: string): string {
  try { return decodeURIComponent(new URL(url).pathname.split("/").pop() || "file"); } catch { return "file"; }
}

/** Download a given list of URLs; advisory — a failed/oversized download is skipped. */
async function downloadAttachments(
  urls: string[],
  token: TokenSource,
  fetchImpl: typeof fetch,
  onUnauthorized?: () => Promise<string>,
): Promise<FileAttachment[]> {
  const out: FileAttachment[] = [];
  for (const url of urls) {
    try {
      const r = await fetchWithAuth(url, {}, token, fetchImpl, onUnauthorized);
      if (!r.ok) continue;
      const buf = await r.arrayBuffer();
      if (buf.byteLength > MAX_ATTACHMENT_BYTES) continue;
      const mediaType = (r.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim();
      out.push({ url, filename: filenameOf(url), mediaType, data: Buffer.from(buf).toString("base64") });
    } catch (err) {
      console.error(`[attachments] download failed for ${url} (advisory): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

/** Download all attachments; advisory — a failed/oversized download is skipped. */
export async function fetchAttachments(
  token: TokenSource,
  text: string,
  fetchImpl: typeof fetch = fetch,
  onUnauthorized?: () => Promise<string>,
): Promise<FileAttachment[]> {
  return downloadAttachments(extractAttachmentUrls(text), token, fetchImpl, onUnauthorized);
}

export type AttachmentKind = "image" | "pdf" | "text" | "binary";
export function routeAttachment(a: FileAttachment): AttachmentKind {
  if (a.mediaType.startsWith("image/")) return "image";
  if (a.mediaType === "application/pdf") return "pdf";
  if (a.mediaType.startsWith("text/") || a.mediaType === "application/json" || a.mediaType.includes("csv")) return "text";
  return "binary";
}

/** Back-compat wrapper: image content blocks only (used by callers that only
 *  want vision). Uses the image-only URL extraction so the 5-item cap applies
 *  to images alone, not to a mix of images/files/bare URLs; the routeAttachment
 *  filter is a defensive guard against a non-image content-type on an ![]() link. */
export async function fetchImageAttachments(
  token: TokenSource,
  text: string,
  fetchImpl: typeof fetch = fetch,
  onUnauthorized?: () => Promise<string>,
): Promise<ImageAttachment[]> {
  const all = await downloadAttachments(extractImageUrls(text), token, fetchImpl, onUnauthorized);
  return all.filter((a) => routeAttachment(a) === "image").map((a) => ({ mediaType: a.mediaType, data: a.data }));
}
