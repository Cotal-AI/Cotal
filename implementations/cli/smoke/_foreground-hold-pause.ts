/** Pause the CLI after it takes the startup lock but before it publishes the foreground hold.
 * The contender sees the real lock and an absent hold. A byte on stdin resumes the atomic write. */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";

const rename = fs.renameSync;
fs.renameSync = (source, target) => {
  if (typeof target === "string" && basename(target) === "stack-foreground.hold") {
    fs.writeSync(2, "Ready to publish foreground hold\n");
    if (fs.readSync(0, Buffer.alloc(1)) !== 1) throw new Error("foreground hold was not released by the smoke");
  }
  rename(source, target);
};
syncBuiltinESMExports();
