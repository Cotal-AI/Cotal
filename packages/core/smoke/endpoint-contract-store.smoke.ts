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
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable, EpEnvelopeError,
  createEndpointStreams, epcSubject,
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
  await createEndpointStreams(jsm, new Kvm(nc), SPACE);
  const ctx = await contractStoreContext(nc, SPACE);
  const artifact = (v: unknown) => contractArtifactCanonicalBytes(v);

  await rejects("a hand-assembled context never authorizes (the space bond is constructed, not asserted)",
    () => publishContractArtifact({ js: ctx.js, jsm: ctx.jsm, space: SPACE } as ContractStoreContext, artifact({ a: 1 })), "failed-precondition");

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
    await ctx.js.publish(epcSubject(SPACE, "f".repeat(64)), enc("not the content"), { headers: h1 });
    await rejects("a mis-addressed artifact FAILS verify-on-read (content addressing is the tamper boundary)",
      () => fetchContractArtifact(ctx, "f".repeat(64)), "internal");
    const nonCanon = enc('{"b":1,"a":2}');
    const nonCanonHex = contractArtifactDigestHex(nonCanon);
    const h2 = headers(); h2.set("Nats-Expected-Last-Subject-Sequence", "0");
    await ctx.js.publish(epcSubject(SPACE, nonCanonHex), nonCanon, { headers: h2 });
    await rejects("NONCANONICAL bytes at their own digest subject STILL fail the read (canonical form is the second proof)",
      () => fetchContractArtifact(ctx, nonCanonHex), "internal");
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

  await nc.close();
} finally {
  broker.kill("SIGKILL");
  await new Promise<void>((resolve) => { broker.once("exit", () => resolve()); broker.once("error", () => resolve()); });
  rmSync(sd, { recursive: true, force: true });
}

function HEXLIKE(s: string): boolean { return /^[0-9a-f]{64}$/.test(s); }

console.log(`\nENDPOINT CONTRACT-STORE SMOKE ${fail === 0 ? "OK ✅ " : "FAILED ❌ "} (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
