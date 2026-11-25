#!/usr/bin/env node
/** The generation-local Node preflight and CLI entry. Reached through the built-ins bootstrap. */
import { dirname, isAbsolute } from "node:path";
import { setFlagsFromString } from "node:v8";
import { ensureSupportedNode } from "./cotal.js";

// The updater probes this form. Leave usage and invalid-home diagnostics to the dispatcher.
async function runVersionFlag(): Promise<boolean> {
  if (process.argv.length !== 3 || (process.argv[2] !== "--version" && process.argv[2] !== "-V")) return false;
  const { c, cotalHomeProblem, stderrLine } = await import("@cotal-ai/workspace");
  const home = process.env.COTAL_HOME;
  if ((home && !isAbsolute(home)) || cotalHomeProblem()) return false;
  const { completeFileWrites, stdoutError } = await import("@cotal-ai/cli/dispatch");
  const { cliVersion, printVersion, readExtensionVersions } = await import("@cotal-ai/cli/version");
  (await import("./update-notice.js")).installUpdateNotice(process.argv.slice(2), cliVersion());
  const inventory = readExtensionVersions();
  if (inventory.unreadable !== undefined && !inventory.unreadableSelection) {
    stderrLine("✗ ", inventory.unreadable, c.red);
    process.exitCode = 1;
  } else {
    process.stdout.on("error", stdoutError);
    completeFileWrites();
    await (await import("./startup-interrupt.js")).releaseStartupInterrupt();
    printVersion(inventory.versions);
  }
  return true;
}

ensureSupportedNode();
setFlagsFromString("--no-maglev");
setFlagsFromString("--no-concurrent-sparkplug");
const emitWarning = process.emitWarning.bind(process) as (...args: unknown[]) => void;
process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
  if (warning !== "The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.") emitWarning(warning, ...rest);
}) as typeof process.emitWarning;
const bearerDone = process.argv[2] === "agent-bearer" && await (await import("@cotal-ai/auth/agent-bearer")).runAgentBearerEntry(process.argv.slice(3));
if (process.argv[2] === "__update-check") {
  await (await import("./update-notice.js")).updateCheckWorker();
} else if (!bearerDone) {
  const commandWord = process.argv.slice(2).find((word) => !word.startsWith("-"));
  if (!commandWord?.startsWith("__")) (await import("./startup-interrupt.js")).holdStartupInterrupt();
  const { executionIdentity } = await import("@cotal-ai/workspace");
  const identity = executionIdentity();
  if (identity && identity.logicalEntry === identity.loadedEntry) {
    const { retireSupersededExecutionDescriptor } = await import("./execution-transaction.js");
    retireSupersededExecutionDescriptor(dirname(dirname(identity.logicalEntry)));
  }
  if (!(await runVersionFlag())) await import("./run.js");
}
