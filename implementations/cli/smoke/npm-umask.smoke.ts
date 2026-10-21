/**
 * npm children start under a umask with 022 added. Under a umask of 0002, npm makes group-writable
 * directories, files and bin targets, and its own `--umask` setting leaves package directories and
 * bin targets group-writable, so the CLI sets the process umask around each npm spawn and restores
 * it when the spawn call returns. A stub npm records the umask it starts with. Broker-free; the
 * extension prefix is private to this run.
 *
 * Run: pnpm smoke:npm-umask
 */
import { strict as nodeAssert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { countedAssert, emitSentinel, skipSuite } from "@cotal-ai/smoke-kit";
import { claimExtensionUpdatePass, extensionsDir } from "@cotal-ai/workspace";
import { EXT_UPDATE_PARENT_ENV } from "../src/commands/ext.js";
import { withInstallUmask } from "../src/lib/install-umask.js";

if (process.platform === "win32") skipSuite("umask is POSIX-only");
const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;

const root = mkdtempSync(join(tmpdir(), "cotal-npm-umask-"));
const fakeBin = join(root, "bin");
const recorded = join(root, "npm-umask");
mkdirSync(fakeBin);
// One line per npm child, so an install and its rollback remove are both checked.
writeFileSync(join(fakeBin, "npm"), '#!/bin/sh\numask >> "$FAKE_NPM_UMASK"\nexit 1\n');
chmodSync(join(fakeBin, "npm"), 0o755);
const env = { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`, FAKE_NPM_UMASK: recorded };
/** The umask of each recorded npm child, then a fresh record. */
function recordedUmasks(): number[] {
  const masks = existsSync(recorded) ? readFileSync(recorded, "utf8").split("\n").filter(Boolean).map((line) => parseInt(line.trim(), 8)) : [];
  rmSync(recorded, { force: true });
  return masks;
}
const stub = () => spawnSync(join(fakeBin, "npm"), [], { env });

const prior = process.umask(0o002);
const priorXdg = process.env.XDG_CONFIG_HOME;
let releasePass: (() => void) | undefined;
try {
  // 1. The helper itself, from a parent umask of 0002.
  withInstallUmask(stub);
  assert.deepEqual(recordedUmasks(), [0o022], "npm starts under 022 from a parent umask of 0002");
  assert.equal(process.umask(0o002), 0o002, "the parent's umask is back once the spawn returns");
  stub();
  assert.deepEqual(recordedUmasks(), [0o002], "a spawn outside the helper still inherits 0002, so the stub reads the real umask");
  process.umask(0o077);
  withInstallUmask(stub);
  assert.deepEqual(recordedUmasks(), [0o077], "a stricter parent umask keeps its bits");
  assert.equal(process.umask(0o002), 0o077, "the stricter umask is restored");
  assert.throws(() => withInstallUmask(() => { throw new Error("spawn refused"); }), /spawn refused/, "a failed spawn propagates");
  assert.equal(process.umask(0o002), 0o002, "a failed spawn still restores the umask");

  // 2. The real `ext __update-add` path, started under 0002: every npm child it runs starts under
  //    022, and the extension prefix it creates is not group-writable.
  const xdg = join(root, "xdg");
  const fixture = join(root, "fixture");
  const pkg = "@cotal-ai/umask-smoke";
  mkdirSync(fixture);
  writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: pkg, version: "1.0.0", type: "module", peerDependencies: { "@cotal-ai/core": "*" } }));
  process.env.XDG_CONFIG_HOME = xdg;
  releasePass = claimExtensionUpdatePass();
  const cli = join(import.meta.dirname, "..", "..", "..", "bin", "cotal.ts");
  const add = spawnSync(
    process.execPath,
    [...process.execArgv, cli, "ext", "__update-add", pkg, fixture],
    { env: { ...env, XDG_CONFIG_HOME: xdg, COTAL_SKIP_CONNECTOR_SEED: "1", [EXT_UPDATE_PARENT_ENV]: String(process.pid) }, encoding: "utf8", timeout: 30_000 },
  );
  assert.notEqual(add.status, 0, `the stub npm fails the add: ${add.stderr}`);
  const masks = recordedUmasks();
  assert.ok(masks.length >= 1, `the add reached npm: ${add.stderr}`);
  assert.deepEqual(masks, masks.map(() => 0o022), "every npm child of ext add starts under 022");
  assert.equal(statSync(extensionsDir()).mode & 0o777, 0o755, "the extension prefix is created 0755 under a umask of 0002");
  assert.equal(statSync(join(extensionsDir(), "package.json")).mode & 0o777, 0o644, "the prefix package.json is created 0644 under a umask of 0002");
} finally {
  releasePass?.();
  process.umask(prior);
  if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = priorXdg;
  rmSync(root, { recursive: true, force: true });
}

console.log("npm-umask smoke: OK - npm children start under 022 from a parent umask of 0002, a stricter umask keeps its bits, the parent's umask is restored, and ext add's npm children, prefix and prefix package.json are not group-writable");
emitSentinel({ passed: cells(), failed: 0 });
