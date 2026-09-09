import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { encodeUser, fmtCreds, type User } from "@nats-io/jwt";
import { createUser, fromPublic, fromSeed } from "@nats-io/nkeys";
import { createSpaceAuth, serverConfig, isReachable } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { importNativeSubjectPermissions } from "../../../packages/core/smoke/prototypes/issued-subject-permissions.js";
import { acceptedReadGrant } from "../../../packages/core/smoke/prototypes/issued-accepted-row.js";
import { profileFixtures, namespaceGrants, namespaceOverlap, writeAndRawReadStreams, shippedSources, holdsServerView, ledgerCitations, suiteCellNames, clientApiVerbs, DELIVERY_CONFIGURING_VERBS, singleSampledHoldAssertions, TRUSTED_PROFILES, deliveryPaths, deliveryClassOf, PEER_HELD_PROFILES, type ProfileFixture } from "./prototypes/issued-profile-census.js";

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
  const observations: Record<string, unknown> = {};
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
  await check("every broker grant a peer can hold has a decided delivery class", async () => {
    // The origin argument quantifies over "granted delivery paths". Enumerating them by hand is
    // how that argument silently goes stale, so every $JS. grant is classified and an unknown
    // verb refuses.
    assert.throws(() => deliveryClassOf("$JS.API.STREAM.PURGE.CHAT_x"), /unclassified/);
    // A stream create or update can carry `republish`, which makes the server publish stored
    // messages to a destination the holder names. No peer holds one; the table must refuse it
    // rather than fold it into an envelope class.
    assert.throws(() => deliveryClassOf("$JS.API.STREAM.CREATE.CHAT_x"), /unclassified/);
    assert.throws(() => deliveryClassOf("$JS.API.STREAM.UPDATE.CHAT_x"), /unclassified/);
    assert.equal(deliveryClassOf("$JS.API.CONSUMER.CREATE.CHAT_x.d"), "creates-push-delivery");
    assert.throws(() => deliveryClassOf("$SYS.REQ.ACCOUNT.x.CONNZ"), /unclassified/);
    assert.equal(deliveryClassOf("$SYS.REQ.USER.INFO"), "api-envelope");
    const classified: Record<string, string[]> = {};
    for (const fixture of fixtures) {
      if (!PEER_HELD_PROFILES.includes(fixture.profile as never)) continue;
      for (const { row, cls } of deliveryPaths(fixture.permissions)) (classified[cls] ??= []).push(row);
    }
    // Each class fails the forgery on its own ground, so none is absent by accident.
    assert.deepEqual(Object.keys(classified).sort(), ["api-envelope", "creates-push-delivery", "no-delivery", "stored-captured-subject", "stored-marked"]);
    observations.peerDeliveryClasses = Object.fromEntries(Object.entries(classified).map(([k, v]) => [k, [...new Set(v)].length]));
  });

  await check("every API verb the client library can call is classified or refused", async () => {
    const { createRequire } = await import("node:module");
    const lib = dirname(createRequire(import.meta.url).resolve("@nats-io/jetstream"));
    const verbs = clientApiVerbs(lib);
    const classified: string[] = [], refused: string[] = [];
    for (const verb of verbs) {
      const row = `$JS.API.${verb}${verb.endsWith("LIST") || verb.endsWith("NAMES") ? "" : ".s"}`;
      try { deliveryClassOf(row); classified.push(verb); }
      catch (error) {
        assert.match(String((error as Error).message), /unclassified JetStream grant/, `${verb} failed for a reason other than being unclassified`);
        refused.push(verb);
      }
    }
    assert.equal(classified.length + refused.length, verbs.length);
    // A verb that configures where the server delivers must never resolve to an envelope class:
    // an envelope is answered to the requester, while these hand the server a destination.
    // The pairing is derived, not trusted: any verb that creates or updates a stream or consumer
    // hands the server a configuration, so dropping one from the constant fails here.
    assert.deepEqual(verbs.filter((verb) => /\.(CREATE|UPDATE)$/.test(verb)), [...DELIVERY_CONFIGURING_VERBS].sort());
    for (const verb of DELIVERY_CONFIGURING_VERBS) {
      assert.ok(verbs.includes(verb), `${verb} is no longer in the library surface; the pairing is stale`);
      let cls: string | undefined;
      try { cls = deliveryClassOf(`$JS.API.${verb}.s`); } catch { cls = undefined; }
      assert.notEqual(cls, "api-envelope", `${verb} configures server-side delivery and cannot be an envelope`);
    }
    observations.clientApiSurface = { verbs: verbs.length, classified: classified.length, refused: refused.length };
  });

  await check("no cell asserts a concurrent operation has not settled from one sample", async () => {
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const suites = ["implementations/auth/smoke/issued-authority-lifecycle.smoke.ts",
      "implementations/auth/smoke/issued-callout-binding.smoke.ts"];
    let guarded = 0;
    for (const file of suites) {
      const source = readFileSync(join(root, file), "utf8");
      assert.deepEqual(singleSampledHoldAssertions(source), [], `${file} samples a settling operation once`);
      guarded += [...source.matchAll(/assert\.\w+\(\s*(?:!)?settled\b/g)].length;
    }
    // Without this, an empty scan and a scan of the wrong thing look identical.
    assert.ok(guarded >= 2, `found ${guarded} hold assertions; the scan is not reading the suites`);
    observations.holdAssertions = guarded;
  });

  await check("every cell and mutation the claim ledger cites still exists", async () => {
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const ledger = readFileSync(join(root, "packages/core/smoke/prototypes/CLAIMS.md"), "utf8");
    const { cells, mutations } = ledgerCitations(ledger);
    assert.ok(cells.length >= 20 && mutations.length >= 20, `the extractor found ${cells.length} cells and ${mutations.length} mutations; it is not reading the ledger`);
    const suites = ["packages/core/smoke/issued-subject-permissions.smoke.ts",
      "implementations/auth/smoke/issued-authority-lifecycle.smoke.ts",
      "implementations/auth/smoke/issued-static-binding.smoke.ts",
      "implementations/auth/smoke/issued-callout-binding.smoke.ts",
      "implementations/auth/smoke/issued-profile-census.smoke.ts",
      "implementations/auth/smoke/issued-ingress-origin.smoke.ts"];
    const known = new Set(suites.flatMap((file) => suiteCellNames(readFileSync(join(root, file), "utf8"))));
    assert.deepEqual(cells.filter((name) => !known.has(name)), []);
    const configs = ["packages/core/smoke/mutations/issued-subject-permissions-prototype.json",
      "implementations/auth/smoke/mutations/issued-authority-lifecycle-prototype.json",
      "implementations/auth/smoke/mutations/issued-static-binding-prototype.json",
      "implementations/auth/smoke/mutations/issued-callout-binding-prototype.json",
      "implementations/auth/smoke/mutations/issued-profile-census-prototype.json"];
    const named = new Set(configs.flatMap((file) => (JSON.parse(readFileSync(join(root, file), "utf8")) as { mutations: { name: string }[] }).mutations.map((m) => m.name)));
    assert.deepEqual(mutations.filter((name) => !named.has(name)), []);
    observations.ledgerCitations = { cells: cells.length, mutations: mutations.length };
  });

  await check("no shipped source imports the prototypes", async () => {
    // The README says these files are attached to nothing shipped. That is cheap to falsify, so
    // it should be a cell rather than a promise.
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const importers = shippedSources(root).filter((file) => /smoke\/prototypes/.test(readFileSync(file, "utf8")));
    assert.deepEqual(importers.map((f) => f.slice(root.length)), []);
  });

  await check("no current profile can request its own server view", async () => {
    // Discovery needs `$SYS.REQ.USER.INFO`. If some profile already had it, adding it would not be
    // part of the issuance change; this pins that it is.
    // Positive control first: an emptiness result from a detector that finds nothing is worthless.
    assert.equal(holdsServerView({ pub: { allow: ["$SYS.REQ.USER.INFO"] } }), true);
    assert.equal(holdsServerView({ pub: { allow: [">"] } }), true);
    assert.equal(holdsServerView({ pub: { allow: ["cotal.x.>"] } }), false);
    assert.deepEqual(fixtures.filter((f) => holdsServerView(f.permissions)).map((f) => `${f.profile}/${f.variant}`), []);
  });

  await check("no shipped source emits an issued-rail subject, under any option combination", async () => {
    // The per-variant checks above cover representative options only. This closes the rest: a
    // namespace no shipped builder ever writes cannot be reached by any option combination.
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const files = shippedSources(root);
    const offenders = files.filter((file) => /ep\.v1/.test(readFileSync(file, "utf8")));
    assert.deepEqual(offenders.map((f) => f.slice(root.length)), []);
    // Positive control: the corpus really contains the endpoint subject builders it must cover.
    assert.ok(files.some((file) => /function epRequestSubject/.test(readFileSync(file, "utf8"))), `scanned ${files.length} files without reaching the subject builders`);
    observations.shippedSourcesScanned = files.length;
  });

  await check("the write-plus-raw-read detector finds the known trusted overlaps", async () => {
    // Positive control: without it, a detector that silently found nothing would pass the
    // invariant below while measuring nothing at all.
    const overlaps = fixtures.map((f) => ({ profile: f.profile, variant: f.variant, streams: writeAndRawReadStreams(f.permissions, space) }))
      .filter((row) => row.streams.length > 0);
    const named = (profile: string) => overlaps.some((row) => row.profile === profile);
    assert.ok(named("run-mediator") && named("provisioner"), `expected trusted overlaps, got ${JSON.stringify(overlaps)}`);
    observations.trustedOverlaps = overlaps;
  });

  await check("no peer-held profile can both write and raw-read one stream", async () => {
    // A credential holding both could place bytes of its own choosing under any subject, which is
    // the one condition that turns the measured deputy paths into a forged request on the rail.
    for (const fixture of fixtures) {
      if (!PEER_HELD_PROFILES.includes(fixture.profile as never)) continue;
      const streams = writeAndRawReadStreams(fixture.permissions, space);
      assert.deepEqual(streams, [], `${fixture.profile}/${fixture.variant} pairs write and raw read on ${streams.join(", ")}`);
    }
  });

  await check("a ceiling carrying the contract's own grants adds no write-plus-raw-read overlap", async () => {
    // The recommended discovery mechanism gives a client a DIRECT.GET on the accepted-row bucket,
    // which is a raw stream read. It is only safe because the client cannot write that bucket, so
    // check that rather than assume it, and check the opposite pairing is still caught.
    const base = fixtures.find((f) => f.profile === "agent" && f.variant === "default")!.permissions;
    const token = "b".repeat(32);
    const withRead = { ...base, pub: { ...(base.pub as object), allow: [...((base.pub as { allow: string[] }).allow), acceptedReadGrant(space, token)] } };
    assert.deepEqual(writeAndRawReadStreams(withRead, space), []);
    const alsoWritable = { ...withRead, pub: { ...(withRead.pub as object), allow: [...withRead.pub.allow, `$KV.cotal_accepted_${space}.>`] } };
    assert.deepEqual(writeAndRawReadStreams(alsoWritable, space), [`KV_cotal_accepted_${space}`]);
  });

  await check("every profile is classified peer-held or trusted", async () => {
    // Peer-heldness is a deployment property, so nothing here can settle the partition. The closed
    // union only makes a NEW profile fail rather than drift into "trusted" by default.
    const all = [...new Set(fixtures.map((f) => f.profile))].sort();
    const classified = [...PEER_HELD_PROFILES, ...TRUSTED_PROFILES].sort();
    assert.deepEqual(classified, all);
    assert.equal(new Set(classified).size, classified.length, "a profile is classified twice");
  });

  const report = {
    profileCount: new Set(fixtures.map((f) => f.profile)).size, variantCount: fixtures.length,
    nativeProfileDecisions: fixtures.length * subjects.length * 2,
    nonProfileKinds: ["membership-observer", "connection-evictor"],
    refusedCalloutViews: ["manager-service"],
    scope: "All Profile names, representative option variants, and every generic callout view. Endpoint-serve uses raw grant rows, not a fenced mint. System-account credentials and other option combinations are outside the native matrix. Namespace intersection is conservative; native samples cover one concrete request and reply in both directions. Queue-qualified normalization remains unsupported.",
    rows: reports, peerHeldProfiles: PEER_HELD_PROFILES, ...observations,
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
