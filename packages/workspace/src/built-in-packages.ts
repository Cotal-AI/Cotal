import type { ExtensionRef } from "@cotal-ai/core";

/** Providers shipped and versioned with the CLI, not installed in the extension prefix. */
export const BUILT_IN_PACKAGES: Readonly<Record<string, readonly ExtensionRef[]>> = {
  "@cotal-ai/acp": [
    { kind: "command", name: "acp" },
    { kind: "client-setup", name: "t3" },
    { kind: "client-setup", name: "zed" },
  ],
  "@cotal-ai/linear": [
    { kind: "command", name: "linear" },
    { kind: "command", name: "__service-linear" },
    { kind: "local-process", name: "linear-service" },
    { kind: "service-preset", name: "linear" },
  ],
  "@cotal-ai/web": [
    { kind: "command", name: "__service-web" },
    { kind: "local-process", name: "web" },
    { kind: "local-process", name: "web-service" },
    { kind: "service-preset", name: "web" },
  ],
};
