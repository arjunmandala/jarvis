import { describe, it, expect } from "vitest";
import { LineParser } from "../../src/agent/events.ts";

describe("LineParser", () => {
  it("parses whole lines", () => {
    const p = new LineParser();
    const out = p.push(JSON.stringify({ kind: "assistant_text", text: "hi" }) + "\n");
    expect(out).toEqual([{ kind: "assistant_text", text: "hi" }]);
  });

  it("buffers a line split across chunks", () => {
    const p = new LineParser();
    expect(p.push('{"kind":"tool_use","name":"Bash",')).toEqual([]);
    const out = p.push('"input":{"command":"ls"}}\n');
    expect(out).toEqual([{ kind: "tool_use", name: "Bash", input: { command: "ls" } }]);
  });

  it("ignores non-JSON noise lines", () => {
    const p = new LineParser();
    const out = p.push("npm warn something\n" + JSON.stringify({ kind: "result", subtype: "success", text: "done", costUsd: 0.4, sessionId: "s1" }) + "\n");
    expect(out).toEqual([{ kind: "result", subtype: "success", text: "done", costUsd: 0.4, sessionId: "s1" }]);
  });

  it("flush returns a trailing unterminated JSON line", () => {
    const p = new LineParser();
    p.push('{"kind":"error","message":"x"}');
    expect(p.flush()).toEqual([{ kind: "error", message: "x" }]);
  });
});
