// Keep the host process census out of the isolated npm updater test. All registry,
// archive verification, installation and reconciliation use the shipped implementation.
import { registry } from "@cotal-ai/core";
import { runCli } from "@cotal-ai/cli";
import { updateRuntime } from "@cotal-ai/cli/update";
updateRuntime.reportRunningManager = async () => "none";
await runCli(registry, process.argv.slice(2));
