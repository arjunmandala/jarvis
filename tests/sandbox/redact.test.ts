import { describe, it, expect } from "vitest";
import { redactSecret } from "../../src/sandbox/session.ts";

describe("redactSecret", () => {
  it("replaces a token occurrence with ***", () => {
    const out = redactSecret("clone https://x-access-token:ghp_SECRET@github.com/o/r failed", "ghp_SECRET");
    expect(out).toContain("***");
    expect(out).not.toContain("ghp_SECRET");
  });

  it("replaces multiple occurrences", () => {
    const out = redactSecret("ghp_SECRET and again ghp_SECRET", "ghp_SECRET");
    expect(out).not.toContain("ghp_SECRET");
    expect(out).toBe("*** and again ***");
  });

  it("returns text unchanged when the secret is empty string", () => {
    const out = redactSecret("nothing to redact here", "");
    expect(out).toBe("nothing to redact here");
  });

  it("returns text unchanged when the secret isn't present", () => {
    const out = redactSecret("no secrets in this string", "ghp_SECRET");
    expect(out).toBe("no secrets in this string");
  });
});
