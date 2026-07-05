// tests/config.test.ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.ts";

const full = {
  LINEAR_ACCESS_TOKEN: "tok", LINEAR_WEBHOOK_SECRET: "whsec",
  LINEAR_CLIENT_ID: "cid", LINEAR_CLIENT_SECRET: "csec",
  ANTHROPIC_API_KEY: "ak", E2B_API_KEY: "ek", E2B_TEMPLATE: "jarvis-agent",
  GH_TOKEN: "gh", TARGET_REPO: "owner/name", PUBLIC_BASE_URL: "https://x", PORT: "8080",
};

describe("loadConfig", () => {
  it("parses a full env", () => {
    const c = loadConfig(full);
    expect(c.port).toBe(8080);
    expect(c.linear.accessToken).toBe("tok");
    expect(c.targetRepo).toBe("owner/name");
  });

  it("defaults port to 3000", () => {
    const { PORT, ...noPort } = full;
    expect(loadConfig(noPort).port).toBe(3000);
  });

  it("throws listing every missing var", () => {
    expect(() => loadConfig({})).toThrowError(/LINEAR_CLIENT_ID/);
    expect(() => loadConfig({})).toThrowError(/TARGET_REPO/);
  });

  // LINEAR_ACCESS_TOKEN is a bootstrap seed, not required: the live token is
  // renewed automatically and persisted in SQLite.
  it("loads without LINEAR_ACCESS_TOKEN (optional bootstrap seed)", () => {
    const { LINEAR_ACCESS_TOKEN, ...noToken } = full;
    const c = loadConfig(noToken);
    expect(c.linear.accessToken).toBeUndefined();
    expect(c.linear.clientId).toBe("cid");
  });
});
