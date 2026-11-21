/** Pause the CLI after it takes the startup lock but before it publishes the foreground hold.
 * The contender sees the real lock and an absent hold. The parent releases the atomic write. */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";

const rename = fs.renameSync;
fs.renameSync = (source, target) => {
  if (typeof target === "string" && basename(target) === "stack-foreground.hold") {
    fs.writeSync(2, "Ready to publish foreground hold\n");
    const tick = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 90_000;
    while (!fs.existsSync(`${target}.test-release`)) {
      if (Date.now() >= deadline) throw new Error("foreground hold pause expired");
      Atomics.wait(tick, 0, 0, 10);
    }
  }
  rename(source, target);
};
syncBuiltinESMExports();
