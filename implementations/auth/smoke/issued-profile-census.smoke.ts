import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { encodeUser, fmtCreds, type User } from "@nats-io/jwt";
import { createUser, fromPublic, fromSeed } from "@nats-io/nkeys";
import { createSpaceAuth, serverConfig, isReachable } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { importNativeSubjectPermissions } from "../../../packages/core/smoke/prototypes/issued-subject-permissions.js";
import { profileFixtures, namespaceGrants, namespaceOverlap, type ProfileFixture } from "./prototypes/issued-profile-census.js";

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); } catch (error) { console.error(`  FAIL: ${name}`); throw error; }
  console.log(`  ok ${name}`); passed++;
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn: () => boolean) {
  for (let i = 0; i < 100; i++) { if (fn()) return; await wait(20); }
  throw new Error("native census outcome timed out");
}
const enc = (s: string) => new TextEncoder().encode(s);
const space = "issuedcensus";
let fixtures!: ProfileFixture[];
await check("profile and view producers cover their declared sets", async () => { fixtures = profileFixtures(space); });
const auth = await createSpaceAuth(space);
const port = await pickFreePort(), server = `nats://127.0.0.1:${port}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { host: "127.0.0.1", port, storeDir: join(dir, "js"), transport: { kind: "plaintext" } }), { mode: 0o600 });
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const exited = new Promise<void>((resolve) => { broker.once("exit", () => resolve()); broker.once("error", () => resolve()); });
const releaseBroker = teardownOnSignal(broker, dir);
const connections: NatsConnection[] = [];
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(server); if (!up) await wait(50); }
  assert.ok(up);
  async function open(permissions: Record<string, unknown>) {
    const key = createUser();
    const jwt = await encodeUser("isolated-census", fromPublic(key.getPublicKey()), fromPublic(auth.account.pub), permissions as Partial<User>, { signer: fromSeed(enc(auth.account.signingSeed)), exp: Math.floor(Date.now() / 1000) + 600 });
    const nc = await connect({ servers: server, authenticator: credsAuthenticator(fmtCreds(jwt, key)), maxReconnectAttempts: 0 });
    connections.push(nc); return nc;
  }
  const operator = await open({ pub: { allow: [">"] }, sub: { allow: [">"] } });
  const seen = new Set<string>();
  const tap = operator.subscribe(`cotal.${space}.ep.v1.>`);
  void (async () => { for await (const msg of tap) seen.add(new TextDecoder().decode(msg.data)); })();
  await operator.flush();
  const uid = "u".repeat(26), generation = "a".repeat(32), nonce = "n".repeat(22);
  const subjects = [
    `cotal.${space}.ep.v1.one.manager.run-start.local.census.${uid}.${generation}.${nonce}`,
    `cotal.${space}.ep.v1.reply.manager.${"i".repeat(26)}.1.local.census.${uid}.${generation}.${nonce}`,
  ];
  async function measure(permissions: Record<string, unknown>) {
    const nc = await open(permissions);
    let errors = 0;
    void (async () => { for await (const event of nc.status()) if (event.type === "error" && /permission/i.test(String(event.error))) errors++; })();
    const results: Array<{ subject: string; publish: boolean; subscribe: boolean }> = [];
    for (const subject of subjects) {
      const id = randomBytes(16).toString("hex"), before = errors;
      nc.publish(subject, enc(id)); await nc.flush();
      await until(() => seen.has(id) || errors > before);
      const publish = seen.has(id);
      let read = false, denied = false;
      const readId = randomBytes(16).toString("hex");
      const sub = nc.subscribe(subject, { callback(error, msg) {
        if (error) { denied = true; return; }
        if (new TextDecoder().decode(msg.data) === readId) read = true;
      } });
      await nc.flush();
      operator.publish(subject, enc(readId)); await operator.flush();
      await until(() => read || denied);
      assert.notEqual(read, denied);
      sub.unsubscribe();
      results.push({ subject, publish, subscribe: read });
    }
    await nc.close();
    return results;
  }
  await check("namespace detector recognizes broad grants and honors explicit deny-all", async () => {
    assert.equal(namespaceOverlap(">", space), true);
    assert.equal(namespaceOverlap(`cotal.${space}.ep.*.>`, space), true);
    assert.equal(namespaceOverlap(`cotal.${space}.ep.v1.>`, space), true);
    assert.equal(namespaceOverlap(`cotal.${space}.ep.one.>`, space), false);
    assert.equal(namespaceOverlap(`cotal.${space}.ep.v1`, space), false);
    assert.equal(namespaceGrants({ pub: { deny: [">"] } }, space, "pub").potential, false);
    const asymmetric = { pub: { deny: [">"] }, sub: { allow: [`cotal.${space}.ep.v1.>`] } };
    assert.equal(namespaceGrants(asymmetric, space, "pub").potential, false);
    assert.equal(namespaceGrants(asymmetric, space, "sub").potential, true);
  });
  await check("native positive and deny-all controls exercise both permission directions", async () => {
    const allow = await measure({ pub: { allow: [">"] }, sub: { allow: [">"] } });
    assert.ok(allow.every((r) => r.publish && r.subscribe));
    const deny = await measure({ pub: { deny: [">"] }, sub: { deny: [">"] } });
    assert.ok(deny.every((r) => !r.publish && !r.subscribe));
    const asymmetric = await measure({ pub: { deny: [">"] }, sub: { allow: [`cotal.${space}.ep.v1.>`] } });
    assert.ok(asymmetric.every((r) => !r.publish && r.subscribe));
  });
  const reports: unknown[] = [];
  for (const fixture of fixtures) {
    await check(`current profile excludes issued namespace: ${fixture.profile}/${fixture.variant}`, async () => {
      const pub = namespaceGrants(fixture.permissions, space, "pub");
      const sub = namespaceGrants(fixture.permissions, space, "sub");
      const native = await measure(fixture.permissions);
      let normalization: string = "supported";
      try { importNativeSubjectPermissions(fixture.permissions); }
      catch (error) { normalization = (error as Error).message; }
      reports.push({ profile: fixture.profile, variant: fixture.variant, producer: fixture.producer, pub, sub, normalization, native });
      assert.equal(pub.potential, false, JSON.stringify(pub));
      assert.equal(sub.potential, false, JSON.stringify(sub));
      assert.ok(native.every((r) => !r.publish && !r.subscribe));
    });
  }
  const report = {
    profileCount: new Set(fixtures.map((f) => f.profile)).size, variantCount: fixtures.length,
    nativeProfileDecisions: fixtures.length * subjects.length * 2,
    nonProfileKinds: ["membership-observer", "connection-evictor"],
    refusedCalloutViews: ["manager-service"],
    scope: "All Profile names, representative option variants, and every generic callout view. Endpoint-serve uses raw grant rows, not a fenced mint. System-account credentials and other option combinations are outside the native matrix. Namespace intersection is conservative; native samples cover one concrete request and reply in both directions. Queue-qualified normalization remains unsupported.",
    rows: reports,
  };
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + "\n");
  console.log(`issued profile census: ${passed} checks, ${report.profileCount} profiles, ${report.variantCount} variants, ${report.nativeProfileDecisions} native profile decisions`);
} finally {
  for (const nc of connections) await nc.close();
  if (broker.exitCode === null && broker.signalCode === null) broker.kill("SIGTERM");
  const stopped = await Promise.race([exited.then(() => true), wait(2000).then(() => false)]);
  if (!stopped) { broker.kill("SIGKILL"); await exited; }
  rmSync(dir, { recursive: true, force: true }); releaseBroker();
}
