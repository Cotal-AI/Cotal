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
import { jetstreamManager } from "@nats-io/jetstream";
import { EpEnvelopeError, EP_UNBOUND_RESPONDER, EP_UNANSWERED } from "./endpoint-envelope.js";
import { compileContract, type CompiledContract } from "./schema-profile.js";
import {
  contractStoreContext, fetchContractClosure, contractRefToHex, contractArtifactDigestHex,
  type ContractStoreContext, type ArtifactMemo,
} from "./endpoint-contract-store.js";
import { parseClusterDocument, type ClusterDocument } from "./endpoint-cluster.js";
import { epCall, epScatterService } from "./endpoint-verbs.js";
import { epGoalProgressGrantRow } from "./endpoint-grants.js";
import { epRequestSubject, epCallerReplyFilter, parseEpSubject, type EpCaller, type EpRoute } from "./endpoint-subjects.js";
import { parseEndpointReply } from "./endpoint-envelope.js";
import type { EpVerbTarget, EpAttributedReply, EpScatterResult, EpInstanceLiveness } from "./endpoint-verbs.js";

const dec = new TextDecoder(), enc = new TextEncoder();
const nonce = (): string => randomBytes(24).toString("base64url");

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
  opts: { deadlineMs?: number; instanceId?: string } = {},
): Promise<{ answer: DescribeAnswer; responder: { instanceId: string; epoch: number } }> {
  const deadlineMs = opts.deadlineMs ?? 10_000;
  const n = nonce();
  const requestId = nonce();
  // P2 item 3 `--on <instance>`: PIN the describe to one instance's `inst` route so a multi-manager
  // space resolves the exact instance addressed, not whichever wins the class `one` queue. Default =
  // class anycast (mode "one"), unchanged for every existing caller.
  const route: EpRoute = opts.instanceId !== undefined ? { mode: "inst", instanceId: opts.instanceId } : { mode: "one" };
  const subject = epRequestSubject(space, { route, endpoint, command: "describe", caller, nonce: n });
  const env = {
    v: 1, id: requestId, op: { endpoint, command: "describe" }, class: "ephemeral",
    replyExpected: true, deadlineMs, from: { id: `${caller.owner}.${caller.actor}`, name: caller.actor },
  };
  let sub: Subscription | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The status stream itself, kept because `stop()`, not `return()`, is what releases it. */
  let statusStream: { [Symbol.asyncIterator](): AsyncIterator<{ type: string; error?: unknown }>; stop(err?: Error): void } | undefined;
  let statusIter: AsyncIterator<{ type: string; error?: unknown }> | undefined;
  try {
    // REGISTER THE PERMISSION WATCH BEFORE THE PUBLISH IT IS WATCHING: `nc.status()` registers its
    // listener at CALL time, so one created after `nc.publish` cannot see a violation dispatched in
    // between, and that dropped event is indistinguishable from the silence this watch exists to
    // eliminate.
    //
    // RELEASE IS `stop()`, NOT `return()`. The stream is a `QueuedIterator` parked on an internal
    // signal await, so a queued `return()` does not run until the NEXT status event — which on a
    // healthy connection may never come, leaking one listener per resolve. `status()` is typed as a
    // bare `AsyncIterable`, so `stop` is reached structurally and its absence fails loud HERE rather
    // than leaking quietly.
    statusStream = nc.status() as typeof statusStream;
    if (typeof statusStream?.stop !== "function")
      throw new EpEnvelopeError("unavailable", "the NATS connection's status() stream does not expose stop(); the describe's permission watch cannot be released and would leak a listener per resolve");
    statusIter = statusStream[Symbol.asyncIterator]();
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
      nc.publish(subject, enc.encode(JSON.stringify(env)));
    });
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new EpEnvelopeError("deadline-exceeded", `no describe reply from ${endpoint} within ${deadlineMs}ms`, [{ kind: EP_UNANSWERED, endpoint, command: "describe" }])), deadlineMs); });
    // A REFUSED PUBLISH MUST NOT MASQUERADE AS AN ABSENT RESPONDER. `nc.publish` is fire-and-forget:
    // when the credential lacks the subject the broker answers the CONNECTION asynchronously and the
    // publish returns normally, so the only observable is a deadline that reads as "that endpoint
    // isn't there". The two need opposite responses — mint the grant vs. find the responder.
    //
    // Watch only for OUR subject, and do not race the whole status stream: the connection is shared,
    // and another component's denial or an unrelated transport error must not fail this describe.
    const denied = new Promise<never>((_, reject) => {
      void (async () => {
        // Driven by hand rather than `for await` so the `finally` below can CLOSE it: `nc.status()`
        // is connection-lived, and a `for await` parks on the next event and outlives the describe,
        // leaking one listener per resolve.
        const it = statusIter!;
        for (;;) {
          const { value: s, done } = await it.next();
          if (done === true || s === undefined) return;
          if (s.type !== "error") continue;
          if (s.error instanceof PermissionViolationError && s.error.subject === subject) {
            reject(new EpEnvelopeError("permission-denied",
              `the describe for ${endpoint} was REFUSED BY THE BROKER, not unanswered: this caller's credential does not authorize publishing to "${subject}"${opts.instanceId !== undefined ? ` (the instance rail for ${opts.instanceId}: an instance-addressed call needs a credential minted with that instance, not a class-rail one)` : ""}. The responder may be perfectly healthy; the grant is what is missing (SPEC 13.2)`));
            return;
          }
        }
      })().catch(() => { /* the status stream ending is not a describe failure; the deadline still governs */ });
    });
    const { body: reply, responder } = await Promise.race([got, timeout, denied]);
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
    // Release on EVERY exit, success included. `stop()` resolves the generator's signal and its
    // `iterClosed`, which is what the transport splices the listener on; `return()` is kept only to
    // settle the parked `next()` it wakes.
    statusStream?.stop();
    void statusIter?.return?.(undefined);
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
  opts: { deadlineMs?: number; instanceId?: string } = {},
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
  const docs = await pooled(answer.descriptor.clusters, RESOLVE_MAX_INFLIGHT_READS, (cl) => fetchClusterDocument(store, cl.digest, artifactMemo));
  // Flattened in DOCUMENT ORDER first, then resolved concurrently and inserted in that same order:
  // when two clusters declare one command name, last-in-document-order still wins, exactly as the
  // sequential form did. Concurrency must not make the resolved surface depend on read timing.
  const declared = docs.flatMap((doc) => doc.commands).filter((cmd) => visible.has(cmd.name)); // a describe VIEW may narrow a cluster's commands
  // Each command needs two closures, so the pool runs at half the read bound to keep the in-flight
  // read count under it.
  const resolved = await pooled(declared, Math.max(1, RESOLVE_MAX_INFLIGHT_READS >> 1), async (cmd): Promise<ResolvedCommand> => {
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
  opts: { target?: EpVerbTarget; deadlineMs?: number; currentEpoch?: (instanceId: string) => Promise<number> | number },
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
  }, {
    deadlineMs: opts.deadlineMs ?? 10_000,
    currentEpoch: opts.currentEpoch ?? describeBound,
    // What the currency hook returns decides how a stale-epoch refusal is worded and marked: the
    // describe-bound default is this handle's own bind (a responder ahead of it is a successor and
    // the handle is the stale side); a caller-supplied hook is a registry read by epCall's contract.
    currencyReference: opts.currentEpoch ? "registry" : "bind",
  });
}

/** Submit an ACTION command and FOLLOW its goal to the terminal (P2 item 2, 2b): since 2a a
 *  spawn/launch reply is the ACCEPTANCE (returned before the agent is live), so a consumer that
 *  wants the old block-until-outcome behaviour follows the caller-scoped progress subtree to the
 *  terminal here. The subscription opens BEFORE `submit` runs (a fast join could terminalize within
 *  milliseconds of the acceptance), buffering terminals by goalId. The reply is then RESOLVED from
 *  the terminal: `succeeded` → the terminal's data (today's live reply — name/id/role/agent/mode/
 *  lifecycleUid), `failed`/`uncertain`/`cancelled` → a non-ok reply carrying the cause. A reply with
 *  NO goalId (a refuse-at-accept, or a non-action command) passes through unchanged. UX is preserved:
 *  the call still returns on the real outcome. The caller needs the per-goal progress read row
 *  ({@link epGoalProgressGrantRow}) — minted with any goal-bearing capability. */
export async function submitAndFollowGoal(
  nc: NatsConnection,
  space: string,
  endpoint: string,
  caller: EpCaller,
  deadlineMs: number,
  submit: () => Promise<EpAttributedReply>,
): Promise<EpAttributedReply> {
  const terminals = new Map<string, { state: string; data?: unknown }>();
  const waiters = new Map<string, () => void>();
  const sub = nc.subscribe(epGoalProgressGrantRow(space, endpoint, caller), {
    callback: (err, m) => {
      if (err) return;
      let ev: { goalId?: unknown; phase?: unknown; state?: unknown; data?: unknown };
      try { ev = JSON.parse(dec.decode(m.data)); } catch { return; }
      if (ev && ev.phase === "terminal" && typeof ev.goalId === "string") {
        terminals.set(ev.goalId, { state: String(ev.state), data: ev.data });
        waiters.get(ev.goalId)?.();
      }
    },
  });
  try {
    const attributed = await submit();
    if (attributed.reply.ok !== true) return attributed; // refuse at accept — surface as-is
    const goalId = (attributed.reply.data as { goalId?: unknown } | undefined)?.goalId;
    if (typeof goalId !== "string") return attributed; // not an action reply — pass through
    const terminal = terminals.get(goalId) ?? await new Promise<{ state: string; data?: unknown } | undefined>((resolve) => {
      const t = setTimeout(() => resolve(terminals.get(goalId)), deadlineMs);
      waiters.set(goalId, () => { clearTimeout(t); resolve(terminals.get(goalId)); });
    });
    if (terminal === undefined)
      // WHAT THIS PROVED: nothing about the goal. The goal was ACCEPTED (the submit above returned
      // ok); only its terminal did not arrive here in time, which a slow runtime or a dropped
      // progress subscription produces just as readily as a real failure. Observed live: seats that
      // reported this had already come up and were messaging peers. So say the deadline is about
      // the WAIT, not the work, and warn about the one action that turns a false negative into real
      // damage: a retry, which submits a SECOND goal and duplicates whatever the first one did.
      return { ...attributed, reply: { ...attributed.reply, ok: false, data: undefined, error: { code: "deadline-exceeded", message: `the goal "${goalId}" was accepted but produced no terminal within ${deadlineMs}ms; this is a timeout on the WAIT, not evidence the goal failed - it may already have succeeded, and may still succeed. Read its outcome with 'ps'/'inspect' before acting; do NOT retry on this alone, a retry submits a second goal and duplicates the effect (SPEC 13.6)` } } };
    if (terminal.state === "succeeded")
      return { ...attributed, reply: { ...attributed.reply, ok: true, ...(terminal.data !== undefined ? { data: terminal.data } : { data: undefined }), error: undefined } };
    const d = (terminal.data ?? {}) as { error?: unknown; reason?: unknown };
    const message = typeof d.error === "string" ? d.error : typeof d.reason === "string" ? d.reason : `the goal settled ${terminal.state}`;
    return { ...attributed, reply: { ...attributed.reply, ok: false, data: undefined, error: { code: terminal.state, message } } };
  } finally {
    sub.unsubscribe();
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
