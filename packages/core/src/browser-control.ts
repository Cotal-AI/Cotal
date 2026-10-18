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
 */
import type { NatsConnection } from "@nats-io/nats-core";
import { describeEndpoint, invokeCommand, type ResolvedCommand, type ResolvedService } from "./endpoint-caller.js";
import type { EpAttributedReply, EpVerbTarget } from "./endpoint-call.js";
import { EpEnvelopeError, replyRefusedBeforeEffect } from "./endpoint-error.js";
import type { EpCaller } from "./endpoint-subjects.js";
import type { CompiledContract } from "./schema-profile.js";

// The stock classifiers, from THIS entry's own module instance: a host that imported them from the
// package root would hold a second EpEnvelopeError class, and `instanceof` would miss every error.
export { EpEnvelopeError, unansweredRequest, replyRefusedBeforeEffect } from "./endpoint-error.js";

/** One validator emitted by the build-time generator (Ajv standalone, the §13.7 profile options). */
export type BrowserValidator = ((data: unknown) => boolean) & { errors?: Array<{ instancePath?: string; message?: string }> | null };

/** One cluster document the generator verified against its recorded digest. */
export interface BrowserCluster {
  readonly urn: string;
  readonly revision: number;
  readonly commands: ReadonlyArray<{ name: string; class: string; targeted: boolean; modes?: readonly string[]; capability: string; inputDigest: string; outputDigest: string }>;
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
      } as ResolvedCommand);
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
