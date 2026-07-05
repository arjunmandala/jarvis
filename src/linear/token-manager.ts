import type { OAuthToken, SessionStore } from "../store/sessions.ts";

// Automatic Linear OAuth token renewal via the `client_credentials` grant,
// which yields a ~30-day app-actor token (the same actor identity the Agent
// Interaction API already uses). The token lives in SQLite (`oauth_tokens`),
// not `.env` — LINEAR_ACCESS_TOKEN is only a bootstrap seed for the very first
// run before a row exists. See src/store/sessions.ts and BUILD_PLAN.md.
//
// The persistence layer is mechanism-agnostic (it stores an optional
// refresh_token too), so switching to refresh-token rotation later means
// swapping #doRefresh, not a schema rewrite.

const TOKEN_URL = "https://api.linear.app/oauth/token";
export const OAUTH_PROVIDER = "linear";

// client_credentials tokens last ~30 days; renew a day early so a failed
// attempt still has ~24h of retries before the live token actually expires.
const SAFETY_MARGIN_MS = 24 * 60 * 60 * 1000;
// Fallback lifetime if the token endpoint omits expires_in (shouldn't happen).
const DEFAULT_EXPIRES_IN_S = 30 * 24 * 60 * 60;
// Bounded backoff after a failed renewal: start at 5 min, double, cap at 1h —
// never give up, never crash the process.
const RETRY_MIN_MS = 5 * 60 * 1000;
const RETRY_MAX_MS = 60 * 60 * 1000;
// Floor for the post-success re-arm: if the endpoint ever returns a token whose
// lifetime is <= the safety margin (or expires_in=0, which bypasses the
// DEFAULT_EXPIRES_IN_S fallback), the raw delay is 0 and re-arming at it would
// busy-loop the token endpoint. Floor it so a short-lived token renews at a
// sane cadence instead of hammering. // ponytail: only bites if Linear changes
// the client_credentials lifetime; drop if that never happens.
const MIN_RENEWAL_MS = 5 * 60 * 1000;
// Node's setTimeout uses a 32-bit signed delay: anything above ~24.8 days
// overflows and is silently clamped to 1ms (firing immediately). The renewal
// horizon (~29 days) is well past that, so long delays are scheduled in chunks.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string | string[];
  error?: string;
  error_description?: string;
}

export class LinearTokenManager {
  #store: Pick<SessionStore, "getOAuthToken" | "setOAuthToken">;
  #clientId: string;
  #clientSecret: string;
  #fetch: typeof fetch;
  #token = "";
  #expiresAtMs = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #retryMs = RETRY_MIN_MS;
  // Dedupes concurrent refreshes: a burst of 401s (or a scheduled renewal
  // racing an on-demand one) must fire a single token request, not N.
  #inflight: Promise<void> | null = null;

  constructor(
    store: Pick<SessionStore, "getOAuthToken" | "setOAuthToken">,
    clientId: string,
    clientSecret: string,
    bootstrapToken?: string,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.#store = store;
    this.#clientId = clientId;
    this.#clientSecret = clientSecret;
    this.#fetch = fetchImpl;

    const row = store.getOAuthToken(OAUTH_PROVIDER);
    if (row) {
      this.#token = row.accessToken;
      this.#expiresAtMs = Date.parse(row.expiresAt) || 0;
    } else if (bootstrapToken) {
      // Seed from the .env bootstrap value with a synthetic near-past expiry so
      // the first scheduled renewal fires almost immediately and persists a
      // proper client_credentials token — after which .env is never read again.
      this.#token = bootstrapToken;
      this.#expiresAtMs = Date.now() - 1000;
    }
  }

  // Synchronous read of the cached current token — the value every consumer
  // (LinearClient factory, plan/thread fetchers, attachment downloads) uses.
  getToken(): string {
    return this.#token;
  }

  // Request a fresh token now. Deduped: concurrent callers share one request.
  async refreshNow(): Promise<void> {
    if (this.#inflight) return this.#inflight;
    this.#inflight = this.#doRefresh();
    try {
      await this.#inflight;
    } finally {
      this.#inflight = null;
    }
  }

  async #doRefresh(): Promise<void> {
    const res = await this.#fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.#clientId,
        client_secret: this.#clientSecret,
        grant_type: "client_credentials",
      }),
    });
    if (!res.ok) {
      // Read the error body for diagnostics but never let it carry the secret.
      let detail = "";
      try {
        const j = (await res.json()) as TokenResponse;
        detail = [j.error, j.error_description].filter(Boolean).join(": ");
      } catch {
        /* non-JSON body */
      }
      throw new Error(`token endpoint returned ${res.status}${detail ? ` (${detail})` : ""}`);
    }
    const json = (await res.json()) as TokenResponse;
    if (!json.access_token) {
      throw new Error(`token response missing access_token (error=${json.error ?? "none"})`);
    }
    const expiresInS = json.expires_in ?? DEFAULT_EXPIRES_IN_S;
    this.#applyToken({
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresAt: new Date(Date.now() + expiresInS * 1000).toISOString(),
    });
    // Never log the token itself — only its lifetime/type (redaction convention).
    console.log(`[oauth] token renewed: expires_in=${expiresInS}s token_type=${json.token_type ?? "?"}`);
  }

  // Persist a token AND update the in-memory cache in one step. Used by
  // #doRefresh and by the /oauth/callback install path (so a freshly captured
  // token goes live immediately, no restart).
  #applyToken(token: OAuthToken): void {
    this.#token = token.accessToken;
    this.#expiresAtMs = Date.parse(token.expiresAt) || 0;
    this.#store.setOAuthToken(OAUTH_PROVIDER, token);
  }

  // Adopt an externally-obtained token (e.g. the authorization_code result from
  // /oauth/callback): cache it, persist it, and re-arm the renewal timer.
  adopt(token: OAuthToken): void {
    this.#applyToken(token);
    this.#retryMs = RETRY_MIN_MS;
    this.scheduleRenewal();
  }

  // Arm the renewal timer for `expires_at - safety margin`. Idempotent: an
  // existing timer is cleared first, so this is safe to call repeatedly.
  scheduleRenewal(): void {
    this.#arm(this.#delayUntilRenewalMs());
  }

  // Stop the renewal timer (tests, graceful shutdown).
  stop(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  // Called by a consumer on a 401: force an immediate (deduped) refresh and
  // hand back the new token so the caller can retry the failed request.
  async onUnauthorized(): Promise<string> {
    await this.refreshNow();
    return this.#token;
  }

  #delayUntilRenewalMs(): number {
    return Math.max(this.#expiresAtMs - SAFETY_MARGIN_MS - Date.now(), 0);
  }

  #arm(delayMs: number): void {
    if (this.#timer) clearTimeout(this.#timer);
    // Chunk delays past the 32-bit setTimeout ceiling: schedule the max, then
    // re-arm for the remainder when it fires. Otherwise a >24.8-day delay is
    // clamped to 1ms and refires in a tight loop.
    const chunk = Math.min(delayMs, MAX_TIMEOUT_MS);
    const remaining = delayMs - chunk;
    this.#timer = setTimeout(() => (remaining > 0 ? this.#arm(remaining) : void this.#onTimer()), chunk);
    // Don't keep the event loop alive purely for the renewal timer.
    (this.#timer as { unref?: () => void }).unref?.();
  }

  async #onTimer(): Promise<void> {
    try {
      await this.refreshNow();
      this.#retryMs = RETRY_MIN_MS; // reset backoff on success
      this.#arm(Math.max(this.#delayUntilRenewalMs(), MIN_RENEWAL_MS));
    } catch (err) {
      // Fail loud, keep the stale token live, retry on bounded backoff — never
      // crash and never give up.
      console.error(`[oauth] renewal failed: ${err instanceof Error ? err.message : String(err)}`);
      const delay = this.#retryMs;
      this.#retryMs = Math.min(this.#retryMs * 2, RETRY_MAX_MS);
      this.#arm(delay);
    }
  }
}
