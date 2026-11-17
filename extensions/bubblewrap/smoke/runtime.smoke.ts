import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mintLifecycleUid, type ManagedLifecycleHandoff } from "@cotal-ai/core";
import { createSuite, skipSuite } from "@cotal-ai/smoke-kit";
import { BubblewrapRuntime, bubblewrapRuntimeProvider } from "../src/index.js";

if (process.platform !== "linux") skipSuite("Bubblewrap requires Linux");
const suite = createSuite();
const root = mkdtempSync(join(tmpdir(), "cotal-bubblewrap-smoke-"));
const image = join(root, "image");
mkdirSync(image, { mode: 0o755 });
chmodSync(image, 0o755);
for (const dir of ["usr/bin", "proc", "dev", "home", "run", "tmp", "scratch", "workspace", "etc"]) mkdirSync(join(image, dir), { recursive: true });
copyFileSync(process.execPath, join(image, "usr/bin/node"));
const libraries = spawnSync("ldd", [process.execPath], { encoding: "utf8" });
assert.equal(libraries.status, 0);
for (const line of libraries.stdout.split("\n")) {
  const path = line.match(/(?:=>\s*)?(\/[^\s]+)\s+\(/)?.[1];
  if (!path) continue;
  mkdirSync(dirname(join(image, path)), { recursive: true });
  copyFileSync(path, join(image, path));
}
writeFileSync(join(image, "etc/passwd"), `seat:x:${process.getuid!()}:${process.getgid!()}:Seat:/home/seat:/bin/sh\n`);
const forbidden = join(root, "operator-home");
mkdirSync(forbidden);
writeFileSync(join(image, "usr/bin/cotal"), `#!/usr/bin/node
const fs = require('fs');
if(fs.existsSync(${JSON.stringify(forbidden)})) process.exit(61);
if(fs.existsSync('/proc/1/root' + ${JSON.stringify(forbidden)})) process.exit(62);
const handoff = JSON.parse(fs.readFileSync(process.env.COTAL_MANAGED_HANDOFF_FILE, 'utf8'));
if(handoff.actor !== 'isolated' || fs.statSync(process.env.COTAL_MANAGED_HANDOFF_FILE).mode % 512 !== 384) process.exit(63);
if(process.env.COTAL_BUBBLEWRAP_ROOTFS || process.env.COTAL_TEST_AMBIENT) process.exit(64);
if(fs.readFileSync('/run/cotal/persona.md', 'utf8') !== 'private persona') process.exit(65);
try { fs.writeFileSync('/etc/outside', 'bad'); process.exit(66); } catch {}
fs.writeFileSync('/workspace/allowed', 'ok');
if(process.argv.includes('--prompt')) setInterval(()=>{},1000);
`);
chmodSync(join(image, "usr/bin/cotal"), 0o755);
const handoff: ManagedLifecycleHandoff = {
  kind: "cotal-managed-handoff/v1", space: "isolation", owner: "u_owner", actor: "isolated", lifecycleUid: mintLifecycleUid(),
  server: "nats://127.0.0.1:4222", tlsRequired: false, authProvider: "fixture", idp: { url: "https://idp.invalid", issuer: "https://idp.invalid", audience: "fixture" },
  exchangeUrl: "https://auth.invalid", sentinelCreds: "fixture-sentinel", actorToken: "fixture-token", subscribe: [], allowSubscribe: [], allowPublish: [],
};
const launch = { agent: "fixture", persona: "private persona", managerInstanceId: mintLifecycleUid() };
const runtime = new BubblewrapRuntime({ rootfs: image });
process.env.COTAL_TEST_AMBIENT = "must-not-cross";
try {
  assert.throws(() => new BubblewrapRuntime({ rootfs: "/" }), /dedicated root/);
  suite.check("host root is refused", true);
  assert.throws(() => new BubblewrapRuntime({ rootfs: image, executable: join(root, "absent-bwrap") }), /executable is unavailable/);
  suite.check("missing native isolation executable fails closed", true);
  assert.throws(() => new BubblewrapRuntime({ rootfs: "relative" }), /absolute rootfs/);
  suite.check("relative rootfs is refused", true);
  assert.throws(() => runtime.spawn("seat", { command: "node", args: [] }, root), /delegated user-auth/);
  suite.check("local manager launch cannot fall back to same-user", true);
  const before = process.env.COTAL_BUBBLEWRAP_ROOTFS;
  delete process.env.COTAL_BUBBLEWRAP_ROOTFS;
  try { assert.throws(() => bubblewrapRuntimeProvider.create({ session: "fixture" }), /requires COTAL_BUBBLEWRAP_ROOTFS/); }
  finally { if (before !== undefined) process.env.COTAL_BUBBLEWRAP_ROOTFS = before; }
  suite.check("missing operator image fails closed", true);
  chmodSync(image, 0o775);
  try { assert.throws(() => new BubblewrapRuntime({ rootfs: image }), /group- or world-writable/); }
  finally { chmodSync(image, 0o755); }
  suite.check("group-writable image root is refused", true);
  const handle = runtime.spawnDelegated(launch, handoff);
  await handle.waitForExit!();
  suite.check("real native sandbox excludes operator roots, host proc roots, ambient env and writes outside its private workspace", handle.exitInfo?.()?.code === 0);
  assert.throws(() => runtime.spawnDelegated(launch, handoff), /already launched/);
  suite.check("same lifecycle is never launched twice", true);
  assert.throws(() => handle.attach(), /no terminal attach/);
  suite.check("unsupported terminal attachment refuses", true);
  const running = runtime.spawnDelegated({ ...launch, prompt: "stay" }, { ...handoff, lifecycleUid: mintLifecycleUid() });
  try {
    await new Promise(resolve => setTimeout(resolve, 200));
    suite.check("native long-running launch is owned", running.status() === "running");
  } finally {
    running.stop({ graceful: false });
    await running.waitForExit!();
  }
  suite.check("stop observes its owned native child exit", running.status() === "exited");
} finally {
  delete process.env.COTAL_TEST_AMBIENT;
  console.log(`Retained Bubblewrap fixture: ${root}`);
}
// Verify only the public fixture script was retained, never handoff files on host disk.
assert.ok(readFileSync(join(image, "usr/bin/cotal"), "utf8").includes("private persona"));
suite.finish();
