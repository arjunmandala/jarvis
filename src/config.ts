export interface Config {
  port: number;
  linear: { accessToken?: string; webhookSecret: string; clientId: string; clientSecret: string };
  anthropicApiKey: string;
  e2bApiKey: string;
  e2bTemplate: string;
  ghToken: string;
  targetRepo: string;
  publicBaseUrl: string;
}

// LINEAR_ACCESS_TOKEN is intentionally NOT required: it's an optional bootstrap
// seed for the very first run before the oauth_tokens row exists. The live token
// is renewed automatically via client_credentials and persisted in SQLite. See
// src/linear/token-manager.ts.
const REQUIRED = [
  "LINEAR_WEBHOOK_SECRET", "LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET",
  "ANTHROPIC_API_KEY", "E2B_API_KEY", "E2B_TEMPLATE", "GH_TOKEN", "TARGET_REPO", "PUBLIC_BASE_URL",
] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
  return {
    port: env.PORT ? Number(env.PORT) : 3000,
    linear: {
      accessToken: env.LINEAR_ACCESS_TOKEN,
      webhookSecret: env.LINEAR_WEBHOOK_SECRET!,
      clientId: env.LINEAR_CLIENT_ID!,
      clientSecret: env.LINEAR_CLIENT_SECRET!,
    },
    anthropicApiKey: env.ANTHROPIC_API_KEY!,
    e2bApiKey: env.E2B_API_KEY!,
    e2bTemplate: env.E2B_TEMPLATE!,
    ghToken: env.GH_TOKEN!,
    targetRepo: env.TARGET_REPO!,
    publicBaseUrl: env.PUBLIC_BASE_URL!,
  };
}
