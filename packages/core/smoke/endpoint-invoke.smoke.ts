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
import {
  compileContract, describeEndpoint, epReplySubject, invokeCommand, parseEpSubject,
  unansweredRequest, type EpCaller, type ResolvedService,
} from "../src/index.js";

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
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const SPACE = "invbind";
const CALLER: EpCaller = { owner: "local", actor: "cliabc", uid: "u".repeat(26) };
const ENDPOINT = "manager";
const HONEST = { instanceId: "honestiiiiiiiiiiiiiiiiiiiii", epoch: 3 };
const ATTACKER = { instanceId: "attackerjjjjjjjjjjjjjjjjjjj", epoch: 99 };
const answer = { public: true, descriptor: { endpoint: ENDPOINT, owner: "local", clusters: [] } };

/** A fake NatsConnection: on publish, parse the request the code sent and deliver `crafted(req)`
 *  replies through the captured subscription callback (each an {subject,data} message). */
function fakeNc(
  crafted: (req: { nonce: string; id: string }) => Array<{ subject: string; data: Uint8Array }>,
  beforePublish?: (req: { nonce: string; id: string }) => void,
) {
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
      beforePublish?.(req);
      // deliver on the next tick so describeEndpoint's promise is armed
      queueMicrotask(() => { for (const m of crafted(req)) cb?.(null, m); });
    },
    // The describe watches this stream to tell a broker-REFUSED publish from an unanswered one, so
    // the double has to model it or it stops being a NatsConnection. Modelled after the real
    // transport's QueuedIterator, INCLUDING the part that matters: a healthy connection emits no
    // status, so `next()` parks, and only `stop()` releases it: a queued `return()` on a parked
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

/** A fake NatsConnection that answers an ordinary resolved command and counts every publish. */
function fakeInvokeNc(onPublish: () => void) {
  let cb: ((err: unknown, msg: { subject: string; data: Uint8Array }) => void) | undefined;
  return {
    subscribe(_filter: string, opts: { callback: (err: unknown, msg: { subject: string; data: Uint8Array }) => void }) {
      cb = opts.callback;
      return { unsubscribe() { cb = undefined; } };
    },
    publish(subject: string, data: Uint8Array) {
      onPublish();
      const parsed = parseEpSubject(subject);
      if (!parsed || parsed.plane !== "request") throw new Error(`unexpected publish subject ${subject}`);
      const body = JSON.parse(dec.decode(data)) as { id: string };
      const replySubject = epReplySubject(SPACE, {
        endpoint: parsed.endpoint, instanceId: HONEST.instanceId, epoch: HONEST.epoch,
        caller: parsed.caller, nonce: parsed.nonce,
      });
      queueMicrotask(() => cb?.(null, {
        subject: replySubject,
        data: enc.encode(JSON.stringify({ v: 1, id: body.id, ok: true, data: { ran: true } })),
      }));
    },
  } as unknown as Parameters<typeof invokeCommand>[0];
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
  // The deadline is the one describe failure that observed NO answer: it carries EP_UNANSWERED.
  let e: unknown;
  try { await describeEndpoint(nc, SPACE, ENDPOINT, CALLER, { deadlineMs: 300 }); } catch (err) { e = err; }
  c("the describe deadline is marked EP_UNANSWERED (nothing answered on our nonce)", unansweredRequest(e), e);
}

// 4b) A responder ANSWERS the describe with ok:false: it is rethrown under the responder's own code
//     (`unavailable` here, as core's describe handler produces when its trusted auth view failed) and
//     WITHOUT the EP_UNANSWERED marker. A consumer keyed on the marker never reads it as absence;
//     one keyed on the code did, and printed "no manager reachable" for an answering manager.
{
  const nc = fakeNc((req) => [reply(HONEST, req.nonce, req.id, false)]);
  let e: unknown;
  try { await describeEndpoint(nc, SPACE, ENDPOINT, CALLER, { deadlineMs: 2000 }); } catch (err) { e = err; }
  c("an answered ok:false describe rethrows under the responder's own code (`unavailable`)", (e as { code?: string })?.code === "unavailable", e);
  c("an answered ok:false describe is NOT marked EP_UNANSWERED (the code alone is not evidence of silence)", !unansweredRequest(e), e);
}

// 5) Sanity: the honest reply alone resolves.
{
  const nc = fakeNc((req) => [reply(HONEST, req.nonce, req.id)]);
  const { answer: a, responder } = await describeEndpoint(nc, SPACE, ENDPOINT, CALLER, { deadlineMs: 2000 });
  c("the honest reply alone resolves with its attributed responder + answer", responder.epoch === HONEST.epoch && a.descriptor.endpoint === ENDPOINT, { responder, a });
}

// 6) Core NATS drops a request published before a responder subscribes. The describe bootstrap is
//    read-only, so it re-publishes the SAME bound request inside the ORIGINAL deadline. Model that
//    registration gap exactly: the first publish has nobody behind it; the second reaches the newly
//    available responder. A one-shot describe waits out the deadline and fails this cell.
{
  let publishes = 0;
  const nc = fakeNc((req) => ++publishes === 1 ? [] : [reply(HONEST, req.nonce, req.id)]);
  let responder: { instanceId: string; epoch: number } | undefined;
  let error: unknown;
  try { ({ responder } = await describeEndpoint(nc, SPACE, ENDPOINT, CALLER, { deadlineMs: 800 })); }
  catch (e) { error = e; }
  c("an unanswered describe is re-published within its original deadline when the responder registers after the first request", publishes === 2 && responder?.instanceId === HONEST.instanceId, { publishes, responder, error });
}

// 7) `publish` throws synchronously after a real connection closes or begins draining. The first
//    retry runs from a timer, so that throw must reject the pending describe rather than escape as an
//    uncaught exception. The short deadline keeps the deliberately unguarded mutation below its
//    second retry: one captured uncaught exception can therefore redden this named cell without the
//    mutant crashing before mutation-proof sees which assertion failed.
{
  let publishes = 0;
  let uncaught: unknown;
  const onUncaught = (e: unknown) => { uncaught = e; };
  process.once("uncaughtException", onUncaught);
  const nc = fakeNc(() => [], () => {
    publishes++;
    if (publishes === 2) throw new Error("closed connection");
  });
  let error: unknown;
  try { await describeEndpoint(nc, SPACE, ENDPOINT, CALLER, { deadlineMs: 400 }); }
  catch (e) { error = e; }
  process.removeListener("uncaughtException", onUncaught);
  c("a retry publish failure rejects the pending describe as unavailable and never escapes the timer",
    publishes === 2 && uncaught === undefined && (error as { code?: string })?.code === "unavailable" && (error as Error)?.message.includes("closed connection"),
    { publishes, uncaught, error });
}

// 7b/7c) Constructed-only: a poisoned Error.message getter or a poisoned non-Error toString must not
//     escape the retry timer. Real NATS close/drain failures were ordinary Error values; these cells
//     prove the catch formats an arbitrary thrown value without throwing, not that production produces
//     either poison. The describe must still settle as unavailable (not hang to the deadline).
{
  const poison = (makeThrow: () => unknown, name: string) => {
    let publishes = 0;
    let uncaught: unknown;
    const onUncaught = (e: unknown) => { uncaught = e; };
    process.once("uncaughtException", onUncaught);
    const started = Date.now();
    const nc = fakeNc(() => [], () => {
      publishes++;
      if (publishes === 2) throw makeThrow();
    });
    return (async () => {
      let error: unknown;
      try { await describeEndpoint(nc, SPACE, ENDPOINT, CALLER, { deadlineMs: 400 }); }
      catch (e) { error = e; }
      process.removeListener("uncaughtException", onUncaught);
      const elapsed = Date.now() - started;
      c(name,
        publishes === 2 && uncaught === undefined && elapsed < 380
          && (error as { code?: string })?.code === "unavailable"
          && (error as Error)?.message.includes("unknown publish failure"),
        { publishes, uncaught, elapsed, error });
    })();
  };
  await poison(() => {
    const err = new Error("closed connection");
    Object.defineProperty(err, "message", { get() { throw new Error("message getter poisoned"); } });
    return err;
  }, "a poisoned Error.message getter on retry publish still rejects as unavailable and never escapes the timer");
  await poison(() => ({ toString() { throw new Error("toString poisoned"); } }),
    "a poisoned non-Error toString on retry publish still rejects as unavailable and never escapes the timer");
}

// 8) The retry above is confined to reserved, read-only describe. A resolved command rides epCall
//    and is published exactly once, including after the describe retry interval has elapsed.
{
  const input = compileContract({ root: { type: "null" } });
  const output = compileContract({ root: { type: "object", properties: { ran: { type: "boolean" } }, required: ["ran"], additionalProperties: false } });
  const service: ResolvedService = {
    endpoint: ENDPOINT, owner: "local", caller: CALLER, responder: HONEST,
    commands: new Map([["mutate", {
      command: "mutate", contract: { input, output }, class: "ephemeral", targeted: false,
      modes: [], capability: "endpoint.mutate",
    }]]),
  };
  let publishes = 0;
  const nc = fakeInvokeNc(() => { publishes++; });
  const result = await invokeCommand(nc, SPACE, service, "mutate", undefined, { deadlineMs: 800 });
  await wait(350);
  c("a resolved command is published exactly ONCE; describe readiness retry never widens to caller-supplied commands",
    publishes === 1 && result.reply.ok === true, { publishes, result });
}

console.log(`\n${fail === 0 ? "ENDPOINT-INVOKE BINDING SMOKE OK ✅" : "ENDPOINT-INVOKE BINDING SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
