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
import type { NatsConnection, Subscription } from "@nats-io/transport-node";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { compileContract, type CompiledContract } from "./schema-profile.js";
import {
  contractStoreContext, fetchContractClosure, contractRefToHex, contractArtifactDigestHex,
  type ContractStoreContext,
} from "./endpoint-contract-store.js";
import { parseClusterDocument, type ClusterDocument } from "./endpoint-cluster.js";
import { epCall } from "./endpoint-verbs.js";
import { epRequestSubject, epCallerReplyFilter, parseEpSubject, type EpCaller, type EpRoute } from "./endpoint-subjects.js";
import { parseEndpointReply } from "./endpoint-envelope.js";
import type { EpVerbTarget, EpAttributedReply } from "./endpoint-verbs.js";

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
  try {
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
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new EpEnvelopeError("deadline-exceeded", `no describe reply from ${endpoint} within ${deadlineMs}ms`)), deadlineMs); });
    const { body: reply, responder } = await Promise.race([got, timeout]);
    if (reply.ok !== true) {
      const e = reply.error as { code?: string; message?: string } | undefined;
      throw new EpEnvelopeError((e?.code as never) ?? "unavailable", `describe(${endpoint}) failed: ${e?.message ?? "unknown"}`);
    }
    return { answer: reply.data as unknown as DescribeAnswer, responder };
  } finally {
    sub?.unsubscribe();
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Fetch + verify ONE cluster document from the store at its closure digest (two-stage §13.7:
 *  the manifest at the closure digest, whose `root` names the document artifact). A cluster
 *  document declares no by-digest child references, so its closure is {root}. */
async function fetchClusterDocument(store: ContractStoreContext, closureDigest: string): Promise<ClusterDocument> {
  const { manifest, artifacts } = await fetchContractClosure(store, closureDigest, () => []);
  const rootBytes = artifacts.get(contractRefToHex(manifest.root));
  if (rootBytes === undefined)
    throw new EpEnvelopeError("failed-precondition", `the cluster manifest ${closureDigest} names root ${manifest.root} but the root artifact is absent from the fetched closure (SPEC 13.7)`);
  return parseClusterDocument(JSON.parse(dec.decode(rootBytes)));
}

/** Fetch a schema CLOSURE from the store and PROFILE-recompile it, binding every by-digest member.
 *  The recompiled contract's closureDigest MUST equal the digest we fetched at — a store that
 *  served bytes hashing to a different closure is a tamper/bug and fails loud (§13.7). */
async function recompileClosure(store: ContractStoreContext, closureDigest: string): Promise<CompiledContract> {
  // Walk the schema closure, resolving `cotal:sha256:<hex>` refs a document makes (the profile's
  // reference form) so a multi-document schema bundle rebuilds. A recompiled contract carries the
  // registered digest, so an equality check below is the tamper boundary.
  const { manifest, artifacts } = await fetchContractClosure(store, closureDigest, (bytes) => extractSchemaRefs(bytes));
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
  const commands = new Map<string, ResolvedCommand>();
  const visible = new Set<string>(answer.descriptor.clusters.flatMap((cl) => cl.commands));
  for (const cluster of answer.descriptor.clusters) {
    const doc = await fetchClusterDocument(store, cluster.digest);
    for (const cmd of doc.commands) {
      if (!visible.has(cmd.name)) continue; // a describe VIEW may narrow a cluster's commands
      commands.set(cmd.name, {
        command: cmd.name,
        contract: { input: await recompileClosure(store, cmd.inputDigest), output: await recompileClosure(store, cmd.outputDigest) },
        class: cmd.class,
        targeted: cmd.targeted,
        modes: cmd.modes ?? [],
        capability: cmd.capability,
      });
    }
  }
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
    if (instanceId !== service.responder.instanceId)
      throw new EpEnvelopeError("failed-precondition", `the ${service.endpoint} instance ${instanceId} answered but this service handle resolved against ${service.responder.instanceId}; a different queue winner is a superseded-or-split responder - re-resolve the service to adopt it (SPEC 13.2)`);
    return service.responder.epoch;
  };
  // P2 item 3 `--on`: a PINNED service routes to its exact instance's `inst` rail (the same instance the
  // describe resolved to, at its resolved epoch), never the class `one` queue — so the command reaches
  // the addressed manager in a multi-manager space. Unpinned ⇒ class anycast `one` (unchanged). The
  // describeBound currency check still holds: an inst-routed reply carries that instance's id.
  const route = service.pinnedInstanceId !== undefined
    ? { mode: "inst" as const, instanceId: service.pinnedInstanceId, epoch: service.responder.epoch }
    : { mode: "one" as const };
  return epCall(nc, space, route, {
    endpoint: service.endpoint, command, contract: resolved.contract, caller,
    ...(sendArgs !== undefined ? { args: sendArgs } : {}),
    ...(opts.target ? { target: opts.target } : {}),
  }, { deadlineMs: opts.deadlineMs ?? 10_000, currentEpoch: opts.currentEpoch ?? describeBound });
}

/** A digest reference's bare hex, exported so a CLI can print the resolved surface's digests. */
export function contractDigestHexOf(value: unknown): string {
  return contractArtifactDigestHex(new TextEncoder().encode(JSON.stringify(value)));
}
