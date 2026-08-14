/**
 * The retirement rail's REPLY BINDING, driven through the PRODUCTION caller {@link epAwaitReply}.
 *
 * WHY THIS EXISTS: the auth-side rail smoke already had an id-echo cell and it was VACUOUS. It
 * reimplemented the caller's comparison in its own helper and never called the shipped function,
 * so deleting the production guard left it green 24/24 — `mutation-proof` reported SURVIVED. A
 * killed mutation proves a suite DEPENDS on some code; it does not prove a real entry point
 * REACHES it, and a suite that builds its inputs by hand must prove that part separately
 * (AGENTS.md). This is that separate proof: it calls the shipped function.
 *
 * SCOPE, stated so it is not over-read: the transport here is a STUB, not a broker. This pins the
 * caller's ACCEPTANCE LOGIC — which replies it binds and which it ignores. Broker-enforced grant
 * confinement for this rail is proven separately and live in the auth rail smoke. A stub is the
 * right instrument for this claim precisely because no profile can serve `ep.one`/publish
 * `ep.reply` for a stand-in responder, and importing the auth implementation here would breach the
 * one-way implementation boundary.
 *
 * Run: pnpm smoke:retire-reply-bind
 */
import { randomBytes } from "node:crypto";
import { mintLifecycleUid, epReplySubject, AUTH_ENDPOINT } from "@cotal-ai/core";
import { epAwaitReply } from "../src/manager.js";

for (const k of ["COTAL_SERVERS", "COTAL_SERVER", "COTAL_CREDS", "COTAL_SPACE"]) delete process.env[k];
for (const [k, v] of Object.entries(process.env))
  if (/broker\.cotal\.ai/.test(String(v))) throw new Error(`refusing to run: ${k} names the live broker`);

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, ctx?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, ctx === undefined ? "" : JSON.stringify(ctx)); }
};

const space = "rrb";
const caller = { owner: "local", actor: "mgr0", uid: mintLifecycleUid() };
const responder = { instanceId: mintLifecycleUid(), epoch: 0 };

/** A stub connection: it answers each published request on the DERIVED reply subject, with an id
 *  chosen by the case under test. Only the surface `epAwaitReply` uses is implemented. */
function stubConn(idFor: (reqId: string) => string) {
  const subs: { filter: string; cb: (err: unknown, msg: { subject: string; data: Uint8Array }) => void }[] = [];
  return {
    subscribe(filter: string, opts: { callback: (err: unknown, msg: { subject: string; data: Uint8Array }) => void }) {
      subs.push({ filter, cb: opts.callback });
      return { unsubscribe() { /* no-op */ } };
    },
    publish(_subject: string, data: Uint8Array) {
      const req = JSON.parse(new TextDecoder().decode(data)) as { id?: string };
      const nonce = _subject.split(".").pop()!;
      const reply = epReplySubject(space, { endpoint: AUTH_ENDPOINT, instanceId: responder.instanceId, epoch: responder.epoch, caller, nonce });
      const body = new TextEncoder().encode(JSON.stringify({ ok: true, id: idFor(String(req.id)), data: { retired: true } }));
      // Deliver on the next tick, as a broker would.
      setTimeout(() => { for (const s of subs) s.cb(null, { subject: reply, data: body }); }, 5);
    },
  };
}

const drive = async (idFor: (reqId: string) => string, timeoutMs: number) => {
  const nonce = randomBytes(24).toString("base64url");
  const requestId = randomBytes(16).toString("base64url");
  const subject = `cotal.${space}.ep.one.${AUTH_ENDPOINT}.retire-lifecycle.handle.local.w1.${mintLifecycleUid()}.${caller.owner}.${caller.actor}.${caller.uid}.${nonce}`;
  try {
    return await epAwaitReply(stubConn(idFor) as never, space, caller, nonce, requestId, subject, JSON.stringify({ id: requestId, op: "retireLifecycle", args: {} }), timeoutMs);
  } catch (e) { return `THREW:${(e as Error).message}`; }
};

console.log("the production caller's reply binding");
// POSITIVE CONTROL FIRST: without it the refusal below passes against a caller that accepts nothing.
const ok = await drive((reqId) => reqId, 3000);
check("POSITIVE CONTROL: a reply whose id ECHOES the request RESOLVES through the production caller",
  typeof ok === "object" && ok !== null && (ok as { ok?: boolean }).ok === true, ok);
// The guard: the responder answers, but with the wrong id.
const wrong = await drive((reqId) => `${reqId}-WRONG`, 1500);
check("a reply whose id does NOT echo is IGNORED by the production caller (a wrong-id ok:true cannot clear a retirement hold)",
  typeof wrong === "string" && wrong.startsWith("THREW:timeout"), wrong);

console.log(`\nretire-reply-bind: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
