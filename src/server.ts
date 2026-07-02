import { Hono } from "hono";
import { LinearWebhookClient } from "@linear/sdk/webhooks";
import type { Config } from "./config.ts";
import { SessionStore } from "./store/sessions.ts";
import { makeLinearClient, makePlanFetcher } from "./linear/client.ts";
import { makeActivities } from "./linear/activities.ts";
import { extractContext, promptedBody } from "./linear/context.ts";
import { Orchestrator } from "./orchestrator/pipeline.ts";

export function makeServer(config: Config): Hono {
  const app = new Hono();
  const store = new SessionStore(process.env.JARVIS_DB ?? "jarvis.db");
  const linear = makeLinearClient(config.linear.accessToken);
  const webhook = new LinearWebhookClient(config.linear.webhookSecret);
  const handler = webhook.createHandler();
  const orchestrator = new Orchestrator(config, store, (id) => makeActivities(linear, id), makePlanFetcher(config.linear.accessToken));

  // Boot reconciliation: recover or fail-loud every session left in-flight by a
  // restart. Fire-and-forget so server startup isn't blocked on e2b.
  void orchestrator.reconcile().catch((e) => console.error("[reconcile]", e));

  // Log every inbound request (method, path, status) — so webhook delivery is
  // visible even when signature verification rejects it before our handler.
  app.use("*", async (c, next) => {
    await next();
    console.log(`[req] ${c.req.method} ${new URL(c.req.url).pathname} → ${c.res.status}`);
  });

  // Sessions with a run currently executing — drop duplicate/echoed webhooks
  // for the same session so runs can't stack or loop. (v1 in-memory guard.)
  const inflight = new Set<string>();

  handler.on("AgentSessionEvent", async (payload: unknown) => {
    const action = (payload as { action?: string }).action;
    const ctx = extractContext(payload);
    if (!ctx.agentSessionId) return;
    const acts = makeActivities(linear, ctx.agentSessionId);
    console.log(`[webhook] AgentSessionEvent action=${action} session=${ctx.agentSessionId} issue=${JSON.stringify(ctx.title)}`);

    if (action === "created") {
      if (inflight.has(ctx.agentSessionId)) {
        console.log(`[skip] ${ctx.agentSessionId} already processing — dropping ${action}`);
        return;
      }
      inflight.add(ctx.agentSessionId);
      await acts.thought("On it — taking a look."); // 10s rule
      store.upsert(ctx.agentSessionId, "clarify", ctx.issueId);
      void orchestrator
        .onCreated(ctx)
        .catch((e) => {
          // A "stop" mid-run kills the sandbox, which makes the in-flight
          // runAgent command reject here with a transport error. steer()
          // already posted "Stopped mid-run." for this session — don't post
          // a contradictory error right after it; just log for diagnostics.
          if (store.get(ctx.agentSessionId)?.phase === "done") {
            console.error(`[error] onCreated ${ctx.agentSessionId} (suppressed, session already stopped):`, e?.message ?? e);
            return;
          }
          console.error(`[error] onCreated ${ctx.agentSessionId}:`, e?.message ?? e);
          acts.error(String(e?.message ?? e)).catch(() => undefined);
        })
        .finally(() => inflight.delete(ctx.agentSessionId));
    } else if (action === "prompted") {
      const reply = promptedBody(payload);
      if (!reply.trim()) {
        // Empty prompts (e.g. echoes of our own activities) would otherwise
        // loop; ignore them. Dump the shape once so we can confirm the field.
        console.log(`[webhook] prompted with EMPTY reply — ignoring. payload=${JSON.stringify(payload).slice(0, 400)}`);
        return;
      }
      console.log(`[webhook] prompted reply=${JSON.stringify(reply.slice(0, 80))}`);
      // A comment while a run is live steers the running agent — it must NOT be
      // dropped by the inflight guard (the run itself holds that flag).
      if (orchestrator.hasLive(ctx.agentSessionId)) {
        void orchestrator.steer(ctx, reply).catch((e) => {
          console.error(`[error] steer ${ctx.agentSessionId}:`, e?.message ?? e);
          acts.error(String(e?.message ?? e)).catch(() => undefined);
        });
        return;
      }
      if (inflight.has(ctx.agentSessionId)) {
        console.log(`[skip] ${ctx.agentSessionId} already processing — dropping ${action}`);
        return;
      }
      inflight.add(ctx.agentSessionId);
      void orchestrator
        .onPrompted(ctx, reply)
        .catch((e) => {
          // Same stop-kill race as onCreated above: don't contradict a
          // "Stopped mid-run." post with a follow-up error.
          if (store.get(ctx.agentSessionId)?.phase === "done") {
            console.error(`[error] onPrompted ${ctx.agentSessionId} (suppressed, session already stopped):`, e?.message ?? e);
            return;
          }
          console.error(`[error] onPrompted ${ctx.agentSessionId}:`, e?.message ?? e);
          acts.error(String(e?.message ?? e)).catch(() => undefined);
        })
        .finally(() => inflight.delete(ctx.agentSessionId));
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
    const json = (await res.json()) as {
      access_token?: string;
      token_type?: string;
      scope?: string | string[];
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!json.access_token) {
      console.log(`OAuth exchange FAILED: status ${res.status} error=${json.error} ${json.error_description ?? ""}`);
      return c.text(
        `OAuth exchange failed (HTTP ${res.status}).\nerror: ${json.error}\ndescription: ${json.error_description}\n\n` +
          "Common cause: the app's saved Redirect URI must exactly equal " +
          `${config.publicBaseUrl}/oauth/callback. Fix it and retry.`,
        400,
      );
    }
    // Self-verify the fresh token against the API so setup fails loud, not silent.
    let verify = "not run";
    try {
      const vr = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${json.access_token}` },
        body: JSON.stringify({ query: "{ viewer { id name } organization { name urlKey } }" }),
      });
      const vj = (await vr.json()) as { data?: { organization?: { name?: string } }; errors?: unknown };
      verify = vr.status === 200 && vj.data?.organization ? `OK (org: ${vj.data.organization.name})` : `FAILED (${vr.status}: ${JSON.stringify(vj.errors ?? vj).slice(0, 160)})`;
    } catch (e) {
      verify = `FAILED (${e instanceof Error ? e.message : String(e)})`;
    }
    const len = json.access_token.length;
    console.log(`OAuth token captured: token_type=${json.token_type} scope=${JSON.stringify(json.scope)} expires_in=${json.expires_in} len=${len} verify=${verify}`);
    return c.text(
      `LINEAR_ACCESS_TOKEN=${json.access_token}\n\n` +
        `token_type: ${json.token_type}\nscope: ${JSON.stringify(json.scope)}\nexpires_in: ${json.expires_in}\nlength: ${len}\nAPI self-check: ${verify}\n\n` +
        "Copy the LINEAR_ACCESS_TOKEN line's value (no trailing spaces) into .env, then restart. " +
        "If the self-check says OK, the token works.",
    );
  });

  app.post("/webhook", async (c) => handler(c.req.raw)); // raw body unconsumed → signature verifies

  return app;
}
