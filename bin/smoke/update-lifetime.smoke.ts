import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveDaemon } from "../daemon/server.js";
import { processBirth, holdLifetime } from "../daemon/lifetime.js";
import { observeUpdateDaemon, sameUpdateDaemon } from "../daemon/update-lifetime.js";

const root = mkdtempSync(join(tmpdir(), "update-lifetime-"));
const dir = join(root, "r"), state = join(root, "s");
for (const path of [dir, state]) mkdirSync(path, { mode: 0o700 });
const paths = { dir, state, socket: join(dir, "d.sock"), lock: join(state, "daemon.lock") };
assert.equal(await observeUpdateDaemon(paths), undefined, "missing endpoint and lifetime record prove absence");
const daemon = await serveDaemon({ paths, version: "0.0.0-lifetime", sessionDir: state, stopAllowed: async () => false });
try {
  const before = { ...daemon.counters };
  const identity = await observeUpdateDaemon(paths);
  assert.deepEqual(identity, { pid: process.pid, start: processBirth(process.pid) });
  assert.equal(daemon.counters.statusAnswered, before.statusAnswered, "identity-only connection sends no status or Manager request");
  assert.equal(sameUpdateDaemon(identity, { ...identity!, start: "changed" }), false);
  assert.equal(sameUpdateDaemon(identity, undefined), false);
  assert.equal(sameUpdateDaemon(undefined, identity), false);
  assert.equal(sameUpdateDaemon(identity, identity), true);
} finally { await daemon.close(); }
assert.equal(await observeUpdateDaemon(paths), undefined, "released empty lifetime is absent");
writeFileSync(paths.lock, "malformed", { mode: 0o600 });
await assert.rejects(observeUpdateDaemon(paths), /identity is unreadable/);
writeFileSync(paths.lock, "", { mode: 0o600 });
const held = holdLifetime(paths.lock);
try { await assert.rejects(observeUpdateDaemon(paths), /held/); }
finally { held.release(); }
console.log("update lifetime: real native peer identity without status, positive absence, malformed identity and held unpublished lifetime passed");
console.log(`Retained update lifetime fixture: ${root}`);
