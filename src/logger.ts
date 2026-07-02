// ponytail: patches console.log/error globally instead of touching every call site.
// Colors by the leading `[tag]` in the message; unrecognized tags fall back to plain white.
const TAG_COLORS: Record<string, string> = {
  boot: "35", req: "90", webhook: "36", skip: "90", phase: "32",
  agent: "34", telemetry: "90", relay: "33", map: "33", recover: "36",
  reconcile: "35", steer: "36", review: "34", retry: "33", serena: "33",
};
const RESET = "\x1b[0m";
const DIM = "\x1b[90m";

function decorate(args: unknown[], forceColor?: string): unknown[] {
  const ts = new Date().toISOString().slice(11, 19);
  const first = typeof args[0] === "string" ? args[0] : String(args[0]);
  const tag = first.match(/^\[(\w+)\]/)?.[1];
  const color = forceColor ?? (tag && TAG_COLORS[tag]) ?? "37";
  return [`${DIM}${ts}${RESET} \x1b[${color}m${first}${RESET}`, ...args.slice(1)];
}

const origLog = console.log.bind(console);
const origError = console.error.bind(console);
console.log = (...args: unknown[]) => origLog(...decorate(args));
console.error = (...args: unknown[]) => origError(...decorate(args, "31"));
