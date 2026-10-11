import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { constants, chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, createSpaceAuth, registry, type AuthProvider, type EndpointDeploymentTrustRecord, type ParsedArgs } from "@cotal-ai/core";
import { loadEndpointDeploymentTrust, recordMesh, resolveEndpointCallerTarget, userAuthStateDir } from "@cotal-ai/workspace";
import { assertGenericEndpointIntent, describeCmd, invokeCmd } from "../src/commands/describe.js";

// Real protected filesystem and shipped command/helper entry points. The provider below is a
// rejection counter only. No successful authenticated acquisition or broker acceptance is claimed.
const home = mkdtempSync(join(tmpdir(), "endpoint-caller-controls-"));
const oldHome = process.env.COTAL_HOME;
process.env.COTAL_HOME = join(home, "machine");
const root = join(home, "client");
mkdirSync(root, { mode: 0o700 });
mkdirSync(join(root, ".cotal"), { mode: 0o700 });
mkdirSync(join(root, ".cotal", "auth"), { mode: 0o700 });
const space = "endpoint-controls";
const state = userAuthStateDir(root, space);
mkdirSync(state, { mode: 0o700 });
const path = join(state, "endpoint-deployment-trust.json");
const origin = "http://127.0.0.1:49221";
const instance = "a".repeat(26);
const selection = { endpoint: "test.example.counter", instanceId: instance, commands: ["describe", "increment"] };
const account = await createSpaceAuth(space);
const publicKey = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
const x = publicKey.x!;
const key = { kty: "OKP" as const, crv: "Ed25519" as const, x,
  kid: createHash("sha256").update(canonicalJson({ crv: "Ed25519", kty: "OKP", x })).digest("base64url"),
  alg: "EdDSA" as const, use: "sig" as const };
const now = Math.floor(Date.now() / 1000);
const record: EndpointDeploymentTrustRecord = {
  v: 2, kind: "cotal.endpoint-deployment-trust", space, exchangeOrigin: origin, provisionedAt: now,
  trust: { account: { space, accountPublicKey: account.account.pub, assignmentRevision: 1 },
    assignmentLifecycleUid: "b".repeat(26), assignmentExpiresAt: now + 600,
    issuer: "https://issuer.example", keys: [key], accountSigningKey: account.account.signingPub,
    authority: { endpoint: "auth", instanceId: "c".repeat(26), epoch: 0 } },
};
const original = canonicalJson(record);
const put = (value: unknown = record) => { writeFileSync(path, canonicalJson(value), { mode: 0o600 }); chmodSync(path, 0o600); };
let acquisitionCalls = 0;
const counter = { kind: "auth-provider", name: "endpoint-controls",
  async endpointCallerAuthority() { acquisitionCalls++; throw new Error("EC-provider-boundary-reached"); },
} as unknown as AuthProvider;
let passed = 0;
async function cell(name: string, run: () => void | Promise<void>): Promise<void> {
  try { await run(); }
  catch (error) {
    if (error instanceof assert.AssertionError) console.error(`endpoint-caller-controls.smoke: FAIL ${name}`);
    throw error;
  }
  passed++; console.log(`PASS ${name}`);
}
const parsed = (values: ParsedArgs["values"], positionals = [selection.endpoint, "increment"]): ParsedArgs => ({ values, positionals, raw: [] });
const protectedTrustSupported = typeof process.getuid === "function" && !!constants.O_NOFOLLOW && !!constants.O_DIRECTORY;
const unsupportedTrust = { name: "Error", message: "protected endpoint deployment trust is unsupported on this platform" };
try {
  put();
  recordMesh({ space, root, server: "nats://127.0.0.1:49222", mode: "user", origin: "manual", ts: new Date().toISOString(),
    userAuth: { provider: counter.name, idp: { url: origin, issuer: record.trust.issuer, audience: space }, endpoints: { url: origin } } });
  registry.register(counter);
  await cell("EC04-untargeted-explicit-intent-positive", () => assertGenericEndpointIntent({ space }, instance));
  await cell("EC05-shipped-generic-missing-instance-denies-before-provider", async () => {
    await assert.rejects(describeCmd(parsed({ space }, [selection.endpoint])), /requires explicit --on/);
    assert.equal(acquisitionCalls, 0);
  });
  for (const [flag, value] of [["creds", "raw.creds"], ["admin", true], ["name", "foreign"], ["self", true], ["session", "session"], ["sessionId", "session"]] as const) {
    await cell(`EC06-shipped-generic-${flag}-denies-before-provider`, async () => {
      await assert.rejects(invokeCmd(parsed({ space, on: instance, [flag]: value })), /do not support raw credentials/);
      assert.equal(acquisitionCalls, 0);
    });
  }
  await cell("EC07-public-helper-raw-creds-denies-before-provider", async () => {
    await assert.rejects(resolveEndpointCallerTarget({ space, creds: "raw.creds" }, selection), /do not accept raw --creds/);
    assert.equal(acquisitionCalls, 0);
  });
  if (!protectedTrustSupported) {
    await cell("EC23-unsupported-protected-trust-loader-refuses", () => {
      assert.throws(() => loadEndpointDeploymentTrust(root, space, origin), unsupportedTrust);
      assert.equal(acquisitionCalls, 0);
    });
    await cell("EC24-unsupported-public-helper-denies-before-provider", async () => {
      await assert.rejects(resolveEndpointCallerTarget({ space }, selection), unsupportedTrust);
      assert.equal(acquisitionCalls, 0);
    });
    await cell("EC25-unsupported-shipped-invoke-denies-before-provider", async () => {
      await assert.rejects(invokeCmd(parsed({ space, on: instance, args: "{}" })), unsupportedTrust);
      assert.equal(acquisitionCalls, 0);
    });
  }
  if (protectedTrustSupported) {
    await cell("EC08-protected-trust-positive-read-and-recheck", () => {
      const loaded = loadEndpointDeploymentTrust(root, space, origin);
      assert.equal(canonicalJson(loaded.record), original);
      loaded.assertCurrent();
    });
    await cell("EC09-missing-record-denies-before-provider", async () => {
      unlinkSync(path);
      await assert.rejects(resolveEndpointCallerTarget({ space }, selection), /ENOENT/);
      assert.equal(acquisitionCalls, 0); put();
    });
    await cell("EC10-wrong-origin-denies-before-provider", async () => {
      put({ ...record, exchangeOrigin: "https://foreign.example" });
      await assert.rejects(resolveEndpointCallerTarget({ space }, selection), /origin mismatch/);
      assert.equal(acquisitionCalls, 0); put();
    });
    await cell("EC11-wrong-account-space-denies-before-provider", async () => {
      put({ ...record, trust: { ...record.trust, account: { ...record.trust.account, space: "foreign" } } });
      await assert.rejects(resolveEndpointCallerTarget({ space }, selection), /account\/time mismatch/);
      assert.equal(acquisitionCalls, 0); put();
    });
    await cell("EC12-expired-assignment-denies-before-provider", async () => {
      put({ ...record, trust: { ...record.trust, assignmentExpiresAt: now - 1 } });
      await assert.rejects(resolveEndpointCallerTarget({ space }, selection), /expired/);
      assert.equal(acquisitionCalls, 0); put();
    });
    await cell("EC13-private-key-denies-before-provider", async () => {
      put({ ...record, trust: { ...record.trust, keys: [{ ...key, d: "private" }] } });
      await assert.rejects(resolveEndpointCallerTarget({ space }, selection), /closed shape/);
      assert.equal(acquisitionCalls, 0); put();
    });
    await cell("EC14-symlink-file-denies-before-provider", async () => {
      const other = join(home, "other.json"); writeFileSync(other, original, { mode: 0o600 });
      unlinkSync(path); symlinkSync(other, path);
      await assert.rejects(resolveEndpointCallerTarget({ space }, selection), /0600 regular file/);
      assert.equal(acquisitionCalls, 0); unlinkSync(path); put();
    });
    await cell("EC15-public-file-mode-denies-before-provider", async () => {
      chmodSync(path, 0o644);
      await assert.rejects(resolveEndpointCallerTarget({ space }, selection), /0600 regular file/);
      assert.equal(acquisitionCalls, 0); chmodSync(path, 0o600);
    });
    await cell("EC16-public-directory-mode-denies-before-provider", async () => {
      chmodSync(state, 0o755);
      await assert.rejects(resolveEndpointCallerTarget({ space }, selection), /0700 directory/);
      assert.equal(acquisitionCalls, 0); chmodSync(state, 0o700);
    });
    await cell("EC17-byte-bound-denies-before-provider", async () => {
      writeFileSync(path, " ".repeat(32769));
      await assert.rejects(resolveEndpointCallerTarget({ space }, selection), /byte bound/);
      assert.equal(acquisitionCalls, 0); put();
    });
    await cell("EC18-canonical-equivalent-byte-change-invalidates-recheck", () => {
      const loaded = loadEndpointDeploymentTrust(root, space, origin);
      writeFileSync(path, original + "\n");
      assert.throws(() => loaded.assertCurrent(), /replaced/); put();
    });
    await cell("EC19-identical-file-replacement-invalidates-recheck", () => {
      const loaded = loadEndpointDeploymentTrust(root, space, origin);
      const replacement = join(state, "replacement.json"); writeFileSync(replacement, original, { mode: 0o600 }); renameSync(replacement, path);
      assert.throws(() => loaded.assertCurrent(), /replaced/);
    });
  }
  await cell("EC20-raw-server-override-denies-before-provider", async () => {
    await assert.rejects(resolveEndpointCallerTarget({ space, server: "nats://127.0.0.1:49223" }, selection), /registry broker and root/);
    assert.equal(acquisitionCalls, 0);
  });
  if (protectedTrustSupported) {
    await cell("EC22-malformed-utf8-denies-before-provider", async () => {
      writeFileSync(path, Buffer.from([0xc3, 0x28]));
      await assert.rejects(resolveEndpointCallerTarget({ space }, selection), /encoded data was not valid/);
      assert.equal(acquisitionCalls, 0); put();
    });
    await cell("EC21-valid-registry-and-trust-reaches-only-dedicated-provider", async () => {
      await assert.rejects(resolveEndpointCallerTarget({ space }, selection), /EC-provider-boundary-reached/);
      assert.equal(acquisitionCalls, 1);
    });
  }
  assert.equal(readFileSync(path, "utf8"), original);
  assert.equal(passed, protectedTrustSupported ? 24 : 13);
  assert.equal(acquisitionCalls, protectedTrustSupported ? 1 : 0);
  console.log(`endpoint-caller-controls.smoke: protected filesystem positives ${protectedTrustSupported ? "exercised" : "not exercised (unsupported platform)"}`);
  console.log(`endpoint-caller-controls.smoke: ${passed} cells passed`);
} finally {
  registry.unregister("auth-provider", counter.name);
  if (oldHome === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = oldHome;
  rmSync(home, { recursive: true, force: true });
}
