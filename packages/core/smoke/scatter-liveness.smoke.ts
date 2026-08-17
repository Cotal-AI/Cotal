/**
 * SCATTER LIVENESS smoke (SPEC §13.5) — the classification point T, and what is allowed to move it.
 *
 * THE DEFECT THIS EXISTS FOR. `epScatter`'s gather has exactly two exits: every frozen slot answered,
 * or the deadline. A frozen slot for an instance that CANNOT answer makes the first unreachable, so
 * the deadline is paid in full. `freezeExpectedSet` reads REGISTRATION, not liveness, and a crashed
 * instance never deregisters — so a corpse stays registered as live forever and every scatter in the
 * space pays for it forever. Measured on a live mesh at `5ded759d`: `cotal ps` = 13.8s, of which
 * `scatterCommand` = 8.38s against its 8000ms budget, with 1 of 3 registered managers answering.
 *
 * WHAT THIS SUITE REFUSES TO ACCEPT AS A FIX. The obvious shortcut — "presence says it is gone, so
 * classify it missing early" — reads absence of evidence as death, and on the mesh this was measured
 * against, the one manager actually running 22 seats both drops out of presence periodically (its
 * liveness lease times out and re-registers) AND needs ~1.1s to answer. A short grace keyed on
 * presence would call THAT manager unreachable, faster than the current code produces the right
 * answer. So section 2 is the whole point of the suite: every non-`gone` verdict — `live`, `unknown`,
 * a throwing probe, a value outside the closed set — must produce the RIGHT answer SLOWLY, and the
 * cells assert the elapsed floor, not just the classification.
 *
 * The only thing allowed to move T earlier is the BROKER affirming that an instance holds no
 * subscription on its own `inst` rail (a no-responders 503 on the reserved sentinel). That is evidence
 * of absence rather than absence of evidence, and section 5 drives the probe against a real broker
 * both ways round.
 *
 * Responders are hand-rolled on the `all` rail — one subscriber emitting a crafted batch — so each
 * simulated instance's answer, delay, and silence are exact. `serveEndpoint` cannot produce a corpse
 * that is still registered; that is the shape being tested.
 *
 * Run: pnpm smoke:scatter-liveness   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import type { NatsConnection, Subscription } from "@nats-io/transport-node";
import {
  isReachable, compileContract, parseEpSubject, epReplySubject, spacePrefix,
  epScatter, epProbeInstanceInterest,
  type EpCaller, type EpVerbOp, type ParsedEpRequest, type EpRegistrationState, type EpInstanceLiveness,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const EXPECTED_CELLS = 36;

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) { ok++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log("  ✗ FAIL:", n, extra !== undefined ? JSON.stringify(extra) : ""); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SPACE = "scatterlive";
const ENDPOINT = "demo";
const caller: EpCaller = { owner: "u_abc", actor: "worker", uid: "c".repeat(26) };
const enc = new TextEncoder(); const dec = new TextDecoder();

const inContract = compileContract({ root: { type: "object", properties: { n: { type: "string" } }, required: ["n"], additionalProperties: false } });
const outContract = compileContract({ root: { type: "object", properties: { which: { type: "string" } }, required: ["which"], additionalProperties: false } });
const contract = { input: inContract, output: outContract };
const opFor = (): EpVerbOp => ({ endpoint: ENDPOINT, command: "ping", contract, caller, args: { n: "x" } });

const A = "a".repeat(26); // the LIVE instance
const B = "b".repeat(26); // the CORPSE: registered, never answers
const slot = (instanceId: string) => ({ instanceId, registrationRevision: 1, epoch: 5 });
const EP = 5;
const okReconcile = (...ids: string[]) => async () =>
  new Map(ids.map((id): [string, EpRegistrationState] => [id, { registered: true, registrationRevision: 1 }]));

/** One crafted reply for a simulated instance, optionally delayed. */
interface CraftedReply { instanceId: string; delayMs?: number }
function respond(nc: NatsConnection, batch: CraftedReply[]): Subscription {
  return nc.subscribe(`${spacePrefix(SPACE)}.ep.all.>`, {
    callback: (err, msg) => {
      if (err) return;
      const p = parseEpSubject(msg.subject);
      if (!p || p.plane !== "request") return;
      const body = JSON.parse(dec.decode(msg.data)) as { id: string };
      for (const r of batch) {
        const send = () => publishReply(nc, p, body.id, r.instanceId);
        if (r.delayMs) setTimeout(send, r.delayMs); else send();
      }
    },
  });
}
function publishReply(nc: NatsConnection, req: ParsedEpRequest, requestId: string, instanceId: string) {
  const subject = epReplySubject(SPACE, { endpoint: req.endpoint, instanceId, epoch: EP, caller: req.caller, nonce: req.nonce });
  nc.publish(subject, enc.encode(JSON.stringify({ v: 1, id: requestId, ok: true, data: { which: instanceId } })));
}

/** A probe built from a fixed verdict table. `undefined` for an id means the probe THROWS for it —
 *  a probe that failed, which must establish nothing. Records what it was asked. */
function probeFrom(table: Record<string, EpInstanceLiveness | "THROW" | "GARBAGE">, delayMs = 0) {
  const asked: string[] = [];
  const probe = async (instanceId: string): Promise<EpInstanceLiveness> => {
    asked.push(instanceId);
    if (delayMs > 0) await wait(delayMs);
    const v = table[instanceId];
    if (v === "THROW") throw new Error("the probe rail is down");
    if (v === "GARBAGE") return "dead" as unknown as EpInstanceLiveness; // outside the closed set
    return v ?? "unknown";
  };
  return { probe, asked };
}

const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-scatterlive-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });

  // ── 0. THE DEFECT, and the compatibility floor ────────────────────────────────────────────────
  // With no probe wired, behavior must be EXACTLY what shipped: the deadline paid in full.
  console.log("0. no probe: a corpse in the frozen set costs the WHOLE deadline (the defect, and the floor)");
  {
    const sub = respond(nc, [{ instanceId: A }]); // B never answers
    const t0 = Date.now();
    const res = await epScatter(nc, SPACE, opFor(), {
      deadlineMs: 900, expected: [slot(A), slot(B)], reconcileRegistration: okReconcile(A, B),
    });
    const elapsed = Date.now() - t0;
    await sub.drain();
    c("without a probe the gather still pays the FULL deadline (the shipped behavior, unchanged)", elapsed >= 900, { elapsed });
    c("A's reply is counted", res.replies.has(A));
    c("B is MISSING, never omitted (pin 3)", res.missing.includes(B) && res.missing.length === 1, res.missing);
    c("not complete", res.complete === false);
  }

  // ── 1. THE FIX ────────────────────────────────────────────────────────────────────────────────
  console.log("1. broker-affirmed gone moves T earlier and moves NOTHING else");
  {
    const sub = respond(nc, [{ instanceId: A }]);
    const { probe, asked } = probeFrom({ [A]: "live", [B]: "gone" });
    const t0 = Date.now();
    const res = await epScatter(nc, SPACE, opFor(), {
      deadlineMs: 900, expected: [slot(A), slot(B)], reconcileRegistration: okReconcile(A, B), probeLiveness: probe,
    });
    const elapsed = Date.now() - t0;
    await sub.drain();
    c("the gather ends WELL before the deadline once the corpse is affirmed gone", elapsed < 450, { elapsed });
    c("every frozen slot was probed", asked.includes(A) && asked.includes(B));
    c("A's reply is still counted", res.replies.get(A)?.reply.ok === true);
    c("B is STILL reported missing — the verdict moved the clock, not the classification (pin 3)",
      res.missing.includes(B) && res.missing.length === 1, res.missing);
    c("still not complete: a gone slot is not a satisfied slot", res.complete === false);
  }

  // THE FIELD SHAPE, and the one a verdict-only settlement check would silently fail: the corpse is
  // affirmed gone within a broker round trip, but the LIVE instance answers a second later. T is
  // reached when the last live peer answers — not at the deadline, and not before the peer answers.
  console.log("1b. corpse affirmed early + live instance answering late: T is the LIVE answer, not the deadline");
  {
    const sub = respond(nc, [{ instanceId: A, delayMs: 700 }]);
    const { probe } = probeFrom({ [A]: "unknown", [B]: "gone" });
    const t0 = Date.now();
    const res = await epScatter(nc, SPACE, opFor(), {
      deadlineMs: 3000, expected: [slot(A), slot(B)], reconcileRegistration: okReconcile(A, B), probeLiveness: probe,
    });
    const elapsed = Date.now() - t0;
    await sub.drain();
    c("the live instance's late answer is counted", res.replies.get(A)?.reply.ok === true, { elapsed });
    c("the gather waited for it", elapsed >= 700, { elapsed });
    c("and ended THERE, not at the 3000ms deadline", elapsed < 1500, { elapsed });
    c("the corpse is still missing", res.missing.includes(B) && res.missing.length === 1, res.missing);
  }

  // ── 2. THE TRAP: every non-`gone` verdict must yield the RIGHT answer SLOWLY ───────────────────
  // A answers at 600ms of a 1200ms budget. If any of these verdicts shortened the gather, A's reply
  // would be lost and the scatter would report a fast, wrong "unreachable".
  console.log("2. THE TRAP CONTROL: live / unknown / throwing / garbled verdicts all keep the full deadline");
  for (const [label, verdict] of [
    ["live", "live"], ["unknown", "unknown"], ["a THROWING probe", "THROW"], ["a verdict outside the closed set", "GARBAGE"],
  ] as const) {
    const sub = respond(nc, [{ instanceId: A, delayMs: 600 }]);
    const { probe } = probeFrom({ [A]: verdict, [B]: "gone" });
    const t0 = Date.now();
    const res = await epScatter(nc, SPACE, opFor(), {
      deadlineMs: 1200, expected: [slot(A), slot(B)], reconcileRegistration: okReconcile(A, B), probeLiveness: probe,
    });
    const elapsed = Date.now() - t0;
    await sub.drain();
    c(`${label} for a slow-but-alive instance: its reply is COUNTED, arriving late rather than lost`,
      res.replies.get(A)?.reply.ok === true, { elapsed, missing: res.missing });
    c(`${label}: the gather waited for it (${elapsed}ms >= 600ms), never a fast wrong answer`, elapsed >= 600, { elapsed });
  }

  // ── 3. A verdict that is WRONG must not lose a reply ───────────────────────────────────────────
  console.log("3. a `gone` verdict for an instance that then answers: reported LATE, never silently dropped");
  {
    const sub = respond(nc, [{ instanceId: A, delayMs: 300 }]);
    const { probe } = probeFrom({ [A]: "gone", [B]: "gone" });
    const res = await epScatter(nc, SPACE, opFor(), {
      deadlineMs: 2000, lateDrainMs: 700, expected: [slot(A), slot(B)],
      reconcileRegistration: okReconcile(A, B), probeLiveness: probe,
    });
    await sub.drain();
    c("the wrongly-gone instance's reply is reported LATE (the post-T rail stayed open)",
      res.late.some((x) => x.instanceId === A), { late: res.late, missing: res.missing });
    c("it is also MISSING — a late reply does not retroactively satisfy its slot", res.missing.includes(A));
    c("not complete", res.complete === false);
  }

  // ── 4. the healthy path is untouched ───────────────────────────────────────────────────────────
  console.log("4. no regression when every instance answers");
  {
    const sub = respond(nc, [{ instanceId: A }, { instanceId: B }]);
    const { probe } = probeFrom({ [A]: "live", [B]: "live" });
    const t0 = Date.now();
    const res = await epScatter(nc, SPACE, opFor(), {
      deadlineMs: 2000, expected: [slot(A), slot(B)], reconcileRegistration: okReconcile(A, B), probeLiveness: probe,
    });
    const elapsed = Date.now() - t0;
    await sub.drain();
    c("early completion still fires when every slot answers", res.complete === true && elapsed < 500, { elapsed });
    c("both replies counted", res.replies.size === 2);
  }
  {
    // A `gone` verdict landing AFTER the slot answered must not un-count the reply in hand.
    // The delay is the point of the cell: without it the verdicts win the race and this grades the
    // NEXT cell's property instead — which is exactly what it did on the first run, silently.
    const sub = respond(nc, [{ instanceId: A }, { instanceId: B }]);
    const { probe } = probeFrom({ [A]: "gone", [B]: "gone" }, 200);
    const res = await epScatter(nc, SPACE, opFor(), {
      deadlineMs: 2000, expected: [slot(A), slot(B)], reconcileRegistration: okReconcile(A, B), probeLiveness: probe,
    });
    await sub.drain();
    c("a gone verdict arriving AFTER the reply never un-counts it", res.replies.size === 2 && res.complete === true && res.missing.length === 0, { missing: res.missing });
  }
  {
    // The failure direction of a LYING probe, stated rather than assumed. Both slots are affirmed gone
    // while both are in fact answering; the verdicts win the race and the gather ends before either
    // reply lands. The result is a false UNREACHABLE — never a false success — and §3 shows the reply
    // is still reported `late` whenever a late window is asked for.
    //
    // Production cannot reach this state: `serveEndpoint` subscribes the `one`, `all` and `inst` rails
    // in one loop per command, and §13.7 makes `describe` mandatory, so an instance that answers the
    // `all` rail necessarily holds the inst-rail interest the probe reads. Only this suite's
    // hand-rolled responder — which answers `all` and subscribes no inst rail — can produce it.
    const sub = respond(nc, [{ instanceId: A }, { instanceId: B }]);
    const { probe } = probeFrom({ [A]: "gone", [B]: "gone" });
    const res = await epScatter(nc, SPACE, opFor(), {
      deadlineMs: 2000, expected: [slot(A), slot(B)], reconcileRegistration: okReconcile(A, B), probeLiveness: probe,
    });
    await sub.drain();
    c("a lying `gone` fails toward UNREACHABLE, never toward a false success",
      res.complete === false && res.missing.length === 2 && res.replies.size === 0, { missing: res.missing, replies: res.replies.size });
  }

  // ── 5. the probe itself, against a real broker ─────────────────────────────────────────────────
  console.log("5. epProbeInstanceInterest reads INTEREST, and only a broker 503 says gone");
  {
    const t0 = Date.now();
    const v = await epProbeInstanceInterest(nc, SPACE, ENDPOINT, B, caller, { deadlineMs: 1500 });
    const elapsed = Date.now() - t0;
    c("an instance with NO subscription on its inst rail is affirmed GONE by the broker", v === "gone", { v, elapsed });
    c("and affirmed FAST — one broker round trip, not the probe budget", elapsed < 500, { elapsed });
  }
  {
    // Interest ONLY for A's instance rail (wildcard on the endpoint token, exact on the instance id).
    const held = nc.subscribe(`${spacePrefix(SPACE)}.ep.inst.*.${A}.>`, { callback: () => { /* never answers */ } });
    await wait(100);
    const t0 = Date.now();
    const v = await epProbeInstanceInterest(nc, SPACE, ENDPOINT, A, caller, { deadlineMs: 400 });
    const elapsed = Date.now() - t0;
    await held.drain();
    c("an instance that HOLDS a subscription but never answers is UNKNOWN, never gone", v === "unknown", { v });
    c("the probe gives up at its budget rather than waiting on an answer it does not read", elapsed >= 400 && elapsed < 1200, { elapsed });
  }
  {
    // The safety direction, stated as a cell: an instance that is present but silent must never be
    // readable as gone, because that is the exact conversion the P0 forbids.
    const held = nc.subscribe(`${spacePrefix(SPACE)}.ep.inst.*.${A}.>`, { callback: () => { /* never answers */ } });
    await wait(100);
    const v = await epProbeInstanceInterest(nc, SPACE, ENDPOINT, A, caller, { deadlineMs: 150 });
    await held.drain();
    c("even at a very short budget a present-but-silent instance is UNKNOWN — the failure direction is always 'keep waiting'", v === "unknown", { v });
  }
  {
    const v = await epProbeInstanceInterest(nc, SPACE, ENDPOINT, B, caller, { deadlineMs: 150 });
    c("and a genuinely absent instance is still GONE at the same short budget (the probe is not just timing out)", v === "gone", { v });
  }

  // ── 6. an in-flight probe is not a reason to still be running ──────────────────────────────────
  console.log("6. an in-flight probe holds nothing open");
  // MEASURED, not theorised. Against a LIVE instance the probe is never answered (a cast is never
  // replied to), so its deadline timer runs the FULL budget every time. Wired into `cotal ps` that
  // kept the command alive for 4.0 seconds after its last row was printed, on a healthy mesh with
  // no dead registration in it at all: 12.8s with the probe against 8.8s with it switched off, same
  // tree, same mesh, two runs each. The gather had already finished, and the only verdict that
  // changes anything is `gone`, which a caller that has already gathered can no longer use. So the
  // timer must not be what keeps the loop alive - and it must still settle for anyone waiting.
  {
    const held = nc.subscribe(`${spacePrefix(SPACE)}.ep.inst.*.${A}.>`, { callback: () => { /* never answers */ } });
    await wait(100);
    const timers = (): number => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const before = timers();
    const inFlight = epProbeInstanceInterest(nc, SPACE, ENDPOINT, A, caller, { deadlineMs: 2_000 });
    const during = timers();
    c("a probe with its whole budget still to run adds NOTHING to the resources keeping this process alive",
      during === before, { before, during });
    const t0 = Date.now();
    const v = await inFlight;
    const elapsed = Date.now() - t0;
    await held.drain();
    c("...and it still settles UNKNOWN at its budget: the timer stopped holding the loop, it did not stop running",
      v === "unknown" && elapsed >= 1_900, { v, elapsed });
  }

  await nc.drain();
} finally {
  try { broker.kill("SIGKILL"); } catch { /* best effort */ }
  try { rmSync(sd, { recursive: true, force: true }); } catch { /* best effort */ }
}

const complete = ok + fail === EXPECTED_CELLS;
if (!complete) console.log(`  ✗ INCOMPLETE: ${ok + fail} cells ran, ${EXPECTED_CELLS} expected — a suite that stopped early is not a pass`);
console.log(`\n${fail === 0 && complete ? "SCATTER LIVENESS SMOKE OK ✅" : "SCATTER LIVENESS SMOKE FAILED"}  (${ok} passed, ${fail} failed, ${EXPECTED_CELLS} expected)`);
process.exit(fail === 0 && complete ? 0 : 1);
