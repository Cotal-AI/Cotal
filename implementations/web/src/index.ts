import { registry, type Command } from "@cotal-ai/core";
import { targetFlags } from "@cotal-ai/workspace";
import { web } from "./web.js";

/**
 * `cotal-web` — the browser observability dashboard as an operator-installed CLI extension:
 * `cotal ext add cotal-web` makes `cotal web` appear in help/completion/dispatch. Self-registers
 * into the shared core Registry on import (the extension contract); shared @cotal-ai/* packages
 * are peerDependencies, linked to the running binary's copies by `ext add`.
 */
const webCommand: Command = {
  kind: "command",
  name: "web",
  group: "Observe",
  summary: "browser observability dashboard — presence, channels, live feed",
  flags: [
    ...targetFlags,
    { name: "port", type: "string", value: "<n>", description: "HTTP port (default 7799)" },
    { name: "no-open", type: "boolean", description: "don't open the browser" },
  ],
  run: web,
};
registry.register(webCommand);
