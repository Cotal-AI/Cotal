/**
 * Which nats-server a broker start runs. A nats-server on PATH in a folder every local account can
 * write fails the rule a broker launch applies to its executable, as one in a group-writable
 * Homebrew Cellar does on macOS. It gives way to the bundled nats-server, is never run, and the
 * selection names it with the reason. Once its folder is protected, the one on PATH is the choice
 * again. The stand-in on PATH is a shell script that leaves a mark when it runs. Broker-free.
 *
 * Run: pnpm smoke:broker-selection
 */
import { strict as nodeAssert } from "node:assert";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countedAssert, emitSentinel, skipSuite } from "@cotal-ai/smoke-kit";
import { protectedLocalEntry } from "@cotal-ai/workspace";
import { findNatsServer, natsServerLabel } from "../src/lib/nats-bin.js";

if (process.platform === "win32") skipSuite("the executable protection rule is POSIX-only");
const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;

const base = realpathSync(mkdtempSync(join(tmpdir(), "cotal-broker-selection-")));
const priorPath = process.env.PATH;
try {
  const bin = join(base, "bin"), mark = join(base, "ran");
  mkdirSync(bin, { mode: 0o755 });
  const script = join(bin, "nats-server");
  writeFileSync(script, `#!/bin/sh\n: > '${mark}'\necho 'nats-server: v2.14.0'\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${priorPath ?? ""}`;

  chmodSync(bin, 0o777);
  const skipping = await findNatsServer();
  assert.equal(skipping.source, "bundled", "a nats-server on PATH in a folder every account can write gives way to the bundled one");
  assert.notEqual(skipping.path, script, "the bundled one is the path chosen");
  assert.doesNotThrow(() => protectedLocalEntry(realpathSync(skipping.path), "the bundled nats-server"), "and that path passes the rule the PATH one failed");
  assert.equal(skipping.skipped?.path, script, "the one passed over is named");
  assert.match(skipping.skipped?.reason ?? "", new RegExp(`^the nats-server on PATH is not protected against other local writers: ${bin} is writable by every local account`), "with the reason the launch would refuse it");
  assert.equal(existsSync(mark), false, "the one passed over is never run");
  assert.equal(natsServerLabel(skipping), `${natsServerLabel({ ...skipping, skipped: undefined })}; the one on PATH at ${script} is not protected against other local writers, so it was not used`, "its label says the PATH one was not used");

  chmodSync(bin, 0o755);
  const onPath = await findNatsServer();
  assert.deepEqual({ ...onPath }, { path: script, source: "path", version: "2.14.0" }, "a protected nats-server on PATH is still the choice, with nothing skipped");
  assert.equal(existsSync(mark), true, "and it is the one run for its version");
} finally {
  process.env.PATH = priorPath;
  try { chmodSync(join(base, "bin"), 0o700); } catch { /* already gone */ }
  rmSync(base, { recursive: true, force: true });
}

console.log("broker-selection smoke: OK - an unprotected nats-server on PATH gives way to the bundled one and is never run; a protected one is still chosen");
emitSentinel({ passed: counted.cells(), failed: 0 });
