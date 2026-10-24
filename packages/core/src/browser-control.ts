/**
 * The browser control entry (`@cotal-ai/core/browser-control`): describe and invoke ANY endpoint from
 * a strict-CSP page, with no Node built-in and no runtime code generation.
 *
 * The package root compiles a described service's §13.7 schema closures with Ajv at runtime, which a
 * `script-src 'self'` page forbids. Here the HOST supplies the validators instead, generated at its
 * own build time by `@cotal-ai/core/browser-validators-build` for the endpoint contracts it calls.
 * A closure digest is the closure's identity, so the generated validator for a digest IS that
 * closure's validator. A cluster or closure the host did not generate refuses as
 * `unsupported-version` before any command is sent: never compiled, guessed or skipped. The read-only
 * `describe` that names those digests has already run; no command, and so no mutation, follows it.
 *
 * Authority stays the host's: it passes its own connection (`wsconnect`, its current credentials)
 * and the caller it was issued. This entry mints, persists and selects nothing, and never retries.
 *
 * `openBrowserManagerCaller` builds that connection for one selected Manager instance from the
 * signed-in person's `manager-caller` bearer, and adds the stock goal follow and the `goal-result`
 * read back, so an accepted goal is followed and reconciled and never submitted again.
 */
import { credsAuthenticator, tokenAuthenticator, wsconnect, type NatsConnection } from "@nats-io/nats-core";
import { describeEndpoint, goalFollowRefusal, invokeCommand, type ResolvedCommand, type ResolvedService } from "./endpoint-caller.js";
import type { EpAttributedReply, EpVerbTarget } from "./endpoint-call.js";
import { EpEnvelopeError, replyRefusedBeforeEffect } from "./endpoint-error.js";
import type { EpCaller } from "./endpoint-subjects.js";
import type { CompiledContract } from "./schema-profile.js";
import type { GoalRef, GoalResultFact } from "./endpoint-action.js";
import { submitAndFollowGoalWith } from "./endpoint-goal-follow.js";
import { assertGoalResultFactShape, goalOutcomeDigestMismatch } from "./goal-result-fact.js";
import { DIGEST_PREFIX, canonicalJson } from "./canonical-json.js";
import { issuedCallerOfToken } from "./issued-accepted.js";
import { managerCallerBinding } from "./manager-caller.js";

// The stock classifiers, from THIS entry's own module instance: a host that imported them from the
// package root would hold a second EpEnvelopeError class, and `instanceof` would miss every error.
export { EpEnvelopeError, unansweredRequest, replyRefusedBeforeEffect } from "./endpoint-error.js";

/** One validator emitted by the build-time generator (Ajv standalone, the §13.7 profile options). */
export type BrowserValidator = ((data: unknown) => boolean) & { errors?: Array<{ instancePath?: string; message?: string }> | null };

/** One cluster document the generator verified against its recorded digest. */
export interface BrowserCluster {
  readonly urn: string;
  readonly revision: number;
  readonly commands: ReadonlyArray<{ name: string; class: string; targeted: boolean; modes?: readonly string[]; capability: string; inputDigest: string; outputDigest: string; action?: true }>;
}

/** The generated module's export: validators by closure digest, cluster documents by cluster digest. */
export interface BrowserContractSet {
  readonly validators: Readonly<Record<string, BrowserValidator>>;
  readonly clusters: Readonly<Record<string, BrowserCluster>>;
}

export interface BrowserEndpointCallerOptions {
  /** The host's own connection, opened with its current credentials. */
  nc: NatsConnection;
  space: string;
  endpoint: string;
  /** The caller the host was issued for this connection. */
  caller: EpCaller;
  /** The instance the host selected. Required: there is no implicit selection. */
  instanceId: string;
  contracts: BrowserContractSet;
  deadlineMs?: number;
  signal?: AbortSignal;
}

export interface BrowserInvokeOptions {
  target?: EpVerbTarget;
  deadlineMs?: number;
  signal?: AbortSignal;
  /** Caller-pinned envelope id; persist it before sending so a reload can reconcile, not resend. */
  id?: string;
}

/**
 * What one invoke established. `replied` means the pinned responder answered ok; it is not a
 * completed domain goal. `refused-before-effect` is a refusal the stock envelope proves ran nothing.
 * `error-reply` is any other error reply. A request that got no answer throws the stock unanswered
 * error (`unansweredRequest`): its effect is unknown and this entry never repeats it.
 */
export type BrowserInvokeOutcome = "replied" | "refused-before-effect" | "error-reply";

export interface BrowserEndpointCaller {
  readonly instanceId: string;
  readonly caller: EpCaller;
  /** The described surface with host contracts, pinned to `instanceId` and its describe epoch. */
  readonly service: ResolvedService;
  invoke(command: string, args?: Record<string, unknown>, opts?: BrowserInvokeOptions): Promise<EpAttributedReply & { outcome: BrowserInvokeOutcome }>;
}

/** The host validator for one closure digest, or `unsupported-version` when the host has none. */
function contractOf(set: BrowserContractSet, closureDigest: string): CompiledContract {
  const validate = Object.hasOwn(set.validators, closureDigest) ? set.validators[closureDigest] : undefined;
  if (typeof validate !== "function")
    throw new EpEnvelopeError("unsupported-version", `schema closure ${closureDigest} has no host-generated validator; regenerate the host's contracts for this endpoint (SPEC 13.7)`);
  return { validate, closureDigest } as unknown as CompiledContract;
}

/**
 * The invocable surface of a described service from host contracts only, assembled as the root's
 * `resolveService` assembles it from the store: clusters in descriptor order, commands narrowed to
 * those the describe view lists, a later cluster's command replacing an earlier one of the same
 * name. Any cluster or closure the host did not generate refuses the WHOLE surface.
 */
export function browserServiceSurface(descriptor: { clusters: ReadonlyArray<{ digest: string; commands: readonly string[] }> }, set: BrowserContractSet): Map<string, ResolvedCommand> {
  const visible = new Set(descriptor.clusters.flatMap((cl) => cl.commands));
  const surface = new Map<string, ResolvedCommand>();
  for (const cl of descriptor.clusters) {
    const doc = Object.hasOwn(set.clusters, cl.digest) ? set.clusters[cl.digest] : undefined;
    if (!doc) throw new EpEnvelopeError("unsupported-version", `cluster document ${cl.digest} has no host-generated contracts; regenerate the host's contracts for this endpoint (SPEC 13.7)`);
    for (const cmd of doc.commands) {
      if (!visible.has(cmd.name)) continue;
      surface.set(cmd.name, {
        command: cmd.name,
        contract: { input: contractOf(set, cmd.inputDigest), output: contractOf(set, cmd.outputDigest) },
        class: cmd.class, targeted: cmd.targeted, modes: [...(cmd.modes ?? [])], capability: cmd.capability,
        ...(cmd.action ? { action: true as const } : {}),
      });
    }
  }
  return surface;
}

/** Describe the endpoint on the selected instance and return a caller bound to that answer. */
export async function openBrowserEndpointCaller(opts: BrowserEndpointCallerOptions): Promise<BrowserEndpointCaller> {
  opts.signal?.throwIfAborted();
  const deadlineMs = opts.deadlineMs ?? 10_000;
  const { answer, responder } = await describeEndpoint(opts.nc, opts.space, opts.endpoint, opts.caller, {
    instanceId: opts.instanceId, deadlineMs, ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (responder.instanceId !== opts.instanceId)
    throw new EpEnvelopeError("failed-precondition", `instance ${responder.instanceId} answered a describe pinned to ${opts.instanceId}; refused`);
  const service: ResolvedService = {
    endpoint: answer.descriptor.endpoint, owner: answer.descriptor.owner, caller: opts.caller, responder,
    commands: browserServiceSurface(answer.descriptor, opts.contracts), pinnedInstanceId: opts.instanceId,
  };
  return {
    instanceId: opts.instanceId,
    caller: opts.caller,
    service,
    async invoke(command, args, o = {}) {
      const result = await invokeCommand(opts.nc, opts.space, service, command, args, {
        ...(o.target ? { target: o.target } : {}), deadlineMs: o.deadlineMs ?? deadlineMs,
        ...(o.signal ? { signal: o.signal } : {}), ...(o.id !== undefined ? { id: o.id } : {}),
      });
      const outcome: BrowserInvokeOutcome = result.reply.ok !== false ? "replied"
        : replyRefusedBeforeEffect(result.reply.error) ? "refused-before-effect" : "error-reply";
      return { ...result, outcome };
    },
  };
}

/** The stock Manager endpoint (`BASELINE_LIFECYCLE_ENDPOINT`). */
const MANAGER_ENDPOINT = "manager";

/** The signed-in person's authority for one connection. */
export interface BrowserManagerAuthority {
  /** Their `manager-caller` bearer, issued for the selected instance (SPEC 10). */
  bearer: string;
  /** The space's sentinel credential, which lands the connection in the callout account. */
  sentinelCreds: string;
}

export interface BrowserManagerCallerOptions {
  /** WebSocket URL(s) of the space's broker. */
  servers: string | string[];
  space: string;
  /** The principal and interactive lifecycle the issuer bound the bearer to. */
  owner: string;
  actor: string;
  lifecycleUid: string;
  /** The Manager instance the person selected. Required: there is no implicit selection. */
  instanceId: string;
  /** Returns fresh authority. Called on open and on every `reopen`. */
  acquire: (signal?: AbortSignal) => Promise<BrowserManagerAuthority>;
  /** The Manager's contracts, generated at the host's build from `managerBrowserContractSource()`. */
  contracts: BrowserContractSet;
  deadlineMs?: number;
  signal?: AbortSignal;
}

export interface BrowserManagerCaller extends BrowserEndpointCaller {
  /** Submit once under the caller's persisted envelope id and follow the goal to its terminal (the
   *  stock goal follow). A goal still open at the deadline answers `deadline-exceeded` with outcome
   *  `unknown`, and is read back with `reconcileGoal`, never submitted again. Refuses before sending when the
   *  Manager serves no `goal-result`, because an accepted goal could never be read back. */
  followGoal(command: string, args: Record<string, unknown> | undefined, opts: BrowserInvokeOptions & { id: string }): Promise<EpAttributedReply>;
  /** Read an accepted goal's recorded terminal through the stock `goal-result` command. */
  reconcileGoal(goalId: string, opts?: { deadlineMs?: number; signal?: AbortSignal }): Promise<EpAttributedReply & { outcome: BrowserInvokeOutcome }>;
  /** Close this connection and open a new one through `acquire`, re-checking every pin. */
  reopen(signal?: AbortSignal): Promise<BrowserManagerCaller>;
  close(): Promise<void>;
}

const hex = (bytes: ArrayBuffer): string => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
const sha256Hex = async (text: string): Promise<string> => hex(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

/** `parseGoalResultFact` with Web Crypto: the same shape checks and the same outcome digest. */
export async function verifyGoalResultFact(raw: unknown, subject: string, ref: GoalRef): Promise<GoalResultFact> {
  const o = assertGoalResultFactShape(raw, subject, ref);
  if (DIGEST_PREFIX + await sha256Hex(canonicalJson(o.data === undefined ? null : o.data)) !== o.outcomeDigest) throw goalOutcomeDigestMismatch(subject);
  return o as unknown as GoalResultFact;
}

/** Open a caller for one explicitly selected Manager instance. */
export async function openBrowserManagerCaller(opts: BrowserManagerCallerOptions): Promise<BrowserManagerCaller> {
  opts.signal?.throwIfAborted();
  const deadlineMs = opts.deadlineMs ?? 10_000;
  const authority = await opts.acquire(opts.signal);
  // The bearer must name this space, principal, lifecycle and instance before anything is dialled.
  const bound = managerCallerBinding(authority.bearer, {
    space: opts.space, owner: opts.owner, actor: opts.actor, lifecycleUid: opts.lifecycleUid, instanceId: opts.instanceId,
  });
  // The user-mode connect of `standaloneConnectOpts`: a fresh nonce names the connection and its inbox.
  const connId = `ibx${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
  const nc = await wsconnect({
    servers: opts.servers,
    name: connId,
    inboxPrefix: `_INBOX_${connId}`,
    authenticator: [credsAuthenticator(new TextEncoder().encode(authority.sentinelCreds)), tokenAuthenticator(authority.bearer)],
    maxReconnectAttempts: 0,
    timeout: Math.min(deadlineMs, 5_000),
  });
  try {
    opts.signal?.throwIfAborted();
    // The person's manager view is issued at the callout (SPEC 13.15): read its generation back from
    // this connection's accepted row. A missing row refuses; there is no legacy-rail retry.
    const caller = await issuedCallerOfToken(nc, opts.space, (await sha256Hex(`cotal.accepted.v1\0${connId}`)).slice(0, 32), bound.caller);
    const endpointCaller = await openBrowserEndpointCaller({
      nc, space: opts.space, endpoint: MANAGER_ENDPOINT, caller, instanceId: bound.instanceId, contracts: opts.contracts, deadlineMs,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const reconcileGoal: BrowserManagerCaller["reconcileGoal"] = (goalId, o = {}) =>
      endpointCaller.invoke("goal-result", { goalId }, { deadlineMs: o.deadlineMs ?? deadlineMs, ...(o.signal ? { signal: o.signal } : {}) });
    const handle: BrowserManagerCaller = {
      ...endpointCaller,
      async followGoal(command, args, o) {
        if (typeof o?.id !== "string" || o.id.length === 0)
          throw new EpEnvelopeError("bad-request", "followGoal needs the caller's persisted envelope id; a goal is never submitted under an id the caller cannot reconcile", undefined, "not-executed");
        const unfollowable = goalFollowRefusal(endpointCaller.service);
        if (unfollowable) return unfollowable;
        const followMs = o.deadlineMs ?? deadlineMs;
        return submitAndFollowGoalWith(verifyGoalResultFact, nc, opts.space, MANAGER_ENDPOINT, caller, followMs,
          (signal) => endpointCaller.invoke(command, args, { ...o, ...(signal ? { signal } : {}) }), {
            reconcile: async (goalId, _attributed, context) => {
              const q = await reconcileGoal(goalId, { deadlineMs: Math.min(followMs, context.deadlineMs), signal: context.signal });
              if (q.reply.ok !== true) throw new Error(q.reply.error?.message ?? "goal-result query refused");
              return q.reply.data as { goalId: string; result?: GoalResultFact } | undefined;
            },
            ...(o.signal ? { signal: o.signal } : {}),
          });
      },
      reconcileGoal,
      async reopen(signal) {
        await handle.close();
        return openBrowserManagerCaller({ ...opts, ...(signal ? { signal } : {}) });
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
