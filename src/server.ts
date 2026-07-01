import { Hono } from "hono";
import { LinearWebhookClient } from "@linear/sdk/webhooks";
import type { Config } from "./config.ts";
import { SessionStore } from "./store/sessions.ts";
import { makeLinearClient } from "./linear/client.ts";
import { makeActivities } from "./linear/activities.ts";
import { extractContext, promptedBody } from "./linear/context.ts";
import { Orchestrator } from "./orchestrator/pipeline.ts";

export function makeServer(config: Config): Hono {
  const app = new Hono();
  const store = new SessionStore(process.env.JARVIS_DB ?? "jarvis.db");
  const linear = makeLinearClient(config.linear.accessToken);
  const webhook = new LinearWebhookClient(config.linear.webhookSecret);
  const handler = webhook.createHandler();
  const orchestrator = new Orchestrator(config, store, (id) => makeActivities(linear, id));

  handler.on("AgentSessionEvent", async (payload: unknown) => {
    const action = (payload as { action?: string }).action;
    const ctx = extractContext(payload);
    if (!ctx.agentSessionId) return;
    const acts = makeActivities(linear, ctx.agentSessionId);

    if (action === "created") {
      await acts.thought("On it — taking a look."); // 10s rule
      store.upsert(ctx.agentSessionId, "clarify", ctx.issueId);
      void orchestrator.onCreated(ctx).catch((e) => acts.error(String(e?.message ?? e)).catch(() => undefined));
    } else if (action === "prompted") {
      const reply = promptedBody(payload);
      void orchestrator.onPrompted(ctx, reply).catch((e) => acts.error(String(e?.message ?? e)).catch(() => undefined));
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
    console.log("OAuth token captured; returning in response");
    return c.text(
      `LINEAR_ACCESS_TOKEN=${json.access_token ?? "(no token in response)"}\n\nCopy this into your .env as LINEAR_ACCESS_TOKEN, then restart the server. This value is shown once and is not logged.`,
    );
  });

  app.post("/webhook", async (c) => handler(c.req.raw)); // raw body unconsumed → signature verifies

  return app;
}
