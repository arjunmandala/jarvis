import { describe, it, expect, vi, afterEach } from "vitest";
import { LinearTokenManager } from "../../src/linear/token-manager.ts";
import type { OAuthToken } from "../../src/store/sessions.ts";

// A minimal in-memory fake of the two store methods the manager touches — DI'd
// like the fetch impl, so nothing hits SQLite or the network.
function fakeStore(seed?: OAuthToken) {
  let row = seed;
  return {
    getOAuthToken: vi.fn((_provider: string) => row),
    setOAuthToken: vi.fn((_provider: string, t: OAuthToken) => {
      row = t;
    }),
  };
}

function tokenResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const DAY = 24 * 60 * 60 * 1000;
const THIRTY_DAYS = 30 * DAY;

describe("LinearTokenManager — persistence / seeding", () => {
  it("seeds getToken from the .env bootstrap token when no DB row exists", () => {
    const store = fakeStore();
    const mgr = new LinearTokenManager(store as never, "cid", "csec", "boot-token", vi.fn());
    expect(mgr.getToken()).toBe("boot-token");
  });

  it("prefers a persisted DB row over the bootstrap token", () => {
    const store = fakeStore({ accessToken: "db-token", refreshToken: null, expiresAt: new Date(Date.now() + THIRTY_DAYS).toISOString() });
    const mgr = new LinearTokenManager(store as never, "cid", "csec", "boot-token", vi.fn());
    expect(mgr.getToken()).toBe("db-token");
  });

  it("has an empty token when there is neither a row nor a bootstrap seed", () => {
    const store = fakeStore();
    const mgr = new LinearTokenManager(store as never, "cid", "csec", undefined, vi.fn());
    expect(mgr.getToken()).toBe("");
  });
});

describe("LinearTokenManager — refreshNow", () => {
  it("persists a fresh token + expiry via client_credentials and updates the cache", async () => {
    const store = fakeStore();
    const fetchImpl = vi.fn(async () => tokenResponse({ access_token: "fresh", expires_in: 3600, token_type: "Bearer" }));
    const mgr = new LinearTokenManager(store as never, "cid", "csec", "boot", fetchImpl as unknown as typeof fetch);

    await mgr.refreshNow();

    expect(mgr.getToken()).toBe("fresh");
    expect(store.setOAuthToken).toHaveBeenCalledTimes(1);
    const [, saved] = store.setOAuthToken.mock.calls[0];
    expect(saved.accessToken).toBe("fresh");
    expect(Date.parse(saved.expiresAt)).toBeGreaterThan(Date.now());

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.linear.app/oauth/token");
    const body = String(init.body);
    expect(body).toContain("grant_type=client_credentials");
    expect(body).toContain("client_id=cid");
    expect(body).not.toContain("boot"); // never sends the stale token
  });

  it("on a non-2xx leaves the stale token live and does not persist (never crashes)", async () => {
    const store = fakeStore();
    const fetchImpl = vi.fn(async () => tokenResponse({ error: "unsupported_grant_type", error_description: "toggle off" }, 400));
    const mgr = new LinearTokenManager(store as never, "cid", "csec", "boot", fetchImpl as unknown as typeof fetch);

    await expect(mgr.refreshNow()).rejects.toThrow(/400/);
    expect(mgr.getToken()).toBe("boot");
    expect(store.setOAuthToken).not.toHaveBeenCalled();
  });

  it("on a thrown fetch leaves the stale token live", async () => {
    const store = fakeStore();
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const mgr = new LinearTokenManager(store as never, "cid", "csec", "boot", fetchImpl as unknown as typeof fetch);

    await expect(mgr.refreshNow()).rejects.toThrow(/network down/);
    expect(mgr.getToken()).toBe("boot");
    expect(store.setOAuthToken).not.toHaveBeenCalled();
  });
});

describe("LinearTokenManager — scheduleRenewal", () => {
  afterEach(() => vi.useRealTimers());

  it("fires ~1 day before expiry, then re-arms after a successful refresh", async () => {
    vi.useFakeTimers();
    const store = fakeStore({ accessToken: "t0", refreshToken: null, expiresAt: new Date(Date.now() + THIRTY_DAYS).toISOString() });
    const fetchImpl = vi.fn(async () => tokenResponse({ access_token: "t1", expires_in: THIRTY_DAYS / 1000 }));
    const mgr = new LinearTokenManager(store as never, "cid", "csec", undefined, fetchImpl as unknown as typeof fetch);
    mgr.scheduleRenewal();

    // Up to just shy of the safety margin: nothing fires.
    await vi.advanceTimersByTimeAsync(THIRTY_DAYS - DAY - 1000);
    expect(fetchImpl).not.toHaveBeenCalled();

    // Crossing the margin fires the renewal.
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(mgr.getToken()).toBe("t1");

    // It re-armed itself: another ~29 days later a second renewal fires.
    await vi.advanceTimersByTimeAsync(THIRTY_DAYS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    mgr.stop();
  });

  it("does not busy-loop when a renewal succeeds with a <=margin lifetime", async () => {
    vi.useFakeTimers();
    const store = fakeStore({ accessToken: "t0", refreshToken: null, expiresAt: new Date(Date.now() + 1000).toISOString() });
    // Endpoint keeps handing back short-lived (1h) tokens — well under the 1-day margin.
    const fetchImpl = vi.fn(async () => tokenResponse({ access_token: "short", expires_in: 3600 }));
    const mgr = new LinearTokenManager(store as never, "cid", "csec", undefined, fetchImpl as unknown as typeof fetch);
    mgr.scheduleRenewal();

    // First renewal fires immediately (already past margin) and succeeds.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // The re-arm is floored, not 0: nothing fires again for a while...
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // ...and it does eventually renew again at the floored cadence (no tight loop).
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    mgr.stop();
  });

  it("retries on a bounded backoff after a failed renewal, without giving up", async () => {
    vi.useFakeTimers();
    const store = fakeStore({ accessToken: "t0", refreshToken: null, expiresAt: new Date(Date.now() + 1000).toISOString() });
    const fetchImpl = vi.fn(async () => tokenResponse({ error: "nope" }, 500));
    const mgr = new LinearTokenManager(store as never, "cid", "csec", undefined, fetchImpl as unknown as typeof fetch);
    mgr.scheduleRenewal();

    // Already past expiry → first attempt fires immediately (delay clamped to 0).
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(mgr.getToken()).toBe("t0"); // stale token kept live

    // Backoff #1: 5 minutes.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // Backoff #2: doubled to 10 minutes — it keeps retrying, never gives up.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    mgr.stop();
  });
});

describe("LinearTokenManager — onUnauthorized", () => {
  it("dedupes concurrent 401s into a single in-flight refresh", async () => {
    const store = fakeStore();
    let resolve!: (r: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((r) => (resolve = r)));
    const mgr = new LinearTokenManager(store as never, "cid", "csec", "boot", fetchImpl as unknown as typeof fetch);

    const p1 = mgr.onUnauthorized();
    const p2 = mgr.onUnauthorized();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // both share one request

    resolve(tokenResponse({ access_token: "fresh", expires_in: 3600 }));
    const [t1, t2] = await Promise.all([p1, p2]);
    expect(t1).toBe("fresh");
    expect(t2).toBe("fresh");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("LinearTokenManager — adopt (used by /oauth/callback)", () => {
  it("persists an externally captured token and makes it live immediately", () => {
    vi.useFakeTimers();
    const store = fakeStore();
    const mgr = new LinearTokenManager(store as never, "cid", "csec", "boot", vi.fn());
    const captured = { accessToken: "cb-token", refreshToken: "r1", expiresAt: new Date(Date.now() + THIRTY_DAYS).toISOString() };

    mgr.adopt(captured);

    expect(mgr.getToken()).toBe("cb-token");
    expect(store.setOAuthToken).toHaveBeenCalledWith("linear", captured);
    mgr.stop();
    vi.useRealTimers();
  });
});
