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
import { createSpaceAuth, serverConfig, isReachable, epRequestObserveFilter, token, type EpRequestObserveScope } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { importNativeSubjectPermissions } from "../../../packages/core/smoke/prototypes/issued-subject-permissions.js";
import { acceptedReadGrant } from "../../../packages/core/smoke/prototypes/issued-accepted-row.js";
import { profileFixtures, namespaceGrants, namespaceOverlap, writeAndRawReadStreams, shippedSources, issuedRailLiterals, holdsServerView, ledgerCitations, suiteCellNames, clientApiVerbs, DELIVERY_CONFIGURING_VERBS, singleSampledHoldAssertions, peerOptionSweep, TRUSTED_PROFILES, deliveryPaths, deliveryClassOf, PEER_HELD_PROFILES, type ProfileFixture } from "./prototypes/issued-profile-census.js";

import { servedRunRequestSubjects } from "../src/authority-client.js";

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
await check("profile and view producers cover their declared sets", async () => { fixtures = await profileFixtures(space); });
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
  const tap = operator.subscribe(`cotal.${space}.ep.>`);
  for (const inbox of ["_INBOX_census0123456789abcdef.>", "_INBOX_other0123456789abcdef.>"]) {
    const inboxTap = operator.subscribe(inbox);
    void (async () => { for await (const msg of inboxTap) seen.add(new TextDecoder().decode(msg.data)); })();
  }
  void (async () => { for await (const msg of tap) seen.add(new TextDecoder().decode(msg.data)); })();
  await operator.flush();
  const uid = "u".repeat(26), generation = "a".repeat(32), nonce = "n".repeat(22);
  const subjects = [
    `cotal.${space}.ep.v1.one.manager.run-start.local.census.${uid}.${generation}.${nonce}`,
    `cotal.${space}.ep.v1.reply.manager.${"i".repeat(26)}.1.local.census.${uid}.${generation}.${nonce}`,
  ];
  async function measure(permissions: Record<string, unknown>, probes = subjects) {
    const nc = await open(permissions);
    let errors = 0;
    void (async () => { for await (const event of nc.status()) if (event.type === "error" && /permission/i.test(String(event.error))) errors++; })();
    const results: Array<{ subject: string; publish: boolean; subscribe: boolean }> = [];
    for (const subject of probes) {
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
  const callerTail = `local.census.${uid}.${generation}.${nonce}`;
  const request = `cotal.${space}.ep.v1.inst.test_example_census.${"i".repeat(26)}.increment.${callerTail}`;
  const reply = `cotal.${space}.ep.v1.reply.test_example_census.${"i".repeat(26)}.1.${callerTail}`;
  const callerProbes: Array<{ subject: string; publish: boolean; subscribe: boolean }> = [
    { subject: request, publish: true, subscribe: false },
    { subject: request.replace(".increment.", ".describe."), publish: true, subscribe: false },
    { subject: reply, publish: false, subscribe: true },
    // Reply attribution is wildcarded, not confined to the request's endpoint or instance.
    { subject: reply.replace("test_example_census", "other_example_census").replace("i".repeat(26), "j".repeat(26)).replace(".1.local.", ".2.local."), publish: false, subscribe: true },
    { subject: "_INBOX_census0123456789abcdef.test", publish: false, subscribe: true },
  ];
  const forbiddenRequests = [
    request.replace(".ep.v1.", ".ep."),
    ...["one", "all"].map((route) => request.replace(`inst.test_example_census.${"i".repeat(26)}`, `${route}.test_example_census`)),
    request.replace(".increment.", ".ungranted."),
    request.replace("test_example_census", "other_example_census"),
    request.replace("i".repeat(26), "j".repeat(26)),
  ];
  const forbiddenReplies = [reply.replace(".ep.v1.", ".ep."), "_INBOX_other0123456789abcdef.test"];
  for (const subject of [request, reply]) {
    for (const [from, to] of [[".local.", ".other."], [".census.", ".peer."], [uid, "v".repeat(26)], [generation, "b".repeat(32)]] as const) {
      (subject === request ? forbiddenRequests : forbiddenReplies).push(subject.replace(from, to));
    }
    (subject === request ? forbiddenRequests : forbiddenReplies).push(`${subject}.extra`, subject.slice(0, subject.lastIndexOf(".")));
  }
  callerProbes.push(...[...forbiddenRequests, ...forbiddenReplies].map((subject) => ({ subject, publish: false, subscribe: false })));
  // The same actual native controls validate every new positive and negative probe.
  await check("native endpoint-caller probe controls exercise both permission directions", async () => {
    assert.ok((await measure({ pub: { allow: [">"] }, sub: { allow: [">"] } }, callerProbes.map((p) => p.subject))).every((r) => r.publish && r.subscribe));
    assert.ok((await measure({ pub: { deny: [">"] }, sub: { deny: [">"] } }, callerProbes.map((p) => p.subject))).every((r) => !r.publish && !r.subscribe));
  });
  for (const fixture of fixtures) {
    if (fixture.profile === "endpoint-caller") {
      await check("endpoint-caller holds only pinned instance requests and its own issued replies", async () => {
        const pub = namespaceGrants(fixture.permissions, space, "pub");
        const sub = namespaceGrants(fixture.permissions, space, "sub");
        const native = await measure(fixture.permissions);
        const measured = await measure(fixture.permissions, callerProbes.map((p) => p.subject));
        assert.deepEqual(measured, callerProbes, JSON.stringify(measured));
        const requestRows = ["describe", "increment"].map((command) => `cotal.${space}.ep.v1.inst.test_example_census.${"i".repeat(26)}.${command}.local.census.${uid}.${generation}.*`);
        const replyRows = [`cotal.${space}.ep.v1.reply.*.*.*.local.census.${uid}.${generation}.*`];
        assert.deepEqual(pub, { overlaps: requestRows, deny: [], potential: true });
        assert.deepEqual(sub, { overlaps: replyRows, deny: [], potential: true });
        // Close the entire permission object, including the two restricted metadata reads.
        assert.deepEqual(fixture.permissions, {
          pub: { allow: [`$JS.API.DIRECT.GET.EPC_${space}.cotal.${space}.epc.>`, `$JS.API.DIRECT.GET.KV_cotal_accepted_${space}.$KV.cotal_accepted_${space}.accepted.v1.${generation}`, ...requestRows] },
          sub: { allow: ["_INBOX_census0123456789abcdef.>", ...replyRows] },
        });
        assert.deepEqual(native.map((r) => [r.publish, r.subscribe]), [[false, false], [false, true]], JSON.stringify(native));
        observations.endpointCaller = { probes: measured, nativeDecisions: measured.length * 2 };
        let normalization: string = "supported";
        try { importNativeSubjectPermissions(fixture.permissions); }
        catch (error) { normalization = (error as Error).message; }
        reports.push({ profile: fixture.profile, variant: fixture.variant, producer: fixture.producer, pub, sub, normalization, native, endpointCaller: measured });
      });
      continue;
    }
    await check(`current profile excludes issued namespace: ${fixture.profile}/${fixture.variant}`, async () => {
      const pub = namespaceGrants(fixture.permissions, space, "pub");
      const sub = namespaceGrants(fixture.permissions, space, "sub");
      const native = await measure(fixture.permissions);
      let normalization: string = "supported";
      try { importNativeSubjectPermissions(fixture.permissions); }
      catch (error) { normalization = (error as Error).message; }
      reports.push({ profile: fixture.profile, variant: fixture.variant, producer: fixture.producer, pub, sub, normalization, native });
      if (fixture.profile === "endpoint-serve") {
        // The serving profile on the versioned rail (SPEC 13.15): an endpoint serves both
        // rails, so its rows reach `ep.v1` on the reply publish (attribution-pinned, one more
        // spanned token) and the three subscribe shapes per command. Never a request form: the
        // serve credential cannot spell a request on either rail.
        assert.deepEqual(pub.overlaps, pub.overlaps.filter((row) => /\.ep\.v1\.reply\./.test(row)), JSON.stringify(pub));
        assert.ok(pub.overlaps.length === 1, JSON.stringify(pub));
        assert.deepEqual(sub.overlaps, sub.overlaps.filter((row) => /\.ep\.v1\.(one|all|inst)\./.test(row)), JSON.stringify(sub));
        assert.deepEqual(native.map((r) => [r.publish, r.subscribe]), [[false, false], [true, false]], JSON.stringify(native));
        return;
      }
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

  await check("the syntax census distinguishes prose from decoded literal occurrences", async () => {
    const controls: [string, string, boolean][] = [
      ["line-comment", "// ep.v1\nconst x = 1;", false],
      ["block-comment", "/* ep.v1 */ const x = 1;", false],
      ["jsdoc", "/** ep.v1 */ function x() {}", false],
      ["single-quoted", "const x = 'ep.v1';", true],
      ["double-quoted", 'const x = "ep.v1";', true],
      ["comment-delimiters-in-string", 'const x = "/* ep.v1 */";', true],
      ["escaped-hex", String.raw`const x = "\x65p.v1";`, true],
      ["escaped-unicode", String.raw`const x = "ep.\u00761";`, true],
      ["template-no-hole", "const x = `ep.v1`;", true],
      ["template-head", "const x = `ep.v1${unknown}`;", true],
      ["template-middle", "const x = `${a}ep.v1${b}`;", true],
      ["template-tail", "const x = `${a}ep.v1`;", true],
      ["template-interpolation", "const x = `${'ep.v1'}`;", true],
      ["escaped-template", String.raw`const x = ` + "`" + String.raw`ep.\u00761` + "${a}`;", true],
      ["unknown-hole-not-joined", "const x = `ep.${unknown}`;", false],
      ["split-static-parts-not-joined", "const x = `ep.${unknown}v1`;", false],
      ["regex-is-not-string", String.raw`const x = /ep\.v1/;`, false],
      ["division", "const x = 12 / 3;", false],
      ["type-literal-conservative", 'type X = "ep.v1";', true],
      ["interface-key-conservative", 'interface X { "ep.v1": string }', true],
      ["property-key", 'const x = { "ep.v1": true };', true],
      ["import-path-conservative", 'import "ep.v1";', true],
      ["substring-not-narrowed", 'const x = "ep.v10";', true],
    ];
    const sources = new Map(controls.map(([name, source]) => [`/census-controls/${name}.ts`, source]));
    const found = issuedRailLiterals(sources);
    for (const [name, , expected] of controls) assert.equal(found.get(`/census-controls/${name}.ts`), expected, name);
    assert.throws(() => issuedRailLiterals(new Map([["/census-controls/malformed.ts", "const x = `unterminated"]])), /census syntax refused/);
    const root = fileURLToPath(new URL("../../..", import.meta.url)), bin = join(root, "bin/cotal.ts");
    assert.equal(issuedRailLiterals(new Map([[bin, readFileSync(bin, "utf8") + '\nvoid "ep.v1";']])).get(bin), true, "bin literal control");
  });

  await check("the issued rail is spelled only by core's endpoint subject and grant builders", async () => {
    // This confines detectable decoded string/template occurrences, including erased syntax.
    // It does not prove arbitrary computed subjects or complete runtime construction ownership.
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const files = shippedSources(root);
    const builders = ["packages/core/src/endpoint-subjects.ts", "packages/core/src/endpoint-grants.ts",
      "packages/core/src/endpoint-serve.ts", "packages/core/src/issued-authority.ts"];
    // Inherited generated prose-data exception, not a complete all-code guarantee.
    const prose = "extensions/connector-core/src/docs-bundle.generated.ts";
    const corpus = new Map(files.filter(file => file.slice(root.length) !== prose).map(file => [file, readFileSync(file, "utf8")]));
    const spelled = [...issuedRailLiterals(corpus)].filter(([, found]) => found).map(([file]) => file.slice(root.length));
    assert.deepEqual(spelled.filter(file => !builders.includes(file)).sort(), []);
    assert.ok(builders.every(builder => files.some(file => file.slice(root.length) === builder)), "the corpus no longer reaches all four builders");
    // Positive control: the corpus really contains the endpoint subject builders it must cover.
    assert.ok(files.some((file) => /function epRequestSubject/.test(readFileSync(file, "utf8"))), `scanned ${files.length} files without reaching the subject builders`);
    // The published composition root is shipped code. A negative claim about shipped code that
    // silently stops covering it would still pass the control above, which lives in core.
    assert.ok(files.some((file) => file.endsWith("/bin/cotal.ts")), "the corpus no longer reaches the published composition root");
    observations.shippedSourcesScanned = files.length;
  });

  await check("the observer filter preflight precedes activation effects and is passed through once", async () => {
    const source = readFileSync(new URL("../src/endpoint-authority.ts", import.meta.url), "utf8");
    const begin = source.indexOf("    async activate("), end = source.indexOf("    async caller(", begin);
    assert.ok(begin >= 0 && end > begin, "actual activate source reached");
    const activate = source.slice(begin, end);
    const has = activate.indexOf('if (inFlight.has(row.endpoint)) refuse("another endpoint release is in flight");');
    const preflight = activate.indexOf('const observationFilter = epRequestObserveFilter(account.space, { kind: "issued-instance", endpoint: row.endpoint, instanceId: row.instanceId });');
    const add = activate.indexOf("inFlight.add(row.endpoint);");
    assert.ok(has >= 0 && has < preflight && preflight < add, "observer preflight must follow existing inFlight refusal and precede add");
    for (const effect of ["await acquireEndpointPolicyHold(", "await input.publishArtifact(", "await registerServiceInstance(", "await mintPublicUserJwt(", 'await createRowByteIdempotent(authKv, `endpoint-active.', "await authKv.update(reservationKey(row.instanceId)"])
      assert.ok(activate.indexOf(effect) > preflight, `preflight before ${effect}`);
    assert.equal(activate.split("epRequestObserveFilter(").length - 1, 1, "one preflight evaluation");
    assert.ok(source.includes("function observe(filter: string): void {\n    subscriptions.push(input.nc.subscribe(filter,"), "observer accepts string and subscribes without recomputation");
    const update = activate.indexOf("await authKv.update(reservationKey(row.instanceId)"), sub = activate.indexOf("observe(observationFilter); await input.nc.flush();"), release = activate.indexOf("await hold.release();", sub);
    assert.ok(update < sub && sub < release && activate.indexOf("finally { inFlight.delete(row.endpoint); }", release) > release, "late subscription/release/finally order retained");
  });

  await check("observer filters preserve independent bounded golden bytes and manager row order", async () => {
    const instanceId = "iiiiiiiiiiiiiiiiiiiiiiiiii", endpoint = "test.example.census";
    const examples: [EpRequestObserveScope, string][] = [
      [{ kind: "issued-instances" }, "cotal.observer-fixture.ep.v1.inst.>"],
      [{ kind: "issued-instance", endpoint, instanceId }, "cotal.observer-fixture.ep.v1.inst.test_example_census.iiiiiiiiiiiiiiiiiiiiiiiiii.*.>"],
      [{ kind: "command", rail: "v1", endpoint, command: "increment", route: { mode: "inst", instanceId: "*" } }, "cotal.observer-fixture.ep.v1.inst.test_example_census.*.increment.>"],
      [{ kind: "command", rail: "v1", endpoint, command: "increment", route: { mode: "inst", instanceId } }, "cotal.observer-fixture.ep.v1.inst.test_example_census.iiiiiiiiiiiiiiiiiiiiiiiiii.increment.>"],
      [{ kind: "command", rail: "v1", endpoint, command: "increment", route: { mode: "one" } }, "cotal.observer-fixture.ep.v1.one.test_example_census.increment.>"],
      [{ kind: "command", rail: "legacy", endpoint, command: "increment", route: { mode: "inst", instanceId: "*" } }, "cotal.observer-fixture.ep.inst.test_example_census.*.increment.>"],
      [{ kind: "command", rail: "legacy", endpoint, command: "increment", route: { mode: "inst", instanceId } }, "cotal.observer-fixture.ep.inst.test_example_census.iiiiiiiiiiiiiiiiiiiiiiiiii.increment.>"],
      [{ kind: "command", rail: "legacy", endpoint, command: "increment", route: { mode: "one" } }, "cotal.observer-fixture.ep.one.test_example_census.increment.>"],
    ];
    for (const [scope, expected] of examples) assert.equal(epRequestObserveFilter("observer-fixture", scope), expected);
    const normalizations = [
      { raw: "main", canonicalToken: "main", expectedHostedObserver: "cotal.main.ep.v1.inst.>",
        expectedManagerRows: [
          "cotal.main.ep.v1.inst.manager.*.run-start.>",
          "cotal.main.ep.v1.one.manager.run-start.>",
          "cotal.main.ep.v1.inst.manager.*.run-resume.>",
          "cotal.main.ep.v1.one.manager.run-resume.>",
          "cotal.main.ep.v1.inst.manager.*.run-answer.>",
          "cotal.main.ep.v1.one.manager.run-answer.>",
          "cotal.main.ep.inst.manager.*.run-answer.>",
          "cotal.main.ep.one.manager.run-answer.>",
        ] },
      { raw: "team.alpha", canonicalToken: "team_alpha", expectedHostedObserver: "cotal.team_alpha.ep.v1.inst.>",
        expectedManagerRows: [
          "cotal.team_alpha.ep.v1.inst.manager.*.run-start.>",
          "cotal.team_alpha.ep.v1.one.manager.run-start.>",
          "cotal.team_alpha.ep.v1.inst.manager.*.run-resume.>",
          "cotal.team_alpha.ep.v1.one.manager.run-resume.>",
          "cotal.team_alpha.ep.v1.inst.manager.*.run-answer.>",
          "cotal.team_alpha.ep.v1.one.manager.run-answer.>",
          "cotal.team_alpha.ep.inst.manager.*.run-answer.>",
          "cotal.team_alpha.ep.one.manager.run-answer.>",
        ] },
      { raw: " team.alpha ", canonicalToken: "team_alpha", expectedHostedObserver: "cotal.team_alpha.ep.v1.inst.>",
        expectedManagerRows: [
          "cotal.team_alpha.ep.v1.inst.manager.*.run-start.>",
          "cotal.team_alpha.ep.v1.one.manager.run-start.>",
          "cotal.team_alpha.ep.v1.inst.manager.*.run-resume.>",
          "cotal.team_alpha.ep.v1.one.manager.run-resume.>",
          "cotal.team_alpha.ep.v1.inst.manager.*.run-answer.>",
          "cotal.team_alpha.ep.v1.one.manager.run-answer.>",
          "cotal.team_alpha.ep.inst.manager.*.run-answer.>",
          "cotal.team_alpha.ep.one.manager.run-answer.>",
        ] },
      { raw: "team/*>", canonicalToken: "team___", expectedHostedObserver: "cotal.team___.ep.v1.inst.>",
        expectedManagerRows: [
          "cotal.team___.ep.v1.inst.manager.*.run-start.>",
          "cotal.team___.ep.v1.one.manager.run-start.>",
          "cotal.team___.ep.v1.inst.manager.*.run-resume.>",
          "cotal.team___.ep.v1.one.manager.run-resume.>",
          "cotal.team___.ep.v1.inst.manager.*.run-answer.>",
          "cotal.team___.ep.v1.one.manager.run-answer.>",
          "cotal.team___.ep.inst.manager.*.run-answer.>",
          "cotal.team___.ep.one.manager.run-answer.>",
        ] },
      { raw: "a/b", canonicalToken: "a_b", expectedHostedObserver: "cotal.a_b.ep.v1.inst.>",
        expectedManagerRows: [
          "cotal.a_b.ep.v1.inst.manager.*.run-start.>",
          "cotal.a_b.ep.v1.one.manager.run-start.>",
          "cotal.a_b.ep.v1.inst.manager.*.run-resume.>",
          "cotal.a_b.ep.v1.one.manager.run-resume.>",
          "cotal.a_b.ep.v1.inst.manager.*.run-answer.>",
          "cotal.a_b.ep.v1.one.manager.run-answer.>",
          "cotal.a_b.ep.inst.manager.*.run-answer.>",
          "cotal.a_b.ep.one.manager.run-answer.>",
        ] },
      { raw: "UPPER_01", canonicalToken: "UPPER_01", expectedHostedObserver: "cotal.UPPER_01.ep.v1.inst.>",
        expectedManagerRows: [
          "cotal.UPPER_01.ep.v1.inst.manager.*.run-start.>",
          "cotal.UPPER_01.ep.v1.one.manager.run-start.>",
          "cotal.UPPER_01.ep.v1.inst.manager.*.run-resume.>",
          "cotal.UPPER_01.ep.v1.one.manager.run-resume.>",
          "cotal.UPPER_01.ep.v1.inst.manager.*.run-answer.>",
          "cotal.UPPER_01.ep.v1.one.manager.run-answer.>",
          "cotal.UPPER_01.ep.inst.manager.*.run-answer.>",
          "cotal.UPPER_01.ep.one.manager.run-answer.>",
        ] },
      { raw: "u_example-member", canonicalToken: "u_example-member", expectedHostedObserver: "cotal.u_example-member.ep.v1.inst.>",
        expectedManagerRows: [
          "cotal.u_example-member.ep.v1.inst.manager.*.run-start.>",
          "cotal.u_example-member.ep.v1.one.manager.run-start.>",
          "cotal.u_example-member.ep.v1.inst.manager.*.run-resume.>",
          "cotal.u_example-member.ep.v1.one.manager.run-resume.>",
          "cotal.u_example-member.ep.v1.inst.manager.*.run-answer.>",
          "cotal.u_example-member.ep.v1.one.manager.run-answer.>",
          "cotal.u_example-member.ep.inst.manager.*.run-answer.>",
          "cotal.u_example-member.ep.one.manager.run-answer.>",
        ] },
      { raw: "", canonicalToken: "_", expectedHostedObserver: "cotal._.ep.v1.inst.>",
        expectedManagerRows: [
          "cotal._.ep.v1.inst.manager.*.run-start.>",
          "cotal._.ep.v1.one.manager.run-start.>",
          "cotal._.ep.v1.inst.manager.*.run-resume.>",
          "cotal._.ep.v1.one.manager.run-resume.>",
          "cotal._.ep.v1.inst.manager.*.run-answer.>",
          "cotal._.ep.v1.one.manager.run-answer.>",
          "cotal._.ep.inst.manager.*.run-answer.>",
          "cotal._.ep.one.manager.run-answer.>",
        ] },
      { raw: " \t\n", canonicalToken: "_", expectedHostedObserver: "cotal._.ep.v1.inst.>",
        expectedManagerRows: [
          "cotal._.ep.v1.inst.manager.*.run-start.>",
          "cotal._.ep.v1.one.manager.run-start.>",
          "cotal._.ep.v1.inst.manager.*.run-resume.>",
          "cotal._.ep.v1.one.manager.run-resume.>",
          "cotal._.ep.v1.inst.manager.*.run-answer.>",
          "cotal._.ep.v1.one.manager.run-answer.>",
          "cotal._.ep.inst.manager.*.run-answer.>",
          "cotal._.ep.one.manager.run-answer.>",
        ] },
      { raw: "-leading", canonicalToken: "-leading", expectedHostedObserver: "cotal.-leading.ep.v1.inst.>",
        expectedManagerRows: [
          "cotal.-leading.ep.v1.inst.manager.*.run-start.>",
          "cotal.-leading.ep.v1.one.manager.run-start.>",
          "cotal.-leading.ep.v1.inst.manager.*.run-resume.>",
          "cotal.-leading.ep.v1.one.manager.run-resume.>",
          "cotal.-leading.ep.v1.inst.manager.*.run-answer.>",
          "cotal.-leading.ep.v1.one.manager.run-answer.>",
          "cotal.-leading.ep.inst.manager.*.run-answer.>",
          "cotal.-leading.ep.one.manager.run-answer.>",
        ] },
      { raw: "trailing-", canonicalToken: "trailing-", expectedHostedObserver: "cotal.trailing-.ep.v1.inst.>",
        expectedManagerRows: [
          "cotal.trailing-.ep.v1.inst.manager.*.run-start.>",
          "cotal.trailing-.ep.v1.one.manager.run-start.>",
          "cotal.trailing-.ep.v1.inst.manager.*.run-resume.>",
          "cotal.trailing-.ep.v1.one.manager.run-resume.>",
          "cotal.trailing-.ep.v1.inst.manager.*.run-answer.>",
          "cotal.trailing-.ep.v1.one.manager.run-answer.>",
          "cotal.trailing-.ep.inst.manager.*.run-answer.>",
          "cotal.trailing-.ep.one.manager.run-answer.>",
        ] },
    ];
    for (const { raw, canonicalToken, expectedManagerRows, expectedHostedObserver } of normalizations) {
      assert.equal(token(raw), canonicalToken);
      assert.equal(token(canonicalToken), canonicalToken);
      assert.deepEqual(servedRunRequestSubjects(raw), expectedManagerRows);
      // This is the hosted normalizer algebra, not an invalid public-host activation witness.
      assert.equal(epRequestObserveFilter(token(raw), { kind: "issued-instances" }), expectedHostedObserver);
    }
    assert.equal(Math.max(...servedRunRequestSubjects("a".repeat(984)).map(row => Buffer.byteLength(row))), 1024);
    assert.throws(() => servedRunRequestSubjects("a".repeat(985)), /subject exceeds/);
    assert.equal(Buffer.byteLength(epRequestObserveFilter("a".repeat(1005), { kind: "issued-instances" })), 1024);
    assert.throws(() => epRequestObserveFilter("a".repeat(1006), { kind: "issued-instances" }), /subject exceeds/);
    const exact = { kind: "issued-instance", endpoint, instanceId } as const;
    const overhead = Buffer.byteLength("cotal..ep.v1.inst.test_example_census.iiiiiiiiiiiiiiiiiiiiiiiiii.*.>");
    assert.equal(Buffer.byteLength(epRequestObserveFilter("a".repeat(1024 - overhead), exact)), 1024);
    assert.throws(() => epRequestObserveFilter("a".repeat(1025 - overhead), exact), /subject exceeds/);
    const invoke = (space: unknown, scope: unknown) => epRequestObserveFilter(space as string, scope as EpRequestObserveScope);
    for (const invalid of ["", " ", "team.alpha", "team/*>", null, 12, {}, undefined]) assert.throws(() => invoke(invalid, exact));
    const badScopes: unknown[] = [null, [], {}, { kind: "issued-instances", extra: true }, { kind: "issued-instance", endpoint }, { ...exact, instanceId: "*" }, { ...exact, instanceId: "bad.id" }, { ...exact, endpoint: "" }, { ...exact, endpoint: "test.*" }, { ...exact, endpoint: 42 }, { ...exact, instanceId: 42 }];
    const command = { kind: "command", rail: "v1", endpoint, command: "increment", route: { mode: "one" } };
    badScopes.push({ ...command, rail: "v2" }, { ...command, extra: true }, { ...command, route: { mode: "all" } }, { ...command, route: { mode: "inst" } }, { ...command, route: { mode: "one", instanceId } }, { ...command, route: { mode: "inst", instanceId, extra: true } });
    for (const value of ["", ".", "with.dot", "with space", "*", ">", 42]) badScopes.push({ ...command, command: value });
    badScopes.push(Object.create({ kind: "issued-instances" }));
    badScopes.push({ kind: "issued-instances", [Symbol("unknown")]: true });
    badScopes.push(Object.defineProperty({ kind: "issued-instances" }, "unknown", { value: true }));
    for (const scope of badScopes) assert.throws(() => invoke("observer-fixture", scope));
    for (const invalid of [null, undefined, 12]) assert.throws(() => servedRunRequestSubjects(invalid as unknown as string));
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

  await check("peers hold the push-consumer door and none of the republish doors", async () => {
    const peers = new Set<string>(PEER_HELD_PROFILES as readonly string[]);
    const held = new Map<string, Set<string>>(DELIVERY_CONFIGURING_VERBS.map((v) => [v, new Set<string>()]));
    let seen = 0;
    for (const fixture of fixtures) {
      if (!peers.has(fixture.profile as string)) continue;
      for (const { row } of deliveryPaths(fixture.permissions)) {
        // longest verb first, or DURABLE.CREATE reads as CREATE
        const verb = [...DELIVERY_CONFIGURING_VERBS].sort((a, b) => b.length - a.length)
          .find((v) => row.startsWith(`$JS.API.${v}.`));
        if (verb) held.get(verb)!.add(fixture.profile as string);
        seen++;
      }
    }
    // Without a control, a scan that reads nothing looks exactly like a clean result.
    assert.ok(seen > 50, `only ${seen} peer-held broker rows scanned; the scan is not reading the fixtures`);
    // A stream create or update can carry `republish`, which would let the server publish stored
    // messages to a destination the holder names. No peer may hold either.
    assert.deepEqual([...held.get("STREAM.CREATE")!], []);
    assert.deepEqual([...held.get("STREAM.UPDATE")!], []);
    // The legacy consumer-create spelling is not granted anywhere, so the modern subject is the
    // only push-consumer door a peer has.
    assert.deepEqual([...held.get("CONSUMER.DURABLE.CREATE")!], []);
    // This one IS held, and the origin argument does not rest on its absence. It rests on push
    // delivery being interest-gated, which is measured separately.
    assert.deepEqual([...held.get("CONSUMER.CREATE")!].sort(), ["agent", "observer", "run-driver"]);
    observations.pushConsumerHolders = [...held.get("CONSUMER.CREATE")!].sort();
  });

  await check("no peer option combination pairs a write with a raw stream read", async () => {
    // The fixtures carry representative variants only, so invariant 1 was measured over a space
    // far smaller than the one it is stated over. Options change what permissionsFor emits.
    const swept = peerOptionSweep(space, { owner: "local", actor: "sweep", connId: "sweep0123456789abcdef", lifecycleUid: "u".repeat(26) });
    assert.ok(swept.length >= 1000, `only ${swept.length} option combinations built; the sweep has lost a dimension`);
    const offenders = swept.filter((row) => writeAndRawReadStreams(row.permissions, space).length)
      .map((row) => `${row.label}: ${writeAndRawReadStreams(row.permissions, space).join(",")}`);
    assert.deepEqual(offenders, []);
    // Positive control: a peer shape that really does pair the two must be caught, or the empty
    // result above is a property of the detector rather than of the credentials.
    const base = swept[0].permissions;
    const poisoned = { ...base, pub: { allow: [...((base.pub as { allow: string[] }).allow), `$KV.cotal_channels_${space}.>`, `$JS.API.DIRECT.GET.KV_cotal_channels_${space}.>`] } };
    assert.deepEqual(writeAndRawReadStreams(poisoned, space), [`KV_cotal_channels_${space}`]);
    observations.peerOptionCombinations = swept.length;
  });

  const report = {
    profileCount: new Set(fixtures.map((f) => f.profile)).size, variantCount: fixtures.length,
    nativeProfileDecisions: fixtures.length * subjects.length * 2,
    nonProfileKinds: ["membership-observer", "connection-evictor"],
    refusedCalloutViews: ["manager-service", "endpoint-caller"],
    scope: "All Profile names, representative option variants, and every generic callout view. Endpoint-serve uses raw grant rows, not a fenced mint, and reaches the versioned rail through reply publish and serve subscriptions. Endpoint-caller is measured from permissionsFor with closed instance-only request rows, its own generation-pinned replies, private inbox and restricted metadata reads. Its additional native decisions are reported separately and do not prove the issuer hook or registered authority ceremony. System-account credentials and other option combinations are outside the native matrix. Namespace intersection is conservative; native samples cover one concrete request and reply in both directions. Queue-qualified normalization remains unsupported.",
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
