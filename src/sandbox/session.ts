import { Sandbox, CommandExitError } from "e2b";
import { LineParser, type JarvisEvent } from "../agent/events.ts";
import type { AgentTask } from "../agent/tasks.ts";

export interface SandboxConfig {
  apiKey: string;
  template: string;
  ghToken: string;
  targetRepo: string; // "owner/name"
  // Host-side wall-clock telemetry: called with (label, elapsedMs) for
  // sandbox_create / clone / serena_index. Callers supply a non-throwing callback.
  onTiming?: (label: string, ms: number) => void;
}

export const REPO_DIR = "/home/user/repo";

// Non-image/PDF attachments (text and other binary formats) are written here
// inside the sandbox so the agent can read/convert them directly (pandoc,
// poppler-utils). Images and PDFs instead go in as native content blocks —
// see AgentTask.images/documents and Orchestrator#extractAttachments.
export const ATTACHMENTS_DIR = "/home/user/jarvis-attachments";

// ponytail: retries ALL errors — no transient/permanent split. Upgrade path is an
// error-classifier predicate if 4xx-style permanent failures cause noise. Matches the
// Minor already accepted on the Linear-post retry (durable-runs phase) — keep consistent.
export async function withRetries<T>(
  label: string,
  fn: () => Promise<T>,
  opts?: { attempts?: number; baseDelayMs?: number },
): Promise<T> {
  const attempts = opts?.attempts ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 1000;
  for (let n = 1; ; n++) {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[retry] ${label} attempt ${n}/${attempts} failed: ${message}`);
      if (n >= attempts) throw err;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** (n - 1)));
    }
  }
}

export async function withSandbox<T>(cfg: SandboxConfig, fn: (sbx: Sandbox) => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const sbx = await withRetries("sandbox.create", () =>
    Sandbox.create(cfg.template, {
      apiKey: cfg.apiKey,
      timeoutMs: 60 * 60 * 1000, // 1h; one sandbox per agent run
      metadata: { app: "jarvis" },
      envs: { GH_TOKEN: cfg.ghToken },
    }),
  );
  cfg.onTiming?.("sandbox_create", Date.now() - t0);
  try {
    return await fn(sbx);
  } finally {
    await sbx.kill().catch(() => undefined);
  }
}

export function redactSecret(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join("***");
}

export async function cloneRepo(sbx: Sandbox, cfg: SandboxConfig, branch?: string | null): Promise<void> {
  // Token-in-URL clone of a private repo; GH_TOKEN is also set in env for gh.
  const url = `https://x-access-token:${cfg.ghToken}@github.com/${cfg.targetRepo}.git`;
  // branch is validated (isValidBranchName) before it ever reaches this
  // call — see src/linear/context.ts and its callers in orchestrator/pipeline.ts.
  const branchFlag = branch ? `-b ${branch} ` : "";
  const cloneStart = Date.now();
  await withRetries("git clone", async () => {
    const res = await runCommand(sbx, `git clone ${branchFlag}${url} ${REPO_DIR}`);
    if (res.exitCode !== 0) {
      throw new Error(redactSecret(`git clone failed (${res.exitCode}): ${res.stderr}`, cfg.ghToken));
    }
  });
  cfg.onTiming?.("clone", Date.now() - cloneStart);
  const indexStart = Date.now();
  await indexRepo(sbx, cfg.ghToken);
  cfg.onTiming?.("serena_index", Date.now() - indexStart);
}

// Serena index: pays the LSP indexing cost once up front instead of on the
// agent's first symbolic query. This ALSO creates the repo's .serena/project.yml
// so runner.mjs's `start-mcp-server --project` finds an existing project instead
// of trying to auto-create one at MCP-startup time (which prompts on stdin — the
// JSON-RPC channel — and wedges the server, leaving the agent with no serena
// tools). `yes n |` declines serena's "Enable <lang>? [y/N]" auto-create prompt,
// same workaround the template build uses (e2b/build-template.ts).
// ponytail: advisory — any failure (serena missing, unsupported language, LSP
// crash) logs and continues; the agent falls back to Grep/Glob. Upgrade to a
// serena non-interactive flag if one lands.
export async function indexRepo(sbx: Sandbox, ghToken = ""): Promise<void> {
  try {
    const res = await runCommand(sbx, `yes n | serena project index ${REPO_DIR}`);
    if (res.exitCode !== 0) {
      // Full stderr, not a 300-char slice: the truncation is what hid this exact
      // root cause. It's advisory logging on a bounded command — cheap to keep whole.
      console.error(redactSecret(`[serena] project index failed (${res.exitCode}): ${res.stderr}`, ghToken));
    }
  } catch (err) {
    console.error(redactSecret(`[serena] project index errored: ${err instanceof Error ? err.message : String(err)}`, ghToken));
  }
}

export async function runCommand(
  sbx: Sandbox,
  cmd: string,
  opts: { onStdout?: (d: string) => void; onStderr?: (d: string) => void } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const r = await sbx.commands.run(cmd, {
      timeoutMs: 0, // long jobs: npm ci, test suites, agent runs
      onStdout: opts.onStdout,
      onStderr: opts.onStderr,
    });
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    if (err instanceof CommandExitError) {
      return { exitCode: err.exitCode, stdout: err.stdout, stderr: err.stderr };
    }
    throw err;
  }
}

// The in-sandbox runner writes its final result/error event here before emitting
// it on stdout (Task 1). This file is the authoritative record; the stream is
// telemetry that can go half-open and hang. See runAgent / watchDetached.
export const RESULT_FILE = "/tmp/jarvis-result.json";

// Append-only JSONL the host writes user comments into; the in-sandbox runner
// tails it and injects each line into the live agent session (steering / ask_user
// answers). Cleared alongside RESULT_FILE at the start of every run.
export const INBOX_FILE = "/tmp/jarvis-inbox.jsonl";

// base64 round-trip so arbitrary text (quotes, newlines) survives the shell.
export async function injectMessage(sbx: AgentSandbox, text: string): Promise<void> {
  const b64 = Buffer.from(JSON.stringify({ text }) + "\n", "utf8").toString("base64");
  await sbx.commands.run(`echo ${b64} | base64 -d >> ${INBOX_FILE}`, { timeoutMs: 60_000 });
}

// Narrow structural type so tests can fake a sandbox without e2b. The real e2b
// Sandbox structurally satisfies this.
export interface AgentSandbox {
  // write's return is widened to unknown so the real e2b Sandbox (Promise<WriteInfo>)
  // structurally satisfies this interface.
  files: { read(path: string): Promise<string>; write(path: string, data: string | ArrayBuffer): Promise<unknown> };
  commands: {
    run(cmd: string, opts: object): Promise<{ exitCode: number }>;
    list(): Promise<{ cmd: string; args: string[] }[]>;
  };
}

/** Read RESULT_FILE and return it only if it parses to a result|error event; null otherwise. */
export async function readResultFile(sbx: AgentSandbox): Promise<JarvisEvent | null> {
  let raw: string;
  try {
    raw = await sbx.files.read(RESULT_FILE);
  } catch {
    return null; // missing / unreadable
  }
  try {
    const obj = JSON.parse(raw) as unknown;
    if (
      obj &&
      typeof obj === "object" &&
      ((obj as { kind?: unknown }).kind === "result" || (obj as { kind?: unknown }).kind === "error")
    ) {
      return obj as JarvisEvent;
    }
  } catch {
    // non-JSON
  }
  return null;
}

export interface WatchOpts {
  pollMs?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
}

/** Abortable sleep that clears its timer and settles promptly on abort. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    signal?.addEventListener("abort", onAbort, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
  });
}

function runnerAlive(procs: { cmd: string; args: string[] }[]): boolean {
  return procs.some((p) => {
    const hay = [p.cmd, ...(p.args ?? [])].join(" ");
    return hay.includes("runner.mjs");
  });
}

/**
 * Poll RESULT_FILE (the authoritative record) until it appears, the runner
 * process disappears, the deadline passes, or the signal aborts. Usable
 * standalone to re-attach to a sandbox after a host restart — no stream needed.
 */
export async function watchDetached(sbx: AgentSandbox, opts: WatchOpts = {}): Promise<JarvisEvent | null> {
  const pollMs = opts.pollMs ?? 30_000;
  const deadlineMs = opts.deadlineMs ?? 55 * 60_000;
  const signal = opts.signal;
  const start = Date.now();
  let transient = 0;

  while (!signal?.aborted) {
    try {
      const fromFile = await readResultFile(sbx);
      if (fromFile) return fromFile;

      const procs = await sbx.commands.list();
      if (!runnerAlive(procs)) {
        // Runner is gone: grace-wait one tick, then one final read (may be null).
        await sleep(pollMs, signal);
        return await readResultFile(sbx);
      }
      transient = 0;
    } catch {
      if (++transient >= 3) return null;
    }

    if (Date.now() - start >= deadlineMs) return null;
    await sleep(pollMs, signal);
    if (Date.now() - start >= deadlineMs) return null;
  }
  return null;
}

export async function runAgent(
  sbx: AgentSandbox,
  anthropicApiKey: string,
  task: AgentTask,
  onEvent: (e: JarvisEvent) => void | Promise<void>,
): Promise<{ result: JarvisEvent | null; exitCode: number }> {
  const taskPath = "/tmp/jarvis-task.json";
  // Sandbox reuse (e.g. map run then plan run in one sandbox) must not leak the
  // previous run's RESULT_FILE: clear it before starting a new runner so
  // watchDetached can't win the race on stale data. Must be `rm` via commands
  // (same execution context as the runner) — e2b's files.write gets a 500
  // "permission denied" overwriting a file the runner process wrote, even with
  // matching ownership (verified live against the jarvis-agent template).
  await sbx.commands.run(`rm -f ${taskPath} ${RESULT_FILE} ${INBOX_FILE}`, { timeoutMs: 60_000 });
  await sbx.files.write(taskPath, JSON.stringify(task));

  const parser = new LineParser();
  let last: JarvisEvent | null = null;
  const pending: Promise<unknown>[] = [];

  const consume = (chunk: string) => {
    for (const ev of parser.push(chunk)) {
      if (ev.kind === "result" || ev.kind === "error") last = ev;
      pending.push(Promise.resolve(onEvent(ev)));
    }
  };

  // Start the stream but don't await it directly: a half-open stdout can hang
  // forever. Resolve on normal/CommandExitError exit; leave other errors to reject.
  let streamFinished = false;
  const streamEnd: Promise<number> = sbx.commands
    .run("node /opt/jarvis-agent/runner.mjs", {
      timeoutMs: 0, // long jobs: npm ci, test suites, agent runs
      envs: { ANTHROPIC_API_KEY: anthropicApiKey, JARVIS_TASK_FILE: taskPath },
      onStdout: consume,
    })
    .then(
      (r) => {
        streamFinished = true;
        return r.exitCode;
      },
      (err) => {
        if (err instanceof CommandExitError) {
          streamFinished = true;
          return err.exitCode;
        }
        throw err;
      },
    );

  // Supervise: whichever settles first wins; the loser is aborted.
  const ac = new AbortController();
  const watcher = watchDetached(sbx, { signal: ac.signal });

  const streamRace = streamEnd.then((exitCode) => ({ from: "stream" as const, exitCode }));
  // Don't let the abandoned stream promise reject unhandled if the watcher wins
  // and the stream later rejects (non-CommandExitError).
  streamEnd.catch(() => {});
  streamRace.catch(() => {});

  const winner = await Promise.race([
    streamRace,
    watcher.then((event) => ({ from: "watch" as const, event })),
  ]);

  ac.abort(); // cancel the watcher's sleep if the stream won
  const watcherEvent = winner.from === "watch" ? winner.event : await watcher.catch(() => null);

  // Flush any buffered trailing line from the stream.
  for (const ev of parser.flush()) {
    if (ev.kind === "result" || ev.kind === "error") last = ev;
    pending.push(Promise.resolve(onEvent(ev)));
  }
  await Promise.allSettled(pending);

  // Precedence: stream's own result/error event, else RESULT_FILE, else watcher's.
  let result: JarvisEvent | null = last;
  if (!result) result = await readResultFile(sbx);
  if (!result) result = watcherEvent;

  // exitCode is the stream's if it finished, else -1 (stream never settled).
  const exitCode = streamFinished ? await streamEnd : -1;

  return { result, exitCode };
}
