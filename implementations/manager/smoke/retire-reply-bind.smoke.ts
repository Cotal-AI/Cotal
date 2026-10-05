/**
 * The retirement rail's REPLY BINDING, driven through the PRODUCTION caller {@link invokeCommand}.
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
 * The manager retired `epAwaitReply` for the generic {@link invokeCommand}/{@link resolveService}
 * pair (`manager.ts`, the despawn path around `EP_CMD_RETIRE_LIFECYCLE`); this suite follows that
 * caller so the claim it pins still applies to the caller the manager actually runs.
 *
 * Run: pnpm smoke:retire-reply-bind
 */
import { randomBytes } from "node:crypto";
import {
  compileContract, invokeCommand, epReplySubject, parseEpSubject, mintLifecycleUid,
  AUTH_ENDPOINT, EP_CMD_RETIRE_LIFECYCLE, type EpCaller, type ResolvedService,
} from "@cotal-ai/core";

for (const k of ["COTAL_SERVERS", "COTAL_SERVER", "COTAL_CREDS", "COTAL_SPACE"]) delete process.env[k];
for (const [k, v] of Object.entries(process.env))
  if (/broker\.cotal\.ai/.test(String(v))) throw new Error(`refusing to run: ${k} names the live broker`);

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, ctx?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, ctx === undefined ? "" : JSON.stringify(ctx)); }
};

const enc = new TextEncoder(), dec = new TextDecoder();
const SPACE = "rrb";
const CALLER: EpCaller = { owner: "local", actor: "mgr0", uid: mintLifecycleUid() };
const RESPONDER = { instanceId: mintLifecycleUid(), epoch: 0 };

/** The retire-lifecycle `ResolvedService` a real `resolveService` describe would hand back: the
 *  auth endpoint, the one ephemeral `retire-lifecycle` command with its declared input/output
 *  shape (`auth-service-contract.ts`), and the responder triple the describe reply bound. */
const input = compileContract({
  root: {
    type: "object",
    properties: {
      opId: { type: "string" },
      serveEndpoint: { type: "string" },
      serveInstanceId: { type: "string" },
      serveEpoch: { type: "integer" },
    },
    required: ["opId", "serveEndpoint", "serveInstanceId", "serveEpoch"],
    additionalProperties: false,
  },
});
const output = compileContract({
  root: {
    type: "object",
    properties: {
      retired: { type: "boolean" },
      lifecycleUid: { type: "string" },
      opId: { type: "string" },
      evictedPrincipals: { type: "array", items: { type: "string" } },
    },
    required: ["retired", "lifecycleUid", "opId", "evictedPrincipals"],
    additionalProperties: false,
  },
});
const service: ResolvedService = {
  endpoint: AUTH_ENDPOINT, owner: "local", caller: CALLER, responder: RESPONDER,
  commands: new Map([[EP_CMD_RETIRE_LIFECYCLE, {
    command: EP_CMD_RETIRE_LIFECYCLE, contract: { input, output }, class: "ephemeral",
    targeted: true, modes: ["exact"], capability: "auth.admin",
  }]]),
};

/** A stub connection: it answers each published request on the DERIVED reply subject, with an id
 *  chosen by the case under test. Only the surface `invokeCommand`/`epCall` uses is implemented,
 *  matching `fakeInvokeNc` in `packages/core/smoke/endpoint-invoke.smoke.ts`. */
function stubConn(idFor: (reqId: string) => string) {
  let cb: ((err: unknown, msg: { subject: string; data: Uint8Array }) => void) | undefined;
  return {
    subscribe(_filter: string, opts: { callback: (err: unknown, msg: { subject: string; data: Uint8Array }) => void }) {
      cb = opts.callback;
      return { unsubscribe() { cb = undefined; } };
    },
    publish(subject: string, data: Uint8Array) {
      const parsed = parseEpSubject(subject);
      if (!parsed || parsed.plane !== "request") throw new Error(`unexpected publish subject ${subject}`);
      const body = JSON.parse(dec.decode(data)) as { id: string };
      const replySubject = epReplySubject(SPACE, {
        endpoint: parsed.endpoint, instanceId: RESPONDER.instanceId, epoch: RESPONDER.epoch,
        caller: parsed.caller, nonce: parsed.nonce,
      });
      const reply = enc.encode(JSON.stringify({
        v: 1, id: idFor(body.id), ok: true,
        data: { retired: true, lifecycleUid: "lc", opId: body.id, evictedPrincipals: [] },
      }));
      // Deliver on the next tick, as a broker would.
      setTimeout(() => cb?.(null, { subject: replySubject, data: reply }), 5);
    },
    // epCall watches nc.status() for a broker-refused publish. A double without it
    // is not a NatsConnection for that path.
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
  } as unknown as Parameters<typeof invokeCommand>[0];
}

const drive = async (idFor: (reqId: string) => string, deadlineMs: number) => {
  const opId = randomBytes(16).toString("base64url");
  try {
    return await invokeCommand(stubConn(idFor), SPACE, service, EP_CMD_RETIRE_LIFECYCLE, {
      opId, serveEndpoint: "manager", serveInstanceId: mintLifecycleUid(), serveEpoch: 0,
    }, {
      target: { mode: "exact", owner: "local", actor: "u1", lifecycleUid: mintLifecycleUid() },
      deadlineMs,
    });
  } catch (e) { return `THREW:${(e as Error).message}`; }
};

console.log("the production caller's reply binding");
// POSITIVE CONTROL FIRST: without it the refusal below passes against a caller that accepts nothing.
const ok = await drive((reqId) => reqId, 3000);
check("POSITIVE CONTROL: a reply whose id ECHOES the request RESOLVES through invokeCommand",
  typeof ok === "object" && ok !== null && (ok as { reply: { ok?: boolean } }).reply?.ok === true, ok);
// The guard: the responder answers, but with the wrong id. invokeCommand's per-call reply
// subscription is nonce-scoped to this one request, so a mismatched id is not silently skipped
// in favor of a later honest reply (there is no other reply coming) — it is refused as a
// structured SPEC 13.3 violation. Either way the call never resolves ok:true on the wrong id.
const wrong = await drive((reqId) => `${reqId}-WRONG`, 1500);
check("a reply whose id does NOT echo the request id NEVER resolves ok:true (a wrong-id ok:true cannot clear a retirement hold)",
  typeof wrong === "string" && wrong.startsWith("THREW:") && /does not echo the request id/.test(wrong), wrong);

console.log(`\nretire-reply-bind: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
