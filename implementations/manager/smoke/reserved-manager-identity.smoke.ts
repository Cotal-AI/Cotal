import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { artifactSignerFromSeed, mintLifecycleUid, REMOTE_MANAGER_IDENTITY_NAMES } from "@cotal-ai/core";
import { remoteManagerClient, type RemoteManagerIdentityState } from "@cotal-ai/manager";
import { spaceKey } from "@cotal-ai/workspace";
import { emitSentinel } from "@cotal-ai/smoke-kit";

const fingerprint = (state: RemoteManagerIdentityState): string => createHash("sha256").update(JSON.stringify(state)).digest("hex");
if (process.argv[2] === "reconstruct") {
  const state = remoteManagerClient.loadOrCreateRemoteManagerIdentity(process.argv[3]!, process.argv[4]!);
  console.log(`RECONSTRUCTED=${process.pid}:${fingerprint(state)}`);
} else {
  let passed = 0, failed = 0;
  const check = async (name: string, run: () => void | Promise<void>): Promise<void> => {
    try { await run(); console.log(`✓ ${name}`); passed++; }
    catch (error) { console.error(`✗ ${name}: ${error instanceof Error ? error.message : "check failed"}`); failed++; }
  };
  const coordinates = { space: "reserved_identity", instanceId: mintLifecycleUid(), lifecycleUid: mintLifecycleUid() };
  const root = mkdtempSync(join(tmpdir(), "cotal-reserved-identity-"));
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const state = remoteManagerClient.createReservedRemoteManagerIdentity(coordinates);
    await check("reserved constructor preserves host instance", () => assert.ok(state.instanceId === coordinates.instanceId, "reserved instance was replaced"));
    await check("reserved constructor preserves host lifecycle", () => assert.ok(state.lifecycleUid === coordinates.lifecycleUid, "reserved lifecycle was replaced"));
    await check("reserved constructor preserves space without normalization", () => {
      const unicode = remoteManagerClient.createReservedRemoteManagerIdentity({ ...coordinates, space: "Alpha/🛰" });
      assert.ok(unicode.space === "Alpha/🛰", "space was normalized");
    });
    await check("reserved state has only version coordinates and five identities", () => {
      assert.deepEqual(Object.keys(state).sort(), ["identities", "instanceId", "lifecycleUid", "space", "v"]);
      assert.ok(state.v === 1);
      assert.deepEqual(Object.keys(state.identities), [...REMOTE_MANAGER_IDENTITY_NAMES]);
    });
    for (const name of REMOTE_MANAGER_IDENTITY_NAMES) {
      await check(`reserved ${name} is a matching native user key pair`, () => {
        const identity = state.identities[name];
        assert.deepEqual(Object.keys(identity).sort(), ["id", "seed"]);
        assert.ok(/^U[A-Z2-7]{55}$/.test(identity.id), "not a user public key");
        assert.ok(identity.seed.startsWith("SU"), "not a user private seed");
        assert.ok(artifactSignerFromSeed(identity.seed).publicKey === identity.id, "private seed does not match public key");
      });
    }
    await check("reserved duties use five distinct public keys", () => assert.ok(new Set(REMOTE_MANAGER_IDENTITY_NAMES.map(name => state.identities[name].id)).size === 5, "manager duties share a key"));
    await check("reserved constructor creates fresh keys rather than a replay store", () => {
      const another = remoteManagerClient.createReservedRemoteManagerIdentity(coordinates);
      const prior = new Set(REMOTE_MANAGER_IDENTITY_NAMES.map(name => state.identities[name].id));
      assert.ok(REMOTE_MANAGER_IDENTITY_NAMES.every(name => !prior.has(another.identities[name].id)), "constructor reused keys");
    });
    await check("reserved public projection contains only five public ids", () => {
      const projection = remoteManagerClient.publicIdentities(state);
      assert.deepEqual(Object.keys(projection), [...REMOTE_MANAGER_IDENTITY_NAMES]);
      for (const name of REMOTE_MANAGER_IDENTITY_NAMES) {
        assert.deepEqual(Object.keys(projection[name]), ["id"]);
        assert.ok(projection[name].id === state.identities[name].id);
      }
      const encoded = JSON.stringify(projection);
      assert.ok(REMOTE_MANAGER_IDENTITY_NAMES.every(name => !encoded.includes(state.identities[name].seed)), "private seed crossed public projection");
    });
    const refuses = (raw: unknown): void => {
      assert.throws(() => remoteManagerClient.createReservedRemoteManagerIdentity(raw as typeof coordinates), /reserved manager identity/);
    };
    await check("reserved constructor refuses caller identity and extra fields", () => {
      refuses({ ...coordinates, identities: state.identities });
      refuses({ ...coordinates, owner: "caller_owner" });
      refuses({ ...coordinates, profile: "remote-manager" });
    });
    await check("reserved constructor refuses missing coordinates", () => {
      for (const field of Object.keys(coordinates)) {
        const raw: Record<string, unknown> = { ...coordinates };
        delete raw[field];
        refuses(raw);
      }
    });
    await check("reserved constructor refuses non-object coordinates", () => {
      for (const raw of [null, undefined, [], "coordinates", 1]) refuses(raw);
    });
    await check("reserved constructor refuses non-string coordinates", () => {
      for (const field of Object.keys(coordinates)) refuses({ ...coordinates, [field]: 42 });
    });
    await check("reserved constructor refuses malformed lifecycle tokens", () => {
      for (const field of ["instanceId", "lifecycleUid"]) {
        for (const value of ["", "a".repeat(25), "a".repeat(33), "A".repeat(26), ".".repeat(26)]) refuses({ ...coordinates, [field]: value });
      }
    });
    await check("reserved constructor refuses malformed spaces", () => {
      for (const space of ["", ".", "..", "\uD800"]) refuses({ ...coordinates, space });
    });
    await check("reserved refusal diagnostics expose no supplied values", () => {
      const secret = "PRIVATE_COORDINATE_DIAGNOSTIC_CONTROL";
      let message: string | undefined;
      try { remoteManagerClient.createReservedRemoteManagerIdentity({ ...coordinates, instanceId: secret }); }
      catch (error) { if (error instanceof Error) message = error.message; }
      assert.ok(message !== undefined, "invalid coordinate accepted");
      assert.ok(!message.includes(secret), "diagnostic disclosed supplied coordinate");
    });
    await check("reserved constructor writes no identity record", () => assert.ok(readdirSync(root).length === 0, "constructor persisted outside a claim"));
    const ordinary = remoteManagerClient.loadOrCreateRemoteManagerIdentity(root, coordinates.space);
    const path = join(root, ".cotal", `remote-manager.${spaceKey(coordinates.space)}.json`);
    const bytes = readFileSync(path);
    await check("ordinary manager still selects and privately persists its lifecycle", () => {
      assert.ok(ordinary.instanceId !== coordinates.instanceId && ordinary.lifecycleUid !== coordinates.lifecycleUid);
      assert.ok(fingerprint(JSON.parse(bytes.toString()) as RemoteManagerIdentityState) === fingerprint(ordinary), "stored state differs from claimed state");
      if (process.platform !== "win32") {
        assert.ok((statSync(path).mode & 0o777) === 0o600, "identity file is not mode0600");
        assert.ok((statSync(join(root, ".cotal")).mode & 0o777) === 0o700, "identity parent is not mode0700");
      }
    });
    await check("ordinary stored manager adopts all original private keys", () => {
      const adopted = remoteManagerClient.loadOrCreateRemoteManagerIdentity(root, coordinates.space);
      assert.ok(fingerprint(adopted) === fingerprint(ordinary), "stored keys were replaced");
      assert.ok(readFileSync(path).equals(bytes), "stored identity bytes changed");
    });
    await check("fresh process reconstructs ordinary manager without replacing keys", async () => {
      const result = await new Promise<{ code: number | null; output: string; pid: number | undefined }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), import.meta.filename, "reconstruct", root, coordinates.space], {
          env: { PATH: process.env.PATH, MUTATION_PROOF_RUN: process.env.MUTATION_PROOF_RUN }, stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", data => { output += data.toString(); });
        child.stderr.on("data", data => { output += data.toString(); });
        const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
        child.once("error", error => { clearTimeout(timeout); reject(error); });
        child.once("close", code => { clearTimeout(timeout); resolve({ code, output, pid: child.pid }); });
      });
      assert.ok(result.code === 0, "owned reconstruction process failed");
      assert.ok(result.output.includes(`RECONSTRUCTED=${result.pid}:${fingerprint(ordinary)}\n`), "actual reader PID or reconstructed keys differ");
      assert.ok(readFileSync(path).equals(bytes), "fresh process replaced identity file");
    });
    await check("ordinary malformed stored state refuses without replacement", () => {
      writeFileSync(path, "{}", { mode: 0o600 });
      assert.throws(() => remoteManagerClient.loadOrCreateRemoteManagerIdentity(root, coordinates.space));
      assert.ok(readFileSync(path, "utf8") === "{}", "malformed record was overwritten");
    });
  } finally { process.chdir(cwd); rmSync(root, { recursive: true, force: true }); }
  console.log(`reserved manager identity: ${passed} passed, ${failed} failed`);
  emitSentinel({ passed, failed });
  if (failed) process.exitCode = 1;
}
