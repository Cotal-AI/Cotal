/**
 * The GENERIC caller path: describe an endpoint, fetch its
 * registered contracts from the §13.7 content store, recompile the digest-matching validators,
 * and invoke a named command — WITHOUT the caller compiling the endpoint's schemas ahead of time.
 * This is what a `cotal describe`/`cotal invoke` CLI and every migrated control consumer ride, so
 * a consumer no longer hand-imports the manager's contract module.
 *
 * The trust chain is the §13.7 one, end to end:
 *  - `describe` (the reserved, authorization-scoped command every endpoint serves) answers the
 *    caller's VISIBLE command set + the registered CLUSTER closure digests;
 *  - each cluster document is fetched from the store at its closure digest and VERIFIED
 *    (two-stage manifest→root, content-addressed) — the command's input/output CLOSURE digests
 *    come from those verified bytes, never a caller assertion;
 *  - each schema closure is fetched + PROFILE-recompiled; the recompiled contract's closureDigest
 *    MUST equal the registered digest (a store that served the wrong bytes fails here);
 *  - the invoke pins those digests, so the responder's digest-bound serve boundary honors exactly
 *    the schema the caller validated against.
 */
import type { NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { EpEnvelopeError, replyRefusedBeforeEffect, replyTargetUnmapped } from "./endpoint-envelope.js";
import { compileContract, type CompiledContract } from "./schema-profile.js";
import { parseGoalResultFact } from "./endpoint-action.js";
import { submitAndFollowGoalWith, type SubmitAndFollowGoalOptions } from "./endpoint-goal-follow.js";
import { contractStoreContext, fetchContractClosure, contractRefToHex, contractArtifactDigestHex, type ContractStoreContext, type ArtifactMemo } from "./endpoint-contract-store.js";
import { parseClusterDocument, type ClusterDocument } from "./endpoint-cluster.js";
import { epScatterService, type EpAttributedReply, type EpScatterResult, type EpInstanceLiveness } from "./endpoint-verbs.js";
import type { EpCaller } from "./endpoint-subjects.js";
import { BIND_SPLIT_REISSUES, type ResolvedCommand, type ResolvedService, dec, describeEndpoint, invokeCommand } from "./endpoint-caller.js";
export { BIND_SPLIT_REISSUES, describeEndpoint, goalFollowRefusal, invokeCommand } from "./endpoint-caller.js";
export type { ResolvedCommand, ResolvedService } from "./endpoint-caller.js";

/**
 * {@link invokeCommand} with a SPEC 13.2 bind refusal repaired rather than surfaced.
 *
 * An unpinned handle binds the instance that answered its describe, and the invoke is a second,
 * independent trip through the same class queue, so in a multi-instance space another member
 * routinely receives it and refuses before dispatching. That refusal states the command did not
 * run ({@link replyRefusedBeforeEffect}), so re-resolving and re-issuing is a first attempt and is
 * safe for any command, mutations included. A targeted call that reaches a member holding no
 * mapping for its target ({@link replyTargetUnmapped}) is re-issued the same way, because with an
 * instance-local resolver only the member hosting the target can serve it. The re-issue repeats
 * until a member serves the call or {@link BIND_SPLIT_REISSUES} runs out, and then the last refusal
 * surfaces unchanged, or the last no-mapping refusal when there was one.
 *
 * `reresolve` defaults to a fresh class resolve as the handle's caller; a caller that memoizes its
 * handle passes one that drops the memo first, so later calls do not start from the refused bind.
 * When it throws, the refusal surfaces, because it states that nothing ran, which the resolve
 * failure raised in its place would lose.
 *
 * A pinned handle is never repaired: it names its instance, so a refusal from it is that instance
 * answering about itself, and re-resolving on the class rail would reach another one.
 */
export async function invokeRepairingSplit(
  nc: NatsConnection,
  space: string,
  service: ResolvedService,
  command: string,
  args: Record<string, unknown> | undefined,
  opts: Parameters<typeof invokeCommand>[5],
  reresolve: () => Promise<ResolvedService> = () =>
    resolveService(nc, space, service.endpoint, service.caller, { deadlineMs: opts.deadlineMs ?? 10_000, ...(opts.signal ? { signal: opts.signal } : {}) }),
): Promise<EpAttributedReply> {
  let handle = service;
  // A member that looked the target up and found no mapping says more about it than a bind refusal,
  // which says nothing, so a call that runs out of re-issues surfaces the latest such refusal.
  let unmapped: EpAttributedReply | undefined;
  for (let reissues = 0; ; reissues += 1) {
    const r = await invokeCommand(nc, space, handle, command, args, opts);
    if (replyTargetUnmapped(r.reply.error)) unmapped = r;
    else if (r.reply.ok !== false || !replyRefusedBeforeEffect(r.reply.error)) return r;
    if (handle.pinnedInstanceId !== undefined) return r;
    if (reissues === BIND_SPLIT_REISSUES) return unmapped ?? r;
    try {
      handle = await reresolve();
    } catch {
      return unmapped ?? r;
    }
  }
}

/** The options one {@link resolveService} closure walk runs under: the resolve's shared artifact
 *  memo, what remains of its deadline, and its abort signal. */
interface ClosureWalk { artifactMemo: ArtifactMemo; walkBudgetMs: number; signal?: AbortSignal }

/** Fetch + verify ONE cluster document from the store at its closure digest (two-stage §13.7:
 *  the manifest at the closure digest, whose `root` names the document artifact). A cluster
 *  document declares no by-digest child references, so its closure is {root}. */
async function fetchClusterDocument(store: ContractStoreContext, closureDigest: string, walk: ClosureWalk): Promise<ClusterDocument> {
  const { manifest, artifacts } = await fetchContractClosure(store, closureDigest, () => [], walk);
  const rootBytes = artifacts.get(contractRefToHex(manifest.root));
  if (rootBytes === undefined)
    throw new EpEnvelopeError("failed-precondition", `the cluster manifest ${closureDigest} names root ${manifest.root} but the root artifact is absent from the fetched closure (SPEC 13.7)`);
  return parseClusterDocument(JSON.parse(dec.decode(rootBytes)));
}

/** Fetch a schema CLOSURE from the store and PROFILE-recompile it, binding every by-digest member.
 *  The recompiled contract's closureDigest MUST equal the digest we fetched at — a store that
 *  served bytes hashing to a different closure is a tamper/bug and fails loud (§13.7). */
async function recompileClosure(store: ContractStoreContext, closureDigest: string, walk: ClosureWalk): Promise<CompiledContract> {
  // Walk the schema closure, resolving `cotal:sha256:<hex>` refs a document makes (the profile's
  // reference form) so a multi-document schema bundle rebuilds. A recompiled contract carries the
  // registered digest, so an equality check below is the tamper boundary.
  const { manifest, artifacts } = await fetchContractClosure(store, closureDigest, (bytes) => extractSchemaRefs(bytes), walk);
  const members: Record<string, unknown> = {};
  for (const [hex, bytes] of artifacts) members[`sha256:${hex}`] = JSON.parse(dec.decode(bytes));
  const rootRef = manifest.root;
  const root = members[rootRef];
  if (root === undefined)
    throw new EpEnvelopeError("failed-precondition", `schema closure ${closureDigest} is missing its root ${rootRef} (SPEC 13.7)`);
  // The bundle members are the NON-root artifacts, keyed by their `sha256:` ref (the profile's
  // resolution form); the root is passed separately.
  const bundleMembers: Record<string, unknown> = {};
  for (const [ref, value] of Object.entries(members)) if (ref !== rootRef) bundleMembers[ref] = value;
  const compiled = compileContract({ root, members: bundleMembers });
  if (compiled.closureDigest !== closureDigest)
    throw new EpEnvelopeError("internal", `the recompiled schema closure hashes to ${compiled.closureDigest}, not the fetched ${closureDigest}; a store that served the wrong bytes never authorizes (SPEC 13.7)`);
  return compiled;
}

/** Fetch and recompile ONE schema closure at its registered digest, outside a describe. The same
 *  digest-equality tamper boundary applies: a store that served other bytes never compiles. Used
 *  by a caller that has to prove which contract a pinned instance serves before acting. */
export async function recompileContractClosure(store: ContractStoreContext, closureDigest: string, opts: { walkBudgetMs?: number; signal?: AbortSignal } = {}): Promise<CompiledContract> {
  return recompileClosure(store, closureDigest, { artifactMemo: new Map(), walkBudgetMs: opts.walkBudgetMs ?? 10_000, ...(opts.signal ? { signal: opts.signal } : {}) });
}

/** The by-digest references a stored schema artifact makes: every string value anywhere in the
 *  document of the profile's `cotal:sha256:<hex>` `$ref` form, returned as bare `sha256:<hex>`
 *  refs for the closure walk. A schema with no refs (the common case) returns none. */
function extractSchemaRefs(bytes: Uint8Array): string[] {
  const refs: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      const m = /^cotal:(sha256:[0-9a-f]{64})$/.exec(v);
      if (m) refs.push(m[1]);
    } else if (Array.isArray(v)) {
      for (const c of v) walk(c);
    } else if (v !== null && typeof v === "object") {
      for (const c of Object.values(v)) walk(c);
    }
  };
  walk(JSON.parse(dec.decode(bytes)));
  return refs;
}

/** The most store reads one {@link resolveService} keeps in flight at once. The fan-out width is
 *  the RESPONDER's command count (it comes off the describe answer), so leaving it unbounded would
 *  let a describing endpoint decide how many concurrent requests its caller opens — a caller-side
 *  amplification the rest of §13.7 is careful to bound. Every other limit on this path is explicit;
 *  so is this one. High enough that real surfaces overlap freely, low enough to stay a bound. */
const RESOLVE_MAX_INFLIGHT_READS = 32;

/** Run `work` over `items` with at most `limit` in flight, preserving RESULT ORDER (the resolved
 *  surface must not depend on read timing). Rejects like `Promise.all`: the first failure wins,
 *  and no item starts after it. */
async function pooled<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await work(items[i]);
      } catch (e) {
        // This failure rejects the pool, so a later item would spend store reads on a result
        // nobody reads. Items already in flight finish on their own.
        next = items.length;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}


/**
 * DESCRIBE an endpoint and resolve its full invocation surface: send the reserved `describe`
 * command (untargeted, void args), then for every VISIBLE cluster fetch + verify its document
 * from the store and recompile each command's input/output contracts. The result lets a caller
 * invoke any visible command by name with no compile-time knowledge of the endpoint's schemas.
 *
 * `describe` itself pins no contract (§13.7), so it is issued as a raw void-arg request
 * ({@link describeEndpoint}), never through the digest-stamping {@link epCall}.
 */
export async function resolveService(
  nc: NatsConnection,
  space: string,
  endpoint: string,
  caller: EpCaller,
  opts: { deadlineMs?: number; instanceId?: string; signal?: AbortSignal } = {},
): Promise<ResolvedService> {
  // `deadlineMs` bounds the WHOLE resolve: the describe spends from it, and each closure walk is
  // budgeted with what remains, so a slow store read fails the resolve at the caller's deadline.
  const startedAt = performance.now();
  const deadlineMs = opts.deadlineMs ?? 10_000;
  const { answer, responder } = await describeEndpoint(nc, space, endpoint, caller, { ...opts, deadlineMs });
  const store = await contractStoreContext(nc, space);
  const visible = new Set<string>(answer.descriptor.clusters.flatMap((cl) => cl.commands));
  // The store reads dominate a resolve's wall time and are all caller->broker round-trips, so they
  // are issued CONCURRENTLY and deduped through one memo rather than queued one behind another (a
  // 17-command surface measured 70 strictly sequential reads, 22 of them re-reads; at a WAN RTT
  // that is the whole latency). Each closure walk is still internally sequential and its §13.7
  // bounds are still counted per walk — the concurrency is BETWEEN walks, so no limit is widened.
  const artifactMemo: ArtifactMemo = new Map();
  const walk = (): ClosureWalk => {
    const walkBudgetMs = Math.floor(deadlineMs - (performance.now() - startedAt));
    if (walkBudgetMs <= 0)
      throw new EpEnvelopeError("deadline-exceeded", `resolving ${endpoint} exhausted its ${deadlineMs}ms deadline before a contract-store read`);
    return { artifactMemo, walkBudgetMs, ...(opts.signal ? { signal: opts.signal } : {}) };
  };
  const docs = await pooled(answer.descriptor.clusters, RESOLVE_MAX_INFLIGHT_READS, (cl) => {
    opts.signal?.throwIfAborted();
    return fetchClusterDocument(store, cl.digest, walk());
  });
  // Flattened in DOCUMENT ORDER first, then resolved concurrently and inserted in that same order:
  // when two clusters declare one command name, last-in-document-order still wins, exactly as the
  // sequential form did. Concurrency must not make the resolved surface depend on read timing.
  const declared = docs.flatMap((doc) => doc.commands).filter((cmd) => visible.has(cmd.name)); // a describe VIEW may narrow a cluster's commands
  // Each command needs two closures, so the pool runs at half the read bound to keep the in-flight
  // read count under it.
  const resolved = await pooled(declared, Math.max(1, RESOLVE_MAX_INFLIGHT_READS >> 1), async (cmd): Promise<ResolvedCommand> => {
    opts.signal?.throwIfAborted();
    // Each command recompiles its OWN validators (cheap, CPU-only) even when two commands share a
    // closure digest: a compiled contract is not shared, only the artifact bytes behind it are.
    const [input, output] = await Promise.all([
      recompileClosure(store, cmd.inputDigest, walk()),
      recompileClosure(store, cmd.outputDigest, walk()),
    ]);
    return {
      command: cmd.name,
      contract: { input, output },
      class: cmd.class,
      targeted: cmd.targeted,
      modes: cmd.modes ?? [],
      capability: cmd.capability,
      ...(cmd.action ? { action: true as const } : {}),
    };
  });
  opts.signal?.throwIfAborted();
  const commands = new Map<string, ResolvedCommand>();
  for (const rc of resolved) commands.set(rc.command, rc);
  return { endpoint: answer.descriptor.endpoint, owner: answer.descriptor.owner, caller, responder, commands, ...(opts.instanceId !== undefined ? { pinnedInstanceId: opts.instanceId } : {}) };
}

export type { SubmitAndFollowGoalOptions } from "./endpoint-goal-follow.js";

/** {@link submitAndFollowGoalWith} with the root's synchronous fact verifier. */
export function submitAndFollowGoal(
  nc: NatsConnection,
  space: string,
  endpoint: string,
  caller: EpCaller,
  deadlineMs: number,
  submit: (signal?: AbortSignal) => Promise<EpAttributedReply>,
  opts?: SubmitAndFollowGoalOptions,
): Promise<EpAttributedReply> {
  return submitAndFollowGoalWith(parseGoalResultFact, nc, space, endpoint, caller, deadlineMs, submit, opts);
}

/**
 * SCATTER one untargeted command to the LIVE class (§13.5): resolve the command's contract off the
 * same digest-verified surface {@link invokeCommand} uses, then run the registry-wired scatter —
 * freeze the expected set from the records registry, publish ONCE on the `all` rail, gather one
 * attributed reply per instance, and reconcile registration currency post-classification. The
 * returned `replies` map is keyed by instanceId (per-instance attribution, SPEC §13.5); a frozen
 * instance that produced no on-time reply is a `missing` slot — reported UNREACHABLE, never silently
 * omitted. The caller's connection carries the §13.9 records-read grant the freeze/reconcile ride (a
 * scoped read of the endpoint's `svc` registry); `jsm`/`kv` are opened over it here.
 *
 * A scatter addresses EVERY instance, so a targeted command is refused (a per-instance target is
 * incoherent with the `all` rail) and a handle PINNED to one instance is refused (a pin is the
 * anti-scatter — use {@link invokeCommand} for `--on`). "No args" marshals to the contract's
 * canonical empty form exactly as {@link invokeCommand}.
 */
export async function scatterCommand(
  nc: NatsConnection,
  space: string,
  service: ResolvedService,
  command: string,
  args: Record<string, unknown> | undefined,
  opts: {
    deadlineMs: number; reconcileDeadlineMs?: number; lateDrainMs?: number;
    /** Forwarded verbatim to {@link epScatterService} (§13.5 liveness). The caller owns it because
     *  the caller owns the grant: a probe publishes on an instance rail, and only the credential's
     *  minter knows which instance rails it carries. */
    probeLiveness?: (instanceId: string) => Promise<EpInstanceLiveness>;
  },
): Promise<EpScatterResult> {
  const resolved = service.commands.get(command);
  if (resolved === undefined)
    throw new EpEnvelopeError("not-found", `command "${command}" is not in ${service.endpoint}'s visible surface; describe lists ${[...service.commands.keys()].sort().join(", ") || "(none)"}`);
  if (resolved.targeted)
    throw new EpEnvelopeError("bad-request", `command "${command}" is targeted; a class scatter addresses every instance and cannot carry a per-instance target (SPEC 13.5)`);
  if (service.pinnedInstanceId !== undefined)
    throw new EpEnvelopeError("bad-request", `a class scatter cannot run on a handle pinned to instance ${service.pinnedInstanceId}; resolve the service unpinned (a pin is the anti-scatter, SPEC 13.5)`);
  const caller = service.caller;
  // Same contract-canonical empty-args marshaling as invokeCommand: absent args ride as {} when the
  // command's input rejects null but accepts the empty object (e.g. an all-optional object input).
  let sendArgs = args;
  if (sendArgs === undefined && !resolved.contract.input.validate(null) && resolved.contract.input.validate({}))
    sendArgs = {};
  // `checkAPI: false` so the caller needs NO account `$JS.API.INFO` grant: the freeze's reads are
  // the scoped records-registry rows (`STREAM.INFO` + leader `STREAM.MSG.GET`), never an account
  // probe. The scatter's grant stays exactly the §13.9 records read. No KV handle is opened — the
  // freeze derives the bucket name and reads via jsm only.
  const jsm = await jetstreamManager(nc, { checkAPI: false });
  return epScatterService(nc, jsm, space, {
    endpoint: service.endpoint, command, contract: resolved.contract, caller,
    ...(sendArgs !== undefined ? { args: sendArgs } : {}),
  }, opts);
}

/** A digest reference's bare hex, exported so a CLI can print the resolved surface's digests. */
export function contractDigestHexOf(value: unknown): string {
  return contractArtifactDigestHex(new TextEncoder().encode(JSON.stringify(value)));
}
