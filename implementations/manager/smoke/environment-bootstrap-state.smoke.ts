import assert from "node:assert/strict";
import fs from "node:fs";
import type { RemoteManagerIdentityState } from "@cotal-ai/manager";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const filename = "environment-manager-bootstrap.json";

if (process.argv[2] === "entry") {
  const [, , , directory, input, mode, barrier] = process.argv;
  console.log(`ENTRY_PID=${process.pid}`);
  if (mode === "race" || mode === "before-publish") {
    const original = fs.linkSync;
    (fs as unknown as { linkSync: typeof fs.linkSync }).linkSync = ((from, to) => {
      if (String(to).endsWith(filename)) {
        if (mode === "before-publish") process.exit(23);
        fs.writeFileSync(join(barrier!, `ready-${process.pid}`), "ready", { mode: 0o600 });
        const wait = new Int32Array(new SharedArrayBuffer(4));
        const deadline = Date.now() + 15_000;
        while (!fs.existsSync(join(barrier!, "go"))) {
          if (Date.now() > deadline) process.exit(26);
          Atomics.wait(wait, 0, 0, 10);
        }
      }
      return original(from, to);
    }) as typeof fs.linkSync;
    syncBuiltinESMExports();
  }
  if (mode === "before-file-sync" || mode === "after-directory-sync") {
    const original = fs.fsyncSync;
    (fs as unknown as { fsyncSync: typeof fs.fsyncSync }).fsyncSync = fd => {
      const stat = fs.fstatSync(fd);
      if (stat.isFile() && mode === "before-file-sync") process.exit(24);
      original(fd);
      if (stat.isDirectory() && mode === "after-directory-sync") process.exit(25);
    };
    syncBuiltinESMExports();
  }
  const { claimEnvironmentManagerBootstrapState } = await import("@cotal-ai/manager");
  try {
    const state = claimEnvironmentManagerBootstrapState(directory!, fs.readFileSync(input!, "utf8"));
    console.log(`RETURNED=${process.pid}:${fingerprint(state)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "refused");
    process.exitCode = 2;
  }
} else {
  const core = await import("@cotal-ai/core");
  const manager = await import("@cotal-ai/manager");
  const { emitSentinel } = await import("@cotal-ai/smoke-kit");
  const claim = manager.claimEnvironmentManagerBootstrapState;
  let passed = 0, failed = 0;
  const cell = async (name: string, run: () => void | Promise<void>): Promise<void> => {
    try { await run(); console.log(`  ✓ ${name}`); passed++; }
    catch { console.error(`  ✗ ${name}`); failed++; }
  };
  const root = fs.mkdtempSync(join(tmpdir(), "cotal-bootstrap-state-"));
  const directory = (name: string): string => { const path = join(root, name); fs.mkdirSync(path, { mode: 0o700 }); return path; };
  const auth = await core.createSpaceAuth("bootstrapstate");
  const owner = `u_${"a".repeat(26)}`;
  const instanceId = core.mintLifecycleUid(), lifecycleUid = core.mintLifecycleUid();
  const pin = { owner, instanceId, lifecycleUid, authorityEndpoint: "test.example.environment", authorityInstanceId: core.mintLifecycleUid(), expiresAt: Math.floor(Date.now() / 1000) + 240 };
  const peer = core.newIdentity();
  const token = await core.mintPublicUserJwt({ space: auth.space, account: auth.account }, peer.id, "environment-bootstrap", {
    principal: { owner, actor: core.environmentBootstrapActor(instanceId) }, lifecycleUid, environmentManager: pin, expiresAt: pin.expiresAt,
  });
  const digest = `sha256:${"a".repeat(64)}`;
  const doc = { v: 1, space: auth.space, environmentId: "b".repeat(64), instanceId, lifecycleUid, accountPublicKey: auth.account.pub,
    brokerUrl: "wss://broker.example.invalid/mesh-ws", authorityEndpoint: pin.authorityEndpoint, authorityInstanceId: pin.authorityInstanceId,
    expiresAt: token.exp, contracts: { bootstrap: { clusterDigest: digest, inputDigest: digest, outputDigest: digest },
      "bootstrap-status": { clusterDigest: digest, inputDigest: digest, outputDigest: digest } }, creds: core.credsFromJwt(token.jwt, peer) };
  const text = core.canonicalJson(doc);
  const input = join(root, "input.json");
  fs.writeFileSync(input, text, { mode: 0o600 });
  const launch = (path: string, mode = "normal", barrier = root) => {
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), import.meta.filename, "entry", path, input, mode, barrier], {
      env: { PATH: process.env.PATH, MUTATION_PROOF_RUN: process.env.MUTATION_PROOF_RUN }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", bytes => { output += bytes.toString(); });
    child.stderr.on("data", bytes => { output += bytes.toString(); });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
    const done = new Promise<{ code: number | null; output: string; pid: number | undefined }>((resolve, reject) => {
      child.once("error", error => { clearTimeout(timeout); reject(error); });
      child.once("close", code => { clearTimeout(timeout); resolve({ code, output, pid: child.pid }); });
    });
    return { child, done };
  };
  const refuses = (path: string, carrier = text): void => assert.throws(() => claim(path, carrier), /initial bootstrap state/);
  try {
    const dir = directory("state"), path = join(dir, filename);
    const state = claim(dir, text);
    const bytes = fs.readFileSync(path);
    await cell("public claim couples original bootstrap material and local keys", () => {
      const raw = JSON.parse(bytes.toString()) as { bootstrapText: string; identityState: unknown };
      assert.ok(raw.bootstrapText === text && fingerprint(raw.identityState) === fingerprint(state));
      assert.deepEqual(Object.keys(raw).sort(), ["bootstrapText", "identityState", "v"]);
      assert.ok(state.instanceId === instanceId && state.lifecycleUid === lifecycleUid && state.space === auth.space);
    });
    await cell("five held user seeds match distinct public keys", () => {
      for (const name of core.REMOTE_MANAGER_IDENTITY_NAMES) {
        const identity = state.identities[name];
        assert.ok(core.isUserNkey(identity.id) && identity.seed.startsWith("SU") && core.artifactSignerFromSeed(identity.seed).publicKey === identity.id);
      }
      assert.ok(new Set(Object.values(state.identities).map(identity => identity.id)).size === 5);
    });
    await cell("initial record is current-UID private and complete", () => {
      const stat = fs.statSync(path);
      assert.ok(stat.uid === process.geteuid!() && (stat.mode & 0o7777) === 0o600 && stat.isFile());
      assert.ok(fs.readdirSync(dir).length === 1);
    });
    await cell("same carrier adopts original keys without rewriting bytes", () => {
      assert.ok(fingerprint(claim(dir, text)) === fingerprint(state));
      assert.ok(fs.readFileSync(path).equals(bytes));
    });
    await cell("changed carrier cannot adopt or replace the first state", () => {
      refuses(dir, core.canonicalJson({ ...doc, environmentId: "c".repeat(64) }));
      assert.ok(fs.readFileSync(path).equals(bytes));
    });
    await cell("expired initial carrier refuses without altering state", () => {
      refuses(dir, core.canonicalJson({ ...doc, expiresAt: Math.floor(Date.now() / 1000) - 1 }));
      assert.ok(fs.readFileSync(path).equals(bytes));
    });
    await cell("directory is existing absolute canonical and private", () => {
      refuses("relative"); refuses(join(root, "missing")); refuses(`${dir}/.`);
      const shared = directory("shared"); fs.chmodSync(shared, 0o755); refuses(shared);
      assert.ok(fs.readdirSync(shared).length === 0);
    });
    await cell("directory symlink refuses without touching its target", () => {
      const target = directory("link-target"), link = join(root, "dir-link"); fs.symlinkSync(target, link);
      refuses(link); assert.ok(fs.readdirSync(target).length === 0);
    });
    await cell("record symlink refuses without reading or changing target", () => {
      const bad = directory("file-link"), target = join(root, "private-target"); fs.writeFileSync(target, "PRIVATE_TARGET", { mode: 0o600 });
      fs.symlinkSync(target, join(bad, filename)); refuses(bad);
      assert.ok(fs.readFileSync(target, "utf8") === "PRIVATE_TARGET" && fs.lstatSync(join(bad, filename)).isSymbolicLink());
    });
    await cell("record FIFO refuses without blocking the actual reader", async () => {
      const bad = directory("fifo");
      const { execFileSync } = await import("node:child_process"); execFileSync("mkfifo", [join(bad, filename)]);
      const result = await launch(bad).done;
      assert.ok(result.output.includes(`ENTRY_PID=${result.pid}\n`) && result.code === 2 && !result.output.includes("RETURNED="));
    });
    await cell("nonprivate record refuses without tightening or replacing it", () => {
      const bad = directory("public-record"), file = join(bad, filename); fs.writeFileSync(file, bytes, { mode: 0o644 });
      refuses(bad); assert.ok((fs.statSync(file).mode & 0o777) === 0o644 && fs.readFileSync(file).equals(bytes));
    });
    await cell("record directory empty oversized and malformed entries refuse", () => {
      for (const [name, value] of [["empty", ""], ["oversized", "x".repeat(256 * 1024 + 1)], ["bad-json", "{PRIVATE_SYNTAX"]] as const) {
        const bad = directory(name), file = join(bad, filename); fs.writeFileSync(file, value, { mode: 0o600 }); refuses(bad);
        assert.ok(fs.readFileSync(file, "utf8") === value);
      }
      const bad = directory("record-dir"); fs.mkdirSync(join(bad, filename)); refuses(bad);
    });
    await cell("oversized metadata refuses before any stock record byte read", () => {
      const bad = directory("oversize-pre-read"), file = join(bad, filename), original = fs.readFileSync;
      fs.writeFileSync(file, "x".repeat(256 * 1024 + 1), { mode: 0o600 });
      let reads = 0;
      (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = ((path, ...args) => {
        if (String(path).endsWith(filename)) reads++;
        return original(path, ...args);
      }) as typeof fs.readFileSync;
      syncBuiltinESMExports();
      try { refuses(bad); assert.ok(reads === 0); }
      finally { (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = original; syncBuiltinESMExports(); }
    });
    await cell("unknown missing and mismatched stored coordinates never remint", () => {
      const original = JSON.parse(bytes.toString()) as { v: number; bootstrapText: string; identityState: RemoteManagerIdentityState };
      for (const [name, mutate] of [
        ["unknown", (raw: Record<string, unknown>) => { raw.extra = "PRIVATE"; }],
        ["missing", (raw: Record<string, unknown>) => { delete raw.bootstrapText; }],
        ["coordinate", (raw: Record<string, unknown>) => { (raw.identityState as RemoteManagerIdentityState).instanceId = core.mintLifecycleUid(); }],
      ] as const) {
        const bad = directory(name), file = join(bad, filename), raw = structuredClone(original) as unknown as Record<string, unknown>;
        mutate(raw); const written = JSON.stringify(raw, null, 2); fs.writeFileSync(file, written, { mode: 0o600 }); refuses(bad);
        assert.ok(fs.readFileSync(file, "utf8") === written);
      }
    });
    await cell("stored seed corruption and shared duty keys refuse", () => {
      for (const kind of ["seed", "shared"]) {
        const bad = directory(`keys-${kind}`), file = join(bad, filename), raw = JSON.parse(bytes.toString()) as { identityState: RemoteManagerIdentityState };
        if (kind === "seed") raw.identityState.identities.supervisor.seed = core.newIdentity().seed;
        else raw.identityState.identities.goalWriter = raw.identityState.identities.supervisor;
        const written = JSON.stringify(raw, null, 2); fs.writeFileSync(file, written, { mode: 0o600 }); refuses(bad);
        assert.ok(fs.readFileSync(file, "utf8") === written);
      }
    });
    await cell("file and directory sync both precede material return", () => {
      const fresh = directory("sync-order"), seen: string[] = [], original = fs.fsyncSync;
      (fs as unknown as { fsyncSync: typeof fs.fsyncSync }).fsyncSync = fd => { seen.push(fs.fstatSync(fd).isDirectory() ? "directory" : "file"); original(fd); };
      syncBuiltinESMExports();
      try { claim(fresh, text); assert.deepEqual(seen, ["file", "directory"]); }
      finally { (fs as unknown as { fsyncSync: typeof fs.fsyncSync }).fsyncSync = original; syncBuiltinESMExports(); }
    });
    await cell("sync failure returns no material and preserves the published winner", () => {
      const fresh = directory("sync-error"), original = fs.fsyncSync;
      (fs as unknown as { fsyncSync: typeof fs.fsyncSync }).fsyncSync = () => { throw new Error("PRIVATE_SYNC_DIAGNOSTIC"); };
      syncBuiltinESMExports();
      try { refuses(fresh); }
      finally { (fs as unknown as { fsyncSync: typeof fs.fsyncSync }).fsyncSync = original; syncBuiltinESMExports(); }
      const raw = JSON.parse(fs.readFileSync(join(fresh, filename), "utf8")) as { identityState: unknown };
      assert.ok(fingerprint(claim(fresh, text)) === fingerprint(raw.identityState));
    });
    await cell("expiry during sync prevents material release without replacing keys", () => {
      const fresh = directory("expiry-during-sync"), originalSync = fs.fsyncSync, originalNow = Date.now;
      (fs as unknown as { fsyncSync: typeof fs.fsyncSync }).fsyncSync = fd => {
        originalSync(fd);
        if (fs.fstatSync(fd).isDirectory()) Date.now = () => (doc.expiresAt + 1) * 1000;
      };
      syncBuiltinESMExports();
      try { refuses(fresh); }
      finally { Date.now = originalNow; (fs as unknown as { fsyncSync: typeof fs.fsyncSync }).fsyncSync = originalSync; syncBuiltinESMExports(); }
      const raw = JSON.parse(fs.readFileSync(join(fresh, filename), "utf8")) as { identityState: unknown };
      assert.ok(fingerprint(claim(fresh, text)) === fingerprint(raw.identityState));
    });
    await cell("held directory rename cannot redirect publication or adoption", () => {
      const fresh = directory("rename"), moved = join(root, "renamed"), original = fs.openSync;
      let renamed = false;
      (fs as unknown as { openSync: typeof fs.openSync }).openSync = ((path, flags, mode) => {
        const fd = original(path, flags, mode);
        if (!renamed && path === fresh) { renamed = true; fs.renameSync(fresh, moved); fs.mkdirSync(fresh, { mode: 0o700 }); }
        return fd;
      }) as typeof fs.openSync;
      syncBuiltinESMExports();
      try { claim(fresh, text); }
      finally { (fs as unknown as { openSync: typeof fs.openSync }).openSync = original; syncBuiltinESMExports(); }
      assert.ok(renamed && fs.existsSync(join(moved, filename)) && fs.readdirSync(fresh).length === 0);
    });
    await cell("two unpublished process candidates converge on one actual winner", async () => {
      const fresh = directory("race"), barrier = directory("barrier"), workers = [launch(fresh, "race", barrier), launch(fresh, "race", barrier)];
      try {
        const deadline = Date.now() + 12_000;
        while (!workers.every(worker => fs.existsSync(join(barrier, `ready-${worker.child.pid}`)))) {
          if (Date.now() > deadline) throw new Error("publication barrier not reached");
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(!fs.existsSync(join(fresh, filename)), "one process published before the labelled barrier");
        fs.writeFileSync(join(barrier, "go"), "go", { mode: 0o600 });
        const results = await Promise.all(workers.map(worker => worker.done));
        const record = JSON.parse(fs.readFileSync(join(fresh, filename), "utf8")) as { identityState: unknown };
        assert.ok(results.every(result => result.code === 0 && result.output.includes(`ENTRY_PID=${result.pid}\n`) && result.output.includes(`RETURNED=${result.pid}:${fingerprint(record.identityState)}\n`)));
      } finally { for (const worker of workers) worker.child.kill("SIGKILL"); await Promise.all(workers.map(worker => worker.done)); }
    });
    await cell("fresh process adopts persisted keys without a new identity", async () => {
      const result = await launch(dir).done;
      assert.ok(result.code === 0 && result.output.includes(`RETURNED=${result.pid}:${fingerprint(state)}\n`) && fs.readFileSync(path).equals(bytes));
    });
    await cell("crash before publication releases no keys and leaves no final record", async () => {
      const fresh = directory("prepublish-crash"), result = await launch(fresh, "before-publish").done;
      assert.ok(result.code === 23 && result.output.includes(`ENTRY_PID=${result.pid}\n`) && !result.output.includes("RETURNED=") && !fs.existsSync(join(fresh, filename)));
    });
    for (const [mode, code] of [["before-file-sync", 24], ["after-directory-sync", 25]] as const)
      await cell(`interrupted ${mode} reconstructs the same coupled state`, async () => {
        const fresh = directory(mode), result = await launch(fresh, mode).done;
        assert.ok(result.code === code && !result.output.includes("RETURNED="));
        const raw = JSON.parse(fs.readFileSync(join(fresh, filename), "utf8")) as { bootstrapText: string; identityState: unknown };
        assert.ok(raw.bootstrapText === text);
        const restarted = await launch(fresh).done;
        assert.ok(restarted.code === 0 && restarted.output.includes(`RETURNED=${restarted.pid}:${fingerprint(raw.identityState)}\n`));
      });
    await cell("diagnostics disclose neither paths nor bootstrap or private key material", () => {
      const bad = directory("diagnostics"); fs.writeFileSync(join(bad, filename), "{PRIVATE_DIAGNOSTIC", { mode: 0o600 });
      let message: string | undefined;
      try { claim(bad, text); } catch (error) { if (error instanceof Error) message = error.message; }
      assert.ok(message !== undefined && !message.includes(bad) && !message.includes(peer.seed) && !message.includes(text) && !message.includes("PRIVATE_DIAGNOSTIC"));
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log(`environment bootstrap state: ${passed} passed, ${failed} failed`);
  emitSentinel({ passed, failed });
  if (failed) process.exitCode = 1;
}
