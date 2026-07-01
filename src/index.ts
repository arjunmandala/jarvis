import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { makeServer } from "./server.ts";

const config = loadConfig();
const app = makeServer(config);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Jarvis listening on http://localhost:${info.port}`);
});
