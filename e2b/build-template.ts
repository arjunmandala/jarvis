import "../src/logger.ts";
import { Template, defaultBuildLogger } from "e2b";
import { join } from "node:path";

// Build with: node --env-file-if-exists=.env e2b/build-template.ts
// Requires E2B_API_KEY in env. Copy sources resolve within fileContextPath;
// default is this script's dir (e2b/), so pin it to the repo root one level up.
const template = Template({ fileContextPath: join(import.meta.dirname, "..") })
  .fromUbuntuImage("24.04")
  .setUser("root")
  .aptInstall(["curl", "git", "ca-certificates", "python3", "python3-venv", "python3-pip", "pandoc", "poppler-utils"])
  // Node 24 (NodeSource) + gh (GitHub apt repo) — baked so cold sandboxes are ready.
  .runCmd("curl -fsSL https://deb.nodesource.com/setup_24.x | bash -")
  .aptInstall(["nodejs"])
  .runCmd(
    "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg " +
      "| dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && " +
      'echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] ' +
      'https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list',
  )
  .aptInstall(["gh"])
  // uv + serena (semantic code retrieval MCP server, started by runner.mjs)
  .runCmd("curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh")
  // ponytail: uv's default UV_PYTHON_INSTALL_DIR lands under /root, which the
  // sandbox's unprivileged "user" can't traverse (bad interpreter: Permission
  // denied). Pin it under /opt and open perms so `user` can exec it.
  .runCmd(
    "env UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin " +
      "UV_PYTHON_INSTALL_DIR=/opt/uv-tools/python uv tool install -p 3.13 serena-agent && " +
      "chmod -R a+rX /opt/uv-tools",
  )
  // In-sandbox Agent SDK + runner under /opt/jarvis-agent
  .makeDir("/opt/jarvis-agent")
  .runCmd("cd /opt/jarvis-agent && npm init -y && npm i @anthropic-ai/claude-agent-sdk@^0.3.197 zod@^4")
  .copy("src/agent/runner.mjs", "/opt/jarvis-agent/runner.mjs")
  // superpowers skills available to the agent as a user setting source
  .makeDir("/home/user/.claude/skills")
  .copy("vendor/superpowers-skills", "/home/user/.claude/skills")
  .copy("vendor/ponytail-skills", "/home/user/.claude/skills")
  .copy("vendor/frontend-design-skills", "/home/user/.claude/skills")
  .runCmd("chown -R user:user /home/user/.claude")
  .setUser("user")
  // Pre-warm serena's TS/JS + Python language servers into /home/user so a
  // fresh sandbox never downloads them at run time. `|| true`: warming is an
  // optimization, never a build failure.
  .runCmd(
    "mkdir -p /tmp/warm/ts /tmp/warm/py && " +
      "printf '{\"compilerOptions\":{}}' > /tmp/warm/ts/tsconfig.json && " +
      "printf 'export const x = 1;\\n' > /tmp/warm/ts/index.ts && " +
      // ponytail: newer serena prompts "Enable <lang>? [y/N]" on stdin during
      // project auto-creation; the builder has no TTY, so pipe "n" to decline
      // every prompt. Upgrade to a serena non-interactive flag if one lands.
      "(yes n | serena project index /tmp/warm/ts || true)",
  )
  .runCmd("printf 'x = 1\\n' > /tmp/warm/py/main.py && (yes n | serena project index /tmp/warm/py || true)");

try {
  await Template.build(template, "jarvis-agent", {
    cpuCount: 2,
    memoryMB: 4096,
    onBuildLogs: defaultBuildLogger({ minLevel: "debug" }),
  });
  console.log("Built template: jarvis-agent");
} catch (e) {
  console.error(`Template build failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
