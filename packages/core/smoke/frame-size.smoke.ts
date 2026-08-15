/**
 * `encodedSize` must measure what the BROKER measures — calibrated against a real one.
 *
 * WHY A SIZING API AT ALL. An oversized event frame is split into parts so the loss is LABELLED and
 * therefore visible. A split sized against the caller's own payload is not merely imprecise, it is
 * wrong in the dangerous direction: the frame it produces is REJECTED, and a rejected truncation
 * makes the loss silent again — the exact failure the split exists to prevent. So the number a
 * caller splits against has to be the number the broker enforces, and nothing short of a broker can
 * confirm that it is.
 *
 * THE CONTROL THIS SUITE IS BUILT AROUND, and it is the reason the API is not just `maxPayload`
 * arithmetic: **a frame that FITS by naive payload arithmetic and is still REFUSED.** Under a
 * 4096-byte ceiling, a 3994-byte JSON payload — a hundred bytes clear by the caller's own
 * measurement — is rejected with `'payload' max_payload size exceeded`, because the endpoint adds
 * `id`/`ts`/`space`/`from`/`channel` to the envelope after the call and the JetStream client adds
 * two headers the broker charges against the same ceiling. Without that cell, `encodedSize` would be
 * an API nobody had shown measures the thing that is actually enforced.
 *
 * WHY IT BINARY-SEARCHES INSTEAD OF ASSERTING A CONSTANT. A cell comparing `encodedSize` to a number
 * I computed from the protocol would be grading my arithmetic against itself. The broker's true
 * boundary is found by bisection and `encodedSize` is required to land on it EXACTLY — one byte
 * either side is a failure. That makes a client upgrade that changes header encoding, or a publish
 * path that starts setting a third header, fail HERE rather than in a customer's split.
 *
 * The ceiling is 4096 rather than the 1MB default so the search is cheap and the arithmetic is
 * legible; the property under test is a ratio of frame to ceiling, not an absolute size. This suite
 * therefore boots its OWN broker: forcing the rest of the CAS suite under a 4KB ceiling would couple
 * cells that have nothing to do with sizing to a configuration they never asked for.
 *
 * KILL SET, as names:
 *   M8  drop the header block from `encodedSize` (return the payload length alone) — kills
 *       "encodedSize lands EXACTLY on the broker's boundary" and "encodedSize PREDICTS the refusal
 *       of a frame that naive arithmetic says fits". This is the mutation that reproduces the whole
 *       defect: it is what a caller doing its own arithmetic already computes.
 *   M9  size the expectation header at a fixed 0 — kills "the expectation's DIGITS are charged".
 *       A frame sized one digit short of the ceiling is precisely the frame that gets refused.
 *
 * Run: pnpm smoke:frame-size   (needs nats-server on PATH)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CotalEndpoint, isReachable, mintLifecycleUid } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MAXP = 4096;
const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "frame-size-"));
const conf = join(sd, "nats.conf");
writeFileSync(conf, `port: ${PORT}\nhost: "127.0.0.1"\nmax_payload: ${MAXP}\njetstream { store_dir: "${join(sd, "js")}" }\n`);
const broker = spawn("nats-server", ["-c", conf], { stdio: "ignore" });
const SPACE = "framesize";
const CH = "events.probe.s1";

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  c("broker is reachable", up);

  const ep = new CotalEndpoint({
    space: SPACE, servers: `nats://127.0.0.1:${PORT}`,
    card: { name: "w1", kind: "agent", id: "w1_p" }, channels: [CH], lifecycleUid: mintLifecycleUid(),
  });
  ep.on("error", () => {});
  await ep.start();
  c("the broker's ceiling is the one we configured", ep.maxPayload === MAXP, ep.maxPayload);

  /** The frame under test at a given text length — one shape, so every cell measures and publishes
   *  the same thing rather than two things that resemble each other. */
  const frame = (n: number, id: string) => ({ channel: CH, parts: [{ kind: "text" as const, text: "x".repeat(n) }], id });
  /** What a caller doing its OWN arithmetic would compute: its parts, serialized. This is the number
   *  that is wrong, kept explicit so the inverse control is legible rather than asserted. */
  const naive = (n: number, id: string) => Buffer.byteLength(JSON.stringify(frame(n, id).parts), "utf8");

  let tip = 0;
  const publishes = async (n: number): Promise<{ ok: boolean; err?: string }> => {
    const id = randomUUID();
    try {
      const r = await ep.multicastExpecting({ ...frame(n, id), expectedLastSubjectSeq: tip });
      tip = r.ack.seq;                     // only a stored frame moves the tip
      return { ok: true };
    } catch (e) { return { ok: false, err: (e as Error).message }; }
  };

  // ── CALIBRATION: find the broker's TRUE boundary by bisection ────────────────────────────────
  let lo = 1, hi = 8000, largest = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((await publishes(mid)).ok) { largest = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  c("a boundary was actually found (the search is not reporting an unreached edge)",
    largest > 0 && largest < 8000, largest);

  // `encodedSize` must land on that boundary EXACTLY: the largest frame that publishes is at or
  // under the ceiling, and one byte more is over it. Both halves, because a function returning a
  // constant 0 satisfies the first and one returning Infinity satisfies the second.
  const atEdge = ep.encodedSize({ ...frame(largest, randomUUID()), expectedLastSubjectSeq: tip });
  const overEdge = ep.encodedSize({ ...frame(largest + 1, randomUUID()), expectedLastSubjectSeq: tip });
  c("encodedSize lands EXACTLY on the broker's boundary",
    atEdge <= MAXP && overEdge > MAXP, { largest, atEdge, overEdge, MAXP });

  // ── THE INVERSE CONTROL: fits by naive arithmetic, REFUSED by the broker ─────────────────────
  //    The frame one byte past the boundary. Its own payload is comfortably under the ceiling, so a
  //    caller sizing its parts would send it — and the broker would drop it on the floor.
  const overId = randomUUID();
  const naiveBytes = naive(largest + 1, overId);
  c("the refused frame FITS by naive payload arithmetic (this is what makes it a control)",
    naiveBytes < MAXP, { naiveBytes, MAXP });
  const refused = await publishes(largest + 1);
  c("EFFECT: the broker REFUSES it anyway, naming max_payload",
    refused.ok === false && /max_payload/.test(refused.err ?? ""), refused);
  c("encodedSize PREDICTS that refusal, which naive arithmetic does not",
    overEdge > MAXP && naiveBytes < MAXP, { overEdge, naiveBytes, MAXP });
  c("and the bytes the caller cannot see are a real cost, not a rounding error",
    overEdge - naiveBytes > 100, overEdge - naiveBytes);

  // ── THE POSITIVE CONTROL, the inverse of the predicate above ─────────────────────────────────
  //    Everything so far is satisfied by a broker that refuses everything and a sizer that always
  //    reports "too big". The frame `encodedSize` says fits must actually publish.
  c("CONTROL: the frame encodedSize says FITS does publish", (await publishes(largest)).ok === true);

  // ── THE EXPECTATION HEADER IS CHARGED BY ITS DIGITS ──────────────────────────────────────────
  //    Sizing at sequence 0 and publishing at 1234567 differ by six bytes. A frame sized one digit
  //    short of the ceiling is exactly the frame that gets refused, so the parameter is not cosmetic.
  const small = ep.encodedSize({ ...frame(100, "fixed-id-token"), expectedLastSubjectSeq: 0 });
  const big = ep.encodedSize({ ...frame(100, "fixed-id-token"), expectedLastSubjectSeq: 1234567 });
  c("the expectation's DIGITS are charged", big - small === "1234567".length - "0".length, { small, big });

  // ── the headers are charged at all: the same frame always costs more than its payload ─────────
  c("encodedSize exceeds the caller's own payload measurement",
    ep.encodedSize({ ...frame(100, "fixed-id-token"), expectedLastSubjectSeq: 0 }) > naive(100, "fixed-id-token"));

  // ── it refuses what the publish path refuses, so nothing can be sized that could not be sent ──
  //
  //    Each of these names WHICH refusal it expects. `encodedSize` applies four guards in a fixed
  //    order (wildcard → id → expectation → parts), and a cell asserting only "it threw" passes when
  //    an EARLIER guard fires instead of the one under test — so a reordering, or a guard broken to
  //    refuse everything, would leave all four green while three of them stopped testing anything.
  //    That is not hypothetical here: the empty-parts check is the LAST of the four, so its cell is
  //    the one furthest from the message it depends on.
  const throwsSync = (what: string, fn: () => unknown, pattern: RegExp) => {
    try { fn(); c(what, false, "did NOT throw"); }
    catch (e) { const m = (e as Error).message; c(what, pattern.test(m), m); }
  };
  throwsSync("sizing a WILDCARD channel is refused",
    () => ep.encodedSize({ channel: "events.>", parts: [{ kind: "text", text: "x" }], id: randomUUID(), expectedLastSubjectSeq: 0 }),
    /cannot publish to wildcard channel "events\.>"/);
  throwsSync("sizing with EMPTY parts is refused",
    () => ep.encodedSize({ channel: CH, parts: [], id: randomUUID(), expectedLastSubjectSeq: 0 }),
    /encodedSize requires at least one part/);
  // `[\s\S]*` and not `.*`: the refusal quotes the offending id back, and THIS id is `a\r\nb`, so
  // the message genuinely spans two lines and `.` never matches the newline between them. Found by
  // writing the pattern the obvious way and watching this cell fail — the same header-hostile bytes
  // the guard exists to reject also break the naive matcher that checks it was rejected.
  throwsSync("sizing with a header-hostile id is refused",
    () => ep.encodedSize({ channel: CH, parts: [{ kind: "text", text: "x" }], id: "a\r\nb", expectedLastSubjectSeq: 0 }),
    /publish id [\s\S]*is not a valid id token/);
  throwsSync("sizing with a NEGATIVE expectation is refused",
    () => ep.encodedSize({ channel: CH, parts: [{ kind: "text", text: "x" }], id: randomUUID(), expectedLastSubjectSeq: -1 }),
    /expectedLastSubjectSeq must be a non-negative safe integer, got -1/);

  //    THE CONTROL, and it is the inverse of the predicate the four cells test: a machine that
  //    refused EVERY sizing call would satisfy all four refusals above. This is the legitimate
  //    neighbour of each — same channel, same shape, nothing hostile — and it must return a number.
  //    The calibration cells above also size successfully, but they are testing the arithmetic; this
  //    one exists so the refusal block cannot become vacuous without a cell going red.
  let controlSize = -1;
  try {
    controlSize = ep.encodedSize({ channel: CH, parts: [{ kind: "text", text: "x" }], id: randomUUID(), expectedLastSubjectSeq: 0 });
  } catch (e) { controlSize = -1; c("CONTROL threw", false, (e as Error).message); }
  c("CONTROL: the legitimate neighbour of all four is ACCEPTED and sized", controlSize > 0, controlSize);

  await ep.stop();
} finally {
  broker.kill("SIGKILL");
  rmSync(sd, { recursive: true, force: true });
}

console.log(`frame-size smoke: ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
