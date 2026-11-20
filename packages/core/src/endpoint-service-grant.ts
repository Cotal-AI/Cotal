/**
 * Serve-credential authorization and the durable issuance fence (SPEC §13.9 "Serve grants",
 * §13.1): the verified command authority a serve grant carries, the trusted, owner, guest and
 * bearer authorization paths, and the gate, ledger and barrier shapes that finalize issuance.
 * Split verbatim out of endpoint-service.ts, which re-exports it, so the package's exports are
 * unchanged.
 */
import { SERVICE_ACCESS_TTL_SECONDS } from "./service-authority-limits.js";
import { parseServiceConnectionBinding, serviceGateApprovalLive, type ServiceConnectionBinding, type ServiceGateAuthority } from "./service-gate.js";
import type { KV } from "@nats-io/kv";
import { spacePrefix, principalKey } from "./subjects.js";
import { endpointToken, assertBoundedOwner, assertLifecycleToken, assertCommandToken, assertPoolToken, type EpAuthzMode, type PrincipalAuthority } from "./endpoint-subjects.js";
import { EpEnvelopeError, type EpClass } from "./endpoint-envelope.js";
import { RECORD_KINDS, recordSpecKey, decodeRecordJson } from "./endpoint-records.js";
import { verifyClusterManifest, verifyClusterRoot, deriveDescriptor, type ClusterDocument, type DescribeDescriptor } from "./endpoint-cluster.js";
import { createPublicKey, verify as verifySignature } from "node:crypto";
import { canonicalJson, contractDigest } from "./canonical.js";
import { isCanonicalEd25519PublicCoordinate, type ServiceAuthorityInfo, type ServiceIssuerKey, type ServiceRegistration, type ServiceRegistrationWitness } from "./remote-service-authority.js";
import type { EVICT_PRINCIPALS_MAX } from "./evict.js"; // type-only: only a {@link} names it, so no runtime edge into the cycle
import type { EndpointRepairCursor, GateStateOp } from "./lifecycle-state.js";
import type { ServiceEndpointCredential } from "./auth-provider.js";
import { type ServiceSpec, parseServiceSpec, type ServiceNameAuthority, assertServiceNameAuthority } from "./endpoint-service-spec.js";

// ---- serve-credential authorization (§13.9 "Serve grants") -------------------------------------

/** One command's VERIFIED registered authority: everything the serve boundary enforces about
 *  the command, taken from a cluster document whose bytes hash to a digest the registered spec
 *  names — never from a caller-supplied declaration. */
export interface EpCommandAuthority {
  /** The registered cluster (closure digest) that declares this command. */
  clusterDigest: string;
  class: EpClass;
  targeted: boolean;
  /** Admitted authorization modes; empty exactly when untargeted (§13.7). */
  modes: readonly EpAuthzMode[];
  /** Principal-route authority words (SPEC 13.21), present exactly when the declaration carries
   *  them. Such a command is never served on a service route, and `serveEndpoint` refuses a
   *  surface that holds one. */
  authorities?: readonly PrincipalAuthority[];
  capability: string;
  inputDigest: string;
  outputDigest: string;
  /** Declared trait URNs (§13.7), out of the digest-verified cluster bytes; empty when the
   *  declaration carries none. Governed entries (`ai.cotal.guarded`/`ai.cotal.priced`) are
   *  what the serve boundary's pre-effect gate keys on; the rest are vocabulary. */
  traits: readonly string[];
}

/** The registry-authorized serve ARTIFACT {@link authorizeServeGrant} returns: ONE deep-frozen,
 *  brand-registered value binding space, registered identity, epoch, owner, registration
 *  revision, the FULL registered command set (§13.9: the instance credential binds its whole
 *  registered surface; caller-specific scoping happens only in the response-time describe
 *  answer, never in the registration), the digest-VERIFIED per-command surface, and the derived
 *  descriptor — consumed by both the credential mint (`permissionsFor`/`mintCreds`, profile
 *  `endpoint-serve`) and `serveEndpoint`, so neither ever accepts a raw spec/descriptor/command
 *  list again. The registry stays discovery (§13.9); this seam is what turns a REGISTRATION
 *  into serve authority. */
export interface EpServeGrant {
  space: string;
  endpoint: string;
  instanceId: string;
  epoch: number;
  /** The registered owner (the only principal this artifact mints for). */
  owner: string;
  /** The `svc….spec` store revision the surface was verified at (§13.7 `registrationRevision`);
   *  the mint's issuance fence refuses if the registration has advanced (a re-registration
   *  supersedes the branded surface). */
  registrationRevision: number;
  /** The name-authority binding revision the serving owner was verified against (§13.9); the
   *  mint's issuance fence refuses if it has advanced (a name transfer supersedes the owner). */
  nameAuthorityRevision: number;
  commands: readonly string[];
  /** Command → its verified registered declaration. */
  surface: Readonly<Record<string, EpCommandAuthority>>;
  /** DERIVED from the verified surface (never caller-asserted): true iff any registered command
   *  is `class: "journal"` — the mint emits the shared `eff_<e>` effects bind rows exactly then
   *  (§13.9 "the credential also carries the effects bind"; an ephemeral-only endpoint gets
   *  none, default-deny both directions). */
  journalClass: boolean;
  /** The endpoint's owned work pools, sorted — PROVISIONING truth (the exact pools whose
   *  `pool_<e>_<pool>` durables the provisioner pre-created), asserted by the authorizing
   *  provisioner at this boundary because no registered record enumerates pool names (routes
   *  are per-acceptance policy decisions, §13.6). Own-endpoint-confined by construction: every
   *  emitted row names `pool_<endpoint>_<pool>`, so a wrong pool name binds nothing foreign. */
  pools: readonly string[];
  /** The full authoritative descriptor describe publishes: DERIVED from verified registered
   *  bytes, deep-frozen. */
  descriptor: DescribeDescriptor;
}

/** Brand registry: authorized artifact → its immutable authorized snapshot. Like the §13.12
 *  consumer-config family bond, the brand (not structure) is what the consuming seams check,
 *  so a structural copy or post-authorization mutation can never carry serve authority. */
interface AuthorizedServe {
  space: string;
  endpoint: string;
  instanceId: string;
  epoch: number;
  owner: string;
  registrationRevision: number;
  nameAuthorityRevision: number;
  commands: string[];
  journalClass: boolean;
  pools: string[];
}
const AUTHORIZED_SERVE = new WeakMap<EpServeGrant, AuthorizedServe>();

/**
 * Reconstitute a serve artifact inside a TRUSTED host issuer after an explicitly typed remote
 * registration protocol has independently proved the registered records/gate coordinates and
 * digest-verified contract closure. This is not a caller shortcut: every field is validated here,
 * the caller still needs the data-account signer to mint, and the issuance gate is the release
 * fence. It exists because the normal brand is process-local and cannot cross the participant →
 * host protocol boundary as JSON.
 */
export function authorizeTrustedServeSnapshot(args: {
  space: string;
  endpoint: string;
  instanceId: string;
  epoch: number;
  owner: string;
  registrationRevision: number;
  nameAuthorityRevision: number;
  commands: string[];
  surface: Record<string, EpCommandAuthority>;
  descriptor: DescribeDescriptor;
  journalClass?: boolean;
  pools?: string[];
}): EpServeGrant {
  spacePrefix(args.space);
  endpointToken(args.endpoint);
  const instanceId = assertLifecycleToken(args.instanceId, "instanceId");
  assertBoundedOwner(args.owner, "serve owner");
  for (const [name, authority] of Object.entries(args.surface)) {
    assertCommandToken(name);
    if (!args.commands.includes(name))
      throw new EpEnvelopeError("internal", `trusted serve snapshot surface carries undeclared command "${name}"`);
    if (authority === null || typeof authority !== "object")
      throw new EpEnvelopeError("internal", `trusted serve snapshot command "${name}" has no authority`);
  }
  const commands = [...args.commands].sort();
  if (new Set(commands).size !== commands.length || commands.some((name) => args.surface[name] === undefined))
    throw new EpEnvelopeError("internal", "trusted serve snapshot commands must be unique and each must have a surface entry");
  for (const n of [args.epoch, args.registrationRevision, args.nameAuthorityRevision])
    if (!Number.isSafeInteger(n) || n < 0) throw new EpEnvelopeError("internal", "trusted serve snapshot coordinates must be unsigned integers");
  const pools = [...(args.pools ?? [])].map(assertPoolToken).sort();
  const surface = Object.freeze(Object.fromEntries(Object.entries(args.surface).map(([name, value]) => [name, Object.freeze({ ...value, modes: Object.freeze([...value.modes]), traits: Object.freeze([...value.traits]), ...(value.authorities !== undefined ? { authorities: Object.freeze([...value.authorities]) } : {}) })]))) as Readonly<Record<string, EpCommandAuthority>>;
  const journalClass = args.journalClass ?? commands.some((name) => surface[name].class === "journal");
  const grant: EpServeGrant = Object.freeze({
    space: args.space,
    endpoint: args.endpoint,
    instanceId,
    epoch: args.epoch,
    owner: args.owner,
    registrationRevision: args.registrationRevision,
    nameAuthorityRevision: args.nameAuthorityRevision,
    commands: Object.freeze(commands),
    surface,
    journalClass,
    pools: Object.freeze(pools),
    descriptor: args.descriptor,
  });
  AUTHORIZED_SERVE.set(grant, {
    space: args.space, endpoint: args.endpoint, instanceId, epoch: args.epoch, owner: args.owner,
    registrationRevision: args.registrationRevision, nameAuthorityRevision: args.nameAuthorityRevision,
    commands, journalClass, pools,
  });
  return grant;
}

/** The registration read needed to derive a serve grant. A native KV satisfies it; an
 * authenticated remote snapshot supplies only this read, never a writable KV or a JSON brand. */
export interface ServiceSpecReader {
  get(key: string): Promise<Pick<NonNullable<Awaited<ReturnType<KV["get"]>>>, "operation" | "value" | "revision"> | null>;
}

/**
 * Authorize a serve credential against the REGISTERED service (§13.9: serving is granted
 * authority, dual to calling — the registry is discovery, the serve grant is the authority).
 * Runs inside the provisioner. The fence, in order:
 *  1. the instance must be REGISTERED (its `svc….spec` record exists) — `failed-precondition`;
 *  2. the credential's holder must BE the registered owner (`permission-denied`), and the name
 *     authority is re-checked FRESH (`permission-denied` on drift);
 *  3. every registered cluster is read through the two-stage §13.7 content-address protocol:
 *     the MANIFEST is fetched at the registered CLOSURE digest and verified, `members` must be
 *     empty (P1 single-document clusters; a non-empty closure is the D8 loader's, refused loud
 *     until then), then the ROOT cluster document is fetched at `manifest.root` and verified.
 *     The verified documents are the ONLY command source — the FULL union of their declared
 *     commands is the surface (no caller subset; caller scoping is response-time describe).
 *     `describe` is derived by the row builder, never a registered command;
 *  4. the epoch must EQUAL a fresh read of the authoritative mapping's `processEpoch`
 *     (`expired`): a serve credential binds the CURRENT incarnation.
 * The returned artifact carries the verified surface, the derived descriptor, and the
 * registration revision. The MINT's fence is the durable issuance gate ({@link
 * finalizeServeIssuance}), NOT this authorization (a read is never a fence, §13.1): this seam
 * produces the surface, the gate serializes its release against takeover and re-registration.
 */
export async function authorizeServeGrant(
  kv: ServiceSpecReader,
  args: {
    space: string;
    endpoint: string;
    instanceId: string;
    epoch: number;
    holder: { owner: string };
    authority: ServiceNameAuthority;
    readProcessEpoch: () => Promise<number> | number;
    /** The contract-store read seam (§13.7 digest subjects; the D8 tooling provides the
     *  production reader): the ARTIFACT stored at a digest subject (`epc.<digest>`) — a
     *  cluster MANIFEST at a closure digest, a cluster DOCUMENT at a root artifact digest — or
     *  `undefined` when the store has no such artifact (fail-closed). */
    readClusterArtifact: (digest: string) => Promise<unknown> | unknown;
    /** The endpoint's owned work pools (PROVISIONING truth: exactly the pools whose durables
     *  the calling provisioner pre-created; omitted = none). Validated tokens, no duplicates,
     *  and only meaningful on a journal-class surface — a pool list on an ephemeral-only
     *  endpoint is a caller bug and refuses loud. */
    pools?: string[];
  },
): Promise<EpServeGrant> {
  spacePrefix(args.space); // grammar: a malformed space token never becomes credential rows
  const iId = assertLifecycleToken(args.instanceId, "instanceId");
  if (!Number.isSafeInteger(args.epoch) || args.epoch < 0)
    throw new EpEnvelopeError("internal", `epoch ${args.epoch} is not an unsigned integer`);
  const specKey = recordSpecKey(RECORD_KINDS.svc, [args.endpoint, iId]);
  const specEntry = await kv.get(specKey);
  if (!specEntry || specEntry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `no registered spec for "${args.endpoint}/${args.instanceId}"; a serve credential is minted only for a REGISTERED instance (SPEC 13.9)`);
  const spec = parseServiceSpec(decodeRecordJson(specEntry.value, specKey), { endpoint: args.endpoint });
  assertBoundedOwner(args.holder.owner, "serve credential holder");
  if (args.holder.owner !== spec.owner)
    throw new EpEnvelopeError("permission-denied", `the serve credential holder "${args.holder.owner}" is not the registered owner "${spec.owner}" of "${args.endpoint}" (SPEC 13.9: serving is the registered owner's authority)`);
  // §13.9 name authority: ONE atomic snapshot binds the owner DECISION and the binding REVISION
  // together (never a torn owner-vs-revision read, engineer/distsys/security). The revision is
  // RECORDED (not fenced here — a read is never a fence, §13.1); the issuance gate carries it and
  // the mint refuses on drift, so a name transfer after this authorization can never release an
  // old-owner credential.
  const nameAuthorityRevision = await assertServiceNameAuthority(spec.endpoint, spec.owner, args.authority);

  const { surface, commands, clusters, journalClass } = await verifiedServeSurface(spec, iId, args.readClusterArtifact);

  // §13.9 bind-row inputs: journal class is REGISTERED truth (derived from the verified
  // surface, never caller-asserted); pools are PROVISIONING truth (the authorizing provisioner
  // asserts exactly the pool durables it pre-created — no registered record enumerates pool
  // names, routes are per-acceptance policy decisions, §13.6). Pools without a journal-class
  // surface are refused: only journal acceptances route to pools, so the combination is a
  // caller bug, never a silent no-op.
  const pools = [...(args.pools ?? [])].map((p) => assertPoolToken(p)).sort();
  if (new Set(pools).size !== pools.length)
    throw new EpEnvelopeError("internal", `the pools list for "${args.endpoint}/${args.instanceId}" carries duplicates; the provisioner enumerates each pre-created pool once (SPEC 13.9)`);
  if (pools.length > 0 && !journalClass)
    throw new EpEnvelopeError("failed-precondition", `"${args.endpoint}" registers no journal-class command but the provisioner asserts pools [${pools.join(", ")}]; only journal acceptances route to work pools (SPEC 13.6/13.9)`);

  const current = await args.readProcessEpoch();
  if (!Number.isSafeInteger(current) || current < 0)
    throw new EpEnvelopeError("internal", `the authoritative mapping read returned ${JSON.stringify(current)}, not an unsigned processEpoch`);
  if (args.epoch !== current)
    throw new EpEnvelopeError("expired", `serve grant for epoch ${args.epoch} but the authoritative mapping's current processEpoch is ${current}; a serve credential binds the CURRENT incarnation only (SPEC 13.1/13.9)`);

  const grant: EpServeGrant = Object.freeze({
    space: args.space,
    endpoint: spec.endpoint,
    instanceId: iId,
    epoch: args.epoch,
    owner: spec.owner,
    registrationRevision: specEntry.revision,
    nameAuthorityRevision,
    commands: Object.freeze([...commands]) as readonly string[],
    surface: Object.freeze(surface),
    journalClass,
    pools: Object.freeze([...pools]) as readonly string[],
    descriptor: deriveDescriptor(
      { endpoint: spec.endpoint, owner: spec.owner, ...(spec.endpointType !== undefined ? { endpointType: spec.endpointType } : {}) },
      clusters,
    ),
  });
  AUTHORIZED_SERVE.set(grant, {
    space: args.space, endpoint: spec.endpoint, instanceId: iId, epoch: args.epoch,
    owner: spec.owner, registrationRevision: specEntry.revision, nameAuthorityRevision, commands: [...commands],
    journalClass, pools: [...pools],
  });
  return grant;
}

/** The §13.7 two-stage content-address read behind every serve authorization: a registered
 *  digest is a CLOSURE digest naming a MANIFEST, whose `root` names the cluster DOCUMENT. Both
 *  are fetched through `readClusterArtifact` and both are verified; a raw root document presented
 *  at a closure-digest key would conflate the two identities. */
async function verifiedServeSurface(
  spec: ServiceSpec,
  instanceId: string,
  readClusterArtifact: (digest: string) => Promise<unknown> | unknown,
): Promise<{
  surface: Record<string, EpCommandAuthority>;
  commands: string[];
  clusters: { digest: string; document: ClusterDocument; raw: Record<string, unknown> }[];
  journalClass: boolean;
}> {
  const read = async (digest: string, what: string): Promise<unknown> => {
    let raw: unknown;
    try {
      raw = await readClusterArtifact(digest);
    } catch (err) {
      throw new EpEnvelopeError("unavailable", `the contract-store read seam failed for ${what} ${digest}; serve authorization fails closed (SPEC 13.7): ${(err as Error)?.message ?? String(err)}`);
    }
    if (raw === undefined)
      throw new EpEnvelopeError("failed-precondition", `${what} ${digest} is not readable from the contract store; an unverifiable registered surface never authorizes (SPEC 13.7)`);
    return raw;
  };
  // Null-prototype: "constructor" is a valid command token, and on a plain `{}` the duplicate
  // check below would resolve the inherited `Object.prototype.constructor` (falsely refusing a
  // legitimate command as "declared twice") while every downstream `surface[command]` lookup
  // (serve construction, governed-surface verification) would leak through the prototype.
  const surface: Record<string, EpCommandAuthority> = Object.create(null);
  const commands: string[] = [];
  const clusters: { digest: string; document: ClusterDocument; raw: Record<string, unknown> }[] = [];
  for (const closureDigest of spec.clusterDigests) {
    const manifestRaw = await read(closureDigest, "registered cluster manifest");
    let root: string;
    try {
      ({ root } = verifyClusterManifest(closureDigest, manifestRaw));
    } catch (err) {
      throw new EpEnvelopeError("internal", `registered cluster manifest ${closureDigest} of "${spec.endpoint}/${instanceId}" fails verification; mediated registered state that does not verify is a writer/store bug, never authority (SPEC 13.7): ${(err as Error).message}`);
    }
    const rootRaw = await read(root, "registered cluster document");
    let document: ClusterDocument;
    try {
      document = verifyClusterRoot(root, rootRaw);
    } catch (err) {
      throw new EpEnvelopeError("internal", `registered cluster document ${root} (closure ${closureDigest}) fails verification; mediated registered state that does not verify is never authority (SPEC 13.7): ${(err as Error).message}`);
    }
    for (const cmd of document.commands) {
      if (surface[cmd.name] !== undefined)
        throw new EpEnvelopeError("internal", `the registered clusters of "${spec.endpoint}" declare command "${cmd.name}" twice; an ambiguous registered surface never authorizes (SPEC 13.7)`);
      surface[cmd.name] = Object.freeze({
        clusterDigest: closureDigest,
        class: cmd.class,
        targeted: cmd.targeted,
        modes: Object.freeze([...(cmd.modes ?? [])]) as readonly EpAuthzMode[],
        ...(cmd.authorities !== undefined ? { authorities: Object.freeze([...cmd.authorities]) as readonly PrincipalAuthority[] } : {}),
        capability: cmd.capability,
        inputDigest: cmd.inputDigest,
        outputDigest: cmd.outputDigest,
        traits: Object.freeze([...(cmd.traits ?? [])]) as readonly string[],
      });
      commands.push(cmd.name);
    }
    // The inline copy for describe is the verified ROOT cluster DOCUMENT (its command
    // declarations), never the manifest: a consumer verifies it against the advertised closure
    // digest by reconstructing the single-member manifest `{v:1, root: digest(document),
    // members:[]}` (§13.7 two-digest read). Inlining the manifest would ship bytes whose
    // `commands` disagree with the sibling command list.
    clusters.push({ digest: closureDigest, document, raw: rootRaw as Record<string, unknown> });
  }
  commands.sort(); // deterministic full surface
  // Journal class is REGISTERED truth: derived from the verified surface, never caller-asserted.
  const journalClass = commands.some((cmd) => surface[cmd].class === "journal");
  return { surface, commands, clusters, journalClass };
}

/** What makes a guest's access bearer a signed credential rather than bytes it was handed: the
 *  exact `iss` the pinned authority mints and the keys that authority publishes at its JWKS. Both
 *  come from the registered space's authority URL the guest already pins, tenant path included:
 *  the auth provider's `serviceEndpointInfo` answer carries them and satisfies this type as it is.
 *  A key set chosen by the caller or read from a bare shared origin proves nothing. The bearer
 *  never names where its key comes from. */
export interface GuestServeAuthenticity {
  issuer: string;
  keys: readonly ServiceIssuerKey[];
}

/** The authenticity a guest takes from the authority's own info answer. A door that predates the
 *  issuer identity answers without it, and a guest that cannot verify its bearer refuses to serve
 *  rather than brand on bytes it cannot check. */
export function serveAuthenticityOf(info: ServiceAuthorityInfo): GuestServeAuthenticity {
  if (info.issuer === undefined || info.keys === undefined)
    throw new EpEnvelopeError("failed-precondition", "the service authority does not publish its issuer identity; a guest cannot verify its access bearer until the authority is upgraded");
  return { issuer: info.issuer, keys: info.keys };
}

/** The user-token `ver` a service access bearer carries (the host validator's constant). */
const SERVICE_ACCESS_BEARER_VER = 1;
/** Clock tolerance on `iat` and `nbf` only; expiry is refused at the original second (SPEC 13.9). */
const SERVICE_ACCESS_CLOCK_TOLERANCE_SEC = 5;

/** A signed service access bearer whose issue time exceeds this process's clock tolerance.
 *  Carries no bearer material; the refusal remains permission-denied. */
export class ServiceAccessNotYetValidError extends EpEnvelopeError {
  constructor() {
    super("permission-denied", "the access bearer is issued in the future; an unverified bearer binds no serve grant (SPEC 13.9)");
    this.name = "ServiceAccessNotYetValidError";
  }
}

// A declared `never` return narrows the control flow after each call; an inferred arrow does not.
function refuseBearer(why: string): never {
  throw new EpEnvelopeError("permission-denied", `the access bearer ${why}; an unverified bearer binds no serve grant (SPEC 13.9)`);
}
const closedRecord = (value: unknown, fields: readonly string[]): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    && fields.every((k) => Object.hasOwn(value, k)) && Object.keys(value).every((k) => fields.includes(k))
    ? (value as Record<string, unknown>) : undefined;
const jsonPart = (part: string): unknown => {
  try { return JSON.parse(Buffer.from(part, "base64url").toString("utf8")); } catch { return undefined; }
};

/**
 * Verify a service access bearer the way the host's token validator does, with the issuer's published
 * key: EdDSA over the compact JWS with the key the header's `kid` names, no embedded key
 * material, the closed service-access claim set (SPEC 13.9), the exact issuer, the space as the
 * only audience, the registered owner as subject, the fixed at-most-60-second lifetime, and the
 * serve duty on exactly `witness`. Returns nothing: a bearer that does not verify refuses.
 */
function verifyServiceAccessBearer(bearer: string, witness: ServiceRegistrationWitness, auth: GuestServeAuthenticity): void {
  const parts = bearer.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) refuseBearer("is not a compact JWS");
  const header = closedRecord(jsonPart(parts[0]), ["alg", "kid"]);
  if (!header || header.alg !== "EdDSA" || typeof header.kid !== "string" || !header.kid || header.kid.length > 256)
    refuseBearer("header is not {alg: EdDSA, kid}");
  const key = auth.keys.find((k) => k.kid === header!.kid);
  if (!key || key.kty !== "OKP" || key.crv !== "Ed25519" || typeof key.x !== "string" || !isCanonicalEd25519PublicCoordinate(key.x))
    refuseBearer("names a kid the issuer does not publish as a full-order Ed25519 key");
  let publicKey;
  try { publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.x }, format: "jwk" }); } catch { refuseBearer("names a published key that does not import"); }
  if (!verifySignature(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey!, Buffer.from(parts[2], "base64url")))
    refuseBearer("signature does not verify under the issuer's published key");

  const payload = closedRecord(jsonPart(parts[1]), ["iss", "aud", "sub", "iat", "nbf", "exp", "scope", "ver", "act"]);
  if (!payload) refuseBearer("payload is not the closed service access claim set");
  const act = closedRecord(payload!.act, ["owner", "actor", "scope", "lifecycleUid", "credentialId", "view", "service"]);
  const service = act && closedRecord(act.service, ["duty", "witness"]);
  const { iat, nbf, exp } = payload! as { iat: unknown; nbf: unknown; exp: unknown };
  // The process clock, never a caller's: a clock the caller picks would brand an expired or
  // not-yet-issued bearer the host then refuses.
  const now = Math.floor(Date.now() / 1000);
  if (payload!.iss !== auth.issuer) refuseBearer("was not minted by the pinned issuer");
  if (payload!.aud !== witness.space) refuseBearer("is not scoped to exactly this space");
  if (payload!.sub !== witness.principal.owner) refuseBearer("subject is not the registered owner");
  if (payload!.ver !== SERVICE_ACCESS_BEARER_VER || !Array.isArray(payload!.scope) || payload!.scope.length !== 0)
    refuseBearer("version or scope is not the service access shape");
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(nbf) || !Number.isSafeInteger(exp) || (iat as number) < 0
    || nbf !== iat || (exp as number) <= (iat as number) || (exp as number) - (iat as number) > SERVICE_ACCESS_TTL_SECONDS)
    refuseBearer("lifetime is not the fixed service access lifetime");
  if ((iat as number) > now + SERVICE_ACCESS_CLOCK_TOLERANCE_SEC) throw new ServiceAccessNotYetValidError();
  if ((exp as number) <= now) refuseBearer("has expired");
  if (!act || !service || act.view !== "service-endpoint" || service.duty !== "serve" || act.owner !== payload!.sub
    || act.actor !== witness.principal.actor || act.lifecycleUid !== witness.principal.lifecycleUid
    || act.credentialId !== witness.rootCredentialId || !Array.isArray(act.scope) || act.scope.length !== 0)
    refuseBearer("actor claim is not the serve duty for this registered principal");
  if (canonicalJson(service.witness) !== canonicalJson(witness)) refuseBearer("names another registration witness");
}

/**
 * The guest-side reconstitution seam (SPEC §13.6: "Registration returns the host-authorized
 * serving snapshot ... An additive stock reconstitution seam explicitly validates this
 * authenticated host-to-guest direction and produces the process-local branded serve grant").
 * A service that registered through the service door holds a parsed `credential` result and its
 * own embedded contract closure, and no store access, so {@link authorizeServeGrant} is out of
 * its reach and {@link authorizeTrustedServeSnapshot} is the host's. This seam takes those
 * inputs plus the pinned issuer's published keys and proves the binding before it brands:
 *   - the result is a `credential` for the serve duty whose witness names the pinned account
 *     (the parser already bound the snapshot's owner, revisions and epoch to the witness);
 *   - the access bearer the guest will present is a signed credential: its EdDSA signature
 *     verifies under the key the pinned issuer publishes, and its closed claims name the pinned
 *     issuer, this space, the registered owner, the serve duty and exactly this witness
 *     ({@link verifyServiceAccessBearer}, the claim checks the host's token validator runs);
 *   - the snapshot's closure set is the guest's embedded closure, digest for digest, and every
 *     artifact the host answered is byte-identical to the guest's own copy;
 *   - every closure verifies as manifest and root, the same §13.7 read the registry runs.
 * What the bearer signs is the witness: the account, instance, epoch and revisions the grant
 * carries are signed values, so a bearer the issuer did not sign for exactly this witness cannot
 * pass. The closure is not in the witness; it is bound to the caller's own registration, which is
 * the guest's embedded contract and nothing a bearer vouches for. Pools are provisioning truth a
 * guest cannot assert, so the grant carries none.
 */
export async function authorizeGuestServeGrant(args: {
  /** The pinned DATA-account public key of the authority the result came from. */
  accountPublicKey: string;
  /** The `credential` result as {@link parseServiceAuthorityResult} returned it, or the renewal
   *  source's copy of it without the renewal material; the seam reads no renewal field. */
  result: ServiceEndpointCredential;
  /** The guest's embedded closure: the registration it submitted. */
  registration: ServiceRegistration;
  /** The pinned issuer and its published keys, read from the origin the guest already pins. */
  authenticity: GuestServeAuthenticity;
}): Promise<EpServeGrant> {
  const { result } = args;
  if (result.state !== "credential" || result.duty !== "serve")
    throw new EpEnvelopeError("permission-denied", "a guest serve grant needs a serve-duty credential result (SPEC 13.9)");
  const { witness, snapshot } = result;
  if (witness.accountPublicKey !== args.accountPublicKey || witness.space !== result.space)
    throw new EpEnvelopeError("permission-denied", "the credential's witness belongs to another native account or space (SPEC 13.9)");
  const spec = snapshot.spec.value;
  if (spec.endpoint !== witness.endpoint || spec.owner !== witness.principal.owner
    || snapshot.spec.revision !== witness.registrationRevision || snapshot.name.authorized !== true
    || snapshot.name.revision !== witness.nameAuthorityRevision || snapshot.processEpoch !== witness.processEpoch)
    throw new EpEnvelopeError("permission-denied", "the snapshot disagrees with the registration witness (SPEC 13.9)");
  verifyServiceAccessBearer(result.accessBearer, witness, args.authenticity);
  const sorted = (digests: readonly string[]) => canonicalJson([...digests].sort());
  if (sorted(spec.clusterDigests) !== sorted(args.registration.clusterDigests))
    throw new EpEnvelopeError("permission-denied", `the host registered a closure set for "${spec.endpoint}" that is not the guest's embedded closure (SPEC 13.7)`);
  const embedded = new Map(args.registration.contractArtifacts.map((artifact) => [contractDigest(artifact), canonicalJson(artifact)] as const));
  const answered = new Map<string, unknown>();
  for (const artifact of snapshot.contractArtifacts) {
    const digest = contractDigest(artifact);
    if (embedded.get(digest) !== canonicalJson(artifact))
      throw new EpEnvelopeError("permission-denied", `the host answered contract artifact ${digest} that the guest did not embed (SPEC 13.7)`);
    answered.set(digest, artifact);
  }
  if (answered.size !== embedded.size)
    throw new EpEnvelopeError("permission-denied", `the host answered ${answered.size} contract artifacts for ${embedded.size} embedded (SPEC 13.7)`);
  const iId = assertLifecycleToken(witness.instanceId, "instanceId");
  const { surface, commands, clusters, journalClass } = await verifiedServeSurface(spec, iId, (digest) => answered.get(digest));
  const grant: EpServeGrant = Object.freeze({
    space: witness.space,
    endpoint: spec.endpoint,
    instanceId: iId,
    epoch: witness.processEpoch,
    owner: spec.owner,
    registrationRevision: snapshot.spec.revision,
    nameAuthorityRevision: snapshot.name.revision,
    commands: Object.freeze([...commands]) as readonly string[],
    surface: Object.freeze(surface),
    journalClass,
    pools: Object.freeze([]) as readonly string[],
    descriptor: deriveDescriptor(
      { endpoint: spec.endpoint, owner: spec.owner, ...(spec.endpointType !== undefined ? { endpointType: spec.endpointType } : {}) },
      clusters,
    ),
  });
  AUTHORIZED_SERVE.set(grant, {
    space: witness.space, endpoint: spec.endpoint, instanceId: iId, epoch: witness.processEpoch,
    owner: spec.owner, registrationRevision: snapshot.spec.revision, nameAuthorityRevision: snapshot.name.revision,
    commands: [...commands], journalClass, pools: [],
  });
  return grant;
}

/** The brand check every consuming seam runs: `serve` must be the ARTIFACT
 *  {@link authorizeServeGrant} returned, field-for-field equal to its authorized snapshot. A
 *  structural copy, a raw literal, or a diverging value refuses — serve authority flows only
 *  THROUGH the registry authorization. Returns the immutable snapshot (space/owner/epoch/
 *  registrationRevision the release fence checks against). */
export function assertServeGrantAuthorized(serve: EpServeGrant): AuthorizedServe {
  const snap = AUTHORIZED_SERVE.get(serve);
  if (!snap)
    throw new EpEnvelopeError("permission-denied", "the serve artifact was not authorized against the registered service (authorizeServeGrant); a raw or copied value never carries serve authority (SPEC 13.9)");
  if (snap.space !== serve.space || snap.endpoint !== serve.endpoint || snap.instanceId !== serve.instanceId
    || snap.epoch !== serve.epoch || snap.owner !== serve.owner || snap.registrationRevision !== serve.registrationRevision
    || snap.nameAuthorityRevision !== serve.nameAuthorityRevision
    || snap.commands.length !== serve.commands.length || snap.commands.some((cmd, i) => serve.commands[i] !== cmd)
    || snap.journalClass !== serve.journalClass
    || snap.pools.length !== serve.pools.length || snap.pools.some((p, i) => serve.pools[i] !== p))
    throw new EpEnvelopeError("permission-denied", "the serve artifact diverges from its authorized snapshot; refusing mutated serve authority (SPEC 13.9)");
  return snap;
}

/** The mint-side CONTEXT binding (`permissionsFor`, profile `endpoint-serve`): brand + snapshot
 *  equality plus the mint context bound to the artifact (same space, and the minted principal
 *  IS the registered owner — an authorized artifact for space A/owner X emits rows for no other
 *  space or principal). This is NOT the freshness fence: {@link finalizeServeIssuance} is, and
 *  `mintCreds` runs it before releasing the credential. */
export function assertServeGrantMintable(serve: EpServeGrant, mint: { space: string; holderOwner: string }): AuthorizedServe {
  const snap = assertServeGrantAuthorized(serve);
  if (mint.space !== snap.space)
    throw new EpEnvelopeError("permission-denied", `the serve artifact was authorized for space "${snap.space}", not "${mint.space}"; serve authority never crosses spaces (SPEC 13.9)`);
  if (mint.holderOwner !== snap.owner)
    throw new EpEnvelopeError("permission-denied", `the serve artifact belongs to the registered owner "${snap.owner}"; principal "${mint.holderOwner}" cannot mint from it (SPEC 13.9)`);
  return snap;
}

// ---- the durable issuance fence (§13.1 "A read is never a fence; only a CAS write is") --------

/** The observed state of an instance's durable issuance gate (§13.1: the auth bucket's
 *  `gate.<lifecycleUid>`, leader-served with `allow_direct=false` so a read is read-your-writes,
 *  never a follower's stale `open`). ONE key binds ALL THREE currency authorities the serve mint
 *  depends on: `processEpoch` (advanced by a takeover barrier), `registrationRevision` (advanced
 *  by a re-registration barrier), and `nameAuthorityRevision` (advanced when the endpoint NAME's
 *  authority binding transfers, §13.9). `generation` is a monotonic freeze/reopen counter (every
 *  barrier bumps it, so a superseded mint's rebuilt CAS loses even if two coordinates coincide).
 *  `revision` is the KV store revision the mint's CAS and every barrier's freeze pin. */
export type EpGateState = GateStateOp & {
  /** The host-only family discriminator from the persisted endpoint gate. */
  authorityFamily?: "environment-manager" | "service";
  serviceAuthority?: ServiceGateAuthority;
  /** The gate's space. In production the gate physically lives in the per-space
   *  `KV_cotal_auth_<space>` bucket (§13.12), so the space is the bucket and cannot be crossed;
   *  carrying it here is defense-in-depth for the in-memory seam/fake, so a mint/registration
   *  handed a gate constructed for another space is refused rather than trusting the caller wired
   *  the right bucket. */
  space: string;
  /** The gate's OWN instance identity, `(endpoint, lifecycleUid)` (§13.1). For an endpoint the
   *  lifecycle identity is `instanceId`, which SPEC 13.1 makes unique only within
   *  `(space, endpoint)` (its ≥128-bit CSPRNG entropy is what makes the SPEC's `gate.<lifecycleUid>`
   *  key collision-free within the space bucket). Binding the ENDPOINT here is the explicit
   *  identity check that does not rely on that entropy: a caller that passes a DIFFERENT endpoint's
   *  gate sharing the instance token (or any wrong gate) is refused, never confused, and the
   *  credential family stays per-`(endpoint, instance)`. The durable keys carry the endpoint
   *  explicitly: the normative DISJOINT endpoint families are `epgate.<endpoint>.<instanceId>`
   *  and `epcred.<endpoint>.<instanceId>.<credentialId>` (SPEC 13.9/13.12 — disjoint from the
   *  agent `gate.<lifecycleUid>`/`cred.…` families by PREFIX, never arity), so the key
   *  derivation matches this check rather than leaning on the instance-token entropy alone.
   *  The agent families stay endpoint-blind BY DESIGN (a lifecycle uid is space-globally
   *  reserved, not an endpoint child). */
  endpoint: string;
  lifecycleUid: string;
  /** The registered serving instance's CONNZ-attributable connection principal (`<owner>.<actor>`
   *  dot-form, §13.1): the eviction target, and the value every `epcred` row MUST copy
   *  as its `holderPrincipal`. The mint is bound to it — a credential whose minting `owner.actor`
   *  is not this principal (a SIBLING ACTOR under the registered owner) cannot win the gate — so
   *  the ledger/eviction target can never diverge from the registered serving principal. */
  principal: string;
  generation: number;
  processEpoch: number;
  registrationRevision: number;
  nameAuthorityRevision: number;
  revision: number;
};

/** The successor gate coordinate a barrier reopens at (§13.1): the three currency dimensions plus
 *  the bumped `generation`. A re-registration advances `registrationRevision`; a takeover advances
 *  `processEpoch`; a name transfer advances `nameAuthorityRevision`; each also bumps `generation`. */
export interface EpGateSuccessor {
  generation: number;
  processEpoch: number;
  registrationRevision: number;
  nameAuthorityRevision: number;
}

/** One staged credential-ledger row, durably keyed in the ENDPOINT family
 *  `epcred.<endpoint>.<instanceId>.<credentialId>` (SPEC 13.9/13.12; disjoint by prefix from the
 *  agent `cred.<lifecycleUid>.…` family, which stays endpoint-blind by design): written BEFORE
 *  the winning CAS and carrying the NORMATIVE ledger fields (§13.1) so a later barrier's
 *  enumeration can find the credential, prove which surface/incarnation it covered, and EVICT its
 *  holder:
 *   - `credentialId` is the PER-ISSUED-JWT identity (a digest of the credential), so standing
 *     renewal (multiple JWTs for one nkey) writes a DISTINCT row each time — the §13.1 invariant
 *     "every credential ever released resolves to a row" holds, and monotonic `state` is never
 *     overwritten by a re-mint;
 *   - `credentialKey` is the stable holder NKEY the broker revokes by (many JWTs share it);
 *   - `holderPrincipal` (owner.actor) is what cluster-wide eviction targets;
 *   - `lifecycleUid` is the instance's never-reused lifecycle identity (the gate key);
 *   - `sourceChain` is the credential's §13.1 issuance lineage (`root` | `handle.…` | `session.…`);
 *   - `state` is monotonic — a barrier flips `active`→`revoked`, never back;
 *   - `exp` is the credential's expiry (for ledger audit/GC);
 *   - the three currency coordinates + `generation` pin the incarnation the surface covered. */
export interface EpServeLedgerRow {
  credentialId: string;
  credentialKey: string;
  /** Required only for encrypted service-callout issuance. */
  serviceConnection?: ServiceConnectionBinding;
  holderPrincipal: string;
  /** The served endpoint — the instance token is unique only within `(space, endpoint)`, so the
   *  credential family is keyed by `(endpoint, lifecycleUid)`, never the instance token alone. */
  endpoint: string;
  lifecycleUid: string;
  sourceChain: readonly string[];
  state: "active" | "revoked";
  exp?: number;
  generation: number;
  processEpoch: number;
  registrationRevision: number;
  nameAuthorityRevision: number;
}

/** The MINT half of the durable, single-key issuance-gate seam the serve release fence rides
 *  (§13.1). One gate per instance; production wires it to the endpoint family's
 *  `epgate.<endpoint>.<instanceId>` in the credential ledger (the auth implementation's
 *  `kvServeIssuanceGate`; `allow_direct=false`, revision-pinned CAS). A takeover, a
 *  re-registration, and a name transfer are each a {@link EpIssuanceBarrier} that CASes this SAME
 *  key to `frozen` before proceeding and reopens it at the successor coordinate, so mint-finalize
 *  and every barrier serialize on one key — never a pseudo-transaction across two. */
export interface EpIssuanceGate {
  /** Leader-served read of the gate; `null` when there is no gate for this instance (fail
   *  closed — a serve credential never mints against a missing gate). */
  observe: () => Promise<EpGateState | null> | EpGateState | null;
  /** Write the staged credential-ledger row (the §13.1 "write rows" step), before the CAS.
   *  CREATE-ONLY / idempotent-if-identical: staging a `credentialId` that is already present must
   *  succeed only when the row is byte-identical (a retry of the SAME issuance), and CONFLICT when
   *  it differs (a different holder/lineage or a revoked row must never be overwritten or
   *  resurrected). Because `credentialId` is a per-JWT digest, a distinct JWT (a new epoch's grant
   *  or a later second's renewal) gets a new id, while a byte-identical same-second re-mint at one
   *  epoch re-stages the active row. */
  stage: (row: EpServeLedgerRow) => Promise<void> | void;
  /** Revision-pinned CAS: keep the gate `open`, unchanged, at `expectedRevision`. TRUE iff this
   *  mint won the single-key serialization; FALSE on any change (a freeze/retire, or a
   *  reopen at a new generation/epoch/registrationRevision/nameAuthorityRevision advanced the
   *  revision). */
  commit: (expectedRevision: number) => Promise<boolean> | boolean;
  /** Mark the staged row revoked on CAS loss / abort (the credential is never released). */
  revoke: (row: EpServeLedgerRow) => Promise<void> | void;
  /** Service-only post-CAS leader reads of the bound row and original gate authority. */
  verifyServiceIssuance?: (row: EpServeLedgerRow, observed: EpGateState) => Promise<void> | void;
}

/** The BARRIER half of the SAME single-key gate (§13.1): the typed protocol a takeover, a
 *  re-registration, or a name transfer runs to serialize itself against in-flight serve mints —
 *  NOT ad-hoc mutation. A barrier freezes the gate FIRST (so a fresh mint observes `frozen` and
 *  refuses, and a staged-but-uncommitted mint loses its revision-pinned CAS), enumerates the
 *  ledger rows the superseded surface authorized, revokes/evicts them, then reopens at the
 *  successor coordinate (advancing the dimension it changed). Both halves are exported TOGETHER
 *  so core never publishes an independently-callable unsafe writer beside the fence: the spec
 *  writer {@link registerServiceInstance} drives this seam and has no bare spec-key advance. */
export interface EpIssuanceBarrier {
  /** Stable operation id for this registration attempt. A fresh authority retry reuses it. */
  readonly operationId?: string;
  /** Leader-served read of the gate (same key as the mint's {@link EpIssuanceGate.observe}). */
  observe: () => Promise<EpGateState | null> | EpGateState | null;
  /** Revision-pinned CAS `open` → `frozen` at `expectedRevision`, returning the FENCING TOKEN
   *  (the frozen store revision) on success, or `null` on loss (another barrier froze/reopened,
   *  or the gate retired) — a loser MUST abort and never write the spec. The token is consumed by
   *  {@link reopen} so ONLY the barrier that still holds its freeze can reopen: a stalled/duplicate
   *  barrier resuming after a reconciler cannot clobber the newer gate (§13.1). */
  freeze: (expectedRevision: number) => Promise<number | null> | number | null;
  /** Enumerate the credential-ledger rows under the frozen gate (§13.1 "enumerate the family"):
   *  every credential the incarnation the barrier supersedes authorized. */
  enumerate: () => Promise<EpServeLedgerRow[]> | EpServeLedgerRow[];
  /** Flip one enumerated row `active`→`revoked` (§13.1: enforce revocation on the ledger). */
  revoke: (row: EpServeLedgerRow) => Promise<void> | void;
  /** Report retained rows already revoked and each fully settled successful revocation batch.
   *  This observation does not replace durable rows or verified-holder progress. */
  onRevocationProgress?: (progress: { revoked: number; total: number }) => void;
  /** VERIFIED cluster-wide eviction of revoked holder principals (§13.1): enforce the revocation
   *  on every server, evict the principals' live connections, and RE-SCAN — answering, per holder
   *  in input order, `true` only when that principal is verified GONE. FAIL-CLOSED: a `false` (or a
   *  throw) means the barrier MUST NOT complete (no spec write, no reopen); the gate stays frozen
   *  for reconciliation so old authority is never published-over while it is still live. It takes
   *  a set because a family keeps a row for every credential it ever staged, so evicting one holder
   *  at a time makes every restart slower than the last; registration passes at most
   *  {@link EVICT_PRINCIPALS_MAX} holders per call and records the verdicts before the next call. */
  evict: (holderPrincipals: readonly string[]) => Promise<boolean[]> | boolean[];
  /** Token-pinned CAS `frozen` → `open` at the successor coordinate (§13.1). TRUE iff the gate is
   *  still frozen at THIS barrier's `token`; FALSE if a reconciler/newer barrier superseded it (a
   *  stale reopen loses and never clobbers the newer gate). Advances the currency the barrier
   *  changed, so a superseded mint's rebuilt CAS still loses. */
  reopen: (token: number, successor: EpGateSuccessor) => Promise<boolean> | boolean;
  /** Optional durable progress journal for a long-running registration's verified-eviction phase.
   *  Production endpoint barriers provide it. In-memory test barriers may omit it. */
  progress?: {
    load: () => Promise<{ cursor: EndpointRepairCursor; revision: number } | null>;
    save: (cursor: EndpointRepairCursor, expectedRevision: number | null) => Promise<number>;
    clear: (expectedRevision: number) => Promise<void>;
  };
}

/** The minted-credential context the release fence records into its §13.1 ledger row: the
 *  credential's own identity, its holder ACTOR (the owner comes from the authorized grant, so the
 *  eviction target `holderPrincipal` = `owner.actor`), its provenance lineage, and its expiry.
 *  `mintCreds` supplies these from the same values it stamps into the JWT — the ledger row and
 *  the credential describe ONE credential, never two. */
export interface EpServeCredential {
  /** PER-ISSUED-JWT identity (a digest of the credential): the ledger key; a distinct JWT (a new
   *  epoch's grant or a later second's renewal) writes a new row instead of overwriting the prior
   *  one, while a byte-identical same-second re-mint at one epoch re-stages the active row. */
  credentialId: string;
  /** The stable holder NKEY (public key) the broker revokes by; many JWTs share it. */
  credentialKey: string;
  /** Required only for encrypted service-callout issuance. */
  serviceConnection?: ServiceConnectionBinding;
  /** The holder's actor (owner.actor is the §13.1 eviction target). */
  holderActor: string;
  /** The credential's §13.1 issuance lineage: each element `root` | `handle.<issuerKeyId>.<id>` |
   *  `session.<sessionId>` (a root serve mint is `["root"]`). */
  sourceChain: readonly string[];
  /** The credential's expiry (unix seconds), or `undefined` for a non-expiring credential. */
  exp?: number;
}

/** A §13.1 source-chain element, EXACT grammar: the `root` anchor, a handle-redemption step
 *  `handle.<issuerKeyId>.<id>` (exactly two record-grammar id segments), or a session step
 *  `session.<sessionId>` (exactly one). Owner/actor principal components are NOT a lineage; the
 *  mint records `["root"]` for a serve credential minted directly by the provisioner authority.
 *  Ids are the record grammar `[A-Za-z0-9_-]` (uppercase admitted), bounded, and every segment is
 *  non-empty — so `handle.x`, `handle.x.`, and `session.x.y` all refuse. */
const SOURCE_CHAIN_ID = "[A-Za-z0-9_-]{1,64}"; // the §13.2 / assertIdToken id bound
const SOURCE_CHAIN_ELEMENT = new RegExp(`^(root|handle\\.${SOURCE_CHAIN_ID}\\.${SOURCE_CHAIN_ID}|session\\.${SOURCE_CHAIN_ID})$`);

/**
 * The serve-credential release fence (§13.1 "observe gate → write rows → CAS the gate →
 * release"). `mintCreds` calls this AFTER building the credential and BEFORE returning it, so a
 * credential is released only when its ledger row is durably written and its winning CAS proves
 * the gate was still `open` at the SAME `(processEpoch, registrationRevision, nameAuthorityRevision)`
 * the artifact was verified against:
 *  - observe the gate; a missing gate or a `frozen`/`retired` state refuses (`expired`);
 *  - the observed `processEpoch`, `registrationRevision`, and `nameAuthorityRevision` MUST each
 *    equal the artifact's — a takeover (epoch), a re-registration (revision), or a name transfer
 *    (name authority) that already froze+reopened advanced one of them, and this mint's surface
 *    or its owner is superseded (`expired`);
 *  - stage the NORMATIVE ledger row (`holderPrincipal`/`lifecycleUid`/`sourceChain`/`state`/`exp`
 *    plus the three currency coordinates), then revision-pinned CAS the gate; a LOSS (a
 *    concurrent barrier's freeze CAS won the single key) revokes the staged row and releases
 *    nothing (`expired`).
 * The race is closed by serialization on ONE key: a mint that wins wrote its row before its
 * winning CAS, so a later barrier enumerates and revokes/evicts it by `holderPrincipal`; a mint
 * that loses never released.
 */
export async function finalizeServeIssuance(gate: EpIssuanceGate, serve: EpServeGrant, credential: EpServeCredential): Promise<void> {
  const snap = assertServeGrantAuthorized(serve);
  const boundedId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128;
  if (!boundedId(credential.credentialId))
    throw new EpEnvelopeError("internal", "credentialId must be a bounded non-empty per-JWT identifier");
  if (!boundedId(credential.credentialKey))
    throw new EpEnvelopeError("internal", "credentialKey must be a bounded non-empty identifier (the minted credential's nkey)");
  assertBoundedOwner(credential.holderActor, "serve credential holder actor");
  if (!Array.isArray(credential.sourceChain) || credential.sourceChain.length === 0
    || !credential.sourceChain.every((p) => typeof p === "string" && SOURCE_CHAIN_ELEMENT.test(p)))
    throw new EpEnvelopeError("internal", "the serve credential sourceChain must be a non-empty §13.1 issuance lineage (root | handle.<issuer>.<id> | session.<id>), never principal components");
  if (credential.exp !== undefined && (!Number.isSafeInteger(credential.exp) || credential.exp < 0))
    throw new EpEnvelopeError("internal", `the serve credential exp ${JSON.stringify(credential.exp)} is not an unsigned unix timestamp`);
  credential = { ...credential, sourceChain: [...credential.sourceChain],
    ...(credential.serviceConnection === undefined ? {} : { serviceConnection: parseServiceConnectionBinding(credential.serviceConnection) }) };
  const obs = await gate.observe();
  if (obs === null)
    throw new EpEnvelopeError("expired", `no issuance gate for "${snap.endpoint}/${snap.instanceId}"; a serve credential never mints against a missing gate (SPEC 13.1)`);
  // Gate IDENTITY `(space, endpoint, lifecycleUid)`: the instance token is unique only within
  // `(space, endpoint)`, so ALL must match — a caller that handed a foreign gate (another space's,
  // a different endpoint sharing the instance token, or any wrong gate) with coincidentally
  // matching coordinates is refused (the per-space auth bucket is the production space fence; this
  // is the seam's defense-in-depth).
  if (obs.space !== snap.space || obs.endpoint !== snap.endpoint || obs.lifecycleUid !== snap.instanceId)
    throw new EpEnvelopeError("internal", `the issuance gate is for "${obs.space}/${obs.endpoint}/${obs.lifecycleUid}", not the authorized instance "${snap.space}/${snap.endpoint}/${snap.instanceId}"; a serve credential mints only against its OWN gate (SPEC 13.1)`);
  if (obs.state !== "open")
    throw new EpEnvelopeError("expired", `the issuance gate for "${snap.endpoint}/${snap.instanceId}" is ${obs.state}; minting is closed (SPEC 13.1)`);
  if (obs.authorityFamily !== "service" && credential.serviceConnection !== undefined)
    throw new EpEnvelopeError("failed-precondition", "ordinary serving issuance cannot carry service connection evidence");
  if (obs.authorityFamily === "service") {
    if (!credential.serviceConnection || credential.serviceConnection.userNkey !== credential.credentialKey || !gate.verifyServiceIssuance)
      throw new EpEnvelopeError("failed-precondition", "service issuance requires its authenticated connection binding and native verification");
    const authority = obs.serviceAuthority;
    const now = Math.floor(Date.now() / 1000);
    if (!authority || !authority.activationIssued || !serviceGateApprovalLive(authority, now)
      || credential.exp === undefined || credential.exp <= now || credential.exp > now + SERVICE_ACCESS_TTL_SECONDS
      || credential.exp > authority.rootExpiresAt!
      || (authority.approvalExpiresAt !== null && credential.exp > authority.approvalExpiresAt))
      throw new EpEnvelopeError("expired", "service approval does not authorize this bounded serving credential");
  }
  // JOINT currency on ONE key: a takeover advances processEpoch, a re-registration advances
  // registrationRevision, a name transfer advances nameAuthorityRevision; any one that has
  // already frozen+reopened the gate supersedes the branded surface or its owner, and the read
  // below is safe only because the CAS re-checks the same key.
  if (obs.processEpoch !== snap.epoch)
    throw new EpEnvelopeError("expired", `the issuance gate is at processEpoch ${obs.processEpoch}, not the authorized ${snap.epoch}; a takeover superseded this incarnation (SPEC 13.1)`);
  if (obs.registrationRevision !== snap.registrationRevision)
    throw new EpEnvelopeError("expired", `the issuance gate is at registrationRevision ${obs.registrationRevision}, not the authorized ${snap.registrationRevision}; a re-registration superseded the branded surface (SPEC 13.5/13.9)`);
  if (obs.nameAuthorityRevision !== snap.nameAuthorityRevision)
    throw new EpEnvelopeError("expired", `the issuance gate is at nameAuthorityRevision ${obs.nameAuthorityRevision}, not the authorized ${snap.nameAuthorityRevision}; a name transfer superseded the serving owner (SPEC 13.9)`);
  // SERVING-PRINCIPAL BINDING (§13.1): the mint is bound to the gate's REGISTERED serving
  // principal, not merely the registered owner. authorizeServeGrant proves owner == registered
  // owner, but a SIBLING ACTOR under that owner would otherwise win the real gate and be
  // ledgered/evicted in place of the registered serving instance. The minted `owner.actor` MUST
  // equal `epgate.principal`; on any mismatch the mint releases nothing and writes no active row.
  const mintedPrincipal = principalKey(snap.owner, credential.holderActor).key;
  if (mintedPrincipal !== obs.principal)
    throw new EpEnvelopeError("permission-denied", `the serve mint's principal "${mintedPrincipal}" is not the gate's registered serving principal "${obs.principal}" for "${snap.endpoint}/${snap.instanceId}"; a sibling actor under the registered owner cannot win the endpoint gate (SPEC 13.1)`);
  const row: EpServeLedgerRow = {
    credentialId: credential.credentialId,
    credentialKey: credential.credentialKey,
    ...(credential.serviceConnection ? { serviceConnection: credential.serviceConnection } : {}),
    // The eviction target is the OBSERVED gate principal (== the minted principal, checked above),
    // serialized through the ONE principal serializer the eviction feed keys on (subjects.ts
    // principalKey invariant), so the barrier's enumeration key can never drift from the
    // credential's and always names the registered serving principal (§13.1).
    holderPrincipal: obs.principal,
    endpoint: snap.endpoint,
    lifecycleUid: snap.instanceId,
    sourceChain: Object.freeze([...credential.sourceChain]),
    state: "active",
    ...(credential.exp !== undefined ? { exp: credential.exp } : {}),
    generation: obs.generation,
    processEpoch: obs.processEpoch,
    registrationRevision: obs.registrationRevision,
    nameAuthorityRevision: obs.nameAuthorityRevision,
  };
  await gate.stage(row);
  // Best-effort revoke of the staged row on any non-win, ALWAYS surfacing a revoke failure (never
  // swallowed) so the reconciliation debt is visible — the credential is released only on a win.
  const revokeStaged = async (): Promise<string | undefined> => {
    try { await gate.revoke(row); return undefined; }
    catch (err) { return (err as Error)?.message ?? String(err); }
  };
  // Session siblings and standing serve mints touch the same gate without changing its authority.
  // A revision loss alone is contention, not a takeover. Compare the whole original observation
  // before retrying, so a freeze/reopen or any changed coordinate still refuses the staged mint.
  const withoutRevision = (g: EpGateState): string =>
    JSON.stringify(Object.entries(g).filter(([key]) => key !== "revision").sort(([a], [b]) => (a < b ? -1 : 1)));
  const pinnedTo = withoutRevision(obs);
  let pin = obs.revision;
  let won = false;
  for (let attempt = 0; attempt < 64; attempt++) {
    let current: EpGateState | null;
    try {
      won = await gate.commit(pin);
      if (won) break;
      current = await gate.observe();
    } catch (err) {
      const revokeFailed = await revokeStaged();
      throw new EpEnvelopeError("unavailable", `the issuance-gate CAS failed; refusing to release a serve credential (SPEC 13.1): ${(err as Error)?.message ?? String(err)}${revokeFailed ? `; ALSO the staged-row revoke failed and the row needs barrier reconciliation: ${revokeFailed}` : ""}`);
    }
    if (current === null || withoutRevision(current) !== pinnedTo) {
      const revokeFailed = await revokeStaged();
      throw new EpEnvelopeError("expired", `the issuance gate advanced during mint (a takeover, re-registration, or name transfer won the serialization on ${snap.endpoint}/${snap.instanceId}); this mint released nothing (SPEC 13.1)${revokeFailed ? `; ALSO the staged-row revoke failed and the row needs barrier reconciliation: ${revokeFailed}` : ""}`);
    }
    pin = current.revision;
  }
  if (!won) {
    const revokeFailed = await revokeStaged();
    throw new EpEnvelopeError("unavailable", `the issuance gate stayed contended across every retry; this mint released nothing (SPEC 13.1)${revokeFailed ? `; ALSO the staged-row revoke failed and the row needs barrier reconciliation: ${revokeFailed}` : ""}`);
  }
  if (obs.authorityFamily === "service") {
    try { await gate.verifyServiceIssuance!(row, obs); }
    catch {
      const revokeFailed = await revokeStaged();
      throw new EpEnvelopeError("unavailable", `native service issuance could not be verified after its gate CAS${revokeFailed ? `; staged-row revoke also failed: ${revokeFailed}` : ""}`);
    }
  }
  if (obs.authorityFamily === "service" && credential.exp! <= Math.floor(Date.now() / 1000)) {
    const revokeFailed = await revokeStaged();
    throw new EpEnvelopeError("expired", `service credential expired before release; its fixed expiry is not extended${revokeFailed ? `; staged-row revoke also failed: ${revokeFailed}` : ""}`);
  }
}
