import { Template } from "e2b";
import { join } from "node:path";

// Build with: node --env-file-if-exists=.env e2b/build-template.ts
// Requires E2B_API_KEY in env. Copy sources resolve within fileContextPath;
// default is this script's dir (e2b/), so pin it to the repo root one level up.
const template = Template({ fileContextPath: join(import.meta.dirname, "..") })
  .fromUbuntuImage("24.04")
  .setUser("root")
  .aptInstall(["curl", "git", "ca-certificates", "python3", "python3-venv", "python3-pip"])
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
  // In-sandbox Agent SDK + runner under /opt/jarvis-agent
  .makeDir("/opt/jarvis-agent")
  .runCmd("cd /opt/jarvis-agent && npm init -y && npm i @anthropic-ai/claude-agent-sdk@^0.3.197 zod@^4")
  .copy("src/agent/runner.mjs", "/opt/jarvis-agent/runner.mjs")
  // superpowers skills available to the agent as a user setting source
  .makeDir("/home/user/.claude/skills")
  .copy("vendor/superpowers-skills", "/home/user/.claude/skills")
  .runCmd("chown -R user:user /home/user/.claude")
  .setUser("user");

try {
  await Template.build(template, "jarvis-agent", { cpuCount: 2, memoryMB: 4096 });
  console.log("Built template: jarvis-agent");
} catch (e) {
  console.error(`Template build failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
