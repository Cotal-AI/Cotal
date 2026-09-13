/**
 * Preload for the between-check-and-write interleave (see secret-fs.smoke.ts).
 *
 * A userspace `if (exists) throw; write()` REFUSES an already-taken name exactly as `O_EXCL` does,
 * so no in-process cell can tell them apart: both raise EEXIST. The difference only shows when a
 * competitor takes the name AFTER the check has passed and BEFORE the write runs. A race can reach
 * that window only by luck (measured: the previous N-process cell let that mutant escape roughly 1
 * run in 6, and it failed toward GREEN). This lands the competitor in the window deterministically.
 *
 * `--require` runs before the module graph loads, so patching `fs` here reaches the binding that
 * `secret-fs.js` closes over. It fires exactly once, only for the one path under test, and then
 * restores itself, so nothing else in the process is affected.
 */
const fs = require("node:fs");

const target = process.env.COTAL_SECRETFS_INTERLEAVE_TARGET;
if (target) {
  const realWrite = fs.writeFileSync;
  let armed = true;
  fs.writeFileSync = function patched(path, data, options) {
    if (armed && path === target) {
      armed = false;
      fs.writeFileSync = realWrite; // one shot: the rest of the process sees the real function
      // The competitor wins the name in the window a check-then-write has already walked past.
      realWrite(target, "incumbent\n", { mode: 0o600 });
    }
    return realWrite.call(this, path, data, options);
  };
}
