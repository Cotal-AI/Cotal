#!/usr/bin/env node
/**
 * Executable entry for the `cotal` CLI (published as `cotal-ai`): a Node-version preflight, then a
 * hand-off to the real composition root (./run.js) via dynamic import.
 *
 * Why this file exists separately: the CLI's UI stack (ink, @clack/prompts, string-width) and the
 * bundled `nats-server` optional dependency (@eplightning/nats-server-*) all require Node >= 22 —
 * and npm SILENTLY SKIPS an optional dependency whose `engines` the running Node doesn't satisfy,
 * so on an older Node the bundled broker is never installed at all. On top of that, string-width
 * uses a Node-20+ regex flag that is a hard parse error on older Node. An ESM entry parses its whole
 * static-import graph before its own body runs, so a version check inside ./run.ts would come too
 * late — it would crash while parsing string-width. This shim therefore keeps ZERO static imports
 * of that chain: the check runs first, and ./run.js is only pulled in (dynamically) once it passes.
 */
const MIN_NODE_MAJOR = 22;
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);

if (!Number.isInteger(nodeMajor) || nodeMajor < MIN_NODE_MAJOR) {
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
      `  nvm install ${MIN_NODE_MAJOR} && nvm use ${MIN_NODE_MAJOR}\n\n` +
      `If you already ran cotal once under the old Node, also clear the npx cache so the bundled\n` +
      `nats-server is fetched cleanly, then retry:\n` +
      `  rm -rf ~/.npm/_npx        # or: npx clear-npx-cache\n\n` +
      `Or let the installer manage the runtime for you:\n` +
      `  curl -fsSL https://get.cotal.ai | sh\n\n`;
  process.stderr.write(
    `\ncotal-ai requires Node.js >= ${MIN_NODE_MAJOR}, but this is ${process.version}.\n` +
      `The bundled nats-server broker (and the CLI's UI stack) need Node >= ${MIN_NODE_MAJOR}; on an\n` +
      `older Node, npm silently skips the broker binary and the CLI cannot start.\n\n` +
      remedy,
  );
  process.exit(1);
}

await import("./run.js");
