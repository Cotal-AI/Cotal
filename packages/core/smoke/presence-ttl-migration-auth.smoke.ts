/**
 * #286 (AUTH mode) — presence/lease TTL migration GRANT proof. `kvm.create(bucket, {ttl})` NEVER updates an
 * existing bucket, so a presence/lease bucket created by a cotal that predated the TTL keeps NO `max_age` and
 * never expires dead presence records / stale leases — a raw-KV reader (a dashboard) then shows a crashed agent
 * as live forever. `setupSpaceStreams` reconciles the three TTL'd buckets' `max_age` (STREAM.UPDATE), which
 * requires the `provisioner` cred to hold STREAM.UPDATE on exactly those three streams (provision.ts).
 *
 * Runs against a REAL auth-callout broker AS the REAL provisioner credential, so it proves THE GRANT — the one
 * thing unique to auth mode. A fresh `cotal up` never exercises it (a just-created bucket already has the TTL, so
 * the reconcile skips the update), so we stage the old-deployment shape: pre-create the three buckets WITHOUT
 * max_age (as the provisioner's STREAM.CREATE), then run setupSpaceStreams as the provisioner and assert all
 * three `max_age` values flip from 0 to their TTLs. Without the STREAM.UPDATE grant, setupSpaceStreams throws a
 * permissions violation at the reconcile — so reaching the post-asserts IS the proof.
 *
 * The behavioral consequence (a stale record then ages out; an active lease, always younger than its TTL,
 * survives) is plain NATS `max_age` semantics, proven live in open mode by `_r286-mig.ts` / `_r286.ts` — not
 * re-proven here, where writing presence/lease records would need agent/delivery creds (the provisioner writes
 * neither). Needs `nats-server` on PATH. Run: pnpm smoke:presence-ttl-migration:auth
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { connect, nanos } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import { isReachable, createSpaceAuth, mintCreds, serverConfig, newIdentity, setupSpaceStreams, reconcileBucketTtl, standaloneConnectOpts, presenceBucket, deliveryBucket, managerBucket } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { assertEphemeralBroker } from "./_ephemeral-only.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
// FIRST action, before the broker is started and before ANY connection or STREAM.UPDATE: this suite
// rewrites presence/lease bucket config, which against the live mesh would rewrite the liveness every
// agent depends on. Refuses to proceed on a non-throwaway target.
assertEphemeralBroker(SERVERS);
const space = `ttlmig-${randomUUID().slice(0, 8)}`;
const PRESENCE_MS = 6_000, DELIVERY_MS = 30_000, MANAGER_MS = 10_000;

const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-ttlmig-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  console.log(`  ✓ ${name}`);
  pass++;
};

try {
  // The live-broker fence itself, asserted rather than trusted. It is the one guard in this suite
  // whose failure mode is silent: if it stopped refusing, every cell below would still pass, against
  // whatever broker it was pointed at.
  // The fence has TWO layers and they must be pinned separately: naming the live host by itself is
  // not load-bearing (a loopback-only rule already refuses it), so a cell that only tries
  // broker.cotal.ai passes even with the named-host check deleted. The loopback rule is what
  // actually fences; the named host exists so the refusal SAYS why. One cell each.
  const refusal = (servers: string) => { try { assertEphemeralBroker(servers); return undefined; } catch (e) { return (e as Error).message; } };
  check("the live broker is REFUSED (bare, and hidden in a multi-URL list)", [ "nats://broker.cotal.ai:4222", "broker.cotal.ai:4222", "nats://127.0.0.1:4222,nats://broker.cotal.ai:4222" ].every((s) => refusal(s) !== undefined));
  check("ANY non-loopback broker is refused, not just the one we named", refusal("nats://10.0.0.5:4222") !== undefined);
  check("the live broker's refusal NAMES it as the live broker (not the generic message)", /is the LIVE broker/.test(refusal("nats://broker.cotal.ai:4222") ?? ""));
  // The fence must FAIL CLOSED ON NOTHING. An empty/whitespace target used to return without
  // throwing — the loop had no hosts to inspect, so a guard whose only job is refusal silently
  // allowed. `process.env.COTAL_SERVERS ?? ""` produces exactly that value.
  check("an EMPTY broker target is refused (the guard does not fail open on nothing)", refusal("") !== undefined);
  check("...and a whitespace-only target too", refusal("   ") !== undefined);
  check("a throwaway loopback broker is allowed (the fence is not refusing everything)", refusal(SERVERS) === undefined);

  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) break; await sleep(200); }

  // The REAL provisioner credential — the identity `setupSpaceStreams` runs as at `cotal up`.
  const provCreds = await mintCreds(auth, newIdentity(), "provisioner");
  // Pin the reply inbox to the provisioner's own `_INBOX_<id>` — its scoped cred rejects the default
  // `_INBOX.<nuid>`, so a bare connect would hang every JS-API request (same as `setupSpaceStreams`).
  const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: provCreds, tls: false }) });
  const kvm = new Kvm(nc);
  const jsm = await jetstreamManager(nc);
  const maxAge = async (b: string) => (await jsm.streams.info(`KV_${b}`)).config.max_age;

  // OLD deployment: the three TTL'd buckets pre-created (by the provisioner's STREAM.CREATE) with NO max_age.
  await kvm.create(presenceBucket(space), {});
  await kvm.create(deliveryBucket(space), {});
  await kvm.create(managerBucket(space), {});
  check("pre-existing presence bucket has NO expiry (max_age=0)", (await maxAge(presenceBucket(space))) === 0);
  check("pre-existing delivery-lease bucket has NO expiry (max_age=0)", (await maxAge(deliveryBucket(space))) === 0);
  check("pre-existing manager-lease bucket has NO expiry (max_age=0)", (await maxAge(managerBucket(space))) === 0);

  // THE FIX, as the real provisioner: setupSpaceStreams reconciles max_age via STREAM.UPDATE. Without the
  // grant this throws a permissions violation here — so reaching the asserts proves the grant is correct.
  await setupSpaceStreams({ servers: SERVERS, space, creds: provCreds });

  check("presence max_age reconciled to 6s (provisioner STREAM.UPDATE authorized)", (await maxAge(presenceBucket(space))) === nanos(PRESENCE_MS), (await maxAge(presenceBucket(space))) / 1e6);
  check("delivery-lease max_age reconciled to 30s", (await maxAge(deliveryBucket(space))) === nanos(DELIVERY_MS), (await maxAge(deliveryBucket(space))) / 1e6);
  check("manager-lease max_age reconciled to 10s", (await maxAge(managerBucket(space))) === nanos(MANAGER_MS), (await maxAge(managerBucket(space))) / 1e6);

  // Idempotent: a second reconcile pass (a normal repeat `cotal up`) is a no-op — matching max_age, no UPDATE.
  await setupSpaceStreams({ servers: SERVERS, space, creds: provCreds });
  check("second reconcile is a no-op (max_age still 6s — idempotent)", (await maxAge(presenceBucket(space))) === nanos(PRESENCE_MS));

  // ---- the ALREADY-CORRECT bucket, proven at the branch rather than at the value ----------------
  // The assert above cannot tell "skipped" from "re-updated": re-running the UPDATE with the same
  // max_age leaves the same value behind, so a reconcile that had LOST its skip would still pass it.
  // Drive the seam with a jsm whose `update` FAILS THE TEST IF CALLED: the bucket already carries the
  // intended TTL, so a correct reconcile returns without ever issuing STREAM.UPDATE. This proves the
  // branch was taken, not merely that the value survived.
  let updateCalls = 0;
  const alreadyCorrect = {
    streams: {
      info: async () => ({ config: { max_age: nanos(PRESENCE_MS), duplicate_window: nanos(2_000) } }),
      update: async () => { updateCalls++; throw new Error("STREAM.UPDATE issued against an already-correct bucket"); },
    },
  } as unknown as Awaited<ReturnType<typeof jetstreamManager>>;
  let skipped = true;
  try { await reconcileBucketTtl(alreadyCorrect, "KV_already_correct", PRESENCE_MS); } catch { skipped = false; }
  check("already-correct bucket SKIPS the update (no STREAM.UPDATE issued at all)", skipped && updateCalls === 0, { updateCalls });

  // ---- the read-back FAILS CLOSED (ratified review condition (a)) --------------------------------
  // The guarantee is not "we sent an UPDATE" — but it is NOT "the TTL is now in force" either, which
  // is what this comment used to claim. Enforcement cannot be established from the config the server
  // reports back: a metadata-write fault leaves the in-memory config updated, `STREAM.INFO` answering
  // from it, and the store running with no expiry (reproduced live in review; see the tracking issue,
  // and `presence-ttl-expiry-open.smoke.ts` for the behavioural proof on a healthy server). What this
  // cell guards is the weaker, real guarantee: **the reported config did not silently stay wrong.** A
  // broker that accepts the UPDATE and reports the OLD value (an older server, a config rejection that
  // still answers OK) would otherwise leave the bucket unexpired while `cotal up`
  // reported success — the #286 defect restored, now wearing a passing gate. A live broker will not
  // produce that state on demand, so it is INJECTED: `update` resolves OK, the read-back still reports
  // the old max_age. The reconcile MUST throw. This is the cell that dies if the throw becomes a log.
  const lyingBroker = {
    streams: {
      info: async () => ({ config: { max_age: 0, duplicate_window: nanos(2_000) } }), // never changes
      update: async () => ({}),                                                        // "OK" — but nothing took
    },
  } as unknown as Awaited<ReturnType<typeof jetstreamManager>>;
  let threw: Error | undefined;
  try { await reconcileBucketTtl(lyingBroker, "KV_lying_broker", PRESENCE_MS); } catch (e) { threw = e as Error; }
  check("STREAM.UPDATE accepted but NOT applied => reconcile THROWS (fails closed, no silent drift)", threw !== undefined);
  check("...and the throw names the stream and both max_age values", /KV_lying_broker/.test(threw?.message ?? "") && /did not take/.test(threw?.message ?? ""), threw?.message);

  // The read-back checks BOTH fields, not only the one we set. A conforming server cannot leave
  // `duplicate_window > max_age` — it validates the whole config and applies it as one replacement —
  // but the read-back exists precisely so the guarantee does not rest on the server behaving as
  // documented. Injected, because a real broker will not produce it: update "succeeds", max_age is
  // right, and the window is left too large.
  const partialApply = {
    streams: {
      info: (() => { let applied = false; return async () => { const c = { config: { max_age: applied ? nanos(PRESENCE_MS) : 0, duplicate_window: nanos(120_000) } }; applied = true; return c; }; })(),
      update: async () => ({}),
    },
  } as unknown as Awaited<ReturnType<typeof jetstreamManager>>;
  let partialErr: Error | undefined;
  try { await reconcileBucketTtl(partialApply, "KV_partial_apply", PRESENCE_MS); } catch (e) { partialErr = e as Error; }
  check("max_age applied but duplicate_window left ABOVE it => reconcile THROWS (partial apply refused)", partialErr !== undefined);
  check("...and the throw names the window and the max_age it exceeds", /duplicate_window/.test(partialErr?.message ?? "") && /exceeds max_age/.test(partialErr?.message ?? ""), partialErr?.message);

  // Positive control for the two cells above: with the SAME injected seam, a broker whose update
  // genuinely takes must NOT throw. Without this, the fail-closed cell could be passing because the
  // seam throws unconditionally (a reconcile that always threw would satisfy it too).
  const honestBroker = {
    streams: {
      info: (() => { let applied = false; return async () => { const c = { config: { max_age: applied ? nanos(PRESENCE_MS) : 0, duplicate_window: nanos(2_000) } }; applied = true; return c; }; })(),
      update: async () => ({}),
    },
  } as unknown as Awaited<ReturnType<typeof jetstreamManager>>;
  let honestThrew = false;
  try { await reconcileBucketTtl(honestBroker, "KV_honest_broker", PRESENCE_MS); } catch { honestThrew = true; }
  check("control: an update that DOES take is accepted (the guard is not throwing unconditionally)", !honestThrew);

  await nc.close();
  console.log(`\nPRESENCE-TTL-MIGRATION (auth) SMOKE OK ✅  (${pass} checks)`);
} finally {
  srv.kill("SIGKILL");
  await sleep(200);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
