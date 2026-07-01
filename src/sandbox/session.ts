import { Sandbox, CommandExitError } from "e2b";
import type { Config } from "../config.ts";
import type { Activities } from "../linear/activities.ts";
import { LineParser, type JarvisEvent } from "../agent/events.ts";
import type { AgentTask } from "../agent/tasks.ts";

export interface SandboxConfig {
  apiKey: string;
  template: string;
  ghToken: string;
  targetRepo: string; // "owner/name"
}

export const REPO_DIR = "/home/user/repo";

export async function withSandbox<T>(cfg: SandboxConfig, fn: (sbx: Sandbox) => Promise<T>): Promise<T> {
  const sbx = await Sandbox.create(cfg.template, {
    apiKey: cfg.apiKey,
    timeoutMs: 60 * 60 * 1000, // 1h; one sandbox per agent run
    metadata: { app: "jarvis" },
    envs: { GH_TOKEN: cfg.ghToken },
  });
  try {
    return await fn(sbx);
  } finally {
    await sbx.kill().catch(() => undefined);
  }
}

export async function cloneRepo(sbx: Sandbox, cfg: SandboxConfig): Promise<void> {
  // Token-in-URL clone of a private repo; GH_TOKEN is also set in env for gh.
  const url = `https://x-access-token:${cfg.ghToken}@github.com/${cfg.targetRepo}.git`;
  const res = await runCommand(sbx, `git clone ${url} ${REPO_DIR}`);
  if (res.exitCode !== 0) {
    throw new Error(`git clone failed (${res.exitCode}): ${res.stderr}`);
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

export async function runAgent(
  sbx: Sandbox,
  anthropicApiKey: string,
  task: AgentTask,
  onEvent: (e: JarvisEvent) => void | Promise<void>,
): Promise<{ result: JarvisEvent | null; exitCode: number }> {
  const taskPath = "/tmp/jarvis-task.json";
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

  let exitCode: number;
  try {
    const r = await sbx.commands.run("node /opt/jarvis-agent/runner.mjs", {
      timeoutMs: 0, // long jobs: npm ci, test suites, agent runs
      envs: { ANTHROPIC_API_KEY: anthropicApiKey, JARVIS_TASK_FILE: taskPath },
      onStdout: consume,
    });
    exitCode = r.exitCode;
  } catch (err) {
    if (err instanceof CommandExitError) {
      exitCode = err.exitCode;
    } else {
      throw err;
    }
  }

  for (const ev of parser.flush()) {
    if (ev.kind === "result" || ev.kind === "error") last = ev;
    pending.push(Promise.resolve(onEvent(ev)));
  }
  await Promise.allSettled(pending);
  return { result: last, exitCode };
}

// Phase 0 only. Proves the loop: clone → run one command → post result.
export async function runSkeleton(config: Config, acts: Activities): Promise<void> {
  const sbxCfg = {
    apiKey: config.e2bApiKey, template: config.e2bTemplate,
    ghToken: config.ghToken, targetRepo: config.targetRepo,
  };
  await withSandbox(sbxCfg, async (sbx) => {
    await acts.action("Cloning", config.targetRepo);
    await cloneRepo(sbx, sbxCfg);
    await acts.action("Running", "npm test");
    const r = await runCommand(sbx, `cd ${REPO_DIR} && npm test`);
    const status = r.exitCode === 0 ? "✅ passed" : `❌ exited ${r.exitCode}`;
    await acts.response(
      `Ran \`npm test\` in a fresh sandbox — ${status}.\n\n` +
        "```\n" + (r.stdout || r.stderr).slice(-2000) + "\n```",
    );
  });
}
