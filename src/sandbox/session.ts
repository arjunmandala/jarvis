import { Sandbox, CommandExitError } from "e2b";

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
