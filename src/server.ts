import { Hono } from "hono";
import { LinearWebhookClient } from "@linear/sdk/webhooks";
import type { Config } from "./config.ts";
import { SessionStore } from "./store/sessions.ts";
import { makeLinearClient } from "./linear/client.ts";
import { makeActivities } from "./linear/activities.ts";
import { extractContext, promptedBody, parseApproval } from "./linear/context.ts";
import { runSkeleton } from "./sandbox/session.ts"; // Phase 0 uses a skeleton run; replaced in Phase 1+

export function makeServer(config: Config): Hono {
  const app = new Hono();
  const store = new SessionStore(process.env.JARVIS_DB ?? "jarvis.db");
  const linear = makeLinearClient(config.linear.accessToken);
  const webhook = new LinearWebhookClient(config.linear.webhookSecret);
  const handler = webhook.createHandler();

  handler.on("AgentSessionEvent", async (payload: unknown) => {
    const p = payload as { action?: string };
    if (p.action === "created") {
      const ctx = extractContext(payload);
      const acts = makeActivities(linear, ctx.agentSessionId);
      // 10s rule: claim the session immediately.
      await acts.thought("On it — taking a look at this issue.");
      store.upsert(ctx.agentSessionId, "clarify", ctx.issueId);
      // Fire-and-forget the slow work; do NOT await (keeps webhook ACK < 5s).
      void runSkeletonPipeline(config, acts, ctx).catch(async (e) => {
        await acts.error(`Pipeline failed: ${String(e?.message ?? e)}`).catch(() => undefined);
      });
    } else if (p.action === "prompted") {
      // Phase 1+ resumes here on approval; Phase 0 ignores.
      void parseApproval(promptedBody(payload));
    }
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/oauth/callback", async (c) => {
    // One-time install capture. Exchanges the code for an actor=app access token.
    const code = c.req.query("code");
    if (!code) return c.text("missing ?code", 400);
    const res = await fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        redirect_uri: `${config.publicBaseUrl}/oauth/callback`,
        client_id: config.linear.clientId,
        client_secret: config.linear.clientSecret,
        grant_type: "authorization_code",
      }),
    });
    const json = (await res.json()) as { access_token?: string };
    console.log("LINEAR_ACCESS_TOKEN=", json.access_token); // copy into .env, then restart
    return c.text("Token captured — check server logs, copy into .env, restart.");
  });

  app.post("/webhook", async (c) => handler(c.req.raw)); // raw body unconsumed → signature verifies

  return app;
}

// Phase 0 skeleton: clone repo, run one command, post result. Replaced by the
// real orchestrator in Phase 1+ (Task 1.x / orchestrator/pipeline.ts).
async function runSkeletonPipeline(
  config: Config,
  acts: ReturnType<typeof makeActivities>,
  ctx: ReturnType<typeof extractContext>,
): Promise<void> {
  await runSkeleton(config, acts);
}
