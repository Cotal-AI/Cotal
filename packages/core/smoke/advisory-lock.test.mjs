import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { acquireLock, acquireLockAsync, inspectLock } from "../dist/index.js";

// Count real filesystem operations at the same built entrypoints consumers use.
// Hooks replace only this test's canonical file at the sentinel publication boundary.
test("lock inspection pins each verdict to one owner read", async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), "cotal-lock-snapshot-"));
  const path = join(root, "owner.lock");
  const sentinel = `${path}.reclaim`;
  const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  assert.equal(child.status, 0);
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  const stale = { pid: child.pid, nonce: "dead-owner", ts: Date.now() };
  const active = { pid: process.pid, nonce: "live-owner", ts: Date.now() };
  const original = { read: fs.readFileSync, stat: fs.statSync, link: fs.linkSync };
  let counts;
  let onSentinel;
  const reset = () => {
    counts = { before: { read: 0, stat: 0 }, under: { read: 0, stat: 0 }, claims: 0 };
    onSentinel = undefined;
  };
  const count = (operation, file) => {
    if (file === path) counts[fs.existsSync(sentinel) ? "under" : "before"][operation]++;
  };
  const write = (record) => fs.writeFileSync(path, JSON.stringify(record));
  const replace = (record) => {
    const next = join(root, "next.lock");
    fs.writeFileSync(next, JSON.stringify(record));
    fs.renameSync(next, path);
  };
  const clean = () => {
    fs.rmSync(path, { force: true });
    fs.rmSync(sentinel, { force: true });
    reset();
  };
  reset();
  mock.method(fs, "readFileSync", function (file, ...args) {
    count("read", file);
    return original.read.call(this, file, ...args);
  });
  mock.method(fs, "statSync", function (file, ...args) {
    count("stat", file);
    return original.stat.call(this, file, ...args);
  });
  mock.method(fs, "linkSync", function (source, destination) {
    const result = original.link.call(this, source, destination);
    if (destination === sentinel) {
      counts.claims++;
      onSentinel?.();
    }
    return result;
  });
  syncBuiltinESMExports();
  try {
    await t.test("public inspection keeps absent, stale and active projections unchanged", () => {
      clean();
      assert.deepEqual(inspectLock(path), { state: "absent" });
      assert.deepEqual(counts.before, { read: 1, stat: 0 });
      for (const record of [stale, active, null, { pid: 0 }, "legacy"]) {
        write(record);
        reset();
        assert.deepEqual(inspectLock(path), record === active ? { state: "active", owner: active } : { state: "stale" });
        assert.deepEqual(counts.before, { read: 1, stat: 1 });
      }
    });

    for (const acquire of [acquireLock, acquireLockAsync]) {
      await t.test(`${acquire.name}: stale reclaim reads once before and once under the sentinel`, async () => {
        clean();
        write(stale);
        const held = await acquire(path, { waitMs: 0 });
        try {
          assert.deepEqual(counts, { before: { read: 1, stat: 1 }, under: { read: 1, stat: 1 }, claims: 1 });
          const owner = JSON.parse(original.read(path, "utf8"));
          assert.equal(owner.pid, process.pid);
          assert.equal(owner.nonce, held.nonce);
          assert.equal(fs.existsSync(sentinel), false);
        } finally { held.release(); }
        assert.equal(fs.existsSync(path), false);
        held.release();
      });

      await t.test(`${acquire.name}: uncontended acquisition does not inspect the path`, async () => {
        clean();
        const held = await acquire(path, { waitMs: 0 });
        assert.deepEqual(counts.before, { read: 0, stat: 0 });
        held.release();
        assert.deepEqual(counts.before, { read: 1, stat: 1 });
        assert.equal(fs.existsSync(path), false);
      });

      await t.test(`${acquire.name}: live contention inspects once and preserves the owner`, async () => {
        clean();
        write(active);
        const expected = new Error("live contention");
        await assert.rejects(async () => acquire(path, {
          waitMs: 0,
          onTimeout(owner) { assert.deepEqual(owner, active); return expected; },
        }), (error) => error === expected);
        assert.deepEqual(counts, { before: { read: 1, stat: 1 }, under: { read: 0, stat: 0 }, claims: 0 });
        assert.deepEqual(JSON.parse(original.read(path, "utf8")), active);
      });

      await t.test(`${acquire.name}: a different stale generation requires a new sentinel claim`, async () => {
        clean();
        write(stale);
        onSentinel = () => {
          onSentinel = undefined;
          replace({ ...stale, nonce: "replacement" });
        };
        const held = await acquire(path, { waitMs: 0 });
        try {
          assert.deepEqual(counts, { before: { read: 2, stat: 2 }, under: { read: 2, stat: 2 }, claims: 2 });
        } finally { held.release(); }
        assert.equal(fs.existsSync(sentinel), false);
      });

      await t.test(`${acquire.name}: a live replacement under the sentinel is never reclaimed`, async () => {
        clean();
        write(stale);
        onSentinel = () => replace(active);
        await assert.rejects(async () => acquire(path, { waitMs: 0 }), /held by a live process/);
        assert.deepEqual(counts, { before: { read: 2, stat: 2 }, under: { read: 1, stat: 1 }, claims: 1 });
        assert.deepEqual(JSON.parse(original.read(path, "utf8")), active);
        assert.equal(fs.existsSync(sentinel), false);
      });

      await t.test(`${acquire.name}: removal before reinspection retries without unlinking an absent path`, async () => {
        clean();
        write(stale);
        onSentinel = () => fs.unlinkSync(path);
        const held = await acquire(path, { waitMs: 0 });
        try {
          assert.deepEqual(counts, { before: { read: 1, stat: 1 }, under: { read: 1, stat: 0 }, claims: 1 });
        } finally { held.release(); }
        assert.equal(fs.existsSync(sentinel), false);
      });

      await t.test(`${acquire.name}: a dead sentinel fails loud and leaves both records intact`, async () => {
        clean();
        write(stale);
        fs.writeFileSync(sentinel, JSON.stringify(stale));
        await assert.rejects(async () => acquire(path, { waitMs: 0 }), /a lock reclaim was interrupted/);
        assert.deepEqual(JSON.parse(original.read(path, "utf8")), stale);
        assert.equal(fs.existsSync(sentinel), true);
      });
    }
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
