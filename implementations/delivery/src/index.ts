/**
 * `@cotal-ai/delivery` — the server-side Plane-3 delivery daemon, as a self-registering `deliver`
 * command. Importing this package registers `deliver` into the core `Registry`; the `cotal` binary
 * (composition root) pulls it in alongside `@cotal-ai/manager`. Structurally parallel to the manager:
 * a distinct long-lived infra role with its own scoped cred profile and lifecycle. It NEVER imports
 * `@cotal-ai/manager` or `@cotal-ai/cli` (one-way tiering).
 */
import { registry, type Command } from "@cotal-ai/core";
import { runDelivery } from "./delivery.js";

const deliveryCommands: Command[] = [
  {
    kind: "command",
    name: "deliver",
    group: "Manager",
    summary:
      "run the delivery daemon — the server-side Plane-3 durable backstop [--space <s>] [--server <url>] [--creds <file>] (auth mode only; N=1)",
    flags: [
      { name: "space", type: "string", value: "<s>", description: "space to serve (required; the scoped cred doesn't encode it)" },
      { name: "server", type: "string", value: "<url>", description: "broker URL (default: the local mesh)" },
      { name: "creds", type: "string", value: "<file>", description: "pre-minted scoped delivery cred" },
      { name: "shard", type: "string", value: "<n>", description: "shard index (N=1 only; non-zero is rejected)" },
      { name: "shards", type: "string", value: "<n>", description: "shard count (N=1 only; >1 is rejected)" },
      { name: "dev-mint", type: "boolean", description: "standalone dev: mint a scoped delivery cred from the local signer" },
    ],
    run: (args) => runDelivery(args),
  },
];

registry.register(...deliveryCommands);

export { runDelivery };
