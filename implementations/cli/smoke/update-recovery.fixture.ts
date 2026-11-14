import "../src/index.js";
import { registry } from "@cotal-ai/core";
import { runCli } from "../src/command.js";
import { updateRuntime } from "../src/commands/update.js";
import { join } from "node:path";

Object.assign(updateRuntime, {
  env: process.env,
  version: () => "0.164.6",
  now: () => Number(process.env.RECOVERY_TEST_NOW ?? Date.now()),
  ...(process.env.RECOVERY_TEST_LOOKUP_FAILURE ? { recoveryOwnerStart: () => { throw new Error("process identity access denied"); } } : {}),
  isCurrent: () => false,
  preflightReplacement: async () => {},
  reconcile: async () => { console.log("ordinary reconciliation completed"); },
  refreshConnectors: async () => [],
  reportRunningManager: async () => "none",
  extensions: () => [],
  installPrefix: () => undefined,
  npm: (args: string[]) => ({ status: 0, stderr: "", stdout: args[0] === "root" ? join(process.env.HOME!, "prefix/lib/node_modules") : args[0] === "view" && args[2] === "--json" ? JSON.stringify({ name: "cotal-ai", version: "0.13.1", dist: { tarball: "https://registry.example/cotal.tgz", integrity: "sha512-fixture" } }) : '"0.164.6"' }),
  claimGlobalUpdate: () => () => {},
  spawnGlobal: async () => ({ status: 0, stdout: "", stderr: "" }),
  verifyGlobalEntry: () => join(process.env.HOME!, "prefix/lib/node_modules/cotal-ai/dist/cotal.js"),
});
await runCli(registry, process.argv.slice(2));
