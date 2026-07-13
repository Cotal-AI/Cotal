/**
 * v0.4 §13.10 RECEIPT smoke — the signed request→outcome binding: mint (digests computed from
 * the raw evidence), closed identity-bound parsing, create-only publication on the caller- and
 * execution-scoped subject (one execution, one receipt, forever — a different receipt on the
 * subject is a loud conflict), and verification (exact-raw D28 signature via the `receipts`
 * anchor role + endpoint scope + window, digest recomputation against presented args/result,
 * request-mismatch fails loud).
 *
 * Run: pnpm smoke:ep-receipt   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { createUser } from "@nats-io/nkeys";
import {
  isReachable, EpEnvelopeError, contractDigest,
  createEndpointStreams,
  mintReceipt, parseReceipt, publishReceipt, readReceipt, verifyReceipt, receiptSubject,
  type EpCaller, type ReceiptRef, type Receipt, type SignerAnchor, type AnchorResolver,
} from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const rejects = async (n: string, fn: () => Promise<unknown> | unknown, code?: string) => {
  try { await fn(); c(n, false, "no throw"); } catch (e) {
    c(n, code === undefined || (e instanceof EpEnvelopeError && e.code === code), `code ${(e as EpEnvelopeError).code ?? (e as Error).message}`);
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SPACE = "eprcpt";
const NOW = 1_000_000;
const UID = "u".repeat(26);
const caller: EpCaller = { owner: "u_abc", actor: "worker", uid: UID };
const ref: ReceiptRef = { endpoint: "manager", caller, requestId: "req-1", sourceSeq: 42 };
const kp = createUser();
const anchors = new Map<string, SignerAnchor>();
anchors.set("rcpt-1", { keyId: "rcpt-1", publicKey: kp.getPublicKey(), owner: "u_mgr", roles: ["receipts"], scope: { receipts: ["manager"] }, validFrom: 0, validTo: NOW + 10_000_000 });
anchors.set("narrow-1", { keyId: "narrow-1", publicKey: kp.getPublicKey(), owner: "u_mgr", roles: ["receipts"], scope: { receipts: ["other"] }, validFrom: 0, validTo: NOW + 10_000_000 });
const resolveAnchor: AnchorResolver = (keyId) => anchors.get(keyId);

const ARGS = { image: "app:1", replicas: 3 };
const RESULT = { deployed: true };
const SCHEMAS = { input: contractDigest({ in: 1 }), output: contractDigest({ out: 1 }) };
const mint = (over: Record<string, unknown> = {}): Receipt => mintReceipt({
  ref, space: SPACE, command: "deploy",
  instance: { id: "u_mgr.manager", instanceId: "i".repeat(26), epoch: 2 },
  caller: { id: "u_abc.worker", lifecycleUid: UID },
  schemaDigests: SCHEMAS, args: ARGS, outcome: { ok: true }, result: RESULT, ts: NOW,
  signer: { keyId: "rcpt-1" }, ...over,
} as Parameters<typeof mintReceipt>[0], kp);

// ── mint + parse + verify (broker-free) ──
const receipt = mint();
c("mint digests the RAW evidence itself (argsDigest/resultDigest recompute)",
  receipt.argsDigest === contractDigest(ARGS) && receipt.resultDigest === contractDigest(RESULT) && receipt.sig.length > 0);
c("the receipt subject is caller- and execution-scoped",
  receiptSubject(SPACE, ref).endsWith(`.receipt.u_abc.worker.${UID}.req-1.42`));
c("parse binds the receipt to its subject coordinates", parseReceipt(receipt as unknown as Record<string, unknown>, ref, SPACE).requestId === "req-1");
await rejects("a receipt read under FOREIGN coordinates is rejected (request-mismatched receipts fail loud)",
  () => parseReceipt(receipt as unknown as Record<string, unknown>, { ...ref, requestId: "req-OTHER" }, SPACE), "internal");
{
  const verified = await verifyReceipt(receipt, { ref, space: SPACE, resolveAnchor, recompute: { args: ARGS, result: RESULT } });
  c("a genuine receipt verifies: exact-raw signature + full digest recomputation", verified.outcome.ok === true);
}
await rejects("a receipt whose argsDigest does not recompute from the presented args fails loud",
  () => verifyReceipt(receipt, { ref, space: SPACE, resolveAnchor, recompute: { args: { image: "app:1", replicas: 999 } } }), "permission-denied");
await rejects("a receipt whose resultDigest does not recompute from the presented result fails loud",
  () => verifyReceipt(receipt, { ref, space: SPACE, resolveAnchor, recompute: { result: { deployed: false } }, }), "permission-denied");
{
  const noResult = mint({ result: undefined });
  await rejects("a receipt with NO resultDigest cannot attest a presented result",
    () => verifyReceipt(noResult, { ref, space: SPACE, resolveAnchor, recompute: { result: RESULT } }), "permission-denied");
}
{
  const tampered = { ...receipt, outcome: { ok: false } };
  await rejects("a TAMPERED receipt (outcome flipped after signing) fails its signature",
    () => verifyReceipt(tampered, { ref, space: SPACE, resolveAnchor }), "permission-denied");
}
await rejects("a receipt signed by a key whose `receipts` scope does not cover the endpoint fails",
  () => verifyReceipt(mint({ signer: { keyId: "narrow-1" } }), { ref, space: SPACE, resolveAnchor }), "permission-denied");
await rejects("a receipt naming an UNKNOWN signing key fails closed",
  () => verifyReceipt(mint({ signer: { keyId: "ghost" } }), { ref, space: SPACE, resolveAnchor }), "permission-denied");
await rejects("a receipt signed OUTSIDE the anchor's validity window fails",
  () => verifyReceipt(mint({ ts: NOW + 20_000_000 }), { ref, space: SPACE, resolveAnchor }), "permission-denied");
await rejects("a garbled receipt (unknown field) never attests",
  () => parseReceipt({ ...receipt, rogue: 1 }, ref, SPACE), "internal");

// ── create-only publication: one execution, one receipt, forever ──
const PORT = 20000 + Math.floor(Math.random() * 40000);
const sd = mkdtempSync(join(tmpdir(), "cotal-eprcpt-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  await createEndpointStreams(jsm, new Kvm(nc), SPACE);

  c("no receipt reads undefined", (await readReceipt(jsm, SPACE, ref)) === undefined);
  const pub = await publishReceipt(js, jsm, SPACE, ref, receipt);
  c("the first publication wins its create-only CAS", pub.won);
  const dup = await publishReceipt(js, jsm, SPACE, ref, receipt);
  c("an IDENTICAL republish loses harmlessly and returns the recorded receipt (idempotent emit)", !dup.won && dup.receipt.sig === receipt.sig);
  await rejects("a DIFFERENT receipt for the same execution is a loud conflict (one execution, one receipt, forever)",
    () => publishReceipt(js, jsm, SPACE, ref, mint({ ts: NOW + 5 })), "conflict");
  await rejects("publishing a receipt under coordinates it does not name refuses before writing",
    () => publishReceipt(js, jsm, SPACE, { ...ref, requestId: "req-2" }, receipt), "internal");
  const back = await readReceipt(jsm, SPACE, ref);
  c("the recorded receipt reads back identity-bound and re-verifies",
    back !== undefined && (await verifyReceipt(back, { ref, space: SPACE, resolveAnchor, recompute: { args: ARGS, result: RESULT } })).ts === NOW);

  await nc.close();
} finally {
  broker.kill("SIGKILL");
  await new Promise<void>((resolve) => { broker.once("exit", () => resolve()); broker.once("error", () => resolve()); });
  rmSync(sd, { recursive: true, force: true });
}

console.log(`\nENDPOINT RECEIPT SMOKE ${fail === 0 ? "OK ✅ " : "FAILED ❌ "} (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
