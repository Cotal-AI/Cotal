/**
 * Issued-authority retention (SPEC 13.12, 13.15) on a real nats-server: every row of a generation
 * carries its own TTL to the generation's horizon plus the retention margin, the broker removes it,
 * and no reader looks at a generation's keys at or after its horizon, so a key the broker removed and
 * someone re-created is never read as that generation's row. The stores are the shipped ones, created
 * and verified by `ensureIssuedStores`, and every write and read goes through `openIssuedStore`.
 *
 * It waits for real expiry, so it runs for about a minute and a half.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { DiscardPolicy, jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import { Kvm, type KV } from "@nats-io/kv";
import {
  acceptedBucket, acceptedKey, ensureIssuedStores, importNativeSubjectPermissions, issuedAttemptKey,
  issuedBucket, issuedEvidenceKey, issuedHorizon, issuedSourceIndexKey, issuedStoreStreamNames, mintAcceptedToken,
  mintGeneration, openIssuedStore, writeAcceptedRow, ISSUED_RETAIN_MARGIN_SEC,
  type IssuedAuthorityRef, type IssuedEvidence, type IssuedSourceRef, type IssuedStore,
} from "../src/issued-authority.js";
import { createSpaceAuth, mintCreds } from "../src/provision.js";
import { newIdentity } from "../src/identity.js";
import { canonicalJson, rawDigest } from "../src/canonical.js";
import {
  SMOKE_BROKER_TOKEN, awaitBrokerReady, killAndAwaitExit, teardownOnSignal, emitSentinel,
} from "@cotal-ai/smoke-kit";
import { isReachable } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

let passed = 0, failed = 0;
async function check(name: string, run: () => Promise<void>): Promise<void> {
  try { await run(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ FAIL: ${name}`, error); }
}
const nowSec = (): number => Math.floor(Date.now() / 1000);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();

const port = await pickFreePort();
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", dir, "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);
let nc: NatsConnection | undefined;
try {
  const servers = `nats://127.0.0.1:${port}`;
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  nc = await connect({ servers });
  const jsm = await jetstreamManager(nc);
  const kvm = new Kvm(nc);
  const space = "u_retention-member";
  const [issuedStream, acceptedStream] = issuedStoreStreamNames(space);
  const source: IssuedSourceRef = { space, bucket: `cotal_auth_${space}`, key: `cred.${"a".repeat(26)}` };
  const permissions = importNativeSubjectPermissions({ pub: { allow: [`cotal.${space}.chat.local.caller.build`] }, sub: { deny: [">"] } });
  const refFor = (horizon: number, actor = "caller"): IssuedAuthorityRef => ({ space, owner: "local", actor, uid: "a".repeat(26), generation: mintGeneration(horizon) });

  // A store as every release before this one created it: the same immutable flags and per-key
  // shape, and no per-message TTL. It is the upgrade path's starting point.
  await check("a store created before bounded retention is refused at bind with the recreate remedy, and recreated after the operator removes it", async () => {
    for (const [bucket, perKey] of [[issuedBucket(space), { max_msgs_per_subject: -1 }], [acceptedBucket(space), { max_msgs_per_subject: 1, discard: DiscardPolicy.New, discard_new_per_subject: true }]] as const) {
      await kvm.create(bucket, { allow_direct: bucket === acceptedBucket(space) });
      const created = (await jsm.streams.info(`KV_${bucket}`)).config;
      await jsm.streams.update(`KV_${bucket}`, { ...created, allow_rollup_hdrs: false, deny_delete: true, deny_purge: true, ...perKey });
    }
    await assert.rejects(() => ensureIssuedStores(jsm, kvm, space),
      new RegExp(`created before bounded retention.*delete the streams ${issuedStream} and ${acceptedStream}`));
    for (const stream of [issuedStream, acceptedStream]) assert.equal((await jsm.streams.info(stream)).config.allow_msg_ttl, false, "the refusal changed nothing");
    // The operator's step: remove both streams (after backing them up), then start the release.
    for (const stream of [issuedStream, acceptedStream]) await jsm.streams.delete(stream);
    await ensureIssuedStores(jsm, kvm, space);
    for (const stream of [issuedStream, acceptedStream]) {
      const cfg = (await jsm.streams.info(stream)).config;
      assert.equal(cfg.allow_msg_ttl, true);
      assert.equal(cfg.subject_delete_marker_ttl ?? 0, 0);
      assert.equal(cfg.deny_delete, true);
      assert.equal(cfg.deny_purge, true);
      assert.equal(cfg.allow_rollup_hdrs, false);
      assert.equal(cfg.max_age, 0);
    }
  });

  const kv = await kvm.open(issuedBucket(space));
  const accepted = await kvm.open(acceptedBucket(space));
  // Counts the reads the store makes, so a refusal can be shown to come before the store is read.
  let reads = 0;
  const counted = new Proxy(jsm, {
    get(target, prop, receiver) {
      if (prop !== "streams") return Reflect.get(target, prop, receiver);
      return new Proxy(target.streams, {
        get(streams, name, r) {
          const value = Reflect.get(streams, name, r);
          if (name !== "getMessage" || typeof value !== "function") return typeof value === "function" ? value.bind(streams) : value;
          return (...args: unknown[]) => { reads++; return (value as (...a: unknown[]) => unknown).apply(streams, args); };
        },
      });
    },
  }) as JetStreamManager;
  const store: IssuedStore = openIssuedStore(kv, counted, space);
  const issue = async (ref: IssuedAuthorityRef, token: string): Promise<IssuedEvidence> => {
    const evidence: IssuedEvidence = { version: 1, ref, sources: [source], permissions };
    await store.release(await store.stage(evidence), async () => {});
    await writeAcceptedRow(accepted, token, ref);
    return evidence;
  };
  const ttlOf = async (stream: string, subject: string, at: "first" | "last"): Promise<number> => {
    const m = await jsm.streams.getMessage(stream, (at === "first" ? { next_by_subj: subject } : { last_by_subj: subject }) as never);
    const value = m?.header?.get("Nats-TTL");
    assert.match(value ?? "", /^\d+s$/, `${subject} carries a Nats-TTL`);
    return Number.parseInt(value!, 10);
  };

  // Short generations whose rows the broker must remove, and one long one that must stay.
  // Far enough out that issuing and checking them finishes first on a loaded host.
  const shortHorizon = nowSec() + 15;
  const short = Array.from({ length: 12 }, (_, i) => ({ ref: refFor(shortHorizon, `short${i}`), token: mintAcceptedToken() }));
  const long = { ref: refFor(nowSec() + 3600, "long"), token: mintAcceptedToken() };

  await check("every row of an issuance carries a TTL to its generation's horizon plus the retention margin", async () => {
    for (const s of short) await issue(s.ref, s.token);
    await issue(long.ref, long.token);
    const ref = short[0]!.ref;
    const bucket = issuedBucket(space);
    const expected = issuedHorizon(ref.generation) + ISSUED_RETAIN_MARGIN_SEC - nowSec();
    const ttls = [
      await ttlOf(issuedStream, `$KV.${bucket}.${issuedEvidenceKey(ref)}`, "first"),
      await ttlOf(issuedStream, `$KV.${bucket}.${issuedAttemptKey(ref)}`, "first"),
      await ttlOf(issuedStream, `$KV.${bucket}.${issuedAttemptKey(ref)}`, "last"),
      await ttlOf(issuedStream, `$KV.${bucket}.${issuedSourceIndexKey(source, ref)}`, "first"),
      await ttlOf(acceptedStream, `$KV.${acceptedBucket(space)}.${acceptedKey(short[0]!.token)}`, "last"),
    ];
    for (const ttl of ttls) assert.ok(Math.abs(ttl - expected) <= 2, `ttl ${ttl} is within 2 s of ${expected}`);
  });

  await check("a resolution that reaches the horizon during its reads refuses after the linearizing read", async () => {
    const ref = long.ref;
    const horizon = issuedHorizon(ref.generation);
    let calls = 0;
    // The first clock read is before the horizon; the one after the second attempt read is at it.
    await assert.rejects(() => store.resolve(ref, async () => true, () => (calls++ === 0 ? horizon - 1 : horizon)),
      new RegExp(`generation ${ref.generation} expired at ${horizon} \\(SPEC 13\\.15\\)`));
    assert.equal(calls, 2);
  });

  await check("a renewal and a resolution before the horizon succeed, and a retirement before it writes a terminal row with the same TTL", async () => {
    await store.confirm(short[1]!.ref, permissions);
    assert.equal((await store.resolve(short[1]!.ref, async () => true)).evidence.ref.generation, short[1]!.ref.generation);
    assert.equal(await store.retire(short[2]!.ref), "revoked");
    const expected = issuedHorizon(short[2]!.ref.generation) + ISSUED_RETAIN_MARGIN_SEC - nowSec();
    const terminal = await ttlOf(issuedStream, `$KV.${issuedBucket(space)}.${issuedAttemptKey(short[2]!.ref)}`, "last");
    assert.ok(Math.abs(terminal - expected) <= 2, `terminal row ttl ${terminal} is within 2 s of ${expected}`);
    await assert.rejects(() => store.resolve(short[2]!.ref, async () => true), /revoked/);
    assert.equal(await store.retireSource(source), short.length + 1);
  });

  await check("issued and accepted rows are removed by the broker after the horizon plus the margin, and only theirs", async () => {
    const deadline = (shortHorizon + ISSUED_RETAIN_MARGIN_SEC + 30) * 1000;
    const shortSubjects = async (): Promise<number> => {
      const info = await jsm.streams.info(issuedStream, { subjects_filter: ">" });
      return Object.keys(info.state.subjects ?? {}).filter((s) => short.some((x) => s.endsWith(x.ref.generation))).length;
    };
    assert.ok(await shortSubjects() > 0);
    while (await shortSubjects() > 0) {
      assert.ok(Date.now() < deadline, "the broker removed the expired rows in time");
      await sleep(1000);
    }
    assert.ok(nowSec() >= shortHorizon + ISSUED_RETAIN_MARGIN_SEC - 2, "nothing went before its horizon plus the margin");
    const issuedState = (await jsm.streams.info(issuedStream, { subjects_filter: ">" })).state;
    // Left: the long generation's evidence, attempt and index row, nothing else.
    assert.deepEqual(Object.keys(issuedState.subjects ?? {}).sort(), [
      `$KV.${issuedBucket(space)}.${issuedAttemptKey(long.ref)}`,
      `$KV.${issuedBucket(space)}.${issuedEvidenceKey(long.ref)}`,
      `$KV.${issuedBucket(space)}.${issuedSourceIndexKey(source, long.ref)}`,
    ].sort());
    const acceptedState = (await jsm.streams.info(acceptedStream, { subjects_filter: ">" })).state;
    assert.deepEqual(Object.keys(acceptedState.subjects ?? {}), [`$KV.${acceptedBucket(space)}.${acceptedKey(long.token)}`]);
    assert.equal(acceptedState.messages, 1);
  });

  await check("a removed generation re-created by a holder of the issuer's write row is refused as expired before the store is read", async () => {
    const victim = short[3]!;
    const ref = victim.ref;
    // The forger writes everything a resolver would want: evidence with a wider ceiling, no source,
    // an active attempt pinning that evidence's digest, an index row and an accepted row.
    const forged: IssuedEvidence = { version: 1, ref, sources: [], permissions: importNativeSubjectPermissions({}), expiresAt: issuedHorizon(ref.generation) };
    const digest = rawDigest(canonicalJson(forged));
    await kv.create(issuedEvidenceKey(ref), enc.encode(canonicalJson(forged)));
    await kv.create(issuedAttemptKey(ref), enc.encode(canonicalJson({ version: 1, state: "active", digest })));
    await kv.create(issuedSourceIndexKey(source, ref), enc.encode(canonicalJson({ source, ref })));
    await accepted.create(acceptedKey(victim.token), enc.encode(canonicalJson({ version: 1, ref })));
    assert.ok(await kv.get(issuedEvidenceKey(ref)), "the forged evidence is in the store");
    const expiry = new RegExp(`generation ${ref.generation} expired at ${issuedHorizon(ref.generation)} \\(SPEC 13\\.15\\)`);
    reads = 0;
    await assert.rejects(() => store.resolve(ref, async () => true), expiry);
    await assert.rejects(() => store.confirm(ref, forged.permissions), expiry);
    assert.equal(await store.retire(ref), "expired");
    await assert.rejects(() => store.stage(forged), expiry);
    await assert.rejects(() => writeAcceptedRow(accepted, mintAcceptedToken(), ref), expiry);
    assert.equal(reads, 0, "nothing of the expired generation was read");
    // The forged index row is skipped unread; only the long generation, already revoked, counts.
    assert.equal(await store.retireSource(source), 1);
  });

  await check("an issued credential that would outlive its generation's horizon is refused before anything is staged", async () => {
    const auth = await createSpaceAuth(space);
    const untouched = new Proxy({}, { get() { throw new Error("the store was touched"); } }) as IssuedStore;
    const issued = { generation: mintGeneration(nowSec() + 60), acceptedToken: mintAcceptedToken() };
    await assert.rejects(() => mintCreds(auth, newIdentity(), "control-caller-privileged", {
      lifecycleUid: "b".repeat(26), issued, expiresAt: nowSec() + 120,
      issuance: { mode: "issue", store: untouched, accepted: untouched as unknown as KV, sources: [] },
    }), /must expire by its generation's horizon/);
  });
} finally {
  if (nc) await nc.close();
  await killAndAwaitExit(broker);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
console.log(`ISSUED RETENTION LIVE SMOKE (${passed} passed, ${failed} failed)`);
emitSentinel({ passed, failed });
if (failed) process.exitCode = 1;
