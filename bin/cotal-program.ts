#!/usr/bin/env node
/** The generation-local Node preflight and CLI entry. Reached through the built-ins bootstrap. */
import { setFlagsFromString } from "node:v8";
import { ensureSupportedNode } from "./cotal.js";

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
  await import("./run.js");
}
