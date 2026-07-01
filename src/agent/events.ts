export type JarvisEvent =
  | { kind: "assistant_text"; text: string }
  | { kind: "tool_use"; name: string; input: unknown }
  | { kind: "result"; subtype: string; text: string | null; costUsd: number | null; sessionId: string | null }
  | { kind: "error"; message: string };

const KINDS = new Set(["assistant_text", "tool_use", "result", "error"]);

function parseLine(line: string): JarvisEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const obj = JSON.parse(trimmed);
    return obj && KINDS.has(obj.kind) ? (obj as JarvisEvent) : null;
  } catch {
    return null;
  }
}

export class LineParser {
  #buf = "";

  push(chunk: string): JarvisEvent[] {
    this.#buf += chunk;
    const out: JarvisEvent[] = [];
    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      const ev = parseLine(line);
      if (ev) out.push(ev);
    }
    return out;
  }

  flush(): JarvisEvent[] {
    const rest = this.#buf;
    this.#buf = "";
    const ev = parseLine(rest);
    return ev ? [ev] : [];
  }
}
