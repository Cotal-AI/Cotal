#!/usr/bin/env node
// Installed outside npm's package tree. Keep this file self-contained: npm retires the whole
// cotal-ai directory and its declared executable links before unpacking the new release.
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

// The package copy is npm's sole binary, so npx works without a global install script. The stable
// copy lives at <node_modules>/.cotal-launcher/launcher.cjs, beside the package being replaced.
const entry = existsSync(join(__dirname, "package.json"))
  ? join(__dirname, "dist", "cotal.js")
  : join(__dirname, "..", "cotal-ai", "dist", "cotal.js");
const args = process.argv.slice(2);
process.argv[1] = entry;
const started = Date.now();
const signals = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
let child;
let interrupted = false;

// Only the recovery path adds a supervising process. Ordinary launches keep their PID, terminal,
// IPC channel and signal behavior. A fresh process avoids reusing a failed ESM module cache.
function retry() {
  const ipc = typeof process.send === "function";
  const program = `
    const { writeSync } = await import('node:fs');
    process.argv = [process.execPath, ${JSON.stringify(entry)}, ...process.argv.slice(1)];
    process.execArgv = [];
    try { await import(${JSON.stringify(pathToFileURL(entry).href)}); }
    catch (error) {
      if (!globalThis[Symbol.for('cotal.command-started')] &&
          ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ENOENT'].includes(error?.code)) {
        writeSync(3, 'retry');
        process.exit(75);
      }
      throw error;
    }
  `;
  child = spawn(process.execPath, ["--input-type=module", "--eval", program, "--", ...args], {
    stdio: ["inherit", "inherit", "inherit", "pipe", ...(ipc ? ["ipc"] : [])],
    windowsHide: true,
  });
  let receipt = "";
  child.stdio[3].on("data", (data) => { receipt += data; });
  if (ipc) child.on("message", (message) => { if (process.connected) process.send(message, () => {}); });
  child.once("error", (error) => {
    process.stderr.write(`cotal: could not start Node: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once("close", (code, signal) => {
    child = undefined;
    // An ordinary command's exit 75 or missing-module exception is never a retry receipt.
    if (!interrupted && code === 75 && receipt === "retry") { scheduleRetry(); return; }
    process.exit(code ?? signals[signal] ?? 1);
  });
}

function scheduleRetry() {
  if (Date.now() - started < 120_000) { setTimeout(retry, 100); return; }
  process.stderr.write("cotal: the npm installation is still incomplete after 120 seconds. Finish or repair the installation, then retry.\n");
  process.exit(1);
}

import(pathToFileURL(entry).href).catch((error) => {
  if (globalThis[Symbol.for("cotal.command-started")] ||
      !["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ENOENT"].includes(error?.code)) throw error;
  for (const [signal, code] of Object.entries(signals)) process.on(signal, () => {
    interrupted = true;
    if (child) child.kill(signal);
    else process.exit(code);
  });
  process.on("message", (message) => { if (child?.connected) child.send(message, () => {}); });
  process.on("disconnect", () => { if (child?.connected) child.disconnect(); });
  scheduleRetry();
});
