/**
 * v0.4 caller-side VERBS smoke (SPEC §13.5 call/cast/watch/scatter, §13.3 envelope) against a real
 * broker. The meat is epScatter's §13.5 classification against a FROZEN expected set: valid gather,
 * missing, churn (epoch AND registration-advance), duplicate (first-wins, REPORTED), unexpected,
 * invalid (§13.3 fail-loud), late (bounded post-deadline drain), and complete only when every frozen
 * slot produced exactly one counted valid reply. Plus epCall (reply / application-error / deadline /
 * bad-args), epCast (silent, honors replyExpected), and epWatch (valid event / fail-loud onError).
 *
 * The responders read the caller triple + nonce off the request SUBJECT (never the body), exactly
 * like a real serve responder, and reply via deriveReplySubject. A single subscriber on the `all`
 * rail emits the crafted batch of replies (one per simulated instance) so one scatter exercises every
 * classification at once.
 *
 * Run: pnpm smoke:ep-verbs   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import type { NatsConnection, Subscription } from "@nats-io/transport-node";
import {
  isReachable, EpEnvelopeError,
  compileContract,
  parseEpSubject, deriveReplySubject, epeSubject, spacePrefix,
  epCall, epCast, epWatch, epScatter,
  type EpCaller, type EpVerbOp, type ParsedEpRequest, type FrozenInstance, type EpAttributedEvent,
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

// One crafted reply for a simulated instance.
interface CraftedReply { instanceId: string; epoch: number; ok: boolean; data?: unknown; delayMs?: number }
function publishReply(nc: NatsConnection, req: ParsedEpRequest, requestId: string, r: CraftedReply) {
  const subject = deriveReplySubject(SPACE, req, { instanceId: r.instanceId, epoch: r.epoch });
  const env = r.ok ? { v: 1, id: requestId, ok: true, ...(r.data !== undefined ? { data: r.data } : {}) }
                   : { v: 1, id: requestId, ok: false, error: { code: "failed-precondition", message: "app said no" } };
  nc.publish(subject, enc.encode(JSON.stringify(env)));
}
// Subscribe a request filter; for each request, emit the batch the caller supplies for THIS test.
function respond(nc: NatsConnection, filter: string, batch: (req: ParsedEpRequest, requestId: string, replyExpected: boolean) => CraftedReply[]): Subscription {
  const sub = nc.subscribe(filter, {
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
  return sub;
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
  const expected: FrozenInstance[] = [A, B, C, D, E, F].map((instanceId) => ({ instanceId, registrationRevision: 1, epoch: EP }));
  {
    const sub = respond(nc, allFilter, (_req, _id) => [
      { instanceId: A, epoch: EP, ok: true, data: { which: A } },        // valid
      { instanceId: B, epoch: EP + 1, ok: true, data: { which: B } },    // churn (epoch)
      { instanceId: C, epoch: EP, ok: true, data: { which: C } },        // valid
      { instanceId: C, epoch: EP, ok: true, data: { which: C } },        // duplicate (first wins, reported)
      { instanceId: D, epoch: EP, ok: true, data: { which: 123 } },      // invalid (output-contract fail)
      { instanceId: F, epoch: EP, ok: true, data: { which: F } },        // valid, but reg-advanced -> churn(registration)
      { instanceId: Z, epoch: EP, ok: true, data: { which: Z } },        // unexpected (not in frozen set)
      // E: no reply -> missing
    ]);
    // reconcileRegistration reports F advanced past its frozen registrationRevision (a re-registration
    // that the reply rail cannot see); everyone else unchanged.
    const res = await epScatter(nc, SPACE, opFor(), {
      deadlineMs: 600, expected,
      reconcileRegistration: async () => new Map([[A, 1], [B, 1], [C, 1], [D, 1], [E, 1], [F, 2]]),
    });
    await sub.drain();
    c("scatter counts the valid frozen-epoch reply from A", res.replies.get(A)?.reply.ok === true && res.replies.has(A));
    c("scatter counts the valid frozen-epoch reply from C (first of two)", res.replies.has(C));
    c("scatter reg-churn removed F from the counted replies", !res.replies.has(F));
    c("scatter replies map holds exactly the two counted valid slots (A, C)", res.replies.size === 2);
    c("scatter reports E as MISSING (never answered)", res.missing.length === 1 && res.missing[0] === E);
    c("scatter reports B as churn(epoch), not missing", res.churn.some((x) => x.instanceId === B && x.reason === "epoch") && !res.missing.includes(B));
    c("scatter reports F as churn(registration) via reconcile", res.churn.some((x) => x.instanceId === F && x.reason === "registration"));
    c("a churned slot is never also missing (B, F)", !res.missing.includes(B) && !res.missing.includes(F));
    c("scatter reports the second C reply as DUPLICATE, never dropped", res.duplicate.some((x) => x.instanceId === C));
    c("scatter reports Z as UNEXPECTED (outside the frozen set)", res.unexpected.some((x) => x.instanceId === Z));
    c("scatter reports D as INVALID (output-contract fail at the consuming boundary)", res.invalid.some((x) => x.instanceId === D));
    c("scatter did not fold any classification into success: complete is FALSE", res.complete === false);
    c("scatter late bucket is empty (no lateDrainMs)", res.late.length === 0);
    c("responder attribution comes from the reply SUBJECT (A at frozen epoch)", res.replies.get(A)?.responder.instanceId === A && res.replies.get(A)?.responder.epoch === EP);
  }

  // complete: TRUE only when every frozen slot produced one counted valid reply (early completion).
  {
    const sub = respond(nc, allFilter, () => [{ instanceId: A, epoch: EP, ok: true, data: { which: A } }]);
    const res = await epScatter(nc, SPACE, opFor(), { deadlineMs: 800, expected: [{ instanceId: A, registrationRevision: 1, epoch: EP }] });
    await sub.drain();
    c("a fully-answered scatter completes early with complete=TRUE", res.complete === true && res.missing.length === 0 && res.replies.size === 1);
  }

  // late: a valid frozen-slot reply AFTER the deadline, within the drain window, is `late` not counted.
  {
    const sub = respond(nc, allFilter, () => [{ instanceId: A, epoch: EP, ok: true, data: { which: A }, delayMs: 250 }]);
    const res = await epScatter(nc, SPACE, opFor(), { deadlineMs: 150, lateDrainMs: 400, expected: [{ instanceId: A, registrationRevision: 1, epoch: EP }] });
    await sub.drain();
    c("a post-deadline reply within lateDrainMs is classified LATE", res.late.some((x) => x.instanceId === A));
    c("a late reply does NOT count toward completion", res.complete === false && res.replies.size === 0);
    c("a late responder is not reported MISSING (it did answer)", res.missing.length === 0);
  }

  // empty / duplicate-in-freeze refusals (§13.5): never an empty success, never a torn freeze.
  await rejects("scatter refuses an EMPTY frozen expected set (never an empty success)",
    () => epScatter(nc, SPACE, opFor(), { deadlineMs: 100, expected: [] }), "failed-precondition");
  await rejects("scatter refuses a frozen set naming one instance twice",
    () => epScatter(nc, SPACE, opFor(), { deadlineMs: 100, expected: [{ instanceId: A, registrationRevision: 1, epoch: EP }, { instanceId: A, registrationRevision: 2, epoch: EP }] }), "failed-precondition");
  await rejects("scatter surfaces an unreadable registration reconcile as failed-precondition",
    () => epScatter(nc, SPACE, opFor(), { deadlineMs: 120, expected: [{ instanceId: A, registrationRevision: 1, epoch: EP }], reconcileRegistration: async () => { throw new Error("kv down"); } }), "failed-precondition");

  // ---- epCall: reply / application-error / deadline / bad-args ------------------------------------
  const IID = "1".repeat(26);
  {
    const sub = respond(nc, instFilter, (_req, _id) => [{ instanceId: IID, epoch: 3, ok: true, data: { which: "hello" } }]);
    const r = await epCall(nc, SPACE, { mode: "inst", instanceId: IID }, opFor(), { deadlineMs: 800 });
    await sub.drain();
    c("epCall resolves the attributed reply within the budget", r.reply.ok === true && (r.reply.data as { which: string }).which === "hello");
    c("epCall attribution is subject-borne (instance + epoch)", r.responder.instanceId === IID && r.responder.epoch === 3);
  }
  {
    const sub = respond(nc, instFilter, () => [{ instanceId: IID, epoch: 3, ok: false }]);
    const r = await epCall(nc, SPACE, { mode: "inst", instanceId: IID }, opFor(), { deadlineMs: 800 });
    await sub.drain();
    c("an application failure is a reply with ok=false, NOT a thrown error (§13.3)", r.reply.ok === false && r.reply.error?.code === "failed-precondition");
  }
  await rejects("epCall with no responder rejects deadline-exceeded",
    () => epCall(nc, SPACE, { mode: "inst", instanceId: "9".repeat(26) }, opFor(), { deadlineMs: 200 }), "deadline-exceeded");
  await rejects("epCall whose args fail its own input contract refuses bad-request BEFORE publish",
    () => epCall(nc, SPACE, { mode: "inst", instanceId: IID }, opFor({ args: { n: 123 } as unknown as Record<string, unknown> }), { deadlineMs: 200 }), "bad-request");

  // ---- epCast: fire-and-forget, honors replyExpected=false ----------------------------------------
  {
    let replied = 0;
    const sub = respond(nc, instFilter, (_req, _id, replyExpected) => { if (replyExpected) { replied++; return [{ instanceId: IID, epoch: 3, ok: true, data: { which: "x" } }]; } return []; });
    await epCast(nc, SPACE, { mode: "inst", instanceId: IID }, opFor());
    await wait(150);
    await sub.drain();
    c("epCast resolves after flush and the responder saw replyExpected=false (no reply)", replied === 0);
  }

  // ---- epWatch: live event read on a granted epe subtree ------------------------------------------
  {
    const events: EpAttributedEvent[] = []; const errors: EpEnvelopeError[] = [];
    const watch = epWatch(nc, SPACE, `${spacePrefix(SPACE)}.epe.>`, { onEvent: (e) => events.push(e), onError: (e) => errors.push(e) });
    await wait(50);
    const evSubject = epeSubject(SPACE, ENDPOINT, IID, 3, ["progress"]);
    nc.publish(evSubject, enc.encode(JSON.stringify({ v: 1, topic: "progress", ts: 42, data: { pct: 50 } })));
    nc.publish(evSubject, enc.encode("{ not json"));                       // unparseable body -> onError
    await wait(150);
    await watch.stop();
    c("epWatch delivers a valid event with subject-borne instance + epoch attribution", events.some((e) => e.instanceId === IID && e.epoch === 3 && (e.event.data as { pct: number }).pct === 50));
    c("epWatch reports an unparseable event body through onError, never onEvent (§13.3 fail loud)", errors.length >= 1 && events.length === 1);
  }
  await new Promise<void>((res) => { const bad = "not.an.epe.subtree"; try { epWatch(nc, SPACE, bad, { onEvent: () => {}, onError: () => {} }); c("epWatch refuses a non-epe filter", false, "no throw"); } catch { c("epWatch refuses a filter that is not an epe subtree of the space", true); } res(); });

  await nc.drain();
  console.log(`\nENDPOINT VERBS SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed)`);
} finally {
  broker.kill("SIGKILL");
  rmSync(sd, { recursive: true, force: true });
}
if (fail > 0) process.exit(1);
