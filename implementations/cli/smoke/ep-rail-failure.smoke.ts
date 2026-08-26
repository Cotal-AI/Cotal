/**
 * `epRailFailure` polarity smoke: the CLI's ep-rail renderer states the reachability verdict ("no
 * manager reachable" / "instance … did not answer") from core's answer-provenance markers, never from
 * the catalog code. Review of the manager-split lane found the code-keyed version printing "no
 * manager reachable" for a manager that had ANSWERED (a responder's own `ok:false` describe reply is
 * rethrown under its code, `unavailable` included; a store read after an answered describe raises the
 * same code) and for a registry read on the caller's own side (the scatter reconcile).
 *
 * Part 1 grades the renderer on hand-built errors, one cell per producer shape (each names the core
 * site it stands for). Part 2 drives the PUBLIC `askManager` against a real broker: a describe
 * responder that answers `ok:false unavailable` (the exact repro from review), a describe answered
 * `ok:true` whose cluster document is not in the store (the post-describe store read), and no
 * responder at all (the positive control for the verdict, unpinned and pinned).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import {
  EpEnvelopeError, EP_UNANSWERED, EP_UNBOUND_RESPONDER, EP_REGISTRY_READ_FAILED,
  isReachable, parseEpSubject, epReplySubject, spacePrefix,
} from "@cotal-ai/core";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { askManager, epRailFailure } from "../src/lib/control.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

let pass = 0, fail = 0;
const c = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) pass++;
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const IID = "1".repeat(26);
const VERDICT = /no manager reachable|did not answer/;
const ep = (code: ConstructorParameters<typeof EpEnvelopeError>[0], message: string, details?: ConstructorParameters<typeof EpEnvelopeError>[2]) => new EpEnvelopeError(code, message, details);
const unansweredMark = { kind: EP_UNANSWERED, endpoint: "manager", command: "ps" };
const registryMark = { kind: EP_REGISTRY_READ_FAILED, endpoint: "manager", command: "ps" };

console.log("epRailFailure polarity (hand-built errors, one per producer shape):");
{
  // endpoint-verbs.ts epCall: the broker's no-responders control frame (marked).
  const r = epRailFailure(ep("unavailable", "no responder for manager.ps (SPEC 13.5)", [unansweredMark]));
  c("no-responder (marked) unpinned: unanswered=true and the verdict is stated", r.unanswered === true && r.error?.startsWith("no manager reachable on the ep rails (unavailable: no responder for manager.ps") === true, r);
  const p = epRailFailure(ep("unavailable", "no responder for manager.ps (SPEC 13.5)", [unansweredMark]), { instanceId: IID });
  c("no-responder (marked) pinned: names the instance, never 'no manager reachable'", p.unanswered === true && p.error === `manager instance ${IID} did not answer (unavailable: no responder for manager.ps (SPEC 13.5))`, p);
}
{
  // endpoint-verbs.ts epCall: the reply deadline elapsed (marked).
  const r = epRailFailure(ep("deadline-exceeded", "no reply to manager.ps within the 2000ms budget (SPEC 13.5)", [unansweredMark]));
  c("reply-deadline (marked): unanswered=true and the verdict is stated", r.unanswered === true && VERDICT.test(r.error ?? ""), r);
  // endpoint-invoke.ts describe: no describe reply within the deadline (marked, command "describe").
  const d = epRailFailure(ep("deadline-exceeded", "no describe reply from manager within 10000ms", [{ kind: EP_UNANSWERED, endpoint: "manager", command: "describe" }]));
  c("describe-deadline (marked): unanswered=true and the verdict is stated", d.unanswered === true && VERDICT.test(d.error ?? ""), d);
}
{
  // endpoint-invoke.ts:179 the responder's OWN ok:false describe reply, rethrown under its code (unmarked).
  const r = epRailFailure(ep("unavailable", "describe(manager) failed: trusted auth view failed"));
  c("answered ok:false describe (`unavailable`, unmarked): unanswered=false, printed as is, NO verdict", r.unanswered === false && r.error === "unavailable: describe(manager) failed: trusted auth view failed", r);
  const p = epRailFailure(ep("unavailable", "describe(manager) failed: trusted auth view failed"), { instanceId: IID });
  c("answered ok:false describe pinned: still no 'did not answer'", p.unanswered === false && !VERDICT.test(p.error ?? ""), p);
}
{
  // endpoint-contract-store.ts:234 a store read AFTER an answered describe (unmarked `unavailable`).
  const r = epRailFailure(ep("unavailable", "the contract-store read for abc failed (a failed observation is never absence, SPEC 13.7): stream not found"));
  c("post-describe store read (`unavailable`, unmarked): unanswered=false, NO verdict", r.unanswered === false && r.error?.startsWith("unavailable: the contract-store read") === true && !VERDICT.test(r.error), r);
  // endpoint-verbs.ts epCall `one`: a VALID reply landed with no budget left to verify currency (unmarked `deadline-exceeded`).
  const b = epRailFailure(ep("deadline-exceeded", "no budget left to verify the `one` responder's currency within 2000ms (SPEC 13.5)"));
  c("valid reply, no budget left (`deadline-exceeded`, unmarked): unanswered=false, NO verdict", b.unanswered === false && !VERDICT.test(b.error ?? ""), b);
  // endpoint-verbs.ts:288 / endpoint-invoke.ts:125 the caller's own reply subscription failed (unmarked `unavailable`).
  const s = epRailFailure(ep("unavailable", "the caller's reply subscription failed: boom"));
  c("caller-side subscription failure (`unavailable`, unmarked): unanswered=false, NO verdict", s.unanswered === false && !VERDICT.test(s.error ?? ""), s);
}
{
  // endpoint-verbs.ts scatter reconcile: did not settle (`unavailable`) / unreadable (`failed-precondition`), both marked registry-read.
  const r = epRailFailure(ep("unavailable", "the scatter registration reconcile did not settle within its 3000ms bound (SPEC 13.5: deadline mandatory, never a hung scatter)", [registryMark]));
  c("reconcile did not settle (registry-marked `unavailable`): the registry outcome, NO reachability verdict", r.unanswered === false && r.error?.startsWith("the manager registry could not be read") === true && r.error.includes("unavailable: the scatter registration reconcile did not settle") && !VERDICT.test(r.error), r);
  const u = epRailFailure(ep("failed-precondition", "the scatter registration reconcile is unreadable; an unreadable registry is failed-precondition, never an empty success (SPEC 13.5): kv down", [registryMark]));
  c("reconcile unreadable (registry-marked `failed-precondition`): the registry outcome, no --on hint", u.unanswered === false && u.error?.startsWith("the manager registry could not be read") === true && !u.error.includes("--on"), u);
  const f = epRailFailure(ep("deadline-exceeded", "the scatter freeze for manager did not settle within the 8000ms budget (SPEC 13.5)", [registryMark]));
  c("scatter freeze deadline (registry-marked `deadline-exceeded`): the registry outcome, NO reachability verdict", f.unanswered === false && f.error?.startsWith("the manager registry could not be read") === true && !VERDICT.test(f.error), f);
}
{
  // The unpinned class-queue split (EP_UNBOUND_RESPONDER on failed-precondition): the --on hint is
  // offered only to a caller that DECLARED it has the flag (a `pin` present) and did not pass it.
  const mark = { kind: EP_UNBOUND_RESPONDER, endpoint: "manager", command: "ps", answeredBy: "2".repeat(26), boundTo: IID, pinned: false };
  const r = epRailFailure(ep("failed-precondition", "a different instance answered", [mark]), {});
  c("unpinned split on a caller WITH --on (pin declared, not passed): printed as is plus the --on hint, NO verdict", r.unanswered === false && r.error?.endsWith("Pin one manager instance with --on <instance> (the whole id, as `ps` prints it) to avoid the split.") === true && !VERDICT.test(r.error), r);
  const n = epRailFailure(ep("failed-precondition", "a different instance answered", [mark]));
  c("the same split on a caller WITHOUT --on (`models`, `up`, `down`: no pin declared): printed as is, NO --on hint", n.unanswered === false && n.error === "failed-precondition: a different instance answered", n);
  const p = epRailFailure(ep("failed-precondition", "a different instance answered", [mark]), { instanceId: IID });
  c("pinned split: no --on hint (it was passed)", p.unanswered === false && !p.error?.includes("--on"), p);
  const x = epRailFailure(ep("expired", "same instance, other epoch", [{ ...mark, answeredEpoch: 4, heldEpoch: 3, reference: "bind" }]), {});
  c("marked `expired` (stale-epoch bind): printed as is, no --on hint, NO verdict", x.unanswered === false && x.error === "expired: same instance, other epoch", x);
}
{
  const r = epRailFailure(ep("permission-denied", "the describe for manager was REFUSED BY THE BROKER, not unanswered"));
  c("broker-refused describe: printed as is, NO verdict", r.unanswered === false && r.error === "permission-denied: the describe for manager was REFUSED BY THE BROKER, not unanswered", r);
  const n = epRailFailure(new Error("connection closed"));
  c("a non-EpEnvelopeError carries no provenance: message alone, unanswered=false, NO verdict", n.unanswered === false && n.error === "connection closed", n);
  const np = epRailFailure(new Error("connection closed"), { instanceId: IID });
  c("a non-EpEnvelopeError pinned: still no 'did not answer'", np.unanswered === false && np.error === "connection closed", np);
}

// ── Part 2: the public askManager path against a real broker (open mesh) ──
console.log("askManager against a real broker:");
const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, sd);
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = "eprail";
const enc = new TextEncoder(), dec = new TextDecoder();
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(SERVER); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  const nc = await connect({ servers: SERVER });
  /** A describe responder for `manager` on the class rail that answers every request with `body`. */
  const serveDescribe = (body: (id: string) => Record<string, unknown>) => nc.subscribe(`${spacePrefix(SPACE)}.ep.one.manager.describe.>`, {
    callback: (err, msg) => {
      if (err) return;
      const p = parseEpSubject(msg.subject);
      if (!p || p.plane !== "request") return;
      const { id } = JSON.parse(dec.decode(msg.data)) as { id: string };
      nc.publish(epReplySubject(SPACE, { endpoint: "manager", instanceId: IID, epoch: 1, caller: p.caller, nonce: p.nonce }), enc.encode(JSON.stringify(body(id))));
    },
  });
  {
    // The review repro: a manager ANSWERS the describe with ok:false unavailable (core's own describe
    // handler produces exactly this when its trusted auth view failed).
    const sub = serveDescribe((id) => ({ v: 1, id, ok: false, error: { code: "unavailable", message: "trusted auth view failed" } }));
    const r = await askManager(SPACE, SERVER, "ps", undefined, {}, "any", 2000);
    await sub.drain();
    c("live: an ANSWERED ok:false `unavailable` describe is not 'no manager reachable' (the responder's own cause is printed)",
      r.ok === false && r.unanswered === false && r.error === "unavailable: describe(manager) failed: trusted auth view failed", r);
  }
  {
    // A describe answered ok:true whose cluster document is not in the store: the failure is the
    // caller's post-describe store read, after a manager answered.
    const digest = "e".repeat(64);
    const sub = serveDescribe((id) => ({ v: 1, id, ok: true, data: { public: true, descriptor: { endpoint: "manager", owner: "local", clusters: [{ digest, commands: ["ps"] }] } } }));
    const r = await askManager(SPACE, SERVER, "ps", undefined, {}, "any", 2000);
    await sub.drain();
    c("live: an answered describe followed by a failed store read is not 'no manager reachable' (unanswered=false)",
      r.ok === false && r.unanswered === false && r.error?.startsWith("unavailable: the contract-store read for") === true && !VERDICT.test(r.error), r);
  }
  {
    // Positive control: nobody serves `manager` at all. The describe deadline (10s in askManagerEp)
    // is the unanswered producer on this path; the verdict is stated, unpinned and pinned.
    const [r, p] = await Promise.all([
      askManager(SPACE, SERVER, "ps", undefined, {}, "any", 2000),
      askManager(SPACE, SERVER, "ps", undefined, {}, "any", 2000, { instanceId: IID }),
    ]);
    c("live: no responder at all, unpinned: unanswered=true and 'no manager reachable' (the positive control)",
      r.ok === false && r.unanswered === true && r.error?.startsWith("no manager reachable on the ep rails (deadline-exceeded: no describe reply from manager") === true, r);
    c("live: no responder at all, pinned: unanswered=true and 'instance … did not answer'",
      p.ok === false && p.unanswered === true && p.error?.startsWith(`manager instance ${IID} did not answer (deadline-exceeded: no describe reply from manager`) === true, p);
  }
  await nc.drain();
} finally {
  broker.kill("SIGTERM");
  rmSync(sd, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}

console.log(`\n${fail === 0 ? "EP-RAIL-FAILURE POLARITY SMOKE OK ✅" : "EP-RAIL-FAILURE POLARITY SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
