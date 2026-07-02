import { describe, it, expect, vi, afterEach } from "vitest";
import { withRetries } from "../../src/sandbox/session.ts";

describe("withRetries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("succeeds on first try: fn called once", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetries("test.op", fn, { baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("fails twice then succeeds: returns value, fn called 3 times", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom1"))
      .mockRejectedValueOnce(new Error("boom2"))
      .mockResolvedValueOnce("ok");
    const result = await withRetries("test.op", fn, { baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    errSpy.mockRestore();
  });

  it("fails all attempts: rethrows the last error, fn called exactly `attempts` times", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom1"))
      .mockRejectedValueOnce(new Error("boom2"))
      .mockRejectedValueOnce(new Error("boom3-final"));
    await expect(withRetries("test.op", fn, { baseDelayMs: 1 })).rejects.toThrow("boom3-final");
    expect(fn).toHaveBeenCalledTimes(3);
    errSpy.mockRestore();
  });

  it("respects a custom attempts value", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));
    await expect(withRetries("test.op", fn, { attempts: 5, baseDelayMs: 1 })).rejects.toThrow(
      "always fails",
    );
    expect(fn).toHaveBeenCalledTimes(5);
    errSpy.mockRestore();
  });
});
