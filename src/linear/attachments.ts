import { fetchWithAuth, type TokenSource } from "./client.ts";

// Attachments (screenshots and files) arrive as markdown links to Linear's
// authenticated upload host. Images use ![](), files use [](); tolerate bare
// URLs too. All extraction + download lives here.
const UPLOAD_URL_RE = /https:\/\/uploads\.linear\.app\/[^\s)]+/g;

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export interface FileAttachment { url: string; filename: string; mediaType: string; data: string }

/** Every distinct uploads.linear.app URL in `text`, capped. */
export function extractAttachmentUrls(text: string): string[] {
  const urls: string[] = [];
  for (const m of text.matchAll(UPLOAD_URL_RE)) {
    const url = m[0].replace(/[),.]+$/, ""); // strip trailing punctuation from bare URLs
    if (!urls.includes(url)) urls.push(url);
  }
  return urls.slice(0, MAX_ATTACHMENTS);
}

function filenameOf(url: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(new URL(url).pathname.split("/").pop() || "file");
  } catch {
    return "file";
  }
  // A path segment containing an encoded separator (%2f) or dot-dot (%2e%2e)
  // decodes to "/" or ".." — sanitize so `${ATTACHMENTS_DIR}/${filename}` can
  // never escape the attachments dir.
  const safe = decoded.replace(/[/\\]/g, "_").replace(/\.\./g, "_");
  return safe === "" || safe === "." ? "file" : safe;
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
