import type { FlagSpec } from "@cotal-ai/core";

/** Public daemon flags shared by the legacy entry and the native service child. */
export const authServiceFlags = [
  { name: "space", type: "string", value: "<s>", description: "space to serve (required)" },
  { name: "server", type: "string", value: "<url>", description: "broker URL the callout serves (required)" },
  { name: "port", type: "string", value: "<n>", description: "loopback HTTP port for /exchange + /jwks (default: ephemeral)" },
  { name: "exchange-public-port", type: "string", value: "<n>", description: "also serve the PUBLIC exchange face on this loopback port (TLS terminates at a reverse proxy)" },
  { name: "exchange-public-url", type: "string", value: "<https://…>", description: "with --exchange-public-port: the advertised public base URL (the reverse proxy's address)" },
  { name: "exchange-trusted-proxy", type: "boolean", description: "with --exchange-public-port: attribute peers by the last X-Forwarded-For hop (opt-in; default: socket address)" },
  { name: "advertised-server", type: "string", value: "<url>", description: "with --exchange-public-port: the broker address the public bundle advertises - what participants dial (default: --server)" },
  { name: "agent-provisioning-url", type: "string", value: "<https://…>", description: "with --exchange-public-port: the deployment's remote agent-provisioning endpoint the public bundle advertises (spawn POSTs it with the login bearer)" },
  { name: "service-endpoints", type: "boolean", description: "host service endpoints: the public /service-endpoint-authority door and the /service-endpoint-host route for owner decisions and operator name binding" },
] as const satisfies readonly FlagSpec[];
