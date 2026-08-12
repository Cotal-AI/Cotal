/**
 * CAS-aware publish smoke — `multicastExpecting` and `maxPayload`, against a real JetStream.
 *
 * This is the serialized-append primitive the AG-UI event plane is built on: a caller supplies a
 * frozen dedup id and the sequence it believes is the subject's tip, and gets the `PubAck` back
 * instead of having it discarded. Two writers racing one subject cannot interleave, because the
 * loser's expectation no longer holds.
 *
 * MUTATION LEDGER — predicted BEFORE each run, then CORRECTED from what actually died. Both
 * mutations were run; the corrections are the useful part and are kept rather than tidied away.
 *
 *   M1  drop `expect:` from the publish
 *       predicted 2: "stale expectation is a CAS loss", "dual-connect ... LOSES"
 *       ACTUAL  3: also "append at the current tip succeeds".
 *       The prediction was incomplete, not the check wrong: with no fence the refused write LANDS,
 *       so the tip advances and the absolute-sequence assertion shifts. Note the coupling — that
 *       cell depends on earlier cells having been refused, which is deliberate (it proves ordering)
 *       but means it is not independent.
 *
 *   M2  remove `assertIdToken`
 *       predicted 2: "header-hostile id refused (CRLF)", "empty id refused"
 *       ACTUAL  1: only "empty id refused". **The CRLF cell SURVIVED.**
 *       That was a real defect in this suite: the NATS client rejects CRLF in a header on its own,
 *       so that cell proved the TRANSPORT's validation and would stay green with ours deleted.
 *       Fixed by adding two cells only our grammar can catch — a 65-char id and one containing
 *       `.`/`:` — both of which the transport would carry happily. Re-run: kills 3, CRLF correctly
 *       not among them.
 *
 * The lesson worth keeping: a mutation that kills FEWER cells than predicted is a finding about the
 * suite, not a nuisance. M2 is the whole reason this file has a discriminating id cell at all.
 *
 * Run: pnpm smoke:cas-publish   (needs nats-server on PATH)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CotalEndpoint, isCasLoss, isReachable, mintLifecycleUid } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cas-publish-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const SPACE = "caspub";
const CH = "events.probe.s1";

/** Assert a throw happened AND matched, so a silently-succeeding call can never read as a pass. */
async function throws(what: string, fn: () => Promise<unknown>, match: (e: unknown) => boolean) {
  try { await fn(); c(what, false, "did NOT throw"); }
  catch (e) { c(what, match(e), e); }
}

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  c("broker is reachable", up);

  // ── maxPayload BEFORE start: must throw, never guess ──
  const cold = new CotalEndpoint({ space: SPACE, servers: `nats://127.0.0.1:${PORT}`, card: { name: "cold", kind: "agent", id: "cold_p" }, lifecycleUid: mintLifecycleUid() });
  throwsSync("maxPayload throws when not live", () => cold.maxPayload);

  const ep = new CotalEndpoint({ space: SPACE, servers: `nats://127.0.0.1:${PORT}`, card: { name: "w1", kind: "agent", id: "w1_p" }, channels: [CH], lifecycleUid: mintLifecycleUid() });
  ep.on("error", () => {});
  await ep.start();

  // ── maxPayload is live and sane ──
  const mp = ep.maxPayload;
  c("maxPayload is a positive number while live", typeof mp === "number" && mp > 0, mp);

  // ── first append onto an empty subject ──
  const id1 = randomUUID();
  const r1 = await ep.multicastExpecting({ channel: CH, parts: [{ kind: "text", text: "one" }], id: id1, expectedLastSubjectSeq: 0 });
  c("first publish at expected=0 stores", r1.ack.seq > 0 && r1.ack.duplicate === false, r1.ack);
  c("returned message carries the caller's id", r1.message.id === id1);

  // ── the tip moved, so the SAME frozen expectation is now stale ──
  await throws(
    "stale expectation is a CAS loss",
    () => ep.multicastExpecting({ channel: CH, parts: [{ kind: "text", text: "two" }], id: randomUUID(), expectedLastSubjectSeq: 0 }),
    (e) => isCasLoss(e),
  );

  // ── append correctly at the new tip ──
  const r2 = await ep.multicastExpecting({ channel: CH, parts: [{ kind: "text", text: "two" }], id: randomUUID(), expectedLastSubjectSeq: r1.ack.seq });
  c("append at the current tip succeeds", r2.ack.seq === r1.ack.seq + 1, r2.ack);

  // ── in-window duplicate: same id, expectation refreshed to the tip ──
  const dup = await ep.multicastExpecting({ channel: CH, parts: [{ kind: "text", text: "two" }], id: r2.message.id, expectedLastSubjectSeq: r2.ack.seq });
  c("in-window duplicate is reported as duplicate, not stored twice", dup.ack.duplicate === true && dup.ack.seq === r2.ack.seq, dup.ack);

  // ── a DIFFERENT principal does NOT race us: chatSubject puts the publisher's identity BEFORE
  //    the channel, so w2 writes its own subject whose tip is genuinely 0. The first draft of this
  //    smoke asserted a cross-principal CAS loss and FAILED — correctly. The fence is per subject,
  //    i.e. per principal per channel, which is exactly what §5.5's one-emitter-per-principal rule
  //    relies on. Keeping it as a positive check so the separation is proved, not assumed. ──
  const ep2 = new CotalEndpoint({ space: SPACE, servers: `nats://127.0.0.1:${PORT}`, card: { name: "w2", kind: "agent", id: "w2_p" }, channels: [CH], lifecycleUid: mintLifecycleUid() });
  ep2.on("error", () => {});
  await ep2.start();
  const other = await ep2.multicastExpecting({ channel: CH, parts: [{ kind: "text", text: "other-principal" }], id: randomUUID(), expectedLastSubjectSeq: 0 });
  c("a different principal writes its OWN subject (expected=0 still valid there)", other.ack.duplicate === false && other.ack.seq > 0, other.ack);

  // ── the REAL race is dual-connect on ONE principal: same card, same subject, same expectation.
  //    This is the case §5.4 names — one of the two takes a CAS loss and halts. ──
  const twin = new CotalEndpoint({ space: SPACE, servers: `nats://127.0.0.1:${PORT}`, card: { name: "w1", kind: "agent", id: "w1_p" }, channels: [CH], lifecycleUid: mintLifecycleUid() });
  twin.on("error", () => {});
  await twin.start();
  await throws(
    "dual-connect on one principal: the stale writer LOSES",
    () => twin.multicastExpecting({ channel: CH, parts: [{ kind: "text", text: "racer" }], id: randomUUID(), expectedLastSubjectSeq: 0 }),
    (e) => isCasLoss(e),
  );
  await twin.stop();

  // ── argument validation: each refusal is a separate, individually killable cell ──
  // An over-length id is the DISCRIMINATING cell: 65 legal chars, which the transport would carry
  // happily, so ONLY our grammar can refuse it. The CRLF cell below survived removing assertIdToken
  // in mutation testing — the NATS client rejects CRLF headers on its own, so that cell proves the
  // transport's validation, not ours. Kept for the injection case, but it is not the discriminator.
  await throws("over-length id refused (only our grammar can catch this)", () => ep.multicastExpecting({ channel: CH, parts: [{ kind: "text", text: "x" }], id: "a".repeat(65), expectedLastSubjectSeq: 0 }), (e) => !isCasLoss(e));
  await throws("id with a grammar-illegal character refused", () => ep.multicastExpecting({ channel: CH, parts: [{ kind: "text", text: "x" }], id: "has.dots.and:colons", expectedLastSubjectSeq: 0 }), (e) => !isCasLoss(e));
  await throws("header-hostile id refused (CRLF)", () => ep.multicastExpecting({ channel: CH, parts: [{ kind: "text", text: "x" }], id: "bad\r\nid", expectedLastSubjectSeq: 0 }), (e) => !isCasLoss(e));
  await throws("empty id refused", () => ep.multicastExpecting({ channel: CH, parts: [{ kind: "text", text: "x" }], id: "", expectedLastSubjectSeq: 0 }), (e) => !isCasLoss(e));
  await throws("negative expectation refused", () => ep.multicastExpecting({ channel: CH, parts: [{ kind: "text", text: "x" }], id: randomUUID(), expectedLastSubjectSeq: -1 }), (e) => !isCasLoss(e));
  await throws("non-integer expectation refused", () => ep.multicastExpecting({ channel: CH, parts: [{ kind: "text", text: "x" }], id: randomUUID(), expectedLastSubjectSeq: 1.5 }), (e) => !isCasLoss(e));
  await throws("wildcard channel refused", () => ep.multicastExpecting({ channel: "events.>", parts: [{ kind: "text", text: "x" }], id: randomUUID(), expectedLastSubjectSeq: 0 }), (e) => !isCasLoss(e));
  await throws("empty parts refused", () => ep.multicastExpecting({ channel: CH, parts: [], id: randomUUID(), expectedLastSubjectSeq: 0 }), (e) => !isCasLoss(e));

  // ── ordinary multicast is UNTOUCHED: additive change, no existing caller behaves differently ──
  const plain = await ep.multicast("ordinary", { channel: CH });
  c("ordinary multicast still works and still mints its own id", typeof plain.id === "string" && plain.id.length > 0 && plain.id !== id1);

  await ep2.stop();
  await ep.stop();
} finally {
  broker.kill("SIGKILL");
  rmSync(sd, { recursive: true, force: true });
}

function throwsSync(what: string, fn: () => unknown) {
  try { fn(); c(what, false, "did NOT throw"); }
  catch { c(what, true); }
}

console.log(`cas-publish smoke: ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
