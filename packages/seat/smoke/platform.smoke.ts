/**
 * Platform loud-fail for custody transport. Linux is the production transport.
 * Other platforms must throw the named error and print a completion banner.
 * No top-of-file skip. References #1297.
 */
import { unsupportedTransport } from "../src/protocol.js";

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, detail?: unknown): void => {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
    return;
  }
  fail++;
  console.log(`  ✗ FAIL: ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
};

const err = unsupportedTransport("darwin");
check(
  "darwin throws custody transport unsupported on darwin",
  err instanceof Error && err.message === "custody transport unsupported on darwin",
  err.message,
);
const win = unsupportedTransport("win32");
check(
  "win32 throws custody transport unsupported on win32",
  win instanceof Error && win.message === "custody transport unsupported on win32",
  win.message,
);
const linux = unsupportedTransport("linux");
check(
  "named error is still formed for linux so the helper never silently no-ops",
  linux.message === "custody transport unsupported on linux",
);

if (process.platform !== "linux") {
  const { launchSeat } = await import("../src/launcher.js");
  let threw = "";
  try {
    launchSeat({
      root: "/tmp/cotal-seat-should-not-exist",
      name: "nope",
      spec: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      cwd: process.cwd(),
    });
  } catch (e) {
    threw = (e as Error).message;
  }
  check(
    `launchSeat throws custody transport unsupported on ${process.platform}`,
    threw === `custody transport unsupported on ${process.platform}`,
    threw,
  );
}

console.log(`\nSEAT PLATFORM ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
if (process.platform !== "linux") {
  console.log(`SEAT PLATFORM COMPLETE on ${process.platform}: custody transport unsupported (no skip-as-pass)`);
}
process.exitCode = fail === 0 ? 0 : 1;
