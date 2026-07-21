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
import { epRequestSubject, epCallerReplyFilter, type EpCaller } from "./endpoint-subjects.js";
import { spacePrefix } from "./subjects.js";
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
}

/**
 * The reserved `describe` command as a raw request/reply (§13.7: describe pins NO contract, so it
 * carries no `op` digests — {@link epCall} always stamps digests and the serve boundary rejects a
 * digest-bearing describe as `contract-mismatch`, so this is a purpose-built raw path). Subscribes
 * the caller's nonce-scoped reply rail, publishes the void-arg describe on the `one` rail, and
 * resolves the first attributed reply within the deadline.
 */
export async function describeEndpoint(
  nc: NatsConnection,
  space: string,
  endpoint: string,
  caller: EpCaller,
  opts: { deadlineMs?: number } = {},
): Promise<{ answer: DescribeAnswer; responder: { instanceId: string; epoch: number } }> {
  const deadlineMs = opts.deadlineMs ?? 10_000;
  const n = nonce();
  const subject = epRequestSubject(space, { route: { mode: "one" }, endpoint, command: "describe", caller, nonce: n });
  const env = {
    v: 1, id: nonce(), op: { endpoint, command: "describe" }, class: "ephemeral",
    replyExpected: true, deadlineMs, from: { id: `${caller.owner}.${caller.actor}`, name: caller.actor },
  };
  let sub: Subscription | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const got = new Promise<{ body: Record<string, unknown>; responder: { instanceId: string; epoch: number } }>((resolve, reject) => {
      sub = nc.subscribe(epCallerReplyFilter(space, caller), {
        callback: (err, msg) => {
          if (err) { reject(new EpEnvelopeError("unavailable", `describe reply subscription failed: ${err.message}`)); return; }
          // Structural attribution off the reply SUBJECT (§13.2): after the space prefix the rail is
          // `ep.reply.<endpoint>.<instanceId>.<epoch>.<caller triple>.<nonce>` - the serve publish
          // grant pins the responder triple, so these tokens are broker-authenticated, never body data.
          const tokens = msg.subject.split(".");
          const at = spacePrefix(space).split(".").length;
          const [ep, instanceId, epochTok] = [tokens[at + 2], tokens[at + 3], tokens[at + 4]];
          const epoch = Number(epochTok);
          if (ep !== endpoint || instanceId === undefined || !Number.isInteger(epoch) || epoch < 0) {
            reject(new EpEnvelopeError("internal", `describe reply subject ${msg.subject} does not attribute a ${endpoint} responder (SPEC 13.2)`));
            return;
          }
          try { resolve({ body: JSON.parse(dec.decode(msg.data)) as Record<string, unknown>, responder: { instanceId, epoch } }); }
          catch (e) { reject(new EpEnvelopeError("internal", `describe reply did not decode as JSON: ${(e as Error).message}`)); }
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
  opts: { deadlineMs?: number } = {},
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
  return { endpoint: answer.descriptor.endpoint, owner: answer.descriptor.owner, caller, responder, commands };
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
  const describeBound = (instanceId: string): number => {
    if (instanceId !== service.responder.instanceId)
      throw new EpEnvelopeError("failed-precondition", `the ${service.endpoint} instance ${instanceId} answered but this service handle resolved against ${service.responder.instanceId}; a different queue winner is a superseded-or-split responder - re-resolve the service to adopt it (SPEC 13.2)`);
    return service.responder.epoch;
  };
  return epCall(nc, space, { mode: "one" }, {
    endpoint: service.endpoint, command, contract: resolved.contract, caller,
    ...(args !== undefined ? { args } : {}),
    ...(opts.target ? { target: opts.target } : {}),
  }, { deadlineMs: opts.deadlineMs ?? 10_000, currentEpoch: opts.currentEpoch ?? describeBound });
}

/** A digest reference's bare hex, exported so a CLI can print the resolved surface's digests. */
export function contractDigestHexOf(value: unknown): string {
  return contractArtifactDigestHex(new TextEncoder().encode(JSON.stringify(value)));
}
