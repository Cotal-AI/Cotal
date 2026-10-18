/**
 * The browser entry (`@cotal-ai/core/browser`): the Manager command contracts a page can enforce
 * under a strict Content-Security-Policy, with no Node built-in and no runtime code generation.
 *
 * The package root compiles a resolved service's §13.7 schema closures with Ajv at runtime, which a
 * `script-src 'self'` page forbids. This entry instead carries validators generated at build time
 * (`scripts/gen-browser-contracts.ts`) with the same profile and the same Ajv options, one per
 * closure digest of each packaged Manager release. A digest is the closure's identity, so the
 * packaged validator for a digest IS that closure's validator. A cluster or closure digest this
 * build did not package is refused as `unsupported-version`, never compiled, guessed or skipped.
 *
 * This module only names and enforces contracts. It opens no connection and acquires no authority:
 * describing, invoking and following a Manager still need the caller's own authorized connection
 * (docs/embedding.md, "Manager command contracts in a browser").
 */
import { EpEnvelopeError } from "./endpoint-error.js";
import { PACKAGED_CLUSTERS, PACKAGED_VALIDATORS } from "./browser-contracts.generated.js";

type GeneratedValidator = ((data: unknown) => boolean) & { errors?: Array<{ instancePath?: string; message?: string }> | null };
type GeneratedCluster = {
  sources: string[];
  urn: string;
  revision: number;
  commands: Array<{ name: string; class: string; targeted: boolean; modes?: string[]; capability: string; inputDigest: string; outputDigest: string }>;
};
const validators = PACKAGED_VALIDATORS as Readonly<Record<string, GeneratedValidator>>;
const clusters = PACKAGED_CLUSTERS as Readonly<Record<string, GeneratedCluster>>;

/** One packaged closure: its digest and the profile's verdict on a value. */
export interface PackagedContract {
  readonly closureDigest: string;
  /** The profile's verdict, and the first violation when there is one (the wire reports only the first). */
  check(value: unknown): { ok: true } | { ok: false; error: string };
}

/** One command of a packaged cluster, shaped like the root's `ResolvedCommand`. */
export interface PackagedCommand {
  readonly command: string;
  readonly contract: { readonly input: PackagedContract; readonly output: PackagedContract };
  readonly class: string;
  readonly targeted: boolean;
  readonly modes: readonly string[];
  readonly capability: string;
}

/** A packaged Manager cluster document and the releases that ship it. */
export interface PackagedCluster {
  readonly clusterDigest: string;
  readonly sources: readonly string[];
  readonly urn: string;
  readonly revision: number;
  readonly commands: readonly string[];
}

const contracts = new Map<string, PackagedContract>();

/** The packaged validator for one closure digest, or `unsupported-version` when this build has none. */
export function packagedContract(closureDigest: string): PackagedContract {
  const known = contracts.get(closureDigest);
  if (known) return known;
  const validate = Object.hasOwn(validators, closureDigest) ? validators[closureDigest] : undefined;
  if (typeof validate !== "function")
    throw new EpEnvelopeError("unsupported-version", `schema closure ${closureDigest} is not one this browser build packages; update @cotal-ai/core or the Manager so their contracts match (SPEC 13.7)`);
  const contract: PackagedContract = Object.freeze({
    closureDigest,
    check(value: unknown) {
      if (validate(value)) return { ok: true as const };
      const first = validate.errors?.[0];
      return { ok: false as const, error: `${first?.instancePath || "/"} ${first?.message ?? "does not match the contract"}` };
    },
  });
  contracts.set(closureDigest, contract);
  return contract;
}

/** Every Manager cluster document this build packages, for display and support checks. */
export const PACKAGED_MANAGER_CLUSTERS: readonly PackagedCluster[] = Object.freeze(
  Object.entries(clusters).map(([clusterDigest, c]) => Object.freeze({
    clusterDigest, sources: Object.freeze([...c.sources]), urn: c.urn, revision: c.revision,
    commands: Object.freeze(c.commands.map((cmd) => cmd.name)),
  })),
);

/**
 * The invocable surface of a described service from packaged contracts only, assembled exactly as
 * the root's `resolveService` assembles it from the store: clusters in descriptor order, commands
 * narrowed to those the describe view lists, a later cluster's command replacing an earlier one of
 * the same name. Any cluster or closure this build does not package refuses the WHOLE surface
 * (`unsupported-version`): a descriptor it cannot read is no descriptor.
 */
export function packagedServiceSurface(descriptor: { clusters: ReadonlyArray<{ digest: string; commands: readonly string[] }> }): Map<string, PackagedCommand> {
  const visible = new Set(descriptor.clusters.flatMap((cl) => cl.commands));
  const surface = new Map<string, PackagedCommand>();
  for (const cl of descriptor.clusters) {
    const doc = Object.hasOwn(clusters, cl.digest) ? clusters[cl.digest] : undefined;
    if (!doc)
      throw new EpEnvelopeError("unsupported-version", `cluster document ${cl.digest} is not one this browser build packages; supported Manager releases: ${PACKAGED_MANAGER_CLUSTERS.flatMap((c) => c.sources).join(", ")}`);
    for (const cmd of doc.commands) {
      if (!visible.has(cmd.name)) continue;
      surface.set(cmd.name, Object.freeze({
        command: cmd.name,
        contract: Object.freeze({ input: packagedContract(cmd.inputDigest), output: packagedContract(cmd.outputDigest) }),
        class: cmd.class,
        targeted: cmd.targeted,
        modes: Object.freeze([...(cmd.modes ?? [])]),
        capability: cmd.capability,
      }));
    }
  }
  return surface;
}
