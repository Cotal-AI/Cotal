import "../src/index.js";
import { registry } from "@cotal-ai/core";
import { runCli } from "../src/command.js";
import { recoverInterruptedUpdate, updateRuntime } from "../src/commands/update.js";
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
  spawnGlobal: async (_root: string, operation: string) => { console.log(`recovery operation: ${operation}`); return { status: process.env.RECOVERY_TEST_RESTORE_FAIL ? 42 : 0, stdout: "", stderr: "restore fixture failure" }; },
  verifyGlobalEntry: () => process.env.RECOVERY_TEST_COMPLETED_ROLLBACK ? process.argv[1]! : join(process.env.HOME!, "prefix/lib/node_modules/cotal-ai/dist/cotal.js"),
});
if (process.env.RECOVERY_TEST_STARTUP) {
  const restored = await recoverInterruptedUpdate(updateRuntime, true);
  console.log(`startup restored: ${restored}`);
} else await runCli(registry, process.argv.slice(2));
