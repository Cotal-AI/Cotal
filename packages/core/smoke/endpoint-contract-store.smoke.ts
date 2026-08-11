/**
 * v0.4 §13.7 CONTRACT STORE smoke — the content-addressed single-message store against a real
 * broker: STRICT CANONICAL identity (only an artifact's own RFC 8785 serialization publishes;
 * noncanonical/non-JSON/invalid-UTF-8 bytes refuse; a garbled store fails verify-on-read),
 * create-only digest-subject publication through the space-bonded context (idempotent
 * republish, detached publish snapshot), the CLOSURE MANIFEST as contract identity (the walk
 * must equal `members` exactly; under- and over-naming manifests refuse; a self-cycle root has
 * exactly ONE valid manifest), and the frozen walk bounds (1 MiB closure, 32-deep ref chain,
 * non-raiseable artifact ceiling, per-artifact ref cap, one total monotonic budget).
 *
 * Run: pnpm smoke:ep-contract-store   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, headers } from "@nats-io/transport-node";
import { jetstream, jetstreamManager, RetentionPolicy, StorageType } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable, EpEnvelopeError,
  createEndpointStreams, ensureContractStore, epcSubject, epcStreamName,
  contractArtifactDigestHex, contractRefToHex, contractArtifactCanonicalBytes, assertCanonicalArtifactBytes,
  contractStoreContext, publishContractArtifact, fetchContractArtifact,
  buildContractClosureManifest, publishContractClosureManifest, fetchContractClosure,
  CONTRACT_ARTIFACT_MAX_BYTES, CONTRACT_CLOSURE_MAX_ARTIFACTS,
  type ContractStoreContext,
} from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const rejects = async (n: string, fn: () => Promise<unknown> | unknown, code?: string) => {
  try { await fn(); c(n, false, "no throw"); } catch (e) {
    c(n, code === undefined || (e instanceof EpEnvelopeError && e.code === code), `code ${(e as EpEnvelopeError).code ?? (e as Error).message}`);
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const SPACE = "epstore";

// ── reference normalization + canonical identity (broker-free) ──
{
  const hex = contractArtifactDigestHex(enc("x"));
  c("a bare-hex and a sha256:-prefixed reference normalize to the same subject token",
    contractRefToHex(hex) === hex && contractRefToHex(`sha256:${hex}`) === hex);
}
await rejects("a malformed reference never resolves", () => contractRefToHex("sha256:nope"), "contract-invalid");
c("canonical bytes ARE their own canonical serialization (round-trip identity)",
  (assertCanonicalArtifactBytes(contractArtifactCanonicalBytes({ b: 1, a: 2 }), "probe") as { a: number }).a === 2);
await rejects("bytes with UNSORTED keys are not canonical and never get an identity",
  () => assertCanonicalArtifactBytes(enc('{"b":1,"a":2}'), "probe"), "contract-invalid");
await rejects("bytes with WHITESPACE are not canonical",
  () => assertCanonicalArtifactBytes(enc('{"a": 2}'), "probe"), "contract-invalid");
await rejects("non-JSON bytes are never an artifact",
  () => assertCanonicalArtifactBytes(enc("not json"), "probe"), "contract-invalid");
await rejects("invalid UTF-8 bytes are never an artifact",
  () => assertCanonicalArtifactBytes(new Uint8Array([0x7b, 0xff, 0x7d]), "probe"), "contract-invalid");

const PORT = 20000 + Math.floor(Math.random() * 40000);
const sd = mkdtempSync(join(tmpdir(), "cotal-epstore-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
  const jsm = await jetstreamManager(nc);
  const js = jetstream(nc); // a raw handle for planting tampered/oversize artifacts the context would never publish
  await createEndpointStreams(jsm, new Kvm(nc), SPACE);
  const ctx = await contractStoreContext(nc, SPACE);
  const artifact = (v: unknown) => contractArtifactCanonicalBytes(v);

  await rejects("a hand-assembled context never authorizes (resources are WeakMap-private, not on the token)",
    () => publishContractArtifact({ space: SPACE } as ContractStoreContext, artifact({ a: 1 })), "failed-precondition");
  c("the context token exposes NO js/jsm to rebind (resources are WeakMap-private)",
    (ctx as unknown as Record<string, unknown>).js === undefined && (ctx as unknown as Record<string, unknown>).jsm === undefined);

  // ── publish + fetch + two-proof verify-on-read ──
  const A = artifact({ refs: [], schema: "A" });
  const pubA = await publishContractArtifact(ctx, A);
  c("the first publication wins its create-only CAS at the content address",
    pubA.won && pubA.digestHex === contractArtifactDigestHex(A));
  const dupA = await publishContractArtifact(ctx, A);
  c("a republish of the SAME bytes is an idempotent loss (the subject IS the digest)", !dupA.won && dupA.digestHex === pubA.digestHex);
  const backA = await fetchContractArtifact(ctx, pubA.digestHex);
  c("the artifact fetches back verified (bytes recompute the digest AND are canonical)", backA !== undefined && dec(backA) === dec(A));
  c("an unpublished digest fetches undefined",
    (await fetchContractArtifact(ctx, "0".repeat(64))) === undefined);
  await rejects("NONCANONICAL bytes never publish (an equivalent value in a different encoding never gets its own identity)",
    () => publishContractArtifact(ctx, enc('{"schema":"A","refs":[]}')), "contract-invalid");
  await rejects("an OVERSIZE artifact refuses (single-message bound; never chunked)",
    () => publishContractArtifact(ctx, new Uint8Array(CONTRACT_ARTIFACT_MAX_BYTES + 1)), "contract-invalid");
  {
    // the publish snapshot: mutating the live buffer across the publish await changes nothing.
    const live = artifact({ probe: "snapshot" });
    const expectHex = contractArtifactDigestHex(live);
    const publishing = publishContractArtifact(ctx, live);
    live.fill(0x20); // mutate while the publish awaits — after the entry snapshot
    const pubS = await publishing;
    const backS = await fetchContractArtifact(ctx, expectHex);
    c("a mid-publish mutation of the live buffer changes NOTHING (the detached snapshot is what publishes)",
      pubS.won && pubS.digestHex === expectHex && backS !== undefined && dec(backS) === '{"probe":"snapshot"}');
  }
  {
    // the tamper boundary, both proofs: (a) bytes planted at a subject they do not digest to;
    // (b) NONCANONICAL bytes planted at their own digest subject — a garbled store never serves.
    const h1 = headers(); h1.set("Nats-Expected-Last-Subject-Sequence", "0");
    await js.publish(epcSubject(SPACE, "f".repeat(64)), enc("not the content"), { headers: h1 });
    await rejects("a mis-addressed artifact FAILS verify-on-read (content addressing is the tamper boundary)",
      () => fetchContractArtifact(ctx, "f".repeat(64)), "internal");
    const nonCanon = enc('{"b":1,"a":2}');
    const nonCanonHex = contractArtifactDigestHex(nonCanon);
    const h2 = headers(); h2.set("Nats-Expected-Last-Subject-Sequence", "0");
    await js.publish(epcSubject(SPACE, nonCanonHex), nonCanon, { headers: h2 });
    await rejects("NONCANONICAL bytes at their own digest subject STILL fail the read (canonical form is the second proof)",
      () => fetchContractArtifact(ctx, nonCanonHex), "internal");
  }

  // ── APPEND-SHADOW DEFENSE (the panel blocker, live-confirmed): a grant-holder must not be able
  //    to shadow a published artifact by raw-appending a second message to its digest subject. ──
  {
    // (A) BROKER-ENFORCED per-subject immutability (ensureContractStore's stream shape): a raw
    //     append to an OCCUPIED digest subject is REJECTED regardless of the create-only header.
    const honest = artifact({ shadow: "honest-A" });
    const dHex = contractArtifactDigestHex(honest);
    const put = await publishContractArtifact(ctx, honest);
    c("the honest artifact publishes (create-only winner at its digest subject)", put.won && put.digestHex === dHex);
    let appendCode: unknown;
    try { await js.publish(epcSubject(SPACE, dHex), enc("SHADOW-GARBAGE")); } // NO create-only header — the non-cooperative publisher
    catch (e) { appendCode = (e as { code?: unknown }).code ?? (e as Error).message; }
    c("a RAW append (no create-only header) to an occupied digest subject is BROKER-REJECTED (max-msgs-per-subject, err 10077)", appendCode === 10077, appendCode);
    const stillHonest = await fetchContractArtifact(ctx, dHex);
    c("the honest artifact is unshadowed — fetch still returns it", stillHonest !== undefined && dec(stillHonest) === '{"shadow":"honest-A"}', stillHonest && dec(stillHonest));
  }
  {
    // (B) VERSION-AGNOSTIC read fallback: on a broker/stream that LACKS the per-subject cap (a
    //     pre-hardening legacy EPC stream), a raw append SUCCEEDS and last_by_subj returns the
    //     shadow — but fetchContractArtifact prefers the create-only WINNER (first-by-subject) and
    //     still returns the honest artifact. Simulated with a manually-created un-hardened stream.
    const SPACE_B = "epstoreshadow";
    await jsm.streams.add({
      name: epcStreamName(SPACE_B), subjects: [`cotal.${SPACE_B}.epc.>`],
      retention: RetentionPolicy.Limits, storage: StorageType.File, allow_direct: true, deny_delete: true, deny_purge: true,
      // DELIBERATELY no max_msgs_per_subject/discard — the legacy shape the read must defend against.
    });
    const ctxB = await contractStoreContext(nc, SPACE_B);
    const honestB = artifact({ shadow: "honest-B" });
    const dHexB = contractArtifactDigestHex(honestB);
    await publishContractArtifact(ctxB, honestB); // create-only winner, seq 1
    const hb = headers(); // a raw append WITHOUT the create-only header — succeeds on the un-hardened stream
    const appended = await js.publish(epcSubject(SPACE_B, dHexB), enc("SHADOW-GARBAGE"), { headers: hb }).then((r) => r.seq).catch(() => 0);
    c("on an UN-HARDENED stream the raw append SUCCEEDS (seq 2) — the shadow is present", appended === 2, appended);
    const last = await jsm.direct.getMessage(epcStreamName(SPACE_B), { last_by_subj: epcSubject(SPACE_B, dHexB) });
    c("last_by_subj now returns the SHADOW garbage (the DoS the read must defeat)", dec(last.data) === "SHADOW-GARBAGE");
    const recovered = await fetchContractArtifact(ctxB, dHexB);
    c("fetchContractArtifact still returns the HONEST artifact (create-only-winner fallback defeats the shadow)", recovered !== undefined && dec(recovered) === '{"shadow":"honest-B"}', recovered && dec(recovered));
    // and a subject where BOTH the winner and the shadow are garbage stays loud (genuinely corrupt).
    const garbHex = "e".repeat(64);
    await js.publish(epcSubject(SPACE_B, garbHex), enc("first-garbage"), { headers: (() => { const h = headers(); h.set("Nats-Expected-Last-Subject-Sequence", "0"); return h; })() });
    await js.publish(epcSubject(SPACE_B, garbHex), enc("second-garbage"));
    await rejects("a subject whose winner AND shadow both fail verify stays loud (no honest artifact to recover)",
      () => fetchContractArtifact(ctxB, garbHex), "internal");
  }
  {
    // (C) UPGRADE PATH: ensureContractStore hardens a pre-existing un-hardened stream in place,
    //     leaving already-published artifacts intact, and a raw append is rejected afterward.
    const SPACE_C = "epstoreupgrade";
    await jsm.streams.add({
      name: epcStreamName(SPACE_C), subjects: [`cotal.${SPACE_C}.epc.>`],
      retention: RetentionPolicy.Limits, storage: StorageType.File, allow_direct: true, deny_delete: true, deny_purge: true,
    });
    const ctxC = await contractStoreContext(nc, SPACE_C);
    const preExisting = artifact({ upgrade: "pre-existing" });
    const dHexC = contractArtifactDigestHex(preExisting);
    await publishContractArtifact(ctxC, preExisting);
    await ensureContractStore(jsm, SPACE_C); // the upgrade: adds the per-subject immutability flags
    const cfgC = (await jsm.streams.info(epcStreamName(SPACE_C))).config as { max_msgs_per_subject?: number; discard?: string; discard_new_per_subject?: boolean };
    c("ensureContractStore UPGRADES an un-hardened stream to per-subject immutability", cfgC.max_msgs_per_subject === 1 && cfgC.discard === "new" && cfgC.discard_new_per_subject === true, cfgC);
    const survived = await fetchContractArtifact(ctxC, dHexC);
    c("the pre-existing artifact SURVIVED the upgrade", survived !== undefined && dec(survived) === '{"upgrade":"pre-existing"}', survived && dec(survived));
    let upCode: unknown;
    try { await js.publish(epcSubject(SPACE_C, dHexC), enc("post-upgrade-shadow")); }
    catch (e) { upCode = (e as { code?: unknown }).code; }
    c("after the upgrade a raw append is broker-rejected", upCode === 10077, upCode);
  }
  {
    // (D) THE CONFIG-A FOOTGUN is never silently adopted: a stream created with
    //     max_msgs_per_subject:1 + the DEFAULT discard:old (which would DELETE the honest artifact
    //     on an append) is CORRECTED to config B by ensureContractStore, not accepted.
    const SPACE_D = "epstorefootgun";
    await jsm.streams.add({
      name: epcStreamName(SPACE_D), subjects: [`cotal.${SPACE_D}.epc.>`],
      retention: RetentionPolicy.Limits, storage: StorageType.File, allow_direct: true, deny_delete: true, deny_purge: true,
      max_msgs_per_subject: 1, // config A: mmps:1 but DEFAULT discard:old — the footgun
    });
    const preA = (await jsm.streams.info(epcStreamName(SPACE_D))).config as { discard?: string };
    c("the footgun stream starts at config A (discard:old)", preA.discard === "old", preA.discard);
    await ensureContractStore(jsm, SPACE_D);
    const postA = (await jsm.streams.info(epcStreamName(SPACE_D))).config as { max_msgs_per_subject?: number; discard?: string; discard_new_per_subject?: boolean };
    c("ensureContractStore CORRECTS config A -> config B (discard:new + discard_new_per_subject), never silently adopts the delete-footgun",
      postA.max_msgs_per_subject === 1 && postA.discard === "new" && postA.discard_new_per_subject === true, postA);
    // and it now rejects the append (the footgun's delete-on-append is gone).
    const ctxD = await contractStoreContext(nc, SPACE_D);
    const vD = artifact({ footgun: "V" });
    const dHexD = contractArtifactDigestHex(vD);
    await publishContractArtifact(ctxD, vD);
    let footCode: unknown;
    try { await js.publish(epcSubject(SPACE_D, dHexD), enc("append-would-have-deleted-V-under-config-A")); }
    catch (e) { footCode = (e as { code?: unknown }).code; }
    c("post-correction the append is REJECTED (config A would have deleted V; config B rejects)", footCode === 10077, footCode);
    const vStill = await fetchContractArtifact(ctxD, dHexD);
    c("V survives (never deleted) after the corrected store rejects the append", vStill !== undefined && dec(vStill) === '{"footgun":"V"}', vStill && dec(vStill));
  }
  {
    // (E) UPGRADE of an ALREADY-SHADOWED legacy store REFUSES LOUD, never trim-cements (critic
    //     upgrade-trim residual): config-B's per-subject trim would keep the newest (the shadow)
    //     and delete the honest winner, so ensureContractStore fails loud on such a store instead.
    const SPACE_E = "epstoreshadowup";
    await jsm.streams.add({
      name: epcStreamName(SPACE_E), subjects: [`cotal.${SPACE_E}.epc.>`],
      retention: RetentionPolicy.Limits, storage: StorageType.File, allow_direct: true, deny_delete: true, deny_purge: true,
      // legacy shape: no per-subject cap - a shadow can exist.
    });
    const ctxE = await contractStoreContext(nc, SPACE_E);
    const vE = artifact({ shadowedUpgrade: "honest" });
    const dHexE = contractArtifactDigestHex(vE);
    await publishContractArtifact(ctxE, vE); // V @ seq 1
    await js.publish(epcSubject(SPACE_E, dHexE), enc("PRE-EXISTING-SHADOW")); // shadow @ seq 2 (legacy store allows it)
    await rejects("ensureContractStore REFUSES LOUD to upgrade an already-shadowed legacy store (would trim-cement the shadow)",
      () => ensureContractStore(jsm, SPACE_E));
    // the honest winner is still there (nothing was trimmed - the upgrade refused before touching it),
    // recoverable by the read fallback until the operator reprovisions.
    const vStillE = await fetchContractArtifact(ctxE, dHexE);
    c("the honest artifact is NOT trimmed (the refusal ran BEFORE any config change)", vStillE !== undefined && dec(vStillE) === '{"shadowedUpgrade":"honest"}', vStillE && dec(vStillE));
  }

  // ── the closure manifest: contract identity is the MANIFEST digest ──
  const l1 = (await publishContractArtifact(ctx, artifact({ refs: [], schema: "leaf1" }))).digestHex;
  const l2 = (await publishContractArtifact(ctx, artifact({ refs: [], schema: "leaf2" }))).digestHex;
  const m = (await publishContractArtifact(ctx, artifact({ refs: [`sha256:${l1}`, l2], schema: "mid" }))).digestHex;
  const r = (await publishContractArtifact(ctx, artifact({ refs: [m, l1], schema: "root" }))).digestHex; // l1 twice: diamond
  const refsOf = (bytes: Uint8Array): string[] => (JSON.parse(dec(bytes)) as { refs: string[] }).refs;

  const manifest = buildContractClosureManifest(r, [m, l1, l2]);
  c("the built manifest is canonical: sorted, deduplicated, sha256-prefixed",
    manifest.members.length === 3 && [...manifest.members].sort().join() === manifest.members.join());
  const pubM = await publishContractClosureManifest(ctx, manifest);
  c("the manifest publishes as an ordinary artifact; its digest IS the closure digest", pubM.won && HEXLIKE(pubM.closureDigestHex));

  const closure = await fetchContractClosure(ctx, pubM.closureDigestHex, refsOf);
  c("the verified closure walks from the manifest's root (diamond-safe) and PROVES the walked set equals members exactly",
    closure.artifacts.size === 4 && [...closure.artifacts.keys()][0] === r
    && closure.artifacts.has(l1) && closure.artifacts.has(l2) && closure.artifacts.has(m)
    && closure.manifest.root === `sha256:${r}`);
  {
    const under = await publishContractClosureManifest(ctx, buildContractClosureManifest(r, [m, l1])); // omits reached l2
    await rejects("an UNDER-NAMING manifest (the walk reaches an unlisted artifact) never verifies",
      () => fetchContractClosure(ctx, under.closureDigestHex, refsOf), "contract-invalid");
    const stray = (await publishContractArtifact(ctx, artifact({ refs: [], schema: "stray" }))).digestHex;
    const over = await publishContractClosureManifest(ctx, buildContractClosureManifest(r, [m, l1, l2, stray])); // names an unreached artifact
    await rejects("an OVER-NAMING manifest (a listed member is never reached) never verifies",
      () => fetchContractClosure(ctx, over.closureDigestHex, refsOf), "contract-invalid");
    await rejects("an UNSORTED members list is a noncanonical manifest and refuses at publication",
      () => publishContractClosureManifest(ctx, { v: 1, root: `sha256:${r}`, members: [`sha256:${l2}`, `sha256:${l1}`].sort().reverse() }), "contract-invalid");
    await rejects("a closure digest naming an UNPUBLISHED manifest refuses",
      () => fetchContractClosure(ctx, "3".repeat(64), refsOf), "failed-precondition");
    await rejects("a closure referencing an UNPUBLISHED artifact fails loud (all-or-nothing, never partial)",
      () => fetchContractClosure(ctx, pubM.closureDigestHex, (b, hex) => (hex === m ? ["1".repeat(64)] : refsOf(b))), "failed-precondition");
  }
  {
    // a SELF-CYCLE root is reference-reachable, so it belongs in members — and exactly ONE
    // manifest names that closure (a members list omitting the re-reached root refuses too).
    const s1 = (await publishContractArtifact(ctx, artifact({ probe: "self" }))).digestHex;
    const cycM = await publishContractClosureManifest(ctx, buildContractClosureManifest(s1, [s1]));
    const cyc = await fetchContractClosure(ctx, cycM.closureDigestHex, () => [s1]);
    c("a cyclic reference terminates and the re-reached root is a MEMBER", cyc.artifacts.size === 1);
    const cycEmpty = await publishContractClosureManifest(ctx, buildContractClosureManifest(s1, []));
    await rejects("a manifest omitting the re-reached root never verifies (one closure, one manifest, one digest)",
      () => fetchContractClosure(ctx, cycEmpty.closureDigestHex, () => [s1]), "contract-invalid");
  }

  // ── the frozen walk bounds ──
  await rejects("an artifact ceiling ABOVE the frozen bound refuses (a caller narrows, never widens)",
    () => fetchContractClosure(ctx, pubM.closureDigestHex, refsOf, { maxArtifacts: CONTRACT_CLOSURE_MAX_ARTIFACTS + 1 }), "failed-precondition");
  await rejects("a closure exceeding the (narrowed) artifact bound fails loud (bounded, never truncated)",
    () => fetchContractClosure(ctx, pubM.closureDigestHex, refsOf, { maxArtifacts: 2 }), "failed-precondition");
  await rejects("a garbled resolution seam (non-string-array) never extends a closure",
    () => fetchContractClosure(ctx, pubM.closureDigestHex, (() => "nope") as unknown as () => string[]), "internal");
  await rejects("a closure without the resolution seam refuses (the store never guesses a document's reference shape)",
    () => fetchContractClosure(ctx, pubM.closureDigestHex, undefined as unknown as () => string[]), "failed-precondition");
  await rejects("a per-artifact reference list above the cap never extends a closure",
    () => fetchContractClosure(ctx, pubM.closureDigestHex, () => Array.from({ length: CONTRACT_CLOSURE_MAX_ARTIFACTS + 1 }, () => l1)), "contract-invalid");
  await rejects("an exhausted walk budget is a bounded refusal, never a hung fetch",
    () => fetchContractClosure(ctx, pubM.closureDigestHex, (b) => { const end = performance.now() + 8; while (performance.now() < end) { /* burn past the budget deterministically */ } return refsOf(b); }, { walkBudgetMs: 3 }), "deadline-exceeded");
  {
    // the reference-chain depth bound: a 34-deep chain refuses at depth 33.
    let nextHex: string | undefined;
    const chain: string[] = [];
    for (let i = 0; i < 34; i++) {
      const bytes = artifact({ probe: `chain-${i}`, refs: nextHex === undefined ? [] : [`sha256:${nextHex}`] });
      nextHex = (await publishContractArtifact(ctx, bytes)).digestHex;
      chain.push(nextHex);
    }
    const rootHex = nextHex!;
    const deepM = await publishContractClosureManifest(ctx, buildContractClosureManifest(rootHex, chain.slice(0, -1)));
    await rejects("a reference chain deeper than the frozen bound refuses (never an unbounded descent)",
      () => fetchContractClosure(ctx, deepM.closureDigestHex, refsOf), "contract-invalid");
  }
  {
    // the closure byte bound: six ~200 KiB members overflow 1 MiB (each carries refs:[] so the
    // resolution seam extends the walk, letting the byte accumulation reach the bound).
    const bigHexes: string[] = [];
    for (let i = 0; i < 6; i++)
      bigHexes.push((await publishContractArtifact(ctx, artifact({ d: "x".repeat(200 * 1024), i, refs: [] }))).digestHex);
    const bigRoot = (await publishContractArtifact(ctx, artifact({ refs: bigHexes.map((h) => `sha256:${h}`) }))).digestHex;
    const bigM = await publishContractClosureManifest(ctx, buildContractClosureManifest(bigRoot, bigHexes));
    await rejects("a closure above the frozen 1 MiB byte bound refuses (bounded, never truncated)",
      () => fetchContractClosure(ctx, bigM.closureDigestHex, refsOf), "contract-invalid");
  }
  {
    // M4: a mutating resolution seam cannot poison the returned map (detached copies handed out).
    const res = await fetchContractClosure(ctx, pubM.closureDigestHex, (bytes, hex) => { const refs = refsOf(bytes); bytes.fill(0x20); return refs; });
    c("a MUTATING resolution seam cannot poison the returned artifacts (every handed-out buffer is detached)",
      [...res.artifacts.entries()].every(([hex, bytes]) => contractArtifactDigestHex(bytes) === hex));
  }
  // ── re-review 8dcad72 (distsys): 1H manifest digest spelling, M2 read ceiling, M4 depth-order ──
  {
    // HIGH: a manifest digest field must be EXACTLY sha256:<hex>; a bare-hex spelling gives one
    // closure a second identity. Both publication and the fetch parse refuse the noncanonical form.
    await rejects("a manifest with a BARE-HEX root refuses (a digest field is exactly sha256:<hex>, never a second spelling)",
      () => publishContractClosureManifest(ctx, { v: 1, root: r, members: [`sha256:${l1}`, `sha256:${l2}`, `sha256:${m}`].sort() }), "contract-invalid");
    await rejects("a manifest with a BARE-HEX member refuses",
      () => publishContractClosureManifest(ctx, { v: 1, root: `sha256:${r}`, members: [l1, `sha256:${l2}`, `sha256:${m}`].sort() }), "contract-invalid");

    // M2: the 256 KiB document ceiling is enforced on READ, not just publication. Plant a canonical
    // artifact just over the bound directly (bypassing publishContractArtifact); the fetch refuses it.
    const big = contractArtifactCanonicalBytes({ big: "a".repeat(263_000) });
    const bigHex = contractArtifactDigestHex(big);
    const hb = headers(); hb.set("Nats-Expected-Last-Subject-Sequence", "0");
    await js.publish(epcSubject(SPACE, bigHex), big, { headers: hb });
    await rejects("an OVERSIZE artifact planted directly FAILS verify-on-read (the document ceiling is enforced on every read)",
      () => fetchContractArtifact(ctx, bigHex), "internal");

    // M4: an over-depth edge that RE-REACHES the already-visited root must trip the depth bound,
    // not be skipped by the visited-node dedupe. Content-addressed artifacts can't truly cycle, but
    // the caller's extractRefs seam can declare one: R -> C1 -> ... -> C32 -> R (root at depth 33).
    const nodes: string[] = [];
    for (let i = 0; i < 33; i++) nodes.push((await publishContractArtifact(ctx, artifact({ probe: `m4-${i}` }))).digestHex);
    const seam = (_b: Uint8Array, hex: string): string[] => {
      const idx = nodes.indexOf(hex);
      if (idx === 32) return [`sha256:${nodes[0]}`]; // C32 -> R: the over-depth edge back to the visited root
      if (idx >= 0) return [`sha256:${nodes[idx + 1]}`]; // Ci -> Ci+1
      return [];
    };
    const m4M = await publishContractClosureManifest(ctx, buildContractClosureManifest(nodes[0], nodes));
    await rejects("an over-depth edge re-reaching the already-visited root trips the depth bound (checked before the visited dedupe)",
      () => fetchContractClosure(ctx, m4M.closureDigestHex, seam), "contract-invalid");
  }

  await nc.close();
} finally {
  broker.kill("SIGKILL");
  await new Promise<void>((resolve) => { broker.once("exit", () => resolve()); broker.once("error", () => resolve()); });
  rmSync(sd, { recursive: true, force: true });
}

function HEXLIKE(s: string): boolean { return /^[0-9a-f]{64}$/.test(s); }

console.log(`\nENDPOINT CONTRACT-STORE SMOKE ${fail === 0 ? "OK ✅ " : "FAILED ❌ "} (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
