import { spawn } from "node:child_process";

const [stub, ...args] = process.argv.slice(2);
if (!stub) throw new Error("orphan-seat wrapper requires a stub path");

const child = spawn(process.execPath, [stub, ...args], {
  env: process.env,
  stdio: "ignore",
});

const stop = (signal) => {
  if (child.exitCode === null) child.kill(signal);
  process.exit(0);
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

// The wrapper is the runtime handle. Delivery-admin may terminate the stub's broker connection,
// but the independently owned OS process stays alive until the exact owned process group is cleaned.
setInterval(() => {}, 1 << 30);
