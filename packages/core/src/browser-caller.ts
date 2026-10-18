/**
 * A browser caller for ONE explicitly selected Manager instance (`@cotal-ai/core/browser`), composed
 * from the same caller path the CLI and connector ride: the `manager-caller` binding check, the
 * callout-shaped user-mode connect, the issued caller read (SPEC 13.15), `describeEndpoint` pinned to
 * the instance rail, and `invokeCommand`. Only the contract source differs: the surface comes from the
 * packaged, digest-keyed validators (`packagedServiceSurface`), never a runtime compile.
 *
 * Authority stays the signed-in person's own. `acquire` returns that person's stock-issued
 * `manager-caller` bearer for the named instance and the space's deny-all sentinel; this module holds
 * both in memory only, for one connection, and never stores, forwards or widens them. The connection
 * never reconnects: a lost or refreshed connection is reopened through `acquire`, and every reopen is
 * re-checked against the same space, principal, lifecycle and instance, so a refresh can never switch
 * account, principal, lifecycle or Manager.
 *
 * Commands are never repeated automatically, except the stock rule: a reply refused BEFORE effect is
 * re-resolved and invoked once more. An accepted or unknown goal is never resubmitted; the caller
 * persists the envelope id it submits under and reads the goal back with `reconcileGoal`.
 *
 * `followGoal` is the stock goal follow (`submitAndFollowGoalWith`, the same code the root's
 * `submitAndFollowGoal` runs): it subscribes to the caller's own progress subject before the single
 * submission and reconciles through `goal-result` on this connection. Only the fact's outcome digest
 * is computed differently, through Web Crypto. A follow lives as long as its page: after a reload the
 * page holds only what it persisted, and reads the goal back with `reconcileGoal`, never by submitting.
 */
import { credsAuthenticator, tokenAuthenticator, wsconnect, type NatsConnection } from "@nats-io/nats-core";
import { packagedValidatorFor, packagedServiceSurface } from "./browser.js";
import { describeEndpoint, goalFollowRefusal, invokeCommand, type ResolvedCommand, type ResolvedService } from "./endpoint-caller.js";
import type { GoalResultFact, GoalRef } from "./endpoint-action.js";
import { submitAndFollowGoalWith } from "./endpoint-goal-follow.js";
import { assertGoalResultFactShape, goalOutcomeDigestMismatch } from "./goal-result-fact.js";
import { DIGEST_PREFIX, canonicalJson } from "./canonical-json.js";
import type { EpAttributedReply, EpVerbTarget } from "./endpoint-call.js";
import { EpEnvelopeError, replyRefusedBeforeEffect } from "./endpoint-error.js";
import { isPermissionDenied } from "./permission-denied.js";
import { issuedCallerOfToken } from "./issued-accepted.js";
import { managerCallerBinding } from "./manager-caller.js";
import type { EpCaller } from "./endpoint-subjects.js";
import type { CompiledContract } from "./schema-profile.js";

/** The stock Manager endpoint name (`BASELINE_LIFECYCLE_ENDPOINT`). */
const MANAGER_ENDPOINT = "manager";

/** What `acquire` returns: the signed-in person's own authority for exactly one connection. */
export interface BrowserManagerAuthority {
  /** The stock `manager-caller` view, freshly issued for the selected instance. */
  bearer: string;
  /** The space's deny-all sentinel credential; it lands the connection in the callout account. */
  sentinelCreds: string;
}

export interface BrowserManagerCallerOptions {
  /** WebSocket URL(s) of the space's broker, `wss://` on a deployed origin. */
  servers: string | string[];
  space: string;
  /** The signed-in person's principal and interactive lifecycle, as the issuer bound them. */
  owner: string;
  actor: string;
  lifecycleUid: string;
  /** The Manager instance the person selected. Required: there is no implicit selection. */
  instanceId: string;
  /** Returns fresh authority for one connection. Called on open and on every `reopen`. */
  acquire: (signal?: AbortSignal) => Promise<BrowserManagerAuthority>;
  deadlineMs?: number;
}

export interface BrowserInvokeOptions {
  target?: EpVerbTarget;
  deadlineMs?: number;
  signal?: AbortSignal;
  /** Caller-pinned envelope id. A goal-accepting command binds its goal under it; persist it BEFORE
   *  submitting so a reload can reconcile instead of submitting again. */
  id?: string;
}

export interface BrowserManagerCaller {
  readonly instanceId: string;
  readonly caller: EpCaller;
  /** The described surface with packaged contracts, pinned to `instanceId` and its describe epoch. */
  readonly service: ResolvedService;
  /** One stock invoke. A before-effect refusal re-resolves and invokes once more; nothing else repeats. */
  invoke(command: string, args?: Record<string, unknown>, opts?: BrowserInvokeOptions): Promise<EpAttributedReply>;
  /** Submit a goal-accepting command under the caller's persisted envelope id. Refuses up front when
   *  the Manager serves no `goal-result`, because an accepted goal could never be read back. */
  submitGoal(command: string, args: Record<string, unknown> | undefined, opts: BrowserInvokeOptions & { id: string }): Promise<EpAttributedReply>;
  /** Submit once under the caller's persisted envelope id and follow the goal to its terminal (the
   *  stock goal follow). The deadline bounds the follow; an accepted goal that has not settled by then
   *  reports `uncertain` with its acceptance, and is read back with `reconcileGoal`, never resubmitted. */
  followGoal(command: string, args: Record<string, unknown> | undefined, opts: BrowserInvokeOptions & { id: string }): Promise<EpAttributedReply>;
  /** Read an accepted goal's recorded terminal through the stock `goal-result` command. */
  reconcileGoal(goalId: string, opts?: { deadlineMs?: number; signal?: AbortSignal }): Promise<EpAttributedReply>;
  /** Close this connection and open a new one through `acquire`, re-checking every pin. */
  reopen(signal?: AbortSignal): Promise<BrowserManagerCaller>;
  close(): Promise<void>;
}

const hex = (bytes: ArrayBuffer): string => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

/** `connectionAcceptedToken` with Web Crypto: the same SHA-256 over the same bytes, asynchronously. */
export async function acceptedTokenOf(connId: string): Promise<string> {
  return hex(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(`cotal.accepted.v1\0${connId}`))).slice(0, 32);
}

/** `parseGoalResultFact` with Web Crypto: the same shape checks and the same outcome digest, asynchronously. */
export async function verifyGoalResultFact(raw: unknown, subject: string, ref: GoalRef): Promise<GoalResultFact> {
  const o = assertGoalResultFactShape(raw, subject, ref);
  const bytes = new TextEncoder().encode(canonicalJson(o.data === undefined ? null : o.data));
  if (DIGEST_PREFIX + hex(await globalThis.crypto.subtle.digest("SHA-256", bytes)) !== o.outcomeDigest) throw goalOutcomeDigestMismatch(subject);
  return o as unknown as GoalResultFact;
}

const persistedId = (o: { id?: unknown } | undefined, verb: string): void => {
  if (typeof o?.id !== "string" || o.id.length === 0)
    throw new EpEnvelopeError("bad-request", `${verb} needs the caller's persisted envelope id; a goal is never submitted under an id the caller cannot reconcile`);
};

/** Packaged contracts in the shape `invokeCommand` reads: it calls `validate` and reads its `errors`. */
function contractOf(closureDigest: string): CompiledContract {
  return { validate: packagedValidatorFor(closureDigest), closureDigest } as unknown as CompiledContract;
}

async function resolvePinned(nc: NatsConnection, space: string, caller: EpCaller, instanceId: string, deadlineMs: number, signal?: AbortSignal): Promise<ResolvedService> {
  const { answer, responder } = await describeEndpoint(nc, space, MANAGER_ENDPOINT, caller, { instanceId, deadlineMs, ...(signal ? { signal } : {}) });
  if (responder.instanceId !== instanceId)
    throw new EpEnvelopeError("failed-precondition", `Manager instance ${responder.instanceId} answered a describe pinned to ${instanceId}; refused`);
  const commands = new Map<string, ResolvedCommand>();
  for (const [name, cmd] of packagedServiceSurface(answer.descriptor)) {
    commands.set(name, {
      command: name,
      contract: { input: contractOf(cmd.contract.input.closureDigest), output: contractOf(cmd.contract.output.closureDigest) },
      class: cmd.class, targeted: cmd.targeted, modes: cmd.modes, capability: cmd.capability,
    });
  }
  return { endpoint: answer.descriptor.endpoint, owner: answer.descriptor.owner, caller, responder, commands, pinnedInstanceId: instanceId };
}

/** The callout-shaped connect (`standaloneConnectOpts` user mode): the sentinel lands the connection
 *  in the callout account, the bearer rides `auth_token`, a fresh inbox nonce is the `name`, and the
 *  connection never reconnects. */
export async function dialCalloutConnection(servers: string | string[], authority: { bearer: string; sentinelCreds: string }, deadlineMs: number): Promise<{ nc: NatsConnection; connId: string }> {
  const connId = `ibx${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
  const nc = await wsconnect({
    servers,
    name: connId,
    inboxPrefix: `_INBOX_${connId}`,
    authenticator: [credsAuthenticator(new TextEncoder().encode(authority.sentinelCreds)), tokenAuthenticator(authority.bearer)],
    maxReconnectAttempts: 0,
    timeout: Math.min(deadlineMs, 5_000),
  });
  return { nc, connId };
}

/** Open a caller for one explicitly selected Manager instance. */
export async function openBrowserManagerCaller(opts: BrowserManagerCallerOptions, signal?: AbortSignal): Promise<BrowserManagerCaller> {
  signal?.throwIfAborted();
  const deadlineMs = opts.deadlineMs ?? 10_000;
  const authority = await opts.acquire(signal);
  // The issuer's binding must name this space, principal, lifecycle and instance (SPEC 10).
  const bound = managerCallerBinding(authority.bearer, {
    space: opts.space, owner: opts.owner, actor: opts.actor, lifecycleUid: opts.lifecycleUid, instanceId: opts.instanceId,
  });
  const { nc, connId } = await dialCalloutConnection(opts.servers, authority, deadlineMs);
  try {
    signal?.throwIfAborted();
    let caller: EpCaller = bound.caller;
    // Issued views carry their accepted-row read (SPEC 13.15); a view without that issuance stays on its
    // legacy rail, which the broker reports as a refused read. Any other failure refuses the open.
    try { caller = await issuedCallerOfToken(nc, opts.space, await acceptedTokenOf(connId), caller); }
    catch (e) { if (!isPermissionDenied(e)) throw e; }
    let service = await resolvePinned(nc, opts.space, caller, bound.instanceId, deadlineMs, signal);
    const invoke = async (command: string, args?: Record<string, unknown>, o: BrowserInvokeOptions = {}): Promise<EpAttributedReply> => {
      const io = { ...(o.target ? { target: o.target } : {}), deadlineMs: o.deadlineMs ?? deadlineMs, ...(o.signal ? { signal: o.signal } : {}), ...(o.id !== undefined ? { id: o.id } : {}) };
      const result = await invokeCommand(nc, opts.space, service, command, args, io);
      if (result.reply.ok !== false || !replyRefusedBeforeEffect(result.reply.error)) return result;
      // Stock rule (connector `invokeUserManager`): only a refusal before effect re-resolves, once.
      service = await resolvePinned(nc, opts.space, caller, bound.instanceId, deadlineMs, o.signal);
      return invokeCommand(nc, opts.space, service, command, args, io);
    };
    const handle: BrowserManagerCaller = {
      instanceId: bound.instanceId,
      caller,
      get service() { return service; },
      invoke,
      async submitGoal(command, args, o) {
        persistedId(o, "submitGoal");
        const unfollowable = goalFollowRefusal(service);
        if (unfollowable) return unfollowable;
        return invoke(command, args, o);
      },
      async followGoal(command, args, o) {
        persistedId(o, "followGoal");
        const unfollowable = goalFollowRefusal(service);
        if (unfollowable) return unfollowable;
        const followMs = o.deadlineMs ?? deadlineMs;
        return submitAndFollowGoalWith(verifyGoalResultFact, nc, opts.space, MANAGER_ENDPOINT, caller, followMs,
          (s) => invoke(command, args, { ...o, ...(s ? { signal: s } : {}) }), {
            // The stock reader (`Endpoint.followGoal`): `goal-result` through this caller's own route.
            reconcile: async (goalId, _attributed, context) => {
              const q = await invokeCommand(nc, opts.space, service, "goal-result", { goalId }, { deadlineMs: Math.min(followMs, context.deadlineMs), signal: context.signal });
              if (q.reply.ok !== true) throw new Error(q.reply.error?.message ?? "goal-result query refused");
              return q.reply.data as { goalId: string; result?: GoalResultFact } | undefined;
            },
            ...(o.signal ? { signal: o.signal } : {}),
          });
      },
      reconcileGoal(goalId, o = {}) {
        return invokeCommand(nc, opts.space, service, "goal-result", { goalId }, { deadlineMs: o.deadlineMs ?? deadlineMs, ...(o.signal ? { signal: o.signal } : {}) });
      },
      async reopen(s) {
        await handle.close();
        return openBrowserManagerCaller(opts, s);
      },
      async close() {
        if (!nc.isClosed()) await nc.close();
      },
    };
    return handle;
  } catch (e) {
    await nc.close();
    throw e;
  }
}
