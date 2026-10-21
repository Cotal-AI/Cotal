/**
 * Plane-1 IdP bridge — the token exchange that turns an EXTERNAL IdP-authenticated human into a
 * Cotal user bearer (the plan's §"Plane 1"): verify the IdP's JWT offline against its pinned JWKS,
 * derive the opaque per-space owner from the IdP subject, authorize the requested actor against
 * the operator's ledger, and mint the bearer through the {@link UserTokenIssuer}.
 *
 * The bridge is IdP-GENERIC on purpose (pluggable edges): any IdP that publishes an EdDSA/Ed25519
 * JWKS and mints `iss`/`aud`/`sub`/`exp` JWTs plugs in via {@link IdpConfig} — Better Auth (JWT
 * plugin) is the reference IdP, and the integration smoke runs a real instance. Nothing
 * Better-Auth-specific leaks in here.
 *
 * Trust-boundary order inside {@link IdpBridge.exchange} (each step fail-loud, no fallback):
 *  1. the requested actor is grammar-asserted BEFORE anything else touches it;
 *  2. the IdP token verifies against the PINNED key path only — `alg` pinned to EdDSA, embedded
 *     key material (`jku`/`jwk`/`x5u`/`x5c`) rejected outright, exact `iss`/`aud`, `exp` and a
 *     non-post-dated `iat` required, `sub` a non-empty string (no coercion);
 *  3. the owner derives from the JSON-array encoding of [idp issuer, sub] — issuer-namespaced so
 *     the same `sub` from two IdPs can never collide, INJECTIVE by construction (JSON escaping —
 *     no delimiter an issuer/sub pair could straddle), and deterministic so re-login re-lands in
 *     the same lanes. This encoding is FROZEN: changing it (or the IdP issuer string) re-keys
 *     every owner in the space — a migration, like rotating the space secret;
 *  4. the ledger hook AUTHORIZES (owner, actor) and is the ONLY source of `scope`/`parent` — the
 *     request cannot carry them (server-authored `act`, no confused deputy). The hook must return
 *     an explicit grant object; anything else is a deny;
 *  5. the issuer mints (which re-asserts every claim shape — the issuer ↔ validator inverse).
 */
import { decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import type { CryptoKey, JWTPayload, JWTVerifyGetKey } from "jose";
import { assertValidOwnerToken } from "@cotal-ai/core";
import { deriveOwnerForIdpSubject } from "./derive.js";
import type { UserTokenIssuer } from "./issuer.js";
import { CLOCK_TOLERANCE_SEC, USER_TOKEN_VIEWS, VIEW_REQUIRED_SCOPE, viewTtlCapSec, type UserTokenSession, type UserTokenTransferWriter, type UserTokenView } from "./token.js";
import { grantCommandLine } from "./grant-command.js";

/** The pinned identity of ONE external IdP. All fields are operator config — nothing in here is
 *  ever read from a presented token. */
export interface IdpConfig {
  /** Exact `iss` the IdP mints (Better Auth default: its base-URL origin). */
  issuer: string;
  /** Exact `aud` the IdP mints (Better Auth default: its base-URL origin). */
  audience: string;
  /** The pinned verification key path over the IdP's JWKS — a {@link pinnedJwksResolver} on the
   *  IdP's JWKS URL, or a local public key. The token never influences key resolution. */
  key: JWTVerifyGetKey | CryptoKey;
}

/** What the operator's ledger grants a (owner, actor) pair — the ONLY source of `scope`/`parent`
 *  in the minted bearer. Returned by {@link CreateIdpBridgeOpts.authorizeActor}; the hook throws
 *  to deny. */
export interface ActorGrant {
  scope?: string[];
  /** The row's CURRENT channel ACLs, when the bridge's ledger can supply them. A refusal that has
   *  to print a re-grant needs these: `cotal actor grant` is a whole-row upsert, so a command that
   *  names only the field being changed resets these two to `>` and `>`. Optional because the hook
   *  is pluggable; a bridge that cannot supply them gets a refusal that names the flags and
   *  refuses to invent their values, rather than one that prints a placeholder. */
  allowSubscribe?: string[];
  allowPublish?: string[];
  /** Carried for the same reason: an upsert that does not name them drops them. */
  role?: string;
  label?: string;
  /** The spawning principal (`<owner>.<actor>` dot-form), when the ledger records one. */
  parent?: string;
  /** The row's lifecycle UID (SPEC 13.1) — stamped into the bearer so a predecessor incarnation's
   *  still-unexpired bearer can never be minted the successor's broker authority at connect. */
  lifecycleUid?: string;
}

export interface CreateIdpBridgeOpts {
  /** The one IdP this bridge trusts. */
  idp: IdpConfig;
  /** The space every minted bearer is scoped to (`aud`). One bridge per space. */
  space: string;
  /** The space's owner-derivation secret (≥32 bytes, operator-held). */
  spaceSecret: string | Uint8Array;
  /** The Plane-1 issuer that mints the Cotal bearer. */
  issuer: UserTokenIssuer;
  /** The ledger authority: is `actor` a live, ledger-authorized instance of `owner`, and what does
   *  it get? MUST return an {@link ActorGrant} object to allow; throw to deny. There is no
   *  allow-by-default — a hook that returns anything else fails the exchange. */
  authorizeActor: (owner: string, actor: string) => ActorGrant | Promise<ActorGrant>;
  /** The ROOT-credential ensure (R1, SPEC 13.1): returns the incarnation's live root credential
   *  id, minting it release-last on first exchange; throws to deny. Its result rides
   *  `act.credentialId`, which the connect arm requires against the LIVE `cred.` row. REQUIRED and
   *  construction-validated (like {@link authorizeActor}): a bridge that could mint a CLAIMLESS
   *  bearer is a silent-degrade hazard — in ANY composition that wires this public bridge without
   *  the v0.4 deny-new arm, a claimless bearer means the credential-liveness check has nothing to
   *  bite and deny-new never engages at all. The public v0.4 mint API therefore MUST NOT be able
   *  to emit a claimless shape whose safety depends on a separate component being wired. A
   *  genuinely different connect-authority model gets its own explicit constructor that still
   *  emits a conformant credential id. (`validateUserToken` stays tolerant of an absent claim so
   *  the CONNECT boundary owns the signed deny-new denial for pre-cut/forged tokens.) */
  mintConnectCredential: (args: { owner: string; actor: string; lifecycleUid: string }) => Promise<string>;
  /** The dedicated `aud` of `dm-reader` proofs (#4189), from the same pinned IdP issuer and keys.
   *  Explicit operator config: it is never derived from, or defaulted to, `idp.audience`, and
   *  construction refuses it when it equals `idp.audience`, so every exact-audience verifier of
   *  ordinary proofs refuses a `dm-reader` proof. Absent: the bridge refuses the `dm-reader` view. */
  dmReaderAudience?: string;
}

/** A successful exchange: the minted bearer plus what a caller needs to cache/refresh it. */
export interface ExchangeResult {
  /** The Cotal user bearer (compact JWS) the agent presents in `auth_token`. */
  token: string;
  /** The derived opaque owner the bearer is bound to. */
  owner: string;
  /** Bearer expiry (unix seconds) — schedule re-mint before this. */
  exp: number;
}

export interface IdpBridge {
  /** Exchange a verified IdP token for a Cotal user bearer bound to (derived owner, actor).
   *  `view` requests a per-connection profile ({@link USER_TOKEN_VIEWS}), authorized against
   *  the fresh ledger grant and its explicit required-scope policy, then stamped into `act.view`.
   *  This bridge handles human proofs only; the actor-secret handler separately allows the
   *  narrowing manager-caller view. */
  exchange(idpToken: string, req: {
    actor: string; ttlSec?: number; view?: UserTokenView; managerInstanceId?: string;
    /** #2312, required for view "session-caller": the identity plane's session decision for the
     *  principal this bridge derived. Returns the session claim to stamp; throws to refuse. */
    verifySession?: (p: { owner: string; actor: string; lifecycleUid: string }) => Promise<UserTokenSession>;
    /** Required for view "transfer-writer": the one object the bearer may upload (#1499). */
    transferWriter?: UserTokenTransferWriter;
  }): Promise<ExchangeResult>;
}

/** Verified IdP claims. Optional password provenance is retained only when well-shaped;
 * ordinary exchanges do not require it or gain consent authority from it. */
export interface VerifiedIdpToken {
  sub: string;
  exp: number;
  auth_time?: number;
  amr?: readonly string[];
}

/** The one `purpose` value a purpose-bound proof may carry (#4189). */
export const DM_READER_PURPOSE = "dm-reader";

/** A verified `dm-reader` proof: the human, the proof's expiry, and the three claims that bind it to
 *  one reader incarnation in one space. */
export interface DmReaderProof {
  sub: string;
  exp: number;
  actor: string;
  lifecycle: string;
  space: string;
}

/** The pinning shared by every IdP proof: alg, key path, exact issuer, exact single `audience`,
 *  a bounded lifetime and a string subject. Returns the verified payload. */
async function verifyPinnedIdpJwt(token: string, idp: IdpConfig, audience: string): Promise<JWTPayload & { exp: number; iat: number; sub: string }> {
  const header = decodeProtectedHeader(token);
  if (header.jku !== undefined || header.jwk !== undefined || header.x5u !== undefined || header.x5c !== undefined)
    throw new Error("idp token: embedded key material (jku/jwk/x5u/x5c) is rejected - keys resolve only via the pinned JWKS");
  if (header.alg !== "EdDSA") throw new Error(`idp token: alg must be EdDSA (got ${String(header.alg)})`);

  const { payload } = await jwtVerify(token, idp.key as JWTVerifyGetKey, {
    algorithms: ["EdDSA"],
    issuer: idp.issuer,
    audience,
    clockTolerance: CLOCK_TOLERANCE_SEC,
  });

  // jose's `audience` option is SET-MEMBERSHIP (an aud array containing the expected value
  // passes) — exact means the token's audience set is exactly {configured}: the plain string, or
  // a singleton array of it. A multi-audience session proof minted for other services too must
  // not be exchangeable here.
  if (payload.aud !== audience && !(Array.isArray(payload.aud) && payload.aud.length === 1 && payload.aud[0] === audience))
    throw new Error("idp token: aud must be exactly the configured audience - a multi-audience session proof is rejected");
  if (typeof payload.exp !== "number") throw new Error("idp token: exp is required - an IdP session proof must expire");
  if (typeof payload.iat !== "number") throw new Error("idp token: iat is required");
  if (payload.iat > Math.floor(Date.now() / 1000) + CLOCK_TOLERANCE_SEC) throw new Error("idp token: iat is in the future");
  if (typeof payload.sub !== "string" || !payload.sub)
    throw new Error("idp token: sub must be a non-empty string user id - no coercion at a trust boundary");
  return payload as JWTPayload & { exp: number; iat: number; sub: string };
}

/** Verify an external IdP JWT against the pinned config and return its `sub` AND `exp`. Same pinning
 *  posture as `validateUserToken`, minus the Cotal claim shape (an IdP token has no `ver`/`act`; its
 *  lifetime is the IdP's session policy — but it must expire and must not be post-dated). The `exp` is
 *  returned so `exchange` can CAP the minted Cotal bearer to the upstream proof's remaining life.
 *  A token carrying a `purpose` claim is refused: a purpose-bound proof is accepted only by the one
 *  exchange its purpose names, never as a general human proof (#4189). */
export async function verifyIdpToken(token: string, idp: IdpConfig): Promise<VerifiedIdpToken> {
  const payload = await verifyPinnedIdpJwt(token, idp, idp.audience);
  if (Object.hasOwn(payload, "purpose"))
    throw new Error("idp token: a token carrying a purpose claim is not a general human proof - it is accepted only by the exchange its purpose names");
  return {
    sub: payload.sub, exp: payload.exp,
    ...(typeof payload.auth_time === "number" && Number.isSafeInteger(payload.auth_time) && payload.auth_time >= 0
      ? { auth_time: payload.auth_time } : {}),
    ...(Array.isArray(payload.amr) && payload.amr.length > 0 && payload.amr.every(method => typeof method === "string" && method.length > 0)
      ? { amr: Object.freeze([...payload.amr] as string[]) } : {}),
  };
}

/** Verify a `dm-reader` proof (#4189): the same pinned issuer and keys as every IdP proof, the
 *  dedicated `audience`, `purpose` exactly {@link DM_READER_PURPOSE}, and non-empty string `actor`,
 *  `lifecycle` and `space` claims. Matching those claims to the request is the exchange's job. */
export async function verifyDmReaderProof(token: string, idp: IdpConfig, audience: string): Promise<DmReaderProof> {
  const payload = await verifyPinnedIdpJwt(token, idp, audience);
  if (payload.purpose !== DM_READER_PURPOSE)
    throw new Error(`dm-reader proof: purpose must be "${DM_READER_PURPOSE}" - an absent, unknown or malformed purpose is refused`);
  for (const claim of ["actor", "lifecycle", "space"] as const)
    if (typeof payload[claim] !== "string" || !payload[claim])
      throw new Error(`dm-reader proof: the ${claim} claim must be a non-empty string`);
  return { sub: payload.sub, exp: payload.exp, actor: payload.actor as string, lifecycle: payload.lifecycle as string, space: payload.space as string };
}

/** A private-result consent proof, not consent or permission to read any result. */
export interface ToolResultHumanProof {
  readonly sub: string;
  readonly exp: number;
  readonly authTime: number;
}

/** Verify the pinned signed proof before applying the consent-only, five-minute password rule.
 * The host clock returns integer milliseconds and is read after verification;
 * no rounding or JWT tolerance widens this window. */
export async function verifyToolResultHumanProof(
  token: string, idp: IdpConfig, now: () => number = Date.now,
): Promise<ToolResultHumanProof> {
  const verified = await verifyIdpToken(token, idp);
  const at = verified.auth_time;
  const ms = now();
  if (!Number.isSafeInteger(ms) || ms < 0 || at === undefined || at * 1000 > ms || ms - at * 1000 > 300_000 ||
      !verified.amr?.includes("pwd") || verified.exp * 1000 <= ms)
    throw new Error("tool-result consent requires a fresh signed password proof");
  return Object.freeze({ sub: verified.sub, exp: verified.exp, authTime: at });
}

/**
 * The re-grant an elevated-view refusal points the operator at.
 *
 * `cotal actor grant` is an upsert of the WHOLE row, so a command naming only the scope resets the
 * row's channel ACLs to `>` and `>` and drops its role and label. Until this was fixed, that was
 * exactly what this refusal printed, described as "the upsert replaces the scope list".
 *
 * The command is printed only when the bridge's ledger supplied the row's CURRENT values, in which
 * case every field is real and the line is genuinely paste-ready. When it did not, no command is
 * printed at all: a line carrying `\'<current read set>\'` looks paste-ready, fails on an invalid
 * channel, and the operator's shortest route to a command that succeeds is to delete the flag,
 * which is the wide default this exists to avoid. Naming the flags and refusing to invent their
 * values is the honest answer.
 */
function regrantRemedy(owner: string, actor: string, grant: ActorGrant, need: string): string {
  const scope = [...new Set([...(grant.scope ?? []), need])];
  if (grant.allowSubscribe === undefined || grant.allowPublish === undefined)
    return (
      "no ready-to-run line is printed here, and that is deliberate: this bridge did not supply the row's " +
      "current ACLs, so a printed command would either invent them or leave them off, and a flag " +
      "left off comes back as the WIDE default, `>` read and `>` post. Read the row first " +
      "(`cotal actor list`), then re-grant it whole: the scope it already carries plus " +
      `"${need}", and --allow-subscribe and --allow-publish set to exactly what that row holds today.`
    );
  return (
    "run exactly the line below, which already carries every other field the row holds today. " +
    grantCommandLine(owner, actor, {
      scope,
      allowSubscribe: grant.allowSubscribe,
      allowPublish: grant.allowPublish,
      ...(grant.role ? { role: grant.role } : {}),
      ...(grant.label ? { label: grant.label } : {}),
    }) +
    "  (every field spelled out on purpose: the upsert replaces the WHOLE row, not just the scope, " +
    "and a field left off comes back as the WIDE default, `>` read and `>` post)"
  );
}

/** Build an {@link IdpBridge}. Misconfig fails HERE, at construction — an empty pin would
 *  otherwise fail closed on every exchange with a far worse operator signal. */
export function createIdpBridge(opts: CreateIdpBridgeOpts): IdpBridge {
  if (!opts.space) throw new Error("idp bridge: a space is required");
  if (typeof opts.idp?.issuer !== "string" || !opts.idp.issuer)
    throw new Error("idp bridge: idp.issuer (the exact iss pin) is required");
  if (typeof opts.idp.audience !== "string" || !opts.idp.audience)
    throw new Error("idp bridge: idp.audience (the exact aud pin) is required");
  if (!opts.idp.key) throw new Error("idp bridge: idp.key (the pinned JWKS resolver / public key) is required");
  if (typeof opts.authorizeActor !== "function")
    throw new Error("idp bridge: an authorizeActor ledger hook is required - there is no allow-by-default");
  if (typeof opts.mintConnectCredential !== "function")
    throw new Error("idp bridge: a mintConnectCredential hook is required (SPEC 13.1, R1) - the v0.4 bridge must stamp every bearer's incarnation root credential; a claimless mint would silently disable deny-new in any composition without the connect arm");
  const dmReaderAudience = opts.dmReaderAudience;
  if (dmReaderAudience !== undefined) {
    if (typeof dmReaderAudience !== "string" || !dmReaderAudience)
      throw new Error("idp bridge: dmReaderAudience must be a non-empty string when present");
    if (dmReaderAudience === opts.idp.audience)
      throw new Error("idp bridge: dmReaderAudience must differ from idp.audience - a dm-reader proof on the ordinary audience would pass every exact-audience verifier of ordinary proofs");
  }
  return {
    exchange: async (idpToken, req) => {
      if (req.view === "service-endpoint") throw new Error("service-endpoint requires the dedicated service authority exchange");
      assertValidOwnerToken(req.actor);
      // A dm-reader view rides ONLY a dm-reader proof, and a dm-reader proof rides only that view:
      // the generic verifier refuses its audience and its purpose claim, and the dedicated verifier
      // refuses an ordinary token's audience and missing purpose.
      let dmProof: DmReaderProof | undefined;
      if (req.view === "dm-reader") {
        if (dmReaderAudience === undefined)
          throw new Error('the "dm-reader" view needs a dedicated proof audience (dmReaderAudience), and this bridge has none configured');
        dmProof = await verifyDmReaderProof(idpToken, opts.idp, dmReaderAudience);
        if (dmProof.actor !== req.actor) throw new Error("dm-reader proof: its actor claim is not the requested actor");
        if (dmProof.space !== opts.space) throw new Error("dm-reader proof: its space claim is not this bridge's space");
      }
      const { sub, exp: idpExp } = dmProof ?? await verifyIdpToken(idpToken, opts.idp);
      // The (issuer, sub) → derivation-input encoding lives in ONE place (deriveOwnerForIdpSubject),
      // shared with the operator grant command — the ledger's grant-time owner and the exchange-time
      // owner must be the same bytes or every grant silently misses.
      const owner = deriveOwnerForIdpSubject(opts.spaceSecret, opts.idp.issuer, sub);
      const grant = await opts.authorizeActor(owner, req.actor);
      if (grant === null || typeof grant !== "object" || Array.isArray(grant))
        throw new Error("idp bridge: authorizeActor must return a grant object - anything else is a deny");
      if (req.view === "manager-service")
        throw new Error('view "manager-service" is not a bearer profile; use the typed manager-service authority exchange');
      if (req.view !== undefined) {
        // An elevated view is authorized against the FRESH grant just read, per the central
        // policy table (admin-gated operator views; spawn-gated deployer). The refusal names the
        // exact re-grant (ADD to the current list — the upsert replaces it), mirroring the
        // control-op copy.
        if (!USER_TOKEN_VIEWS.includes(req.view))
          throw new Error(`view "${String(req.view)}" is not a known view (${USER_TOKEN_VIEWS.join(", ")})`);
        const need = VIEW_REQUIRED_SCOPE[req.view];
        if (need !== undefined && !(grant.scope ?? []).includes(need))
          throw new Error(
            `the "${req.view}" view needs scope "${need}", which your grant lacks. Ask the mesh operator to re-grant the WHOLE ROW with "${need}" ADDED to its scope. This is not a scope edit: ` +
              regrantRemedy(owner, req.actor, grant, need),
          );
      }
      // Lifecycle-BIND every human bearer at the MINT boundary (SPEC 13.1), views included: the
      // grant row's uid rides act.lifecycleUid and the callout requires exact equality with the
      // CURRENT row at every connect, so a predecessor's still-unexpired bearer (agent OR
      // elevated view) dies at the alias's re-grant. A grant without a uid is a pre-cut row and
      // cannot mint - minting claimless would only defer the same refusal to every connect.
      if (typeof grant.lifecycleUid !== "string" || !grant.lifecycleUid)
        throw new Error(
          `idp bridge: the grant for actor "${req.actor}" carries no lifecycleUid - re-grant it (bearers are lifecycle-bound from v0.4)`,
        );
      if (dmProof && dmProof.lifecycle !== grant.lifecycleUid)
        throw new Error("dm-reader proof: its lifecycle claim is not the current grant's - an old lifecycle's proof mints nothing");
      // Cap the minted bearer's lifetime to the IdP proof's REMAINING life: the Cotal bearer must not
      // outlive the session proof it rests on. Otherwise a near-expired (or stolen just-before-expiry)
      // IdP JWT would exchange for a full MAX_TOKEN_TTL_SEC bearer, widening authority past the upstream
      // proof and defeating the "revocation bites when the IdP session lapses" model. An already-lapsed
      // proof cannot mint anything (fail-loud). The relative TTL alone is not that cap: the hooks below
      // await before the issuer reads its clock, so `notAfter` carries the proof's ABSOLUTE expiry
      // (and a session-caller's session expiry) to signing time, and the issuer refuses once it passes.
      let notAfter = Math.floor(idpExp);
      const idpRemaining = idpExp - Math.floor(Date.now() / 1000);
      if (idpRemaining <= 0)
        throw new Error("idp bridge: the IdP session proof has expired - cannot mint a bearer");
      let ttlSec = Math.min(req.ttlSec ?? viewTtlCapSec(req.view), idpRemaining);
      let session: UserTokenSession | undefined;
      if (req.view === "session-caller") {
        if (!req.verifySession) throw new Error('view "session-caller" needs the identity plane\'s session decision - refusing to mint');
        session = await req.verifySession({ owner, actor: req.actor, lifecycleUid: grant.lifecycleUid });
        ttlSec = Math.min(ttlSec, Math.max(1, session.exp - Math.floor(Date.now() / 1000)));
        notAfter = Math.min(notAfter, session.exp);
      }
      // Credential-BIND the bearer (SPEC 13.1, R1): the incarnation's live root credential id
      // rides act.credentialId — ensured (minted release-last on first exchange) BEFORE the
      // bearer bytes are signed, so the row the connect arm requires is durable before any
      // bearer naming it exists. Views included: EVERY bearer carries the claim. The hook is
      // required at construction, so this never mints a claimless bearer.
      const credentialId = await opts.mintConnectCredential({ owner, actor: req.actor, lifecycleUid: grant.lifecycleUid });
      const token = await opts.issuer.issue({
        owner,
        space: opts.space,
        actor: req.actor,
        scope: grant.scope,
        parent: grant.parent,
        lifecycleUid: grant.lifecycleUid,
        credentialId,
        view: req.view,
        managerInstanceId: req.managerInstanceId,
        ...(session ? { session } : {}),
        ...(req.transferWriter ? { transferWriter: req.transferWriter } : {}),
        ttlSec,
        notAfter,
      });
      const { exp } = decodeJwt(token);
      if (typeof exp !== "number") throw new Error("idp bridge: minted bearer is missing exp - issuer contract violated");
      return { token, owner, exp, ...(req.managerInstanceId ? { managerInstanceId: req.managerInstanceId } : {}) };
    },
  };
}
