/** Pause only the requested private record write: after the first startup lock is written or
 * before the foreground hold is published. The contender sees a real lock and no hold. */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const path = process.env.COTAL_SMOKE_STARTUP_PAUSE_PATH;
if (!path) throw new Error("foreground startup pause requires the private record path");
const release = `${path}.test-release`;
function pause(): void {
  fs.writeSync(2, "Foreground startup paused\n");
  const tick = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 240_000;
  while (!fs.existsSync(release)) {
    if (Date.now() >= deadline) throw new Error("foreground startup pause expired");
    Atomics.wait(tick, 0, 0, 10);
  }
}

const open = fs.openSync;
let lockFd: number | undefined;
fs.openSync = (file, flags, mode) => {
  const fd = open(file, flags, mode);
  if (file === path && typeof flags === "number" && (flags & fs.constants.O_EXCL) !== 0) lockFd = fd;
  return fd;
};
const fsync = fs.fsyncSync;
fs.fsyncSync = (fd) => {
  fsync(fd);
  if (fd === lockFd) { lockFd = undefined; pause(); }
};
const rename = fs.renameSync;
fs.renameSync = (source, target) => {
  if (target === path) pause();
  rename(source, target);
};
syncBuiltinESMExports();
