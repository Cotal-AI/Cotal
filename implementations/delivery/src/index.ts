/**
 * `@cotal-ai/delivery` — the server-side Plane-3 delivery daemon, as a self-registering `deliver`
 * command. Importing this package registers `deliver` into the core `Registry`; the `cotal` binary
 * (composition root) pulls it in alongside `@cotal-ai/manager`. Structurally parallel to the manager:
 * a distinct long-lived infra role with its own scoped cred profile and lifecycle. It NEVER imports
 * `@cotal-ai/manager` or `@cotal-ai/cli` (one-way tiering).
 */
import { registry, type Command } from "@cotal-ai/core";
import { assertUninjectedCredsSharesCwdRoot, DELIVERY_CREDS_KIND, deliveryCredsKey, reloadStoreIdentityFromCredsPath, reloadStoreIdentityOf, runDelivery } from "./delivery.js";
import { runFeedbackIntake } from "./feedback-intake.js";
import { runPending } from "./pending.js";

const deliveryCommands: Command[] = [
  {
    kind: "command",
    name: "deliver",
    group: "Manager",
    summary:
      "run the delivery daemon — the server-side Plane-3 durable backstop [--space <s>] [--server <url>] [--creds <file>] (auth mode only; N=1); or `deliver pending <name>` to inspect a recipient's held DMs",
    positionals: "[pending <name> [--limit <n>] [--durable <name>]]",
    flags: [
      { name: "space", type: "string", value: "<s>", description: "space to serve (required; the scoped cred doesn't encode it)" },
      { name: "server", type: "string", value: "<url>", description: "broker URL (default: the broker recorded for --space, else the local mesh)" },
      { name: "tls", type: "boolean", description: "REQUIRE TLS to the broker - refuse to connect if it is not offered" },
      { name: "creds", type: "string", value: "<file>", description: "pre-minted scoped delivery cred, or (with `pending`) an admin cred" },
      { name: "shard", type: "string", value: "<n>", description: "shard index (N=1 only; non-zero is rejected)" },
      { name: "shards", type: "string", value: "<n>", description: "shard count (N=1 only; >1 is rejected)" },
      { name: "dev-mint", type: "boolean", description: "standalone dev: mint a scoped delivery cred from the local signer" },
      { name: "limit", type: "string", value: "<n>", description: "pending: max recent candidate ids to print (default 20)" },
      { name: "durable", type: "string", value: "<name>", description: "pending: read this exact DM durable (a live read's printed name) instead of resolving <name>" },
      { name: "json", type: "boolean", description: "pending: print the facts as one JSON object" },
    ],
    prepareMeshTarget: false,
    run: (args) => (args.positionals[0] === "pending" ? runPending(args) : runDelivery(args)),
  },
  {
    kind: "command",
    name: "feedback-intake",
    group: "Manager",
    summary:
      "run the self-hosted feedback intake server — --keys <keys.json> [--port <n>] [--store <file>]",
    flags: [
      { name: "host", type: "string", value: "<addr>", description: "bind address (default: 127.0.0.1)" },
      { name: "port", type: "string", value: "<n>", description: "listen port (default: 8787)" },
      { name: "keys", type: "string", value: "<file>", description: "feedback keys file (required) — { keys: [{ key, tester, name? }] }" },
      { name: "store", type: "string", value: "<file>", description: "append records here (default: .cotal/feedback/feedback.jsonl)" },
      { name: "space", type: "string", value: "<s>", description: "space to announce feedback into (default: beta-feedback)" },
      { name: "channel", type: "string", value: "<name>", description: "channel to multicast feedback to (default: feedback)" },
      { name: "server", type: "string", value: "<url>", description: "broker URL (default: the local mesh)" },
      { name: "creds", type: "string", value: "<file>", description: "scoped feedback-intake NATS cred (required)" },
      { name: "max-bytes", type: "string", value: "<n>", description: "max request body size in bytes (default: 65536)" },
      { name: "rate-limit", type: "string", value: "<n>", description: "max requests per tester per minute (default: 30)" },
    ],
    prepareMeshTarget: false,
    run: (args) => runFeedbackIntake(args),
  },
];

registry.register(...deliveryCommands);

export { assertUninjectedCredsSharesCwdRoot, DELIVERY_CREDS_KIND, deliveryCredsKey, reloadStoreIdentityFromCredsPath, reloadStoreIdentityOf, runDelivery };
export { runFeedbackIntake };
