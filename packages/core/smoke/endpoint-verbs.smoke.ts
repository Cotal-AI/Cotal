/**
 * v0.4 caller-side VERBS smoke (SPEC §13.5 call/cast/watch/scatter, §13.3 envelope, §13.2 identity)
 * against a real broker. Covers the responder-identity/currency binding, epScatter's §13.5
 * classification with a MANDATORY bounded registration reconcile linearized at the deadline, the
 * (instanceId,epoch) seen-set for duplicate reporting, non-terminal invalid frames, and the
 * adversarial probes the review round required (wrong-endpoint/same-id scatter, invalid-then-valid,
 * invalid-last-pending, repeated churn/late => duplicate, stale-epoch / wrong-instance / no-responder
 * calls, all-rail cast deadline, timer-bound deadline).
 *
 * Responders read the caller triple + nonce off the request SUBJECT (never the body), like a real
 * serve responder, and reply via epReplySubject. One subscriber on the `all` rail emits the crafted
 * batch (one reply per simulated instance) so one scatter exercises every classification at once.
 *
 * Run: pnpm smoke:ep-verbs   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, headers } from "@nats-io/transport-node";
import type { NatsConnection, Subscription } from "@nats-io/transport-node";
import {
  isReachable, EpEnvelopeError,
  compileContract,
  parseEpSubject, epReplySubject, epeSubject, spacePrefix,
  epCall, epCast, epWatchEvents, epScatter,
  type EpCaller, type EpVerbOp, type ParsedEpRequest, type FrozenInstance, type EpAttributedEvent,
  type EpRegistrationState,
} from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const rejects = async (n: string, fn: () => Promise<unknown>, code?: string) => {
  try { await fn(); c(n, false, "no throw"); } catch (e) {
    c(n, code === undefined || (e instanceof EpEnvelopeError && e.code === code), `code ${(e as EpEnvelopeError).code ?? (e as Error).message}`);
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SPACE = "epverbs";
const ENDPOINT = "demo";
const caller: EpCaller = { owner: "u_abc", actor: "worker", uid: "c".repeat(26) };
const enc = new TextEncoder(); const dec = new TextDecoder();

const inContract = compileContract({ root: { type: "object", properties: { n: { type: "string" } }, required: ["n"], additionalProperties: false } });
const outContract = compileContract({ root: { type: "object", properties: { which: { type: "string" } }, required: ["which"], additionalProperties: false } });
const contract = { input: inContract, output: outContract };
const opFor = (over: Partial<EpVerbOp> = {}): EpVerbOp => ({ endpoint: ENDPOINT, command: "ping", contract, caller, args: { n: "x" }, ...over });
// `registered` at revision N (the common case); `dereg(id)` produces an EXPLICIT deregistration verdict.
const reg = (n: number): EpRegistrationState => ({ registered: true, registrationRevision: n });
const okReconcile = (m: Record<string, number>) => async () => new Map(Object.entries(m).map(([k, v]): [string, EpRegistrationState] => [k, reg(v)]));

// One crafted reply for a simulated instance. `endpoint` overrides the responder endpoint (the
// wrong-endpoint probe); `ok:false` sends a structured app error; malformed `data` fails the boundary;
// `status` forges a NATS status header (the 503-spoof probe) on the responder's OWN normal subject.
interface CraftedReply { instanceId: string; epoch: number; ok: boolean; data?: unknown; endpoint?: string; delayMs?: number; status?: number }
function publishReply(nc: NatsConnection, req: ParsedEpRequest, requestId: string, r: CraftedReply) {
  const subject = epReplySubject(SPACE, { endpoint: r.endpoint ?? req.endpoint, instanceId: r.instanceId, epoch: r.epoch, caller: req.caller, nonce: req.nonce });
  const env = r.ok ? { v: 1, id: requestId, ok: true, ...(r.data !== undefined ? { data: r.data } : {}) }
                   : { v: 1, id: requestId, ok: false, error: { code: "failed-precondition", message: "app said no" } };
  nc.publish(subject, enc.encode(JSON.stringify(env)), r.status !== undefined ? { headers: headers(r.status, "No Responders") } : undefined);
}
function respond(nc: NatsConnection, filter: string, batch: (req: ParsedEpRequest, requestId: string, replyExpected: boolean) => CraftedReply[]): Subscription {
  return nc.subscribe(filter, {
    callback: (err, msg) => {
      if (err) return;
      const p = parseEpSubject(msg.subject);
      if (!p || p.plane !== "request") return;
      const body = JSON.parse(dec.decode(msg.data)) as { id: string; replyExpected: boolean };
      for (const r of batch(p, body.id, body.replyExpected)) {
        if (r.delayMs) { const rr = r; setTimeout(() => publishReply(nc, p, body.id, rr), rr.delayMs); }
        else publishReply(nc, p, body.id, r);
      }
    },
  });
}

// ── live broker ──
const PORT = 20000 + Math.floor(Math.random() * 40000);
const sd = mkdtempSync(join(tmpdir(), "cotal-epverbs-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
  const allFilter = `${spacePrefix(SPACE)}.ep.all.>`;
  const instFilter = `${spacePrefix(SPACE)}.ep.inst.>`;

  // ---- epScatter: the full §13.5 classification in one gather -------------------------------------
  const EP = 5;
  const A = "a".repeat(26), B = "b".repeat(26), C = "cc".repeat(13), D = "d".repeat(26), E = "e".repeat(26), F = "f".repeat(26), Z = "z".repeat(26);
  const sixSlots: FrozenInstance[] = [A, B, C, D, E, F].map((instanceId) => ({ instanceId, registrationRevision: 1, epoch: EP }));
  {
    const sub = respond(nc, allFilter, () => [
      { instanceId: A, epoch: EP, ok: true, data: { which: A } },          // valid
      { instanceId: B, epoch: EP + 1, ok: true, data: { which: B } },      // churn (epoch)
      { instanceId: C, epoch: EP, ok: true, data: { which: C } },          // valid
      { instanceId: C, epoch: EP, ok: true, data: { which: C } },          // duplicate (first wins, reported)
      { instanceId: D, epoch: EP, ok: true, data: { which: 123 } },        // invalid (output-contract fail)
      { instanceId: F, epoch: EP, ok: true, data: { which: F } },          // valid, but reg-advanced -> churn(registration)
      { instanceId: Z, epoch: EP, ok: true, data: { which: Z } },          // unexpected (not in frozen set)
      { instanceId: A, epoch: EP, ok: true, data: { which: A }, endpoint: "other" }, // wrong-endpoint, colliding (A, EP)
      // E: no reply -> missing
    ]);
    const res = await epScatter(nc, SPACE, opFor(), {
      deadlineMs: 600, expected: sixSlots,
      reconcileRegistration: okReconcile({ [A]: 1, [B]: 1, [C]: 1, [D]: 1, [E]: 1, [F]: 2 }), // F advanced
    });
    await sub.drain();
    c("scatter counts the valid frozen-epoch reply from A", res.replies.get(A)?.reply.ok === true);
    c("scatter counts C (first of two)", res.replies.has(C));
    c("reg-churn removed F from the counted replies", !res.replies.has(F));
    c("replies map holds exactly the two counted valid slots (A, C)", res.replies.size === 2);
    c("E reported MISSING (never answered)", res.missing.length === 1 && res.missing[0] === E);
    c("B reported churn(epoch), not missing", res.churn.some((x) => x.instanceId === B && x.reason === "epoch") && !res.missing.includes(B));
    c("F reported churn(registration) via the mandatory reconcile", res.churn.some((x) => x.instanceId === F && x.reason === "registration"));
    c("no churned slot is also missing (B, F)", !res.missing.includes(B) && !res.missing.includes(F));
    c("second C reply reported DUPLICATE, never dropped", res.duplicate.some((x) => x.instanceId === C));
    c("Z reported UNEXPECTED (outside the frozen set)", res.unexpected.some((x) => x.instanceId === Z));
    c("wrong-ENDPOINT reply with a colliding (A, EP) is UNEXPECTED, never counted as slot A (§13.2 endpoint bind)",
      res.unexpected.some((x) => x.instanceId === A) && res.replies.get(A)?.responder.endpoint === ENDPOINT);
    c("D reported INVALID (output-contract fail at the consuming boundary)", res.invalid.some((x) => x.instanceId === D));
    c("nothing folded into success: complete is FALSE", res.complete === false);
    c("late bucket empty (no lateDrainMs)", res.late.length === 0);
    c("responder attribution comes from the reply SUBJECT (A at frozen epoch)", res.replies.get(A)?.responder.instanceId === A && res.replies.get(A)?.responder.epoch === EP);
  }

  // complete: TRUE only when every frozen slot produced one counted valid reply (early completion),
  // verified by the reconcile showing no advance.
  {
    const sub = respond(nc, allFilter, () => [{ instanceId: A, epoch: EP, ok: true, data: { which: A } }]);
    const res = await epScatter(nc, SPACE, opFor(), { deadlineMs: 800, expected: [{ instanceId: A, registrationRevision: 1, epoch: EP }], reconcileRegistration: okReconcile({ [A]: 1 }) });
    await sub.drain();
    c("a fully-answered, reconciled scatter completes with complete=TRUE", res.complete === true && res.missing.length === 0 && res.replies.size === 1);
  }

  // duplicate generalizes: repeated CHURN(epoch) and repeated LATE both dedupe to `duplicate`.
  {
    const sub = respond(nc, allFilter, () => [
      { instanceId: B, epoch: EP + 1, ok: true, data: { which: B } },   // churn(epoch)
      { instanceId: B, epoch: EP + 1, ok: true, data: { which: B } },   // repeat same (B, EP+1) -> duplicate
    ]);
    const res = await epScatter(nc, SPACE, opFor(), { deadlineMs: 400, expected: [{ instanceId: B, registrationRevision: 1, epoch: EP }], reconcileRegistration: okReconcile({ [B]: 1 }) });
    await sub.drain();
    c("a repeated wrong-epoch reply is one churn + one duplicate (seen-set dedupe, §13.5)",
      res.churn.filter((x) => x.instanceId === B).length === 1 && res.duplicate.some((x) => x.instanceId === B));
  }

  // late: a valid post-deadline reply within lateDrainMs is `late`; a repeat is `duplicate`. The slot
  // is BOTH missing (no on-time reply) and late (observational) — classification linearized at deadline.
  {
    const sub = respond(nc, allFilter, () => [
      { instanceId: A, epoch: EP, ok: true, data: { which: A }, delayMs: 250 },
      { instanceId: A, epoch: EP, ok: true, data: { which: A }, delayMs: 320 }, // repeat late -> duplicate
    ]);
    const res = await epScatter(nc, SPACE, opFor(), { deadlineMs: 150, lateDrainMs: 400, expected: [{ instanceId: A, registrationRevision: 1, epoch: EP }], reconcileRegistration: okReconcile({ [A]: 1 }) });
    await sub.drain();
    c("a post-deadline reply within lateDrainMs is LATE, not counted", res.late.some((x) => x.instanceId === A) && res.replies.size === 0 && res.complete === false);
    c("a repeated late reply is DUPLICATE", res.duplicate.some((x) => x.instanceId === A));
    c("the late slot is MISSING (no on-time reply) — classification linearized at the deadline", res.missing.includes(A));
  }

  // invalid is NON-TERMINAL: an invalid-first frame does not consume the slot; a later valid reply
  // COUNTS (not mislabeled duplicate), and an invalid from the last-pending slot never early-completes.
  {
    const sub = respond(nc, allFilter, () => [
      { instanceId: A, epoch: EP, ok: true, data: { which: 999 } },              // invalid first (bad type)
      { instanceId: A, epoch: EP, ok: true, data: { which: A }, delayMs: 120 },  // valid later
    ]);
    const res = await epScatter(nc, SPACE, opFor(), { deadlineMs: 600, expected: [{ instanceId: A, registrationRevision: 1, epoch: EP }], reconcileRegistration: okReconcile({ [A]: 1 }) });
    await sub.drain();
    c("invalid-first: the later valid reply COUNTS, not duplicate (invalid is non-terminal)", res.replies.has(A));
    c("invalid-first: the invalid frame is still reported", res.invalid.some((x) => x.instanceId === A));
    c("invalid-last-pending did NOT early-complete before the valid reply arrived", res.replies.has(A) && res.missing.length === 0);
    c("an observed invalid keeps complete=FALSE even after a valid recovery (§13.3 fail-loud)", res.complete === false);
  }

  // empty / duplicate-in-freeze / unbounded / unreadable reconcile refusals (§13.5).
  await rejects("scatter refuses an EMPTY frozen expected set (never an empty success)",
    () => epScatter(nc, SPACE, opFor(), { deadlineMs: 100, expected: [], reconcileRegistration: okReconcile({}) }), "failed-precondition");
  await rejects("scatter refuses a frozen set naming one instance twice",
    () => epScatter(nc, SPACE, opFor(), { deadlineMs: 100, expected: [{ instanceId: A, registrationRevision: 1, epoch: EP }, { instanceId: A, registrationRevision: 2, epoch: EP }], reconcileRegistration: okReconcile({ [A]: 1 }) }), "failed-precondition");
  await rejects("scatter surfaces an unreadable reconcile as failed-precondition",
    () => epScatter(nc, SPACE, opFor(), { deadlineMs: 120, expected: [{ instanceId: A, registrationRevision: 1, epoch: EP }], reconcileRegistration: async () => { throw new Error("kv down"); } }), "failed-precondition");
  await rejects("scatter BOUNDS a never-settling reconcile as unavailable (deadline mandatory, no hung scatter)",
    () => epScatter(nc, SPACE, opFor(), { deadlineMs: 150, expected: [{ instanceId: A, registrationRevision: 1, epoch: EP }], reconcileRegistration: () => new Promise<Map<string, EpRegistrationState>>(() => { /* never settles */ }) }), "unavailable");
  await rejects("scatter FAILS LOUD when the reconcile omits a frozen slot (incomplete read can't authorize completion)",
    () => epScatter(nc, SPACE, opFor(), { deadlineMs: 120, expected: [{ instanceId: A, registrationRevision: 1, epoch: EP }, { instanceId: B, registrationRevision: 1, epoch: EP }], reconcileRegistration: okReconcile({ [A]: 1 }) }), "failed-precondition");
  await rejects("scatter FAILS LOUD when the reconcile reports a below-frozen revision (non-monotonic/buggy read)",
    () => epScatter(nc, SPACE, opFor(), { deadlineMs: 120, expected: [{ instanceId: A, registrationRevision: 5, epoch: EP }], reconcileRegistration: okReconcile({ [A]: 3 }) }), "failed-precondition");
  await rejects("scatter FAILS LOUD when the reconcile reports a NaN/garbled revision (a NaN must not slip past the monotonicity fence)",
    () => epScatter(nc, SPACE, opFor(), { deadlineMs: 120, expected: [{ instanceId: A, registrationRevision: 1, epoch: EP }], reconcileRegistration: async () => new Map<string, EpRegistrationState>([[A, { registered: true, registrationRevision: NaN }]]) }), "failed-precondition");
  // Frozen-coordinate ingress fence: an untyped adapter cannot hand in a NaN/negative that would disable
  // the currency/monotonicity checks downstream.
  await rejects("scatter refuses a frozen slot with a NaN registrationRevision (bad-request at ingress)",
    () => epScatter(nc, SPACE, opFor(), { deadlineMs: 100, expected: [{ instanceId: A, registrationRevision: NaN, epoch: EP }], reconcileRegistration: okReconcile({ [A]: 1 }) }), "bad-request");
  await rejects("scatter refuses a frozen slot with a negative epoch (bad-request at ingress)",
    () => epScatter(nc, SPACE, opFor(), { deadlineMs: 100, expected: [{ instanceId: A, registrationRevision: 1, epoch: -1 }], reconcileRegistration: okReconcile({ [A]: 1 }) }), "bad-request");

  // EXPLICIT mid-scatter deregistration is NOT registration-churn (SPEC §13.5 recorded intent): a valid
  // reply the instance already gave still counts, distinct from an ABSENT Map entry (an incomplete read,
  // which stays fail-loud above).
  {
    const sub = respond(nc, allFilter, () => [{ instanceId: A, epoch: EP, ok: true, data: { which: A } }]);
    const res = await epScatter(nc, SPACE, opFor(), {
      deadlineMs: 300,
      expected: [{ instanceId: A, registrationRevision: 1, epoch: EP }],
      reconcileRegistration: async () => new Map<string, EpRegistrationState>([[A, { registered: false }]]),
    });
    await sub.drain();
    c("explicit deregistration of a slot that already replied: reply still counts, complete stays true, no churn",
      res.complete === true && res.replies.has(A) && res.churn.length === 0);
  }
  {
    // deregistered WITHOUT a prior reply -> `missing` (honest: expected, no counted reply), never a throw.
    const res = await epScatter(nc, SPACE, opFor(), {
      deadlineMs: 150,
      expected: [{ instanceId: A, registrationRevision: 1, epoch: EP }],
      reconcileRegistration: async () => new Map<string, EpRegistrationState>([[A, { registered: false }]]),
    });
    c("explicit deregistration of a slot that never replied is `missing`, not thrown, complete false",
      res.missing.includes(A) && res.complete === false);
  }
  // The registration-state discriminant is RUNTIME-validated: an untyped/legacy hook cannot fail OPEN as
  // deregistration and bypass the completeness fence. A bare number, even WITH a valid reply, must throw
  // (never authorize complete=true); a non-boolean `.registered` must throw too.
  {
    const sub = respond(nc, allFilter, () => [{ instanceId: A, epoch: EP, ok: true, data: { which: A } }]);
    await rejects("a legacy bare-number reconcile verdict cannot masquerade as deregistration even WITH a valid reply (no false complete)",
      () => epScatter(nc, SPACE, opFor(), { deadlineMs: 300, expected: [{ instanceId: A, registrationRevision: 1, epoch: EP }], reconcileRegistration: async () => new Map([[A, 1]]) as unknown as Map<string, EpRegistrationState> }), "failed-precondition");
    await sub.drain();
  }
  await rejects("a malformed reconcile verdict ({ registered: 0 }, non-boolean discriminant) fails loud, not open",
    () => epScatter(nc, SPACE, opFor(), { deadlineMs: 120, expected: [{ instanceId: A, registrationRevision: 1, epoch: EP }], reconcileRegistration: async () => new Map([[A, { registered: 0 }]]) as unknown as Map<string, EpRegistrationState> }), "failed-precondition");
  await rejects("an empty-object reconcile verdict ({}) fails loud (no `.registered`), not open",
    () => epScatter(nc, SPACE, opFor(), { deadlineMs: 120, expected: [{ instanceId: A, registrationRevision: 1, epoch: EP }], reconcileRegistration: async () => new Map([[A, {}]]) as unknown as Map<string, EpRegistrationState> }), "failed-precondition");
  await rejects("a null reconcile verdict fails loud as failed-precondition, never a raw TypeError",
    () => epScatter(nc, SPACE, opFor(), { deadlineMs: 120, expected: [{ instanceId: A, registrationRevision: 1, epoch: EP }], reconcileRegistration: async () => new Map([[A, null]]) as unknown as Map<string, EpRegistrationState> }), "failed-precondition");
  {
    // A garbled discriminant on a slot that actually re-registered must not mask the churn: with a valid
    // reply present, `{ registered: undefined }` must FAIL LOUD, never silently count as deregistration.
    const sub = respond(nc, allFilter, () => [{ instanceId: A, epoch: EP, ok: true, data: { which: A } }]);
    await rejects("a garbled discriminant ({ registered: undefined }) on a replied slot fails loud, never silently counts (no masked churn)",
      () => epScatter(nc, SPACE, opFor(), { deadlineMs: 300, expected: [{ instanceId: A, registrationRevision: 1, epoch: EP }], reconcileRegistration: async () => new Map([[A, { registered: undefined }]]) as unknown as Map<string, EpRegistrationState> }), "failed-precondition");
    await sub.drain();
  }

  // late does NOT leak past its horizon: with no lateDrainMs, a reply arriving after the deadline but
  // DURING a slow reconcile is not classified `late` (the rail is closed at T, absolute).
  {
    const sub = respond(nc, allFilter, () => [{ instanceId: A, epoch: EP, ok: true, data: { which: A }, delayMs: 180 }]); // after the 100ms deadline
    const res = await epScatter(nc, SPACE, opFor(), {
      deadlineMs: 100, reconcileDeadlineMs: 600,
      expected: [{ instanceId: A, registrationRevision: 1, epoch: EP }],
      reconcileRegistration: async () => { await wait(250); return new Map([[A, reg(1)]]); }, // slow reconcile still running at 180ms
    });
    await sub.drain();
    c("no lateDrainMs: a reply during a slow reconcile is NOT classified late (rail closed at T)", res.late.length === 0 && res.missing.includes(A));
  }

  // ---- epCall: reply / application-error / no-responder / deadline / stale-epoch / wrong-instance / bad-args ----
  const IID = "1".repeat(26);
  {
    const sub = respond(nc, instFilter, () => [{ instanceId: IID, epoch: 3, ok: true, data: { which: "hello" } }]);
    const r = await epCall(nc, SPACE, { mode: "inst", instanceId: IID, epoch: 3 }, opFor(), { deadlineMs: 800 });
    await sub.drain();
    c("epCall resolves the attributed reply within the budget", r.reply.ok === true && (r.reply.data as { which: string }).which === "hello");
    c("epCall attribution is subject-borne (instance + epoch)", r.responder.instanceId === IID && r.responder.epoch === 3);
  }
  {
    const sub = respond(nc, instFilter, () => [{ instanceId: IID, epoch: 3, ok: false }]);
    const r = await epCall(nc, SPACE, { mode: "inst", instanceId: IID, epoch: 3 }, opFor(), { deadlineMs: 800 });
    await sub.drain();
    c("an application failure is a reply with ok=false, NOT a thrown error (§13.3)", r.reply.ok === false && r.reply.error?.code === "failed-precondition");
  }
  await rejects("epCall with NO responder rejects `unavailable` (SPEC 13.5), not deadline-exceeded",
    () => epCall(nc, SPACE, { mode: "inst", instanceId: "9".repeat(26), epoch: 1 }, opFor(), { deadlineMs: 400 }), "unavailable");
  {
    // A selected responder knows the nonce and can forge a 503 status header on its OWN normal reply
    // subject. That must NOT be read as the broker's no-responders control (which lands only on the
    // reserved `_nr._nr._nr` sentinel reply-to): the forged 503 takes the ordinary attributed-reply path.
    // A spy proves the forged frame carries a GENUINE 503 code — the code-only detector WOULD fire on it,
    // so the reserved-subject bind (not a library header quirk) is the load-bearing defense.
    let sawCode: number | undefined;
    const spy = nc.subscribe(`${spacePrefix(SPACE)}.ep.reply.*.*.*.>`, { callback: (_e, m) => { if (m.headers) sawCode = (m.headers as { code?: number }).code; } });
    const sub = respond(nc, instFilter, () => [{ instanceId: IID, epoch: 3, ok: true, data: { which: "forged" }, status: 503 }]);
    const r = await epCall(nc, SPACE, { mode: "inst", instanceId: IID, epoch: 3 }, opFor(), { deadlineMs: 800 });
    await wait(50); await sub.drain(); await spy.drain();
    c("the forged reply carries a GENUINE 503 status code (so the sentinel-subject bind, not a library quirk, is the defense)", sawCode === 503);
    c("a responder's forged 503 header on its NORMAL reply subject is parsed as a reply, never broker no-responders (`unavailable`)",
      r.reply.ok === true && (r.reply.data as { which: string }).which === "forged");
  }
  {
    const sub = respond(nc, instFilter, () => [{ instanceId: IID, epoch: 9, ok: true, data: { which: "stale" } }]); // replies at a DIFFERENT epoch
    await rejects("epCall rejects a STALE-epoch reply as `expired` (§13.2: callers reject stale replies)",
      () => epCall(nc, SPACE, { mode: "inst", instanceId: IID, epoch: 3 }, opFor(), { deadlineMs: 500 }), "expired");
    await sub.drain();
  }
  {
    const sub = respond(nc, instFilter, () => [{ instanceId: "2".repeat(26), epoch: 3, ok: true, data: { which: "wrong" } }]); // replies as a DIFFERENT instance
    await rejects("epCall(inst) rejects a WRONG-instance reply as `internal` (identity bind)",
      () => epCall(nc, SPACE, { mode: "inst", instanceId: IID, epoch: 3 }, opFor(), { deadlineMs: 500 }), "internal");
    await sub.drain();
  }
  {
    const sub = respond(nc, instFilter, () => []); // subscriber exists but never replies -> slow, not absent
    await rejects("epCall with a live-but-silent responder rejects deadline-exceeded (distinct from unavailable)",
      () => epCall(nc, SPACE, { mode: "inst", instanceId: IID, epoch: 3 }, opFor(), { deadlineMs: 250 }), "deadline-exceeded");
    await sub.drain();
  }
  await rejects("epCall whose args fail its own input contract refuses bad-request BEFORE publish",
    () => epCall(nc, SPACE, { mode: "inst", instanceId: IID, epoch: 3 }, opFor({ args: { n: 123 } as unknown as Record<string, unknown> }), { deadlineMs: 200 }), "bad-request");
  await rejects("epCall refuses a deadline beyond the setTimeout timer bound (2^31-1)",
    () => epCall(nc, SPACE, { mode: "inst", instanceId: IID, epoch: 3 }, opFor(), { deadlineMs: 2_147_483_648 }), "bad-request");
  {
    // A correctly ATTRIBUTED reply whose BODY is not JSON: the documented catalog holds — the caller
    // boundary refuses structured `internal`; a raw SyntaxError never escapes the verb (§13.3).
    const sub = nc.subscribe(instFilter, {
      callback: (err, msg) => {
        if (err) return;
        const p = parseEpSubject(msg.subject);
        if (!p || p.plane !== "request") return;
        nc.publish(epReplySubject(SPACE, { endpoint: p.endpoint, instanceId: IID, epoch: 3, caller: p.caller, nonce: p.nonce }), enc.encode("{"));
      },
    });
    await rejects("epCall surfaces an UNPARSEABLE reply body as structured `internal`, never a raw SyntaxError",
      () => epCall(nc, SPACE, { mode: "inst", instanceId: IID, epoch: 3 }, opFor(), { deadlineMs: 500 }), "internal");
    await sub.drain();
  }

  // epCall `one` (queue anycast): the caller cannot pin an instance up front, so it MUST supply a
  // currentEpoch hook; the queue winner's currency is CHECKED, not assumed (§13.2:1187-1189).
  const oneFilter = `${spacePrefix(SPACE)}.ep.one.>`;
  const OID = "7".repeat(26);
  {
    const sub = respond(nc, oneFilter, () => [{ instanceId: OID, epoch: 4, ok: true, data: { which: "one" } }]);
    const r = await epCall(nc, SPACE, { mode: "one" }, opFor(), { deadlineMs: 800, currentEpoch: () => 4 });
    await sub.drain();
    c("epCall `one` accepts a reply whose responder epoch matches currentEpoch", r.reply.ok === true && r.responder.epoch === 4);
  }
  {
    const sub = respond(nc, oneFilter, () => [{ instanceId: OID, epoch: 4, ok: true, data: { which: "stale" } }]); // answers at epoch 4
    await rejects("epCall `one` rejects a superseded-incarnation reply as `expired` (currentEpoch=5 > answered 4, §13.2:1187-1189)",
      () => epCall(nc, SPACE, { mode: "one" }, opFor(), { deadlineMs: 500, currentEpoch: () => 5 }), "expired");
    await sub.drain();
  }
  await rejects("epCall on the `one` rail WITHOUT currentEpoch refuses bad-request (queue winner is not implicitly current)",
    () => epCall(nc, SPACE, { mode: "one" }, opFor(), { deadlineMs: 200, currentEpoch: undefined as unknown as () => number }), "bad-request");
  {
    // The hook is an untrusted caller-supplied boundary (same class as scatter's reconcile): its own
    // throw normalizes into the catalog, and a garbled VALUE fails as the read's own failure — a NaN
    // compares unequal to any real epoch and would otherwise mislabel a valid reply `expired`.
    const sub = respond(nc, oneFilter, () => [{ instanceId: OID, epoch: 4, ok: true, data: { which: "one" } }]);
    await rejects("epCall `one` normalizes a THROWING currentEpoch hook into structured `internal` (the catalog holds)",
      () => epCall(nc, SPACE, { mode: "one" }, opFor(), { deadlineMs: 800, currentEpoch: () => { throw new TypeError("registry exploded"); } }), "internal");
    await rejects("epCall `one` refuses a NaN currentEpoch value as failed-precondition, never mislabeled `expired` staleness",
      () => epCall(nc, SPACE, { mode: "one" }, opFor(), { deadlineMs: 800, currentEpoch: () => Number.NaN }), "failed-precondition");
    await sub.drain();
  }

  // ---- epCast: fire-and-forget; honors replyExpected=false; all-rail needs a deadline ------------
  {
    let replied = 0;
    const sub = respond(nc, instFilter, (_req, _id, replyExpected) => { if (replyExpected) { replied++; return [{ instanceId: IID, epoch: 3, ok: true, data: { which: "x" } }]; } return []; });
    await epCast(nc, SPACE, { mode: "inst", instanceId: IID }, opFor());
    await wait(150);
    await sub.drain();
    c("epCast resolves after flush and the responder saw replyExpected=false (no reply)", replied === 0);
  }
  await rejects("epCast to the ALL rail without deadlineMs refuses bad-request (would be silently dropped)",
    () => epCast(nc, SPACE, { mode: "all" }, opFor()), "bad-request");

  // ---- epWatchEvents: live event read on a granted epe subtree ------------------------------------
  {
    const events: EpAttributedEvent[] = []; const errors: EpEnvelopeError[] = [];
    const watch = epWatchEvents(nc, SPACE, `${spacePrefix(SPACE)}.epe.>`, { onEvent: (e) => events.push(e), onError: (e) => errors.push(e) });
    await wait(50);
    const evSubject = epeSubject(SPACE, ENDPOINT, IID, 3, ["progress"]);
    nc.publish(evSubject, enc.encode(JSON.stringify({ v: 1, topic: "progress", ts: 42, data: { pct: 50 } })));
    nc.publish(evSubject, enc.encode("{ not json"));                       // unparseable body -> onError
    await wait(150);
    await watch.stop();
    c("epWatchEvents delivers a valid event with subject-borne instance + epoch", events.some((e) => e.instanceId === IID && e.epoch === 3 && (e.event.data as { pct: number }).pct === 50));
    c("epWatchEvents reports an unparseable event body through onError, never onEvent (§13.3)", errors.length >= 1 && events.length === 1);
  }
  await new Promise<void>((res) => { try { epWatchEvents(nc, SPACE, "not.an.epe.subtree", { onEvent: () => {}, onError: () => {} }); c("epWatchEvents refuses a non-epe filter", false, "no throw"); } catch { c("epWatchEvents refuses a filter that is not an epe subtree of the space", true); } res(); });

  await nc.drain();
  console.log(`\nENDPOINT VERBS SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed)`);
} finally {
  broker.kill("SIGKILL");
  rmSync(sd, { recursive: true, force: true });
}
if (fail > 0) process.exit(1);
