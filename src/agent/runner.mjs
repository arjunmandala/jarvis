// Runs INSIDE the E2B sandbox. Reads a task JSON, runs the Claude Agent SDK in
// streaming-input mode, and prints newline-delimited JarvisEvent JSON to stdout
// for the host to parse. The host can append {"text": "..."} lines to the inbox
// file at any time: they are injected into the live session as user messages
// (steering), or consumed as the answer to a pending ask_user call.
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";

const task = JSON.parse(readFileSync(process.env.JARVIS_TASK_FILE, "utf8"));
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const RESULT_FILE = "/tmp/jarvis-result.json";
const INBOX_FILE = "/tmp/jarvis-inbox.jsonl"; // keep in sync with INBOX_FILE in src/sandbox/session.ts
const START = Date.now();
// Below the host's 55-min watchDetached deadline so an ask_user wait can never
// outlive the watcher.
const DEADLINE_MS = 50 * 60_000;
const ASK_TIMEOUT_MS = 10 * 60_000;
const NO_ANSWER =
  "No answer within 10 minutes — proceed with your best judgment and state your assumption in your final output.";

// --- inbox tail: read appended lines from a byte offset (no re-reads).
let inboxOffset = 0;
function readNewLines() {
  if (!existsSync(INBOX_FILE)) return [];
  const size = statSync(INBOX_FILE).size;
  if (size <= inboxOffset) return [];
  const fd = openSync(INBOX_FILE, "r");
  const buf = Buffer.alloc(size - inboxOffset);
  readSync(fd, buf, 0, buf.length, inboxOffset);
  closeSync(fd);
  inboxOffset = size;
  const out = [];
  for (const line of buf.toString("utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (typeof o.text === "string" && o.text.trim()) out.push(o.text);
    } catch {
      // partial line still being written; it re-parses next tick via offset? No —
      // offset already advanced. ponytail: host writes each line atomically
      // (single echo >> append), so torn lines don't occur in practice.
    }
  }
  return out;
}

// Priority routing: a pending ask_user takes the next line; otherwise lines
// queue as steering messages for the prompt generator.
const steering = [];
let askWaiter = null; // (text) => void
const pump = setInterval(() => {
  for (const text of readNewLines()) {
    if (askWaiter) {
      const w = askWaiter;
      askWaiter = null;
      w(text);
    } else {
      steering.push(text);
    }
  }
}, 2000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userMsg = (text, images) => ({
  type: "user",
  message: {
    role: "user",
    content: [
      ...(images ?? []).map((img) => ({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: img.data },
      })),
      { type: "text", text },
    ],
  },
  parent_tool_use_id: null,
  session_id: "",
});

// The input stream stays open so steering can arrive mid-run; it closes when a
// turn finishes (result message seen) with nothing queued — that result is final.
let turnDone = false;
async function* promptStream() {
  yield userMsg(task.goal, task.images);
  for (;;) {
    if (steering.length > 0) {
      turnDone = false;
      yield userMsg(steering.shift());
      continue;
    }
    if (turnDone) {
      // Final drain: the 2s pump may not have scanned a comment that landed in
      // the last moments of the turn — read the file directly before closing.
      for (const t of readNewLines()) steering.push(t);
      if (steering.length > 0) continue;
      return;
    }
    await sleep(500);
  }
}

const askUser = tool(
  "ask_user",
  "Ask the human a question in Linear and wait up to 10 minutes for their reply. " +
    "Use ONLY when blocked on a decision you cannot infer from the repo or issue.",
  { question: z.string() },
  async ({ question }) => {
    emit({ kind: "ask_user", question });
    const waitMs = Math.min(ASK_TIMEOUT_MS, Math.max(0, DEADLINE_MS - (Date.now() - START)));
    const answer = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        askWaiter = null;
        resolve(null);
      }, waitMs);
      askWaiter = (text) => {
        clearTimeout(timer);
        resolve(text);
      };
    });
    return { content: [{ type: "text", text: answer ?? NO_ANSWER }] };
  },
);

// Serena (semantic retrieval MCP). ponytail: presence check only — if the
// template lacks the binary the run continues with Grep/Glob; never crash a
// run over a retrieval optimization.
const SERENA_BIN = "/usr/local/bin/serena";
const mcpServers = { jarvis: createSdkMcpServer({ name: "jarvis", version: "1.0.0", tools: [askUser] }) };
// Only register serena when the task actually allows it — otherwise a task like
// mapTask (Read/Glob/Grep only) pays serena's MCP cold-start for nothing.
const wantsSerena = Array.isArray(task.allowedTools) && task.allowedTools.some((t) => t === "mcp__serena" || t.startsWith("mcp__serena__"));
if (wantsSerena && existsSync(SERENA_BIN)) {
  mcpServers.serena = {
    type: "stdio",
    command: SERENA_BIN,
    args: ["start-mcp-server", "--context", "ide-assistant", "--project", task.cwd],
  };
}

// Docs MCP (Linear docs / thread / prior run events over streamable HTTP).
// The host passes a per-run bearer token; the Linear OAuth token never enters
// the sandbox. ponytail: presence check only — no docsMcp, no registration, and
// the agent simply lacks the tools (advisory), never a crash.
if (task.docsMcp?.url && task.docsMcp?.token) {
  mcpServers.docs = {
    type: "http",
    url: task.docsMcp.url,
    headers: { Authorization: `Bearer ${task.docsMcp.token}` },
  };
}

let lastResult = null;
// Cumulative token usage across every assistant turn. The SDK's result.usage is
// only the FINAL turn's snapshot, which badly undercounts a multi-turn run —
// summing per-assistant usage is what makes cost/cache telemetry honest.
const totals = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
try {
  const toolNames = new Map(); // tool_use id -> name, to label tool_results
  for await (const message of query({
    prompt: promptStream(),
    options: {
      cwd: task.cwd,
      model: task.model,
      ...(task.effort ? { effort: task.effort } : {}),
      // excludeDynamicSections keeps the preset byte-stable across sandboxes so the prompt cache hits (Phase 4.2)
      systemPrompt: { type: "preset", preset: "claude_code", append: task.systemAppend, excludeDynamicSections: true },
      settingSources: ["user", "project"], // REQUIRED so superpowers skills load
      allowedTools: task.allowedTools,
      permissionMode: "bypassPermissions", // safe: the sandbox is the isolation boundary
      maxTurns: task.maxTurns,
      maxBudgetUsd: task.maxBudgetUsd,
      mcpServers,
    },
  })) {
    if (message.type === "assistant") {
      const u = message.message?.usage;
      if (u) {
        totals.input_tokens += u.input_tokens ?? 0;
        totals.output_tokens += u.output_tokens ?? 0;
        totals.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
        totals.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
      }
      for (const block of message.message.content) {
        if (block.type === "text") emit({ kind: "assistant_text", text: block.text });
        else if (block.type === "tool_use") {
          toolNames.set(block.id, block.name);
          emit({ kind: "tool_use", name: block.name, input: block.input });
        }
      }
    } else if (message.type === "user" && Array.isArray(message.message?.content)) {
      for (const block of message.message.content) {
        if (block.type === "tool_result") {
          const content =
            typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
          emit({
            kind: "tool_result",
            tool: toolNames.get(block.tool_use_id) ?? null,
            isError: block.is_error === true,
            content: content.slice(0, 2048),
          });
        }
      }
    } else if (message.type === "result") {
      lastResult = {
        kind: "result",
        subtype: message.subtype,
        text: message.subtype === "success" ? message.result : null,
        costUsd: message.total_cost_usd ?? null,
        sessionId: message.session_id ?? null,
        usage: { ...totals }, // cumulative across the whole run, not the final turn
        numTurns: message.num_turns ?? null,
      };
      emit(lastResult);
      turnDone = true; // generator closes unless steering is queued
    }
  }
  // True end of run: only now is RESULT_FILE authoritative (per-turn results
  // must not end the host's watchDetached early).
  writeFileSync(RESULT_FILE, JSON.stringify(lastResult ?? { kind: "error", message: "run ended without a result" }));
} catch (err) {
  const ev = { kind: "error", message: String(err?.message ?? err) };
  try {
    writeFileSync(RESULT_FILE, JSON.stringify(ev));
  } catch (writeErr) {
    // Write failure must not mask the emit
  }
  emit(ev);
  process.exitCode = 1;
} finally {
  clearInterval(pump);
}
