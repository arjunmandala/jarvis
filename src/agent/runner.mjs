// Runs INSIDE the E2B sandbox. Reads a task JSON, runs the Claude Agent SDK,
// and prints newline-delimited JarvisEvent JSON to stdout for the host to parse.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";

const task = JSON.parse(readFileSync(process.env.JARVIS_TASK_FILE, "utf8"));
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

try {
  for await (const message of query({
    prompt: task.goal,
    options: {
      cwd: task.cwd,
      model: task.model,
      systemPrompt: { type: "preset", preset: "claude_code", append: task.systemAppend },
      settingSources: ["user", "project"], // REQUIRED so superpowers skills load
      allowedTools: task.allowedTools,
      permissionMode: "bypassPermissions", // safe: the sandbox is the isolation boundary
      maxTurns: task.maxTurns,
      maxBudgetUsd: task.maxBudgetUsd,
    },
  })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") emit({ kind: "assistant_text", text: block.text });
        else if (block.type === "tool_use") emit({ kind: "tool_use", name: block.name, input: block.input });
      }
    } else if (message.type === "result") {
      emit({
        kind: "result",
        subtype: message.subtype,
        text: message.subtype === "success" ? message.result : null,
        costUsd: message.total_cost_usd ?? null,
        sessionId: message.session_id ?? null,
        usage: message.usage ?? null,
        numTurns: message.num_turns ?? null,
      });
    }
  }
} catch (err) {
  emit({ kind: "error", message: String(err?.message ?? err) });
  process.exit(1);
}
