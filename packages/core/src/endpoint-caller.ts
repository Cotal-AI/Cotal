/** The node-free half of the generic caller path: `describeEndpoint`, `invokeCommand` and
 *  `goalFollowRefusal`, shared by `endpoint-invoke` and the browser entry. Moved unchanged from
 *  `endpoint-invoke.ts`; the store fetch, recompile and split repair stay there. */
import { base64url } from "./base64url.js";
import type { NatsConnection, Subscription } from "@nats-io/transport-node";
import { openPublishDenialWatch } from "./endpoint-publish-denial.js";
import { EpEnvelopeError, EP_UNBOUND_RESPONDER, EP_UNANSWERED, parseEndpointReply } from "./endpoint-envelope.js";
import type { CompiledContract } from "./schema-profile.js";
import { epCall, type EpVerbTarget, type EpAttributedReply } from "./endpoint-call.js";
import { epRequestSubject, epCallerReplyFilter, epPlaneTokens, parseEpSubject, type EpCaller, type EpRoute } from "./endpoint-subjects.js";

export const dec = new TextDecoder(), enc = new TextEncoder();
const nonce = (): string => base64url(globalThis.crypto.getRandomValues(new Uint8Array(24)));
/** A describe is the reserved read-only discovery bootstrap, so an unanswered request may be
 *  re-published within its ORIGINAL deadline. Core NATS does not retain a request sent before a
 *  responder subscribes; without this bounded retry, a responder that registers one moment later
 *  is invisible until the caller pays the whole deadline. Commands are never retried here. */
const DESCRIBE_RETRY_MS = 250;

/** Format a caught value on a path that cannot afford to throw (timer/callback). A
 *  poisoned `Error.message` getter or `toString` must not escape the catch; the
 *  fallback is the detail, never a reason to skip the rejection. */
function caughtText(e: unknown, fallback: string): string {
  try {
    return e instanceof Error ? e.message : String(e);
  } catch {
    return fallback;
  }
}

/** Delivery margin above an action owner's accepted readiness budget. Spawn's established generic
 *  invariant was 40s client > 30s manager; preserve that measured 10s separation when a connector
 *  declares a different budget instead of inventing a second timeout policy. */
export const GOAL_FOLLOW_MARGIN_MS = 10_000;

/** A resolved command contract: the compiled input/output validators (recompiled from the store,
 *  digest-verified against the registered declaration) plus the command's §13.2 admission facts. */
export interface ResolvedCommand {
  command: string;
  contract: { input: CompiledContract; output: CompiledContract };
  class: string;
  targeted: boolean;
  modes: readonly string[];
  capability: string;
}

/** An endpoint's resolved invocation surface: every command the caller may see, with recompiled
 *  digest-verified contracts. Built from a fresh `describe` + store fetch. Carries the `caller`
 *  triple the describe ran as, so {@link invokeCommand} reuses the same authenticated identity,
 *  and the ANSWERING incarnation's identity off the describe reply SUBJECT (broker-authenticated:
 *  the §13.9 serve publish row pins `instanceId`+`epoch`, a responder cannot stamp another's) -
 *  {@link invokeCommand}'s default currency check binds the invoke to this incarnation. */
export interface ResolvedService {
  endpoint: string;
  owner: string;
  caller: EpCaller;
  responder: { instanceId: string; epoch: number };
  commands: Map<string, ResolvedCommand>;
  /** Set when the service was resolved PINNED to one instance's `inst` route (`--on`):
   *  {@link invokeCommand} then routes commands to that exact instance, never the class `one` queue,
   *  so a multi-manager space can be addressed per-instance. Absent ⇒ class anycast (the default). */
  pinnedInstanceId?: string;
}

/**
 * The reserved `describe` command as a raw request/reply (§13.7: describe pins NO contract, so it
 * carries no `op` digests — {@link epCall} always stamps digests and the serve boundary rejects a
 * digest-bearing describe as `contract-mismatch`, so this is a purpose-built raw path). It
 * REQUEST-BINDS its reply exactly as {@link epCall}'s `parseAttributedReply` does (§13.2): the
 * responder grant `epResponderReplyPattern` spans EVERY caller suffix, so any live responder can
 * publish on the caller's rail at any nonce — acceptance therefore checks the reply SUBJECT's
 * endpoint + nonce AND the body's echoed request id, not just "first `{ok:true}` on the rail".
 * A reply that fails any of these is IGNORED (not rejected: an attacker racing a wrong-nonce reply
 * must not be able to fail an honest describe), and the wait continues to the deadline. A signal
 * that aborts with a `TimeoutError` ends the wait as that deadline would.
 */
export async function describeEndpoint(
  nc: NatsConnection,
  space: string,
  endpoint: string,
  caller: EpCaller,
  opts: { deadlineMs?: number; instanceId?: string; signal?: AbortSignal } = {},
): Promise<{ answer: DescribeAnswer; responder: { instanceId: string; epoch: number } }> {
  opts.signal?.throwIfAborted();
  const deadlineMs = opts.deadlineMs ?? 10_000;
  const n = nonce();
  const requestId = nonce();
  // `--on <instance>`: PIN the describe to one instance's `inst` route so a multi-manager
  // space resolves the exact instance addressed, not whichever wins the class `one` queue. Default =
  // class anycast (mode "one"), unchanged for every existing caller.
  const route: EpRoute = opts.instanceId !== undefined ? { mode: "inst", instanceId: opts.instanceId } : { mode: "one" };
  const subject = epRequestSubject(space, { route, endpoint, command: "describe", caller, nonce: n });
  // The plane this describe rides, recorded on the unanswered marker so a surface that renders a
  // reachability verdict can scope it (SPEC 13.15: the legacy and versioned rails are disjoint subject spaces,
  // an endpoint serves both, and a caller holds rows on one of them only). Silence on the versioned rail is
  // therefore consistent with a responder that predates the versioned rail and serves `ep` alone.
  const rail = epPlaneTokens(caller).join(".");
  const env = {
    v: 1, id: requestId, op: { endpoint, command: "describe" }, class: "ephemeral",
    replyExpected: true, deadlineMs, from: { id: `${caller.owner}.${caller.actor}`, name: caller.actor },
  };
  let sub: Subscription | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setInterval> | undefined;
  let denialWatch: { denied: Promise<never>; release(): void } | undefined;
  let onAbort: (() => void) | undefined;
  const startedAt = performance.now();
  const unanswered = (ms: number) => new EpEnvelopeError("deadline-exceeded", `no describe reply from ${endpoint}${opts.instanceId !== undefined ? ` instance ${opts.instanceId}` : ""} within ${ms}ms on the ${rail} rail`, [{ kind: EP_UNANSWERED, endpoint, command: "describe", rail }]);
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(opts.signal?.reason?.name === "TimeoutError"
      ? unanswered(Math.round(performance.now() - startedAt))
      : new EpEnvelopeError("unavailable", `describe(${endpoint}) observation cancelled`));
    opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    // REGISTER THE PERMISSION WATCH BEFORE THE PUBLISH IT IS WATCHING. See
    // {@link openPublishDenialWatch}: a refused publish is otherwise indistinguishable
    // from an unanswered describe.
    denialWatch = openPublishDenialWatch(nc, subject, () => new EpEnvelopeError("permission-denied",
      `the describe for ${endpoint} was REFUSED BY THE BROKER, not unanswered: this caller's credential does not authorize publishing to "${subject}"${opts.instanceId !== undefined ? ` (the instance rail for ${opts.instanceId}: an instance-addressed call needs a credential minted with that instance, not a class-rail one)` : ""}. The responder may be perfectly healthy; the grant is what is missing (SPEC 13.2)`, undefined, "not-executed"), "describe");
    const got = new Promise<{ body: Record<string, unknown>; responder: { instanceId: string; epoch: number } }>((resolve, reject) => {
      sub = nc.subscribe(epCallerReplyFilter(space, caller), {
        callback: (err, msg) => {
          if (err) { reject(new EpEnvelopeError("unavailable", `describe reply subscription failed: ${err.message}`)); return; }
          // REQUEST-BIND off the reply SUBJECT first (§13.2): the responder triple + nonce are
          // broker-pinned by the serve publish grant. A reply for a DIFFERENT endpoint, or on a
          // nonce that is not the one we published (the rail is shared across our concurrent
          // requests, and a hostile responder can publish at any nonce), is NOT ours — ignore it
          // and keep waiting, never fail the honest describe on an injected reply.
          const parsed = parseEpSubject(msg.subject);
          if (!parsed || parsed.plane !== "reply" || parsed.endpoint !== endpoint || parsed.nonce !== n) return;
          // Then the body: it must parse as an EndpointReply and ECHO our request id on this
          // nonce-scoped rail (§13.3) — the second half of the confused-deputy binding.
          let reply;
          try { reply = parseEndpointReply(JSON.parse(dec.decode(msg.data))); }
          catch { return; } // a malformed body on our nonce is not a usable answer; wait for a valid one
          if (reply.id !== requestId) return;
          resolve({ body: reply as unknown as Record<string, unknown>, responder: { instanceId: parsed.instanceId, epoch: parsed.epoch } });
        },
      });
      const request = enc.encode(JSON.stringify(env));
      nc.publish(subject, request);
      // The first publish may precede the responder's subscription during startup. Re-publish the
      // SAME read-only describe under the SAME request binding until one answer wins or the original
      // deadline expires; this neither extends the budget nor retries the command being resolved.
      // `publish` throws synchronously after close/drain. A timer throw escapes the caller's promise
      // and crashes the process, so make transport loss settle this describe instead.
      retryTimer = setInterval(() => {
        try { nc.publish(subject, request); }
        catch (e) {
          reject(new EpEnvelopeError("unavailable", `the describe retry for ${endpoint} could not publish: ${caughtText(e, "unknown publish failure")}`));
        }
      }, DESCRIBE_RETRY_MS);
    });
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(unanswered(deadlineMs)), deadlineMs); });
    const { body: reply, responder } = await Promise.race([got, timeout, denialWatch.denied, cancelled]);
    if (reply.ok !== true) {
      // A responder ANSWERED with a refusal: it is rethrown under the responder's own code (which
      // may be `unavailable`) and deliberately without the EP_UNANSWERED marker the deadline above
      // carries, so a consumer keyed on that marker never reads an answering responder as absent.
      const e = reply.error as { code?: string; message?: string } | undefined;
      throw new EpEnvelopeError((e?.code as never) ?? "unavailable", `describe(${endpoint}) failed: ${e?.message ?? "unknown"}`);
    }
    return { answer: reply.data as unknown as DescribeAnswer, responder };
  } finally {
    sub?.unsubscribe();
    if (timer !== undefined) clearTimeout(timer);
    if (retryTimer !== undefined) clearInterval(retryTimer);
    if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
    // Release on EVERY exit, success included. See {@link openPublishDenialWatch}.
    denialWatch?.release();
  }
}

/** The describe answer shape a caller reads (a subset — the fields the resolver needs). */
interface DescribeAnswer {
  public: boolean;
  descriptor: { endpoint: string; owner: string; clusters: { digest: string; commands: string[] }[] };
}

/** How many times a call is re-issued after a `not-executed` bind refusal. Every
 *  re-issue is a first attempt, so this is a loop guard and not a duplication guard. Each attempt
 *  splits with probability (m-1)/m in a space of m managers, so seventeen attempts leave a
 *  three-manager space about 1 in 1000 where the unrepaired call failed 2 in 3 (#398). An attempt
 *  costs an answered describe and invoke, never an elapsed deadline. */
export const BIND_SPLIT_REISSUES = 16;

/**
 * INVOKE one named command on a resolved service: validate nothing here (the compiled input
 * contract in {@link epCall}'s request builder gates args before publish, and the responder's
 * digest-bound boundary re-validates), route on the `one` rail, return the attributed reply. A
 * command absent from the resolved surface is `not-found` (the caller cannot see it, or it does
 * not exist); a targeted command needs its `target`.
 *
 * Currency: `opts.currentEpoch` (e.g. the registry-read `serviceEpochReader`) when supplied;
 * otherwise the DESCRIBE-BOUND default - accept exactly the incarnation that answered this
 * service's resolve (its broker-authenticated `instanceId`+`epoch` off the describe reply
 * subject) and refuse `failed-precondition` when a DIFFERENT instance wins the `one` queue
 * (a superseded-or-split responder; re-resolve to adopt a legitimate successor). The bind needs
 * no registry read grant, and it is strictly stronger than no check: two live instances of a
 * single-instance endpoint can never both pass one resolved handle.
 */
export async function invokeCommand(
  nc: NatsConnection,
  space: string,
  service: ResolvedService,
  command: string,
  args: Record<string, unknown> | undefined,
  opts: {
    target?: EpVerbTarget;
    deadlineMs?: number;
    signal?: AbortSignal;
    currentEpoch?: (instanceId: string) => Promise<number> | number;
    /** A caller-pinned envelope id (see {@link EpVerbOp.id}): a goal-accepting command binds its
     *  goal under it, which is what lets a durable caller resubmit idempotently. */
    id?: string;
  },
): Promise<EpAttributedReply> {
  const resolved = service.commands.get(command);
  if (resolved === undefined)
    throw new EpEnvelopeError("not-found", `command "${command}" is not in ${service.endpoint}'s visible surface; describe lists ${[...service.commands.keys()].sort().join(", ") || "(none)"}`);
  if (resolved.targeted && opts.target === undefined)
    throw new EpEnvelopeError("bad-request", `command "${command}" is targeted (modes: ${resolved.modes.join(", ")}); an invoke needs its target`);
  if (!resolved.targeted && opts.target !== undefined)
    throw new EpEnvelopeError("bad-request", `command "${command}" is untargeted; an invoke must not carry a target`);
  const caller = service.caller;
  // "No args" marshals to the CONTRACT's canonical empty form: absent args ride as null on the
  // wire, so when this command's input rejects null but accepts the empty object (e.g. an
  // all-optional `{type:"object"}` input like despawn's), send `{}` — that IS the caller's
  // intent in that contract's vocabulary (a targeted CLI stop has nothing left after the alias
  // becomes the target block). Contract-derived, never a guess: an input that requires fields
  // accepts neither form and still refuses loud at the pre-publish validation below.
  let sendArgs = args;
  if (sendArgs === undefined && !resolved.contract.input.validate(null) && resolved.contract.input.validate({}))
    sendArgs = {};
  const describeBound = (instanceId: string): number => {
    if (instanceId !== service.responder.instanceId) {
      // The refusal is unchanged; what it SAYS is not. One message used to cover two situations
      // that call for opposite responses, and it described only the rarer one.
      //
      // PINNED: the caller named an instance and a different one answered. Genuinely wrong.
      //
      // UNPINNED: the caller addressed the CLASS. The describe and the invoke are two independent
      // trips through the same anycast queue, so in a multi-instance space they routinely land on
      // different instances and this fires on an ordinary, correct request - not on a supersession.
      // Calling that "superseded-or-split" sends the reader hunting a restart that never happened.
      // The old text's remedy is also not executable by the surfaces that print it most (`stop`,
      // `despawn` and `attach` have no adopt path and no pin), so it advised an action the caller
      // could not take. Say which case this is, and stop asserting a cause that is usually wrong.
      // The marker, not the prose, is what stops an automatic re-invoke: reaching here means a
      // responder ANSWERED (executed or refused; the reply does not say which), so a retry is a
      // second attempt that may duplicate an effect rather than a repair. Callers that recover
      // from `failed-precondition` by re-resolving must consult `respondedButUnbound`.
      // The remedy is stated in core vocabulary (address one instance), never as a CLI flag: core
      // cannot know whether its caller has one, and most `invokeService` callers (a connector's
      // tools, a manifest deploy) do not. The CLI names its own flag when it renders this.
      throw new EpEnvelopeError("failed-precondition", service.pinnedInstanceId !== undefined
        ? `the ${service.endpoint} instance ${instanceId} answered but this handle is PINNED to ${service.pinnedInstanceId}; a pinned call names its instance and never accepts another. ${instanceId} did receive and answer the request, so if "${command}" mutates, that effect may already have landed - verify before re-issuing (SPEC 13.2)`
        : `the ${service.endpoint} instance ${instanceId} won the class queue but this UNPINNED handle resolved against ${service.responder.instanceId}; the describe and the invoke are separate trips through the same queue, so in a multi-instance space this is an ordinary split and not necessarily a supersession - the handle cannot currently adopt a different winner. THIS SAYS NOTHING ABOUT WHETHER THE COMMAND RAN: ${instanceId} received the request and answered it, possibly after this error was raised. For a read that is harmless and re-issuing is safe; if "${command}" mutates, verify the outcome ('ps'/'inspect'/roster) before re-issuing, because a retry that assumes failure duplicates the effect. A call that addresses one instance does not split (SPEC 13.2)`,
        [{ kind: EP_UNBOUND_RESPONDER, endpoint: service.endpoint, command, answeredBy: instanceId, boundTo: service.responder.instanceId, pinned: service.pinnedInstanceId !== undefined }]);
    }
    return service.responder.epoch;
  };
  // `--on`: a PINNED service routes to its exact instance's `inst` rail (the same instance the
  // describe resolved to, at its resolved epoch), never the class `one` queue — so the command reaches
  // the addressed manager in a multi-manager space. Unpinned ⇒ class anycast `one` (unchanged). The
  // describeBound currency check still holds: an inst-routed reply carries that instance's id.
  const route = service.pinnedInstanceId !== undefined
    ? { mode: "inst" as const, instanceId: service.pinnedInstanceId, epoch: service.responder.epoch }
    : { mode: "one" as const };
  // The bind travels WITH the request, so the responder can refuse before running the command
  // rather than leaving `describeBound` to report the split afterwards. It is sent exactly when
  // this handle's own resolve is the currency reference — that is the caller saying "this
  // incarnation or none", and it is the same population the check below already refuses. A caller
  // that supplied its own `currentEpoch` is asking a REGISTRY whether the answerer is current, and
  // deliberately accepts any current member; binding it would refuse calls that succeed today.
  const bind = opts.currentEpoch === undefined
    ? { instanceId: service.pinnedInstanceId ?? service.responder.instanceId, epoch: service.responder.epoch }
    : undefined;
  return epCall(nc, space, route, {
    endpoint: service.endpoint, command, contract: resolved.contract, caller,
    ...(sendArgs !== undefined ? { args: sendArgs } : {}),
    ...(opts.target ? { target: opts.target } : {}),
    ...(bind !== undefined ? { bind } : {}),
    ...(opts.id !== undefined ? { id: opts.id } : {}),
  }, {
    deadlineMs: opts.deadlineMs ?? 10_000,
    signal: opts.signal,
    currentEpoch: opts.currentEpoch ?? describeBound,
    // What the currency hook returns decides how a stale-epoch refusal is worded and marked: the
    // describe-bound default is this handle's own bind (a responder ahead of it is a successor and
    // the handle is the stale side); a caller-supplied hook is a registry read by epCall's contract.
    currencyReference: opts.currentEpoch ? "registry" : "bind",
  });
}

/** The refusal a goal-following call meets on a handle whose endpoint serves no `goal-result`: an
 *  accepted goal could never be read back to its terminal (SPEC 13.6), so nothing is submitted.
 *  `undefined` when the handle can follow. */
export function goalFollowRefusal(service: ResolvedService): EpAttributedReply | undefined {
  if (service.commands.has("goal-result")) return undefined;
  return {
    reply: { v: 1, id: globalThis.crypto.randomUUID(), ok: false, error: {
      code: "failed-precondition", outcome: "not-executed",
      message: `endpoint "${service.endpoint}" does not support "goal-result"; upgrade manager to enable durable goal following (SPEC 13.6)`,
    } },
    responder: { endpoint: service.endpoint, instanceId: service.responder.instanceId, epoch: service.responder.epoch },
  };
}
