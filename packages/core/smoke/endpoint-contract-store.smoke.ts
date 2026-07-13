/**
 * v0.4 §13.7 CONTRACT STORE smoke — the content-addressed single-message store against a real
 * broker: create-only digest-subject publication (digest computed from the exact bytes; a
 * republish is idempotent), verify-on-read as the tamper boundary (a mis-addressed artifact
 * fails loud), the 256 KiB single-message bound, and the bounded all-or-nothing closure walk
 * through digest references (cycle-safe, missing artifact and over-bound both loud).
 *
 * Run: pnpm smoke:ep-contract-store   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable, EpEnvelopeError,
  createEndpointStreams, epcSubject,
  contractArtifactDigestHex, contractRefToHex,
  publishContractArtifact, fetchContractArtifact, fetchContractClosure,
  CONTRACT_ARTIFACT_MAX_BYTES,
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

// ── reference normalization (broker-free) ──
{
  const hex = contractArtifactDigestHex(enc("x"));
  c("a bare-hex and a sha256:-prefixed reference normalize to the same subject token",
    contractRefToHex(hex) === hex && contractRefToHex(`sha256:${hex}`) === hex);
}
await rejects("a malformed reference never resolves", () => contractRefToHex("sha256:nope"), "contract-invalid");

const PORT = 20000 + Math.floor(Math.random() * 40000);
const sd = mkdtempSync(join(tmpdir(), "cotal-epstore-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  await createEndpointStreams(jsm, new Kvm(nc), SPACE);

  // ── publish + fetch + verify-on-read ──
  const A = enc(JSON.stringify({ schema: "A", refs: [] }));
  const pubA = await publishContractArtifact(js, jsm, SPACE, A);
  c("the first publication wins its create-only CAS at the content address",
    pubA.won && pubA.digestHex === contractArtifactDigestHex(A));
  const dupA = await publishContractArtifact(js, jsm, SPACE, A);
  c("a republish of the SAME bytes is an idempotent loss (the subject IS the digest)", !dupA.won && dupA.digestHex === pubA.digestHex);
  const backA = await fetchContractArtifact(jsm, SPACE, pubA.digestHex);
  c("the artifact fetches back verified (bytes recompute the digest)", backA !== undefined && dec(backA) === dec(A));
  c("an unpublished digest fetches undefined",
    (await fetchContractArtifact(jsm, SPACE, "0".repeat(64))) === undefined);
  await rejects("an OVERSIZE artifact refuses (single-message bound; never chunked)",
    () => publishContractArtifact(js, jsm, SPACE, new Uint8Array(CONTRACT_ARTIFACT_MAX_BYTES + 1)), "contract-invalid");
  {
    // the tamper boundary: bytes planted at a subject they do not digest to FAIL the read.
    const forgedHex = "f".repeat(64);
    const h = (await import("@nats-io/transport-node")).headers(); h.set("Nats-Expected-Last-Subject-Sequence", "0");
    await js.publish(epcSubject(SPACE, forgedHex), enc("not the content"), { headers: h });
    await rejects("a mis-addressed artifact FAILS verify-on-read (content addressing is the tamper boundary)",
      () => fetchContractArtifact(jsm, SPACE, forgedHex), "internal");
  }

  // ── the bounded, all-or-nothing closure walk ──
  const leaf1 = enc(JSON.stringify({ schema: "leaf1", refs: [] }));
  const leaf2 = enc(JSON.stringify({ schema: "leaf2", refs: [] }));
  const l1 = (await publishContractArtifact(js, jsm, SPACE, leaf1)).digestHex;
  const l2 = (await publishContractArtifact(js, jsm, SPACE, leaf2)).digestHex;
  const mid = enc(JSON.stringify({ schema: "mid", refs: [`sha256:${l1}`, l2] }));
  const m = (await publishContractArtifact(js, jsm, SPACE, mid)).digestHex;
  const root = enc(JSON.stringify({ schema: "root", refs: [m, l1] })); // l1 twice: diamond
  const r = (await publishContractArtifact(js, jsm, SPACE, root)).digestHex;
  const refsOf = (bytes: Uint8Array): string[] => (JSON.parse(dec(bytes)) as { refs: string[] }).refs;

  const closure = await fetchContractClosure(jsm, SPACE, r, refsOf);
  c("the closure walks artifact-by-artifact through digest references (root first, diamond-safe, every artifact verified)",
    closure.size === 4 && [...closure.keys()][0] === r && closure.has(l1) && closure.has(l2) && closure.has(m));
  await rejects("a closure referencing an UNPUBLISHED artifact fails loud (all-or-nothing, never partial)",
    () => fetchContractClosure(jsm, SPACE, r, (b, hex) => (hex === m ? ["1".repeat(64)] : refsOf(b))), "failed-precondition");
  await rejects("a closure exceeding the artifact bound fails loud (bounded, never truncated)",
    () => fetchContractClosure(jsm, SPACE, r, refsOf, { maxArtifacts: 2 }), "failed-precondition");
  {
    // cycle safety: two artifacts referencing each other terminate.
    const selfRef = enc(JSON.stringify({ schema: "self", refs: [] }));
    const s1 = (await publishContractArtifact(js, jsm, SPACE, selfRef)).digestHex;
    const cyc = await fetchContractClosure(jsm, SPACE, s1, () => [s1]); // self-cycle
    c("a cyclic reference terminates (visited digests never re-walk)", cyc.size === 1);
  }
  await rejects("a garbled resolution seam (non-string-array) never extends a closure",
    () => fetchContractClosure(jsm, SPACE, r, (() => "nope") as unknown as () => string[]), "internal");
  await rejects("a closure without the resolution seam refuses (the store never guesses a document's reference shape)",
    () => fetchContractClosure(jsm, SPACE, r, undefined as unknown as () => string[]), "failed-precondition");

  await nc.close();
} finally {
  broker.kill("SIGKILL");
  await new Promise<void>((resolve) => { broker.once("exit", () => resolve()); broker.once("error", () => resolve()); });
  rmSync(sd, { recursive: true, force: true });
}

console.log(`\nENDPOINT CONTRACT-STORE SMOKE ${fail === 0 ? "OK ✅ " : "FAILED ❌ "} (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
