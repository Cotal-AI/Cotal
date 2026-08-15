/**
 * GENERIC describe/invoke REQUEST-BINDING smoke (control-surface P2 item 1, 1c.2c hardening) —
 * proves {@link describeEndpoint} binds its reply to the request it sent, so the describe-derived
 * invoke currency cannot be captured by an injected reply (freelance cold-review HIGH #1).
 *
 * The responder grant `epResponderReplyPattern` spans EVERY caller-nonce suffix, so any live
 * responder can publish on a caller's reply rail at any nonce. A describe that accepted the first
 * `{ok:true}` on the rail (no nonce match, no request-id echo) would adopt an ATTACKER-chosen
 * responder identity + epoch as "current", defeating the whole describe-bound currency check.
 *
 * Hermetic: a fake NatsConnection captures the subscription callback and, on publish, reads the
 * outgoing request's nonce + id off the subject/body and synchronously delivers crafted replies.
 * No broker. Run: pnpm smoke:ep-invoke
 */
import { describeEndpoint, epReplySubject, parseEpSubject, type EpCaller } from "../src/index.js";

const enc = new TextEncoder(), dec = new TextDecoder();
let pass = 0, fail = 0;
const c = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const rejects = async (name: string, fn: () => Promise<unknown>, code?: string) => {
  try { await fn(); c(name, false, "did not throw"); }
  catch (e) { c(name, code === undefined || (e as { code?: string }).code === code, (e as { code?: string }).code ?? (e as Error).message); }
};

const SPACE = "invbind";
const CALLER: EpCaller = { owner: "local", actor: "cliabc", uid: "u".repeat(26) };
const ENDPOINT = "manager";
const HONEST = { instanceId: "honestiiiiiiiiiiiiiiiiiiiii", epoch: 3 };
const ATTACKER = { instanceId: "attackerjjjjjjjjjjjjjjjjjjj", epoch: 99 };
const answer = { public: true, descriptor: { endpoint: ENDPOINT, owner: "local", clusters: [] } };

/** A fake NatsConnection: on publish, parse the request the code sent and deliver `crafted(req)`
 *  replies through the captured subscription callback (each an {subject,data} message). */
function fakeNc(crafted: (req: { nonce: string; id: string }) => Array<{ subject: string; data: Uint8Array }>) {
  let cb: ((err: unknown, msg: { subject: string; data: Uint8Array }) => void) | undefined;
  return {
    subscribe(_filter: string, opts: { callback: (err: unknown, msg: { subject: string; data: Uint8Array }) => void }) {
      cb = opts.callback;
      return { unsubscribe() {} };
    },
    publish(subject: string, data: Uint8Array) {
      const parsed = parseEpSubject(subject);
      if (!parsed || parsed.plane !== "request") throw new Error(`unexpected publish subject ${subject}`);
      const body = JSON.parse(dec.decode(data)) as { id: string };
      const req = { nonce: parsed.nonce, id: body.id };
      // deliver on the next tick so describeEndpoint's promise is armed
      queueMicrotask(() => { for (const m of crafted(req)) cb?.(null, m); });
    },
    // The describe watches this stream to tell a broker-REFUSED publish from an unanswered one, so
    // the double has to model it or it stops being a NatsConnection. Modelled after the real
    // transport's QueuedIterator, INCLUDING the part that matters: a healthy connection emits no
    // status, so `next()` parks, and only `stop()` releases it — a queued `return()` on a parked
    // generator does not run until the next event, which is exactly the leak this shape exists to
    // keep honest. A double that settled on `return()` would let that regression back in silently.
    status() {
      let release: (() => void) | undefined;
      const stopped = new Promise<void>((r) => { release = r; });
      return {
        stop() { release?.(); },
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<{ type: string; error?: unknown }>> {
              await stopped;
              return { done: true, value: undefined };
            },
            async return(): Promise<IteratorResult<{ type: string; error?: unknown }>> {
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
  } as unknown as Parameters<typeof describeEndpoint>[0];
}

const reply = (who: { instanceId: string; epoch: number }, nonce: string, id: string, ok = true) => ({
  subject: epReplySubject(SPACE, { endpoint: ENDPOINT, instanceId: who.instanceId, epoch: who.epoch, caller: CALLER, nonce }),
  data: enc.encode(JSON.stringify({ v: 1, id, ok, ...(ok ? { data: answer } : { error: { code: "unavailable", message: "x" } }) })),
});

console.log("describe REQUEST-BINDING (freelance HIGH #1):");

// 1) An attacker reply on a DIFFERENT nonce (its own valid responder triple + a wrong request id)
//    delivered BEFORE the honest one is IGNORED; describe binds to the honest responder.
{
  const otherNonce = "z".repeat(24);
  const nc = fakeNc((req) => [
    reply(ATTACKER, otherNonce, "wrongreqid00000000000000"), // wrong nonce AND wrong id
    reply(HONEST, req.nonce, req.id), // the real answer, on our nonce, echoing our id
  ]);
  const { responder } = await describeEndpoint(nc, SPACE, ENDPOINT, CALLER, { deadlineMs: 2000 });
  c("an injected reply on a different nonce is ignored; describe binds to the HONEST responder", responder.instanceId === HONEST.instanceId && responder.epoch === HONEST.epoch, responder);
}

// 2) An attacker reply on OUR nonce but with a wrong request id is IGNORED (the id echo is
//    load-bearing: the rail is shared, an id mismatch is not our answer).
{
  const nc = fakeNc((req) => [
    reply(ATTACKER, req.nonce, "wrongreqid00000000000000"), // our nonce, wrong id
    reply(HONEST, req.nonce, req.id),
  ]);
  const { responder } = await describeEndpoint(nc, SPACE, ENDPOINT, CALLER, { deadlineMs: 2000 });
  c("a reply on our nonce with a wrong request id is ignored; the id-echo binding holds", responder.instanceId === HONEST.instanceId, responder);
}

// 3) An attacker reply for a DIFFERENT endpoint on our rail is ignored.
{
  const nc = fakeNc((req) => [
    { subject: epReplySubject(SPACE, { endpoint: "delivery", instanceId: ATTACKER.instanceId, epoch: 1, caller: CALLER, nonce: req.nonce }), data: enc.encode(JSON.stringify({ v: 1, id: req.id, ok: true, data: answer })) },
    reply(HONEST, req.nonce, req.id),
  ]);
  const { responder } = await describeEndpoint(nc, SPACE, ENDPOINT, CALLER, { deadlineMs: 2000 });
  c("a reply attributed to a different endpoint is ignored", responder.instanceId === HONEST.instanceId, responder);
}

// 4) When ONLY an injected reply exists (wrong nonce), describe does NOT accept it — it
//    deadline-exceeds. The attacker cannot force acceptance of its identity by racing.
{
  const nc = fakeNc(() => [reply(ATTACKER, "y".repeat(24), "someid000000000000000000")]);
  await rejects("with only an injected (wrong-nonce) reply present, describe times out - never adopts the attacker", () => describeEndpoint(nc, SPACE, ENDPOINT, CALLER, { deadlineMs: 300 }), "deadline-exceeded");
}

// 5) Sanity: the honest reply alone resolves.
{
  const nc = fakeNc((req) => [reply(HONEST, req.nonce, req.id)]);
  const { answer: a, responder } = await describeEndpoint(nc, SPACE, ENDPOINT, CALLER, { deadlineMs: 2000 });
  c("the honest reply alone resolves with its attributed responder + answer", responder.epoch === HONEST.epoch && a.descriptor.endpoint === ENDPOINT, { responder, a });
}

console.log(`\n${fail === 0 ? "ENDPOINT-INVOKE BINDING SMOKE OK ✅" : "ENDPOINT-INVOKE BINDING SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
