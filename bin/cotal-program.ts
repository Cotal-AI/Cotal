#!/usr/bin/env node
/** The generation-local Node preflight and CLI entry. Reached through the built-ins bootstrap. */
import { setFlagsFromString } from "node:v8";

setFlagsFromString("--no-maglev");
setFlagsFromString("--no-concurrent-sparkplug");
const MIN_NODE = "22.10";
const [MIN_MAJOR, MIN_MINOR] = MIN_NODE.split(".").map(Number) as [number, number];
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map((part) => Number.parseInt(part ?? "", 10));
if (!Number.isInteger(nodeMajor) || !Number.isInteger(nodeMinor) || nodeMajor! < MIN_MAJOR ||
  (nodeMajor === MIN_MAJOR && nodeMinor! < MIN_MINOR)) {
  const viaInstaller = process.env.COTAL_LAUNCHER === "1";
  const remedy = viaInstaller
    ? `The Node this install was pinned to has been replaced with an older one.\n` +
      `Re-run the installer to repin it:\n  curl -fsSL https://get.cotal.ai | sh\n\n` +
      `Or stop depending on the system Node altogether:\n  curl -fsSL https://get.cotal.ai | sh -s -- --vendor-node\n\n`
    : `Install a newer Node (https://nodejs.org). With nvm:\n  nvm install ${MIN_NODE} && nvm use ${MIN_NODE}\n\n` +
      `If you already ran cotal once under the old Node, also clear the npx cache so the bundled\n` +
      `nats-server is fetched cleanly, then retry:\n  rm -rf ~/.npm/_npx        # or: npx clear-npx-cache\n\n` +
      `Or let the installer manage the runtime for you:\n  curl -fsSL https://get.cotal.ai | sh\n\n`;
  process.stderr.write(`\ncotal-ai requires Node.js >= ${MIN_NODE}, but this is ${process.version}.\n` +
    `Below Node ${MIN_MAJOR}, npm silently skips the bundled nats-server broker and the CLI's UI\n` +
    `stack cannot parse. Below ${MIN_NODE}, Node has no module compile cache and a seat refuses to\nstart.\n\n` + remedy);
  const { unlinkSync } = await import("node:fs");
  const command = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
  for (const [key, path] of Object.entries(process.env)) {
    if (key.toUpperCase() !== "COTAL_MANAGED_HANDOFF_FILE" || !path || (command !== "spawn" && command !== "sp")) continue;
    try { unlinkSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") process.stderr.write(`cannot remove the managed handoff file: ${(error as Error).message}\n`);
    }
  }
  process.exit(1);
}
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
