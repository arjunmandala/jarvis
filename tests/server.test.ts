process.env.JARVIS_DB = ":memory:";

import { describe, it, expect } from "vitest";
import { makeServer } from "../src/server.ts";
import type { Config } from "../src/config.ts";

const config: Config = {
  port: 0,
  linear: { webhookSecret: "whsec", clientId: "cid", clientSecret: "csec", accessToken: "seed" },
  anthropicApiKey: "sk-test", e2bApiKey: "e2b", e2bTemplate: "jarvis-agent",
  ghToken: "gh", targetRepo: "o/r", publicBaseUrl: "http://localhost:3000",
};

describe("POST /mcp/docs", () => {
  it("401s an unauthenticated MCP request", async () => {
    const app = makeServer(config);
    const res = await app.request("/mcp/docs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });
});
