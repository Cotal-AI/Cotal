/**
 * The GENERIC caller path (control-surface P2 item 1, item 5): describe an endpoint, fetch its
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
import { randomBytes } from "node:crypto";
import { PermissionViolationError, type NatsConnection, type Subscription } from "@nats-io/transport-node";
import { openPublishDenialWatch } from "./endpoint-publish-denial.js";
import { jetstreamManager } from "@nats-io/jetstream";
import { EpEnvelopeError, EP_UNBOUND_RESPONDER, EP_UNANSWERED, renderLifecycleBlocked, lifecycleBlockedFrom } from "./endpoint-envelope.js";
import { compileContract, type CompiledContract } from "./schema-profile.js";
import {
  parseGoalResultFact,
  type GoalResultFact,
  type GoalRef,
} from "./endpoint-action.js";
import {
  contractStoreContext, fetchContractClosure, contractRefToHex, contractArtifactDigestHex,
  type ContractStoreContext, type ArtifactMemo,
} from "./endpoint-contract-store.js";
import { parseClusterDocument, type ClusterDocument } from "./endpoint-cluster.js";
import { epCall, epScatterService } from "./endpoint-verbs.js";
import { epGoalProgressGrantRow } from "./endpoint-grants.js";
import { epRequestSubject, epCallerReplyFilter, epPlaneTokens, parseEpSubject, type EpCaller, type EpRoute } from "./endpoint-subjects.js";
import { parseEndpointReply } from "./endpoint-envelope.js";
import type { EpVerbTarget, EpAttributedReply, EpScatterResult, EpInstanceLiveness } from "./endpoint-verbs.js";

const dec = new TextDecoder(), enc = new TextEncoder();
const nonce = (): string => randomBytes(24).toString("base64url");
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
const GOAL_FOLLOW_MARGIN_MS = 10_000;

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
  /** Set when the service was resolved PINNED to one instance's `inst` route (P2 item 3 `--on`):
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
 * must not be able to fail an honest describe), and the wait continues to the deadline.
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
  // P2 item 3 `--on <instance>`: PIN the describe to one instance's `inst` route so a multi-manager
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
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(new EpEnvelopeError("unavailable", `describe(${endpoint}) observation cancelled`));
    opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    // REGISTER THE PERMISSION WATCH BEFORE THE PUBLISH IT IS WATCHING. See
    // {@link openPublishDenialWatch}: a refused publish is otherwise indistinguishable
    // from an unanswered describe.
    denialWatch = openPublishDenialWatch(nc, subject, () => new EpEnvelopeError("permission-denied",
      `the describe for ${endpoint} was REFUSED BY THE BROKER, not unanswered: this caller's credential does not authorize publishing to "${subject}"${opts.instanceId !== undefined ? ` (the instance rail for ${opts.instanceId}: an instance-addressed call needs a credential minted with that instance, not a class-rail one)` : ""}. The responder may be perfectly healthy; the grant is what is missing (SPEC 13.2)`), "describe");
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
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new EpEnvelopeError("deadline-exceeded", `no describe reply from ${endpoint}${opts.instanceId !== undefined ? ` instance ${opts.instanceId}` : ""} within ${deadlineMs}ms on the ${rail} rail`, [{ kind: EP_UNANSWERED, endpoint, command: "describe", rail }])), deadlineMs); });
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

/** Fetch + verify ONE cluster document from the store at its closure digest (two-stage §13.7:
 *  the manifest at the closure digest, whose `root` names the document artifact). A cluster
 *  document declares no by-digest child references, so its closure is {root}. */
async function fetchClusterDocument(store: ContractStoreContext, closureDigest: string, artifactMemo?: ArtifactMemo): Promise<ClusterDocument> {
  const { manifest, artifacts } = await fetchContractClosure(store, closureDigest, () => [], { ...(artifactMemo ? { artifactMemo } : {}) });
  const rootBytes = artifacts.get(contractRefToHex(manifest.root));
  if (rootBytes === undefined)
    throw new EpEnvelopeError("failed-precondition", `the cluster manifest ${closureDigest} names root ${manifest.root} but the root artifact is absent from the fetched closure (SPEC 13.7)`);
  return parseClusterDocument(JSON.parse(dec.decode(rootBytes)));
}

/** Fetch a schema CLOSURE from the store and PROFILE-recompile it, binding every by-digest member.
 *  The recompiled contract's closureDigest MUST equal the digest we fetched at — a store that
 *  served bytes hashing to a different closure is a tamper/bug and fails loud (§13.7). */
async function recompileClosure(store: ContractStoreContext, closureDigest: string, artifactMemo?: ArtifactMemo): Promise<CompiledContract> {
  // Walk the schema closure, resolving `cotal:sha256:<hex>` refs a document makes (the profile's
  // reference form) so a multi-document schema bundle rebuilds. A recompiled contract carries the
  // registered digest, so an equality check below is the tamper boundary.
  const { manifest, artifacts } = await fetchContractClosure(store, closureDigest, (bytes) => extractSchemaRefs(bytes), { ...(artifactMemo ? { artifactMemo } : {}) });
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
 *  surface must not depend on read timing). Rejects like `Promise.all`: the first failure wins. */
async function pooled<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await work(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The describe answer shape a caller reads (a subset — the fields the resolver needs). */
interface DescribeAnswer {
  public: boolean;
  descriptor: { endpoint: string; owner: string; clusters: { digest: string; commands: string[] }[] };
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
  const { answer, responder } = await describeEndpoint(nc, space, endpoint, caller, opts);
  const store = await contractStoreContext(nc, space);
  const visible = new Set<string>(answer.descriptor.clusters.flatMap((cl) => cl.commands));
  // The store reads dominate a resolve's wall time and are all caller->broker round-trips, so they
  // are issued CONCURRENTLY and deduped through one memo rather than queued one behind another (a
  // 17-command surface measured 70 strictly sequential reads, 22 of them re-reads; at a WAN RTT
  // that is the whole latency). Each closure walk is still internally sequential and its §13.7
  // bounds are still counted per walk — the concurrency is BETWEEN walks, so no limit is widened.
  const artifactMemo: ArtifactMemo = new Map();
  const docs = await pooled(answer.descriptor.clusters, RESOLVE_MAX_INFLIGHT_READS, (cl) => {
    opts.signal?.throwIfAborted();
    return fetchClusterDocument(store, cl.digest, artifactMemo);
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
      recompileClosure(store, cmd.inputDigest, artifactMemo),
      recompileClosure(store, cmd.outputDigest, artifactMemo),
    ]);
    return {
      command: cmd.name,
      contract: { input, output },
      class: cmd.class,
      targeted: cmd.targeted,
      modes: cmd.modes ?? [],
      capability: cmd.capability,
    };
  });
  opts.signal?.throwIfAborted();
  const commands = new Map<string, ResolvedCommand>();
  for (const rc of resolved) commands.set(rc.command, rc);
  return { endpoint: answer.descriptor.endpoint, owner: answer.descriptor.owner, caller, responder, commands, ...(opts.instanceId !== undefined ? { pinnedInstanceId: opts.instanceId } : {}) };
}

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
  // P2 item 3 `--on`: a PINNED service routes to its exact instance's `inst` rail (the same instance the
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

export interface SubmitAndFollowGoalOptions {
  /** Read through the current authorized transport. Cancellation owns this read, not the goal. */
  reconcile?: (goalId: string, attributed: EpAttributedReply, context: {
    caller: EpCaller; signal: AbortSignal; deadlineMs: number;
  }) => Promise<{ goalId: string; result?: GoalResultFact } | undefined>;
  currentNc?: () => NatsConnection | undefined;
  onReconnect?: (handler: (newNc: NatsConnection) => void) => () => void;
  signal?: AbortSignal;
}

/** Subscribe before a single submission, then observe its accepted goal through live progress and
 *  mediated canonical reads. Local failures before an attributed reply throw; they never invent a
 *  responder. Once accepted, observation failures retain that responder and never authorize retry. */
export async function submitAndFollowGoal(
  nc: NatsConnection,
  space: string,
  endpoint: string,
  caller: EpCaller,
  deadlineMs: number,
  submit: (signal?: AbortSignal) => Promise<EpAttributedReply>,
  opts?: SubmitAndFollowGoalOptions,
): Promise<EpAttributedReply> {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0)
    throw new EpEnvelopeError("bad-request", "goal following requires a positive integer deadline", undefined, "not-executed");
  const acceptingCaller = { ...caller };
  const terminals = new Map<string, { state: string; data?: unknown }>();
  const progressSubject = epGoalProgressGrantRow(space, endpoint, acceptingCaller);
  const work = new AbortController();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let activeNc = nc;
  let activeSub: Subscription | undefined;
  let generation = 0;
  let unbindReconnect: (() => void) | undefined;
  let completed = false;
  let stopped = opts?.signal?.aborted === true;
  let submitted = false;
  let subError: Error | undefined;
  let observationError: Error | undefined;
  let wake: (() => void) | undefined;
  let abortPhase: (() => void) | undefined;
  let needsReconcile = false;
  let reading = false;
  let progressReady = false;
  const aborted = new Promise<void>((resolve) => { abortPhase = resolve; });
  const onAbort = () => {
    stopped = true;
    work.abort();
    abortPhase?.();
    wake?.();
  };
  const phaseError = (code: "unavailable" | "deadline-exceeded") => new EpEnvelopeError(code,
    submitted
      ? "the goal submission was interrupted while in flight; its outcome is unknown. It may have been accepted or executed; do NOT retry without inspecting 'ps'/'inspect' first (SPEC 13.6)"
      : "goal observation stopped or exceeded its deadline before submission; the manager request WAS NOT RUN",
    undefined, submitted ? "unknown" : "not-executed");
  let deadline = Date.now() + deadlineMs;
  const bounded = async <T>(operation: () => Promise<T>, until: number): Promise<T> => {
    if (stopped || completed) throw phaseError("unavailable");
    const remaining = until - Date.now();
    if (remaining <= 0) throw phaseError("deadline-exceeded");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        aborted.then(() => { throw phaseError("unavailable"); }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(phaseError("deadline-exceeded")), Math.min(remaining, 2_147_483_647));
          timers.add(timer);
        }),
      ]);
    } finally {
      if (timer !== undefined) { clearTimeout(timer); timers.delete(timer); }
    }
  };
  const subscribe = (next: NatsConnection) => {
    if (completed || stopped) return;
    const mine = ++generation;
    activeSub?.unsubscribe();
    activeNc = next;
    progressReady = false;
    subError = undefined;
    activeSub = next.subscribe(progressSubject, {
      callback: (err, msg) => {
        if (completed || stopped || mine !== generation) return;
        if (err) { subError ??= err; wake?.(); return; }
        let ev: { goalId?: unknown; phase?: unknown; state?: unknown; data?: unknown };
        try { ev = JSON.parse(dec.decode(msg.data)); } catch { return; }
        if (ev?.phase === "terminal" && typeof ev.goalId === "string") {
          terminals.set(ev.goalId, { state: String(ev.state), data: ev.data });
          wake?.();
        }
      },
    });
  };
  const replaceConnection = (next: NatsConnection) => {
    if (completed || stopped) return;
    try { subscribe(next); }
    catch (err) { subError = err instanceof Error ? err : new Error(String(err)); wake?.(); return; }
    const mine = generation;
    void bounded(() => next.flush(), deadline).then(() => {
      if (completed || stopped || mine !== generation) return;
      progressReady = true;
      needsReconcile = true;
      wake?.();
    }, (err) => {
      if (completed || stopped || mine !== generation) return;
      subError = err instanceof Error ? err : new Error(String(err));
      wake?.();
    });
  };
  try {
    opts?.signal?.addEventListener("abort", onAbort, { once: true });
    if (stopped) throw phaseError("unavailable");
    subscribe(opts?.currentNc?.() ?? nc);
    unbindReconnect = opts?.onReconnect?.(replaceConnection);
    // A borrowed submit can publish on another connection. Confirm broker interest first,
    // including a replacement that arrived while the first connection's flush was pending.
    for (;;) {
      const preparing = activeNc;
      try { await bounded(() => preparing.flush(), deadline); }
      catch (err) { if (!stopped && preparing !== activeNc) continue; throw err; }
      if (stopped) throw phaseError("unavailable");
      const current = opts?.currentNc?.();
      if (current && current !== activeNc) subscribe(current);
      if (preparing === activeNc) { progressReady = true; break; }
    }
    if (stopped) throw phaseError("unavailable");
    submitted = true;
    let attributed: EpAttributedReply;
    try { attributed = await bounded(() => submit(work.signal), deadline); }
    catch (err) {
      if (stopped) throw phaseError("unavailable");
      if (err instanceof EpEnvelopeError && err.outcome === "not-executed") throw err;
      throw new EpEnvelopeError(err instanceof EpEnvelopeError ? err.code : "unavailable",
        `${err instanceof Error ? err.message : String(err)}; the submission outcome is unknown. It may have been accepted or executed; do NOT retry without inspecting 'ps'/'inspect' first (SPEC 13.6)`, undefined, "unknown");
    }
    if (attributed.reply.ok !== true) return attributed;
    const acceptance = attributed.reply.data as { goalId?: unknown; fingerprint?: unknown; readinessDeadlineMs?: unknown } | undefined;
    const goalId = acceptance?.goalId;
    if (typeof goalId !== "string") return attributed;
    const acceptedFingerprint = typeof acceptance?.fingerprint === "string" ? acceptance.fingerprint : undefined;
    const readinessDeadlineMs = acceptance?.readinessDeadlineMs;
    const followDeadlineMs = typeof readinessDeadlineMs === "number"
      && Number.isSafeInteger(readinessDeadlineMs) && readinessDeadlineMs >= 0
      ? Math.max(deadlineMs, readinessDeadlineMs + GOAL_FOLLOW_MARGIN_MS) : deadlineMs;
    deadline = Date.now() + followDeadlineMs;
    const reconcileAt = deadline - Math.min(deadlineMs, followDeadlineMs / 2);
    let finalReadRequested = false;
    const reconcile = async () => {
      if (!opts?.reconcile || completed || stopped || reading || !progressReady) return;
      reading = true;
      needsReconcile = false;
      try {
        const result = await opts.reconcile(goalId, attributed, {
          caller: { ...acceptingCaller }, signal: work.signal, deadlineMs: Math.max(1, deadline - Date.now()),
        });
        if (completed || stopped || Date.now() >= deadline) return;
        if (!result || typeof result !== "object" || result.goalId !== goalId)
          throw new EpEnvelopeError("internal", "goal-result reply is malformed or names a different goal; it cannot authorize this outcome (SPEC 13.6)");
        if (result.result !== undefined) {
          const ref: GoalRef = { endpoint, caller: acceptingCaller, goalId };
          const fact = parseGoalResultFact(result.result, "goal-result reply", ref);
          if (acceptedFingerprint !== undefined && fact.fingerprint !== acceptedFingerprint)
            throw new EpEnvelopeError("internal", "goal result fingerprint does not match the accepted goal (SPEC 13.6)");
          terminals.set(goalId, { state: fact.state, data: fact.data });
        }
      } catch (err) {
        if (!completed && !stopped && Date.now() < deadline)
          observationError = err instanceof Error ? err : new Error(String(err));
      } finally {
        reading = false;
        if (!completed && !stopped) wake?.();
      }
    };
    const current = opts?.currentNc?.();
    if (current && current !== activeNc && !stopped) replaceConnection(current);
    needsReconcile = true; // Also covers a terminal lost before the acceptance arrived.
    while (!terminals.has(goalId) && !stopped && !observationError && !subError && Date.now() < deadline) {
      if (!finalReadRequested && Date.now() >= reconcileAt) {
        finalReadRequested = true;
        needsReconcile = true;
      }
      if (needsReconcile && !reading) void reconcile();
      if (terminals.has(goalId) || stopped || observationError || subError) break;
      await new Promise<void>((resolve) => {
        const until = finalReadRequested ? deadline : reconcileAt;
        const timer = setTimeout(() => { timers.delete(timer); wake = undefined; resolve(); }, Math.max(0, Math.min(until - Date.now(), 2_147_483_647)));
        timers.add(timer);
        wake = () => { clearTimeout(timer); timers.delete(timer); wake = undefined; resolve(); };
      });
    }
    const terminal = terminals.get(goalId);
    const observationFailure = (code: "unavailable" | "permission-denied" | "deadline-exceeded", reason: string) => ({
      ...attributed,
      reply: { ...attributed.reply, ok: false as const, data: undefined, error: {
        code, outcome: "unknown" as const,
        message: `the goal "${goalId}" was accepted, but ${reason}. THE GOAL IS UNAFFECTED - it may already have succeeded; this is not evidence the goal failed. Do NOT retry: another submission could duplicate the effect. Inspect 'ps'/'inspect' first (SPEC 13.6)`,
      } },
    });
    if (stopped) return observationFailure("unavailable", "the endpoint was stopped while awaiting its outcome");
    if (observationError) return observationFailure("unavailable", `following its outcome failed: ${observationError.message}`);
    if (!terminal && subError) return subError instanceof PermissionViolationError
      ? observationFailure("permission-denied", `this caller is NOT PERMITTED to hear its outcome: the broker refused the per-goal progress subscription \"${progressSubject}\" (${subError.message}); grant this caller the per-goal progress read row`)
      : observationFailure("unavailable", `the per-goal progress subscription \"${progressSubject}\" FAILED (${subError.name}: ${subError.message}); this is NOT a grant refusal, so changing ACLs is the wrong remedy`);
    if (!terminal) return observationFailure("deadline-exceeded", `no terminal arrived within ${followDeadlineMs}ms; this is a timeout on the WAIT`);
    if (terminal.state === "succeeded")
      return { ...attributed, reply: { ...attributed.reply, ok: true, data: terminal.data, error: undefined } };
    const d = (terminal.data ?? {}) as { error?: unknown; reason?: unknown; details?: unknown };
    const raw = typeof d.error === "string" ? d.error : typeof d.reason === "string" ? d.reason : `the goal settled ${terminal.state}`;
    const details = Array.isArray(d.details) ? d.details as import("./endpoint-error.js").EpErrorDetail[] : undefined;
    const message = renderLifecycleBlocked(raw, details ? { details } : undefined);
    const fromAccept = lifecycleBlockedFrom(attributed.reply.error);
    const merged = details ?? (fromAccept ? [fromAccept] : undefined);
    return { ...attributed, reply: { ...attributed.reply, ok: false, data: undefined, error: { code: terminal.state, message, ...(merged ? { details: merged } : {}) } } };
  } finally {
    completed = true;
    opts?.signal?.removeEventListener("abort", onAbort);
    unbindReconnect?.();
    activeSub?.unsubscribe();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    wake = undefined;
    work.abort();
    abortPhase?.();
  }
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
