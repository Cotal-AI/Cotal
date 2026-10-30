/**
 * The registry's `endpoints` answer (SPEC 13.20), over an injected read seam so the logic is the
 * same whichever process hosts it. On an authed mesh the caller's generation comes from the
 * broker-authenticated subject, its recorded ceiling from a disclosure read of the issued evidence,
 * and each registered endpoint's commands from its digest-verified root cluster document. Endpoints
 * the ceiling covers no command of are left out before anything is returned.
 */
import {
  ContractInvalidError,
  CoverageLimitError,
  EpEnvelopeError,
  EP_UNBOUND_CALLER_AUTHORITY,
  isIssuedCaller,
  projectCommandCoverage,
  REGISTRY_PAGE_LIMIT,
  verifyClusterManifest,
  verifyClusterRoot,
  type ClusterCommand,
  type EpServeContext,
  type IssuedAuthorityRef,
  type IssuedEvidence,
  type RegistryCommand,
  type RegistryEndpointRow,
  type RegistryEndpointsInput,
  type RegistryEndpointsOutput,
  type RegistryInstance,
} from "@cotal-ai/core";

/** What the answer reads. Every method reads live state; nothing is cached across requests here
 *  except what the seam itself caches by an immutable key (a contract artifact by its digest). */
export interface RegistryReads {
  /** The recorded ceiling of a live generation (`IssuedStore.observe`); throws when it is not one. */
  observe(ref: IssuedAuthorityRef): Promise<IssuedEvidence>;
  /** Every registered `(endpoint, instanceId)`, from the records store's key list. */
  instances(): Promise<{ endpoint: string; instanceId: string }[]>;
  /** The instance's registered cluster closure digests, or `undefined` when its record is gone. */
  clusterDigests(endpoint: string, instanceId: string): Promise<string[] | undefined>;
  /** The instance's recorded serving state, or `null` when it has none. */
  state(endpoint: string, instanceId: string): Promise<string | null>;
  /** A contract artifact's JSON value by digest, or `undefined` when the store has none. */
  artifact(digest: string): Promise<unknown>;
}

export interface RegistryAnswerOptions {
  space: string;
  /** `open`: no permission system, every registered endpoint is callable. */
  mode: "authed" | "open";
  reads: RegistryReads;
}

/** The most bytes one page is built to. The serve layer also caps it at the connection's ceiling. */
export const REGISTRY_PAGE_BYTES = 512 * 1024;

type Declared = { command: ClusterCommand; instances: string[] };

/** `undefined` when the instance's record is gone (deregistered between the key list and the read). */
async function declarations(reads: RegistryReads, endpoint: string, instanceId: string): Promise<{ commands: ClusterCommand[]; artifacts: RegistryInstance["artifacts"] } | undefined> {
  const digests = await reads.clusterDigests(endpoint, instanceId);
  if (digests === undefined) return undefined;
  const commands: ClusterCommand[] = [];
  for (const digest of digests) {
    const hex = digest.replace(/^sha256:/, "");
    const manifest = await reads.artifact(hex);
    if (manifest === undefined) return { commands: [], artifacts: "missing" };
    let root: string;
    try {
      root = verifyClusterManifest(digest, manifest).root;
    } catch (e) {
      if (e instanceof ContractInvalidError) return { commands: [], artifacts: "invalid" };
      throw e;
    }
    const document = await reads.artifact(root.replace(/^sha256:/, ""));
    if (document === undefined) return { commands: [], artifacts: "missing" };
    try {
      commands.push(...verifyClusterRoot(root, document).commands);
    } catch (e) {
      if (e instanceof ContractInvalidError) return { commands: [], artifacts: "invalid" };
      throw e;
    }
  }
  return { commands, artifacts: "verified" };
}

async function endpointRow(
  opts: RegistryAnswerOptions,
  endpoint: string,
  instanceIds: string[],
  ceiling: { evidence: IssuedEvidence; generation: string } | undefined,
  caller: { owner: string; actor: string; uid: string },
): Promise<RegistryEndpointRow | undefined> {
  const instances: RegistryInstance[] = [];
  const declared = new Map<string, Declared>();
  for (const instanceId of instanceIds) {
    const found = await declarations(opts.reads, endpoint, instanceId);
    if (found === undefined) continue;
    instances.push({ instanceId, state: await opts.reads.state(endpoint, instanceId), artifacts: found.artifacts });
    for (const command of found.commands) {
      const seen = declared.get(command.name);
      if (seen) seen.instances.push(instanceId);
      else declared.set(command.name, { command, instances: [instanceId] });
    }
  }
  const commands: RegistryCommand[] = [];
  const unprojected: string[] = [];
  for (const [name, { command, instances: by }] of [...declared].sort(([a], [b]) => a.localeCompare(b))) {
    const partial = by.length < instances.length ? { instances: by } : {};
    if (ceiling === undefined) {
      commands.push({ name, class: command.class, forms: [], ...partial });
      continue;
    }
    try {
      const forms = projectCommandCoverage(opts.space, ceiling.evidence.permissions.publish, {
        endpoint, command, caller, generation: ceiling.generation, instances: instances.map((i) => i.instanceId),
      });
      if (forms.length > 0)
        commands.push({ name, class: command.class, forms: forms.map((f) => ({ ...f, literals: { ...f.literals } as Record<string, string[]>, covered: f.covered.map((c) => ({ ...c }) as Record<string, string | null>) })), ...partial });
    } catch (e) {
      if (!(e instanceof CoverageLimitError)) throw e;
      unprojected.push(name);
    }
  }
  if (instances.length === 0) return undefined;
  if (ceiling !== undefined && commands.length === 0 && unprojected.length === 0) return undefined;
  return { endpoint, instances, commands, ...(unprojected.length ? { unprojected } : {}) };
}

/**
 * Answer one `endpoints` request. A legacy-rail request on an authed mesh carries no generation
 * and is refused, as a command requiring issued caller authority refuses it (SPEC 13.15).
 */
export async function answerEndpoints(opts: RegistryAnswerOptions, ctx: Pick<EpServeContext, "subject" | "replyFits">, input: RegistryEndpointsInput): Promise<RegistryEndpointsOutput> {
  const caller = ctx.subject.caller;
  const triple = { owner: caller.owner, actor: caller.actor, uid: caller.uid };
  let ceiling: { evidence: IssuedEvidence; generation: string } | undefined;
  if (opts.mode === "authed") {
    if (!isIssuedCaller(caller))
      throw new EpEnvelopeError("permission-denied", "the endpoints listing rides the versioned rail under a listing or issued generation; this credential has no listing binding (SPEC 13.15)",
        [{ kind: EP_UNBOUND_CALLER_AUTHORITY, owner: caller.owner, actor: caller.actor, uid: caller.uid }]);
    const evidence = await opts.reads.observe({ space: opts.space, ...triple, generation: caller.generation });
    ceiling = { evidence, generation: caller.generation };
  }
  const limit = input.limit ?? REGISTRY_PAGE_LIMIT;
  const byEndpoint = new Map<string, string[]>();
  for (const { endpoint, instanceId } of await opts.reads.instances()) byEndpoint.set(endpoint, [...(byEndpoint.get(endpoint) ?? []), instanceId]);
  const names = [...byEndpoint.keys()].filter((name) => input.after === undefined || name > input.after).sort();
  const source = opts.mode === "authed" ? "recorded-ceiling" as const : "no-permission-system" as const;
  const rows: RegistryEndpointRow[] = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!;
    if (rows.length === limit) return { rows, next: rows[rows.length - 1]!.endpoint, source };
    const row = await endpointRow(opts, name, byEndpoint.get(name)!.sort(), ceiling, triple);
    if (row === undefined) continue;
    const page = { rows: [...rows, row], next: name, source };
    if (ctx.replyFits !== undefined && !ctx.replyFits(page, REGISTRY_PAGE_BYTES)) {
      if (rows.length === 0) throw new EpEnvelopeError("resource-exhausted", `the row for ${name} does not fit in one reply`);
      return { rows, next: rows[rows.length - 1]!.endpoint, source };
    }
    rows.push(row);
  }
  return { rows, source };
}
