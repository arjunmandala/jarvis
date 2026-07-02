import { execSync } from "node:child_process";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { makeServer } from "./server.ts";

// ponytail: best-effort SHA so "which code was running" is never a mystery;
// silent "unknown" outside a git checkout is fine.
let sha = "unknown";
try {
  sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
} catch {
  /* not a git checkout */
}
console.log(`[boot] jarvis @ ${sha}`);

const config = loadConfig();
const app = makeServer(config);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Jarvis listening on http://localhost:${info.port}`);
});
