#!/usr/bin/env node
/**
 * Executable entry for the `cotal` CLI (published as `cotal-ai`): a Node-version preflight, then a
 * hand-off to the real composition root (./run.js) via dynamic import.
 *
 * The floor is the one `engines.node` declares, 22.10, which is where `module.flushCompileCache()`
 * lands and therefore the oldest Node a connector's seat entry runs on. It is checked here, at the
 * front door, so the binary and the seats it installs agree on one version.
 *
 * Why this file exists separately: the CLI's UI stack (ink, @clack/prompts, string-width) and the
 * bundled `nats-server` optional dependency (@eplightning/nats-server-*) require Node >= 22 —
 * and npm SILENTLY SKIPS an optional dependency whose `engines` the running Node doesn't satisfy,
 * so on an older Node the bundled broker is never installed at all. On top of that, string-width
 * uses a Node-20+ regex flag that is a hard parse error on older Node. An ESM entry parses its whole
 * static-import graph before its own body runs, so a version check inside ./run.ts would come too
 * late — it would crash while parsing string-width. This shim therefore keeps ZERO static imports
 * of that chain: the check runs first, and ./run.js is only pulled in (dynamically) once it passes.
 */
import { setFlagsFromString } from "node:v8";

// Node 24 can hang forever in process.exit(), after the command has printed its result
// (nodejs/node#64274, #5498): exit joins V8's background threads, and a Maglev or background
// Sparkplug compile parked waiting for a garbage collection never finishes. Turning both off here,
// before the CLI loads, restores Node 22's defaults; cli-entry.smoke.ts checks that Maglev stays off.
// Every command, and every daemon this binary re-execs, starts here. Remove these once the supported
// Node releases carry the fix (nodejs/node#66171).
setFlagsFromString("--no-maglev");
setFlagsFromString("--no-concurrent-sparkplug");

const MIN_NODE = "22.10";
const [MIN_MAJOR, MIN_MINOR] = MIN_NODE.split(".").map(Number) as [number, number];
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map((part) => Number.parseInt(part ?? "", 10));

if (!Number.isInteger(nodeMajor) || !Number.isInteger(nodeMinor) || nodeMajor! < MIN_MAJOR ||
  (nodeMajor === MIN_MAJOR && nodeMinor! < MIN_MINOR)) {
  // How cotal was installed decides the fix, so say the one that applies. COTAL_LAUNCHER is set
  // by the launcher install.sh writes: that install pinned a Node, and reaching here means the
  // pinned Node was replaced with an older one, which re-running the installer repairs.
  const viaInstaller = process.env.COTAL_LAUNCHER === "1";
  const remedy = viaInstaller
    ? `The Node this install was pinned to has been replaced with an older one.\n` +
      `Re-run the installer to repin it:\n` +
      `  curl -fsSL https://get.cotal.ai | sh\n\n` +
      `Or stop depending on the system Node altogether:\n` +
      `  curl -fsSL https://get.cotal.ai | sh -s -- --vendor-node\n\n`
    : `Install a newer Node (https://nodejs.org). With nvm:\n` +
      `  nvm install ${MIN_NODE} && nvm use ${MIN_NODE}\n\n` +
      `If you already ran cotal once under the old Node, also clear the npx cache so the bundled\n` +
      `nats-server is fetched cleanly, then retry:\n` +
      `  rm -rf ~/.npm/_npx        # or: npx clear-npx-cache\n\n` +
      `Or let the installer manage the runtime for you:\n` +
      `  curl -fsSL https://get.cotal.ai | sh\n\n`;
  process.stderr.write(
    `\ncotal-ai requires Node.js >= ${MIN_NODE}, but this is ${process.version}.\n` +
      `Below Node ${MIN_MAJOR}, npm silently skips the bundled nats-server broker and the CLI's UI\n` +
      `stack cannot parse. Below ${MIN_NODE}, Node has no module compile cache and a seat refuses to\n` +
      `start.\n\n` +
      remedy,
  );
  // A delegated seat's spawn takes its handoff file, which holds its actor token, before anything
  // else on a supported Node, so this refusal must not leave it on disk either. Any other command
  // leaves the file. The leading global flags take no value, so the first other word is the command.
  // Unlink only, never read.
  const { unlinkSync } = await import("node:fs");
  const command = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
  for (const [key, path] of Object.entries(process.env)) {
    if (key.toUpperCase() !== "COTAL_MANAGED_HANDOFF_FILE" || !path || (command !== "spawn" && command !== "sp")) continue;
    try {
      unlinkSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        process.stderr.write(`cannot remove the managed handoff file: ${(e as Error).message}\n`);
    }
  }
  process.exit(1);
}

// Node warns once, as it loads its own color helpers, when FORCE_COLOR and NO_COLOR are both set.
// The CLI resolves that pair itself (`cotal config` shows FORCE_COLOR winning and NO_COLOR
// outranked), so that one runtime warning is dropped before anything loads. Every other warning
// still prints.
const emitWarning = process.emitWarning.bind(process) as (...args: unknown[]) => void;
process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
  if (warning !== "The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.") emitWarning(warning, ...rest);
}) as typeof process.emitWarning;

// A spawned seat execs `cotal agent-bearer` for every bearer, so it runs from its own module before
// the rest of the CLI loads: loading the whole command surface was most of each bearer's cost. A
// command line that does not parse goes on to the full CLI, which refuses it with the command's help.
const bearerDone = process.argv[2] === "agent-bearer" && await (await import("@cotal-ai/auth/agent-bearer")).runAgentBearerEntry(process.argv.slice(3));
if (!bearerDone) {
  // The notice holds until the command begins, or until the command's own notice takes it over. An
  // internal entry, such as a stack member or shell completion, keeps Node's default signal exit.
  // Every word before the command word is a flag.
  const commandWord = process.argv.slice(2).find((word) => !word.startsWith("-"));
  if (!commandWord?.startsWith("__")) (await import("./startup-interrupt.js")).holdStartupInterrupt();
  await import("./run.js");
}
