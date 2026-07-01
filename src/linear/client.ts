import { LinearClient } from "@linear/sdk";

export function makeLinearClient(accessToken: string): LinearClient {
  // actor=app agents authenticate with the OAuth access token, NOT a personal apiKey.
  return new LinearClient({ accessToken });
}
