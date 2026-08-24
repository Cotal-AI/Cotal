/**
 * The AUTH SERVICE daemon — the one server-side process a user-auth space runs alongside its broker
 * (the delivery-daemon pattern: spawned detached by `cotal up`, pid-filed per space, torn down by
 * `cotal down`). It hosts BOTH halves of the identity plane, which share state and so belong in one
 * isolated process rather than smeared across the manager/delivery daemons:
 *
 *  - **Plane 2 — the NATS auth callout** ({@link startAuthCallout}): answers `$SYS.REQ.USER.AUTH`
 *    over its own callout-account connection, validating bearers offline against the LOCAL issuer
 *    key set and minting scoped data-account user JWTs.
 *  - **Plane 1 — the token exchange + JWKS, over loopback HTTP**: `POST /exchange` turns a fresh
 *    IdP JWT (from `cotal login`'s cached session) into a Cotal user bearer via the pinned
 *    {@link createIdpBridge}; `GET /jwks` publishes the issuer's public keys.
 *
 * Least-privilege by construction: the daemon loads ONLY provider-owned projected files from its
 * space-scoped state dir (`.cotal/auth/<space>/`) — the data-account signing seed arrives via
 * `service-keys.json` (minting scoped users IS this service's function); the space's operator seed
 * and account seed never enter this process (`prepareServer` wrote the projection and kept the rest).
 *
 * The exchange surface is LOCAL-V1, hardened: loopback bind only; `POST /exchange` requires the
 * per-start high-entropy capability (`Authorization: Bearer <cap>` — readable only from the 0600
 * discovery file, so same-user file ACL is the boundary); requests carrying an `Origin` header are
 * rejected (a browser page can reach loopback; it must not be able to drive the exchange); bodies
 * must be `application/json`; failed exchanges are rate-limited and logged. No CORS headers, ever.
 *
 * REMOTE EXCHANGE — the OPTIONAL second listener (`--exchange-public-port`, also binding
 * 127.0.0.1; TLS terminates at a reverse proxy — in-process TLS was rejected: it duplicates cert
 * renewal and forks deploy). It serves ONLY `GET /health`, `GET /jwks`, `POST /exchange`, and
 * `GET /.well-known/cotal-mesh` (the generated discovery bundle); everything else 404s. Its
 * `/exchange` demands NO capability — honestly: the 0600 cap is a same-uid file-ACL boundary with
 * no remote meaning, so requiring its bytes from a remote caller would prove nothing. The proof on
 * the public face is the credential itself: the human arm presents an EdDSA IdP JWT verified
 * against the pinned JWKS/issuer/audience; the agent arm presents an actorToken whose sha256 must
 * match a FRESH ledger row. Origin rejection, JSON-only bodies, the 64 KB bound, and no-CORS-ever
 * hold verbatim; `view` requests are REFUSED outright (operator surfaces stay loopback-only);
 * failures are bucketed per peer (`--exchange-trusted-proxy` opts into the last X-Forwarded-For
 * hop as the peer key; otherwise the socket remote address) in a bounded LRU, under a global
 * concurrent-admission cap and a hard request deadline — all of it pools SEPARATE from the
 * loopback face's budgets, and successful exchanges stay unthrottled on both faces.
 *
 * Both trust boundaries authorize against the SAME actor ledger, read fresh per request — a revoke
 * bites at the next exchange AND the next connect with no restart.
 *
 * JWKS cache contract (gate 4, explicit): responses carry `Cache-Control: max-age=300`. A verifier
 * may cache the set for up to 5 minutes, so a rotated-out (retired) kid MUST stay published for at
 * least (300s + the max bearer TTL) after rotation before `retire` — otherwise still-live bearers
 * signed by it fail verification at a cold cache. The local callout uses `issuer.localKeySet()`
 * (live, in-process) and is exempt.
 *
 * Readiness contract: the discovery file (`auth-service.json`) is written only AFTER the callout
 * subscription is FLUSHED to the broker and the HTTP listener is bound — its existence (plus a
 * /health probe) IS the readiness signal the provider's `ready()` polls.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { admissionMediatorGrants, EpEnvelopeError, ensureAuthorityStores, isReachable, type ParsedArgs, type SecretStore } from "@cotal-ai/core";
import { findCotalRoot, userAuthStateDir, workspaceSecretStore } from "@cotal-ai/workspace";
import { decodeJwt } from "jose";
import { startAuthCallout } from "./callout.js";
import { createIdpBridge, type IdpBridge } from "./idp.js";
import type { UserTokenView, ValidatedUserToken } from "./token.js";
import { pinnedJwksResolver, type UserTokenIssuer } from "./issuer.js";
import { calloutPermissions } from "./permissions.js";
import { authorityBarrierGrants, authorityWriterGrants, openAuthorityClient, openSupervisedConnectReader } from "./authority-client.js";
import { authorizeConnectCredential } from "./connect-reader.js";
import { ensureRootCredential } from "./root-credential.js";
import { observeGate, openLifecycleRegistry, type LifecycleRegistry } from "./lifecycle-registry.js";
import { openAuthLedgerScannerCandidate, type AuthLedgerScanner, type LedgerScannerCandidate } from "./ledger-scanner.js";
import { openRecordsScannerCandidate, type RecordsScanner, type RecordsScannerCandidate } from "./records-scanner.js";
import { acquirePlaneClaim, makeDeliveryAdminPlaneOracle, scannerDeathCopy, type PlaneClaimHold, type PlaneLivenessOracle } from "./plane-claim.js";
import { enumerateOperationIntents, resumeAgentTakeover, type EvictPrincipal } from "./credential-ledger.js";
import { makeDeliveryAdminEvictor } from "./barrier-evict.js";
import { resumeAgentRetirement, type RetirementDeps } from "./retirement-barrier.js";
import { makeRetirementCleaners } from "./retirement-cleaner.js";
import { makeDrainRepairers } from "./drain-repair.js";
import { openAuthAdminListener, type AuthAdminListener } from "./auth-admin.js";
import { drainTargetForEndpoint, openAdmissionMediator } from "./admission-mediator.js";
import {
  AGENT_BEARER_TTL_SEC,
  ledgerAclResolver,
  ledgerAuthorizeAgentExchange,
  ledgerAuthorizeConnect,
  ledgerAuthorizeGrant,
} from "./ledger.js";
import {
  clearAuthServiceInfo,
  loadCalloutAuth,
  loadIssuer,
  loadOwnerSecret,
  loadPinnedIdp,
  loadServiceKeys,
  saveAuthServiceInfo,
  spaceIssuer,
} from "./store.js";

/** JWKS max-age seconds — the cache contract's knob. Exported so a rotation tool can compute the
 *  retire floor (max-age + max bearer TTL) from it. */
export const JWKS_MAX_AGE_SEC = 300;

/** Failed-exchange rate limit: at most this many REFUSED exchanges per rolling minute; further
 *  attempts get 429 until the window drains. Successes are unthrottled (the CLI's normal path). */
const FAILED_EXCHANGE_PER_MIN = 30;

/** Invalid-capability attempts get their OWN window (same size): an unauthenticated local prober
 *  is throttled AND audited, but never consumes the refused-exchange budget of a caller holding
 *  the real capability — a cap-less process must not be able to starve legitimate exchanges. */
const BAD_CAP_PER_MIN = 30;

/** PUBLIC-face budgets — their own pools entirely, so public probing can never consume the
 *  loopback face's windows (and vice versa). Successes stay unthrottled, matching the loopback
 *  stance. */
const PUBLIC_FAILED_PER_MIN = 30; // per-PEER refused-exchange window (rolling minute)
const PUBLIC_PEER_BUCKETS_MAX = 1024; // bounded LRU of per-peer failure buckets
const PUBLIC_MAX_IN_FLIGHT = 64; // global concurrent-admission cap on the public listener
const PUBLIC_DEADLINE_MS = 10_000; // hard wall-clock deadline per public request

type Values = Record<string, string | undefined>;

/** The service's AUTHORITY PLANE (R1, SPEC 13.1): the two self-minted data-account connections
 *  behind (a) the composed connect authorizer — the file-ledger arm PLUS the credential deny-new
 *  arm through the supervised, shape-proved reader — and (b) the exchange-time root-credential
 *  ensure both exchange arms stamp `act.credentialId` from. */
export interface AuthAuthorityPlane {
  authorizeConnect: (t: ValidatedUserToken) => Promise<void>;
  mintConnectCredential: (args: { owner: string; actor: string; lifecycleUid: string }) => Promise<string>;
  /** Resolves with the state-3 copy when a mid-life scanner death FENCES the plane (SPEC 13.13):
   *  the plane is no longer whole, `authorizeConnect`/`mintConnectCredential` refuse from that
   *  moment, and the composition root must take the whole service DOWN loud (a fenced plane that
   *  kept minting would look healthy while a successor reclaims its scanners). Never resolves on a
   *  clean close. */
  fenced: Promise<string>;
  close(): Promise<void>;
}

/**
 * Open the authority plane — the PRODUCTION connect/exchange composition (exported so the live
 * deny-new smoke exercises exactly what the daemon runs). Boot order is the readiness contract:
 * the MINT WRITER connects first and ensures both authority stores exist with their normative
 * shape ({@link ensureAuthorityStores}; the reader's bind proof requires them), then the
 * lifecycle registry binds (its own §13.12 shape proof), then the supervised CONNECT READER
 * binds + proves. Any failure throws — the daemon refuses to come up rather than serving
 * connects it cannot credential-check (no file-only fallback).
 *
 * These are STATIC data-account users (signed by the data-account signing key), so they never
 * transit the auth callout — the callout cannot deadlock on its own reader.
 */
export async function openAuthAuthorityPlane(opts: {
  server: string;
  space: string;
  /** The provider state dir — the file-ledger connect arm reads it fresh per connect. */
  dir: string;
  dataAccount: { pub: string; signingSeed: string };
  log: (line: string) => void;
  /** SMOKE-ONLY eviction override for the barrier executor's boot resume. Production
   *  compositions never set this: the real capability is the delivery daemon's
   *  `ctl.delivery-admin` rail ({@link makeDeliveryAdminEvictor}). */
  probeEvictor?: EvictPrincipal;
  /** SMOKE-ONLY plane-liveness override for the plane claim's stale-reclaim adjudication.
   *  Production compositions never set this: the real oracle is the delivery daemon's
   *  `ctl.delivery-admin` rail ({@link makeDeliveryAdminPlaneOracle}). */
  probePlaneOracle?: PlaneLivenessOracle;
  /** SMOKE-ONLY scanner-death injector: receives kill switches for the two plane-owned scanner
   *  connections so a test can force the mid-life fencing path (a non-reconnecting connection has
   *  no natural failure to inject). Production compositions never set this. */
  probePlaneDeath?: (kill: { ledger: () => Promise<void>; records: () => Promise<void> }) => void;
}): Promise<AuthAuthorityPlane> {
  const { server, space, dataAccount, log } = opts;
  const writer = await openAuthorityClient({ server, space, dataAccount, label: `cotal:auth-mint:${space}`, grants: (id) => authorityWriterGrants(space, id), log });
  let registry;
  try {
    await ensureAuthorityStores(await jetstreamManager(writer.nc), new Kvm(writer.nc), space);
    registry = await openLifecycleRegistry(writer.nc, space);
  } catch (e) {
    await writer.close();
    throw e;
  }
  let reader;
  try {
    reader = await openSupervisedConnectReader({ server, space, dataAccount, log });
  } catch (e) {
    await writer.close();
    throw e;
  }
  // The BARRIER EXECUTOR: the third self-minted connection, with its own registry bind — the
  // mint writer stays the minimal issuance credential ("barriers are NOT this credential's
  // job") and the barrier's stage-write authority lives here alone. The barrier profile holds NO
  // auth-stream `CONSUMER.CREATE` (nats-server#8274): its family/intent/lineage enumeration runs
  // on the SEALED auth-ledger scanner, a FOURTH self-minted connection whose CREATE-capable
  // credential never escapes ({@link openAuthLedgerScannerCandidate}), threaded into the barrier
  // registry. The retirement barrier's OBLIGATION drain (§13.8, records stream) enumerates the
  // same way and for the same #8274 reason: a FIFTH self-minted connection, the SEALED records
  // scanner ({@link openRecordsScannerCandidate}), is opened co-located and threaded into the SAME
  // barrier registry (the ONE records scanner per space the composition owns). The mint-writer
  // registry above carries neither scanner — only the barrier registry enumerates.
  //
  // THE PLANE CLAIM (#29 HIGH 3, SPEC 13.13) gates the whole block: both scanner connections open
  // FIRST as INERT candidates (non-reconnecting, identities captured, no scan capability exists),
  // then the claim is taken by broker-atomic create/CAS on the ONE `plane` auth-KV key. Only the
  // WINNER activates the branded scanners; a loser closes both candidates and this open REFUSES
  // with the operator-legible copy (live peer / inconclusive / concurrent). A stale held claim is
  // reclaimed on LIVENESS ALONE: both claimed tuples conclusively absent under a COMPLETE CONNZ
  // sweep, adjudicated over the delivery-admin rail (auth holds no $SYS). A mid-life scanner
  // disconnect FENCES the plane: the guard refuses every later scan, the sibling closes, and the
  // in-flight enumeration's result is discarded by the post-scan claim check.
  let barrier;
  let ledgerCand: LedgerScannerCandidate | undefined;
  let recordsCand: RecordsScannerCandidate | undefined;
  let hold: PlaneClaimHold | undefined;
  let scanner: AuthLedgerScanner | undefined;
  let recordsScanner: RecordsScanner | undefined;
  let barrierReg;
  let closing = false;
  // The plane-fatal channel (fact HIGH: a fenced plane must never keep serving): the mid-life
  // fence resolves it, every authority operation refuses from then on, and the composition root
  // downs the daemon. A clean close never resolves it.
  let fatalReason: string | undefined;
  let fireFatal!: (reason: string) => void;
  const fenced = new Promise<string>((r) => { fireFatal = r; });
  try {
    barrier = await openAuthorityClient({ server, space, dataAccount, label: `cotal:auth-barrier:${space}`, grants: (id) => authorityBarrierGrants(space, id), log });
    ledgerCand = await openAuthLedgerScannerCandidate({ server, space, dataAccount, log });
    recordsCand = await openRecordsScannerCandidate({ server, space, dataAccount, log });
    const oracle = opts.probePlaneOracle ?? makeDeliveryAdminPlaneOracle({ space, server, dataAccount, log });
    hold = await acquirePlaneClaim({ nc: barrier.nc, space, ledger: ledgerCand.tuple, records: recordsCand.tuple, oracle, log });
    scanner = ledgerCand.activate(hold.guard);
    recordsScanner = recordsCand.activate(hold.guard);
    // Mid-life disconnect = the FENCING event (security req: an owned scanner that dies must not
    // leave the plane half-running). First death wins: fence the guard with the ux state-3 copy,
    // close the sibling so a successor's reclaim isn't blocked by a half-dead pair, log loud.
    const fenceOnDeath = (role: "auth-ledger" | "records", sibling: () => Promise<void>) => {
      if (closing) return;
      const copy = scannerDeathCopy(space, role);
      hold?.fence(copy);
      fatalReason = fatalReason ?? copy;
      fireFatal(copy);
      log(`auth-plane: ${copy}`);
      void sibling().catch(() => {});
    };
    void ledgerCand.gone.then(() => fenceOnDeath("auth-ledger", () => recordsCand?.close() ?? Promise.resolve()));
    void recordsCand.gone.then(() => fenceOnDeath("records", () => ledgerCand?.close() ?? Promise.resolve()));
    const lc = ledgerCand, rc = recordsCand;
    opts.probePlaneDeath?.({ ledger: () => lc.close(), records: () => rc.close() });
    barrierReg = await openLifecycleRegistry(barrier.nc, space, scanner, recordsScanner);
  } catch (e) {
    // Clean-close order even on a failed open: scan-capable clients first, THEN the claim release
    // (held → released is valid only once neither scanner can act), then the rest.
    closing = true;
    await recordsCand?.close();
    await ledgerCand?.close();
    await hold?.release();
    await barrier?.close();
    await reader.close();
    await writer.close();
    throw e;
  }
  const evictPrincipal = opts.probeEvictor ?? makeDeliveryAdminEvictor({ space, server, dataAccount, log });
  // The RETIREMENT deps (#29 piece 4): the barrier's injected mechanics, assembled from reviewed
  // §13.9 profiles only. The obligation drain runs per endpoint on a SHORT-LIVED client minted
  // with that endpoint's admission-mediator profile (the daemon owns no standing mediator; the
  // drain is the first production mediator composition), sharing the plane's ONE sealed records
  // scanner. The per-op cleaner/executor credentials come from the piece-2 split factory.
  //
  // THE CONFINED DRAIN REPAIRERS (#29 HIGH 1 functional closure): the mediator hands CLOSED,
  // already-validated repair commands; the per-op executors ({@link makeDrainRepairers}) mint an
  // exact-coordinate credential per repair, execute, and close. Covered classes now COMPLETE on
  // resume instead of freezing: an accepted self-commit re-applies (or classifies landed /
  // superseded), an accepted pool route re-enqueues create-only. THREE distinct operator
  // outcomes (ux):
  //  1. auto-completed - the retirement finishes; the repair is logged, no freeze message;
  //  2. a covered-class repair that still cannot land names its SPECIFIC reason (an out-of-class
  //     commit key refuses in the executor with the confused-deputy copy; a CAS loss reports
  //     "another writer moved the record" and the next pass re-classifies);
  //  3. accepted EFFECTS work terminalizes through the RETIREMENT-CANCEL terminal (§13.8 option
  //     (i)): a first-terminal-wins cancelled marker on the SAME completion coordinate — an
  //     action's goal union already carries the first-class `cancelled` state, a non-action
  //     effect gets the EffectCancelledFact union member. Never a forged success: a reader sees
  //     the effect did NOT run and which retirement cancelled it; a racing real completion wins
  //     by landing first.
  const repairers = makeDrainRepairers({ server, space, dataAccount, log });
  const retirement: RetirementDeps = {
    evictPrincipal,
    drainTargetObligations: async (endpoint, targetUid, opId) => {
      const drain = await openAuthorityClient({
        server, space, dataAccount,
        label: `cotal:ep-drain:${space}:${endpoint}`,
        grants: (id) => admissionMediatorGrants(space, endpoint, id),
        log,
      });
      try {
        await drainTargetForEndpoint(await openAdmissionMediator(drain.nc, space, endpoint, { recordsScanner }), targetUid, {
          applyCommit: repairers.applyCommitFor(opId),
          reconcilePoolRoute: repairers.reconcilePoolRouteFor(opId),
          cancelEffectsRoute: repairers.cancelEffectsRouteFor(opId),
        });
      } finally {
        await drain.close();
      }
    },
    ...makeRetirementCleaners({ server, space, dataAccount, log }),
    now: Date.now,
  };
  // Boot crash-resume BEFORE the plane answers anything (SPEC 13.1): finish every takeover this
  // executor owes from its durable intents. A garbled intent store fails the boot (we cannot
  // know what we owe); an individual resume failure is LOUD but non-fatal — that alias stays
  // frozen (nothing mints for it, fail-closed) while every other alias keeps working, and a
  // later restart re-drives it.
  try {
    await resumeOpenOperations(barrierReg, evictPrincipal, retirement, log);
  } catch (e) {
    closing = true;
    await recordsScanner.close();
    await scanner.close();
    await hold.release();
    await barrier.close();
    await reader.close();
    await writer.close();
    throw e;
  }
  // The AUTH CONTROL RAIL (#29 piece 3, SPEC 13.2 CONTROL_AUTH_ADMIN): serve the generic
  // "retire a lifecycle" op over a dedicated minimal listener credential. Every executing right
  // stays with the plane's own registry + retirement deps (the drain rides the ONE sealed records
  // scanner exactly like the boot resume); the listener only authorizes (subject attribution +
  // the FRESH space-manager-lease holder check) and dispatches.
  let authAdmin: AuthAdminListener | undefined;
  try {
    authAdmin = await openAuthAdminListener({ server, space, dataAccount, reg: barrierReg, retirement, log });
  } catch (e) {
    closing = true;
    await recordsScanner.close();
    await scanner.close();
    await hold.release();
    await barrier.close();
    await reader.close();
    await writer.close();
    throw e;
  }
  const fileArm = ledgerAuthorizeConnect(opts.dir);
  // Every authority operation refuses once the plane is fenced: a half-dead plane keeps NO face up.
  // AUDIENCE SPLIT (ux): these refusals reach a CONNECTING AGENT during the brief fence→exit
  // window, not the operator — the agent cannot "restart the auth service", so it gets a retryable
  // unavailability, while the operator's state-3 copy stays on the log and the exit line.
  const refuseIfFenced = () => {
    if (fatalReason !== undefined)
      throw new EpEnvelopeError("unavailable",
        `the auth service for space "${space}" is momentarily unavailable (it detected a fault and is restarting); retry shortly`);
  };
  return {
    authorizeConnect: async (t) => {
      refuseIfFenced();
      fileArm(t);
      await authorizeConnectCredential(reader.current(), t, Date.now);
    },
    mintConnectCredential: (args) => {
      refuseIfFenced();
      return ensureRootCredential(registry, { ...args, managerInstance: `auth-service:${space}` });
    },
    fenced,
    close: async () => {
      // Clean-close order (SPEC 13.13): the rail stops answering first, then scan-capable
      // clients down, then `held → released` (never released while either scanner can still
      // act), then the barrier that wrote it.
      closing = true;
      await authAdmin?.close();
      await reader.close();
      await recordsScanner.close();
      await scanner.close();
      await hold.release();
      await barrier.close();
      await writer.close();
    },
  };
}

/**
 * Boot crash-resume (SPEC 13.1): enumerate the durable operation intents and finish every
 * barrier this executor OWES — an intent is owed exactly when its gate is still FROZEN by that
 * opId (completed and lost operations leave their intent behind by design and are skipped).
 * A frozen TAKEOVER resumes through {@link resumeAgentTakeover}; session-derived descendants
 * fail loud inside the barrier until the session reconciler is wired (the #29 trigger slice).
 * A frozen RETIREMENT resumes through {@link resumeAgentRetirement} with the plane's assembled
 * {@link RetirementDeps} (#29 piece 4); its failure is equally loud and non-fatal.
 */
async function resumeOpenOperations(reg: LifecycleRegistry, evictPrincipal: EvictPrincipal, retirement: RetirementDeps, log: (line: string) => void): Promise<void> {
  for (const it of await enumerateOperationIntents(reg)) {
    const gate = await observeGate(reg, it.lifecycleUid);
    if (gate === undefined || gate.row.state !== "frozen" || gate.row.op?.opId !== it.opId) continue;
    if (it.kind === "retirement") {
      try {
        const r = await resumeAgentRetirement(reg, it.opId, retirement);
        log(`auth-barrier: resumed retirement ${it.opId} for ${it.lifecycleUid} (${r.revokedRows} row(s) revoked, ${r.evictedPrincipals.length} principal(s) verified-evicted, ${r.drainedEndpoints.length} endpoint(s) drained, ${Object.keys(r.cleaned).length} pool(s) cleaned, ${Object.keys(r.frontiers).length} frontier stream(s))`);
      } catch (e) {
        log(`auth-barrier: resuming retirement ${it.opId} for ${it.lifecycleUid} FAILED (${e instanceof Error ? e.message : String(e)}) - the gate stays frozen and nothing mints for this alias until a resume succeeds (fail-closed)`);
      }
      continue;
    }
    try {
      const r = await resumeAgentTakeover(reg, it.opId, { evictPrincipal });
      log(`auth-barrier: resumed takeover ${it.opId} for ${it.lifecycleUid} (epoch ${r.toEpoch}, ${r.revokedRows} row(s) revoked, ${r.evictedPrincipals.length} principal(s) verified-evicted)`);
    } catch (e) {
      log(`auth-barrier: resuming takeover ${it.opId} for ${it.lifecycleUid} FAILED (${e instanceof Error ? e.message : String(e)}) - the gate stays frozen and nothing mints for this alias until a resume succeeds (fail-closed)`);
    }
  }
}

/** Run the auth service. Flags: `--space` (required), `--server` (broker URL, required), `--port`
 *  (loopback HTTP port; default ephemeral). All persisted material must already exist (the
 *  provider's `prepareServer` ran at `cotal up`) — a missing piece is a fail-loud config error
 *  naming the fix, never a silent partial service; this daemon LOADS the four secret kinds and
 *  never generates them.
 *
 *  `store` is the hosted composition's injection point for the space's SECRET material (callout
 *  account, issuer keys, owner secret, service key projection) — when given, it is those kinds'
 *  ONLY source (no flag or path can point this daemon at other secret material; an absent key is
 *  the hard error below). Absent, the daemon composes the local workspace store over `.cotal/`.
 *  NON-SEAM state (the actor ledger, the IdP pin, the discovery file) still lives in the local
 *  state dir either way — hosting those is a later, separate seam. */
export async function runAuthService(args: ParsedArgs, store?: SecretStore): Promise<void> {
  const v = args.values as Values;
  const space = v.space;
  if (!space) throw new Error("auth-service: --space is required");
  const server = v.server;
  if (!server) throw new Error("auth-service: --server is required (the broker this callout serves)");
  const port = v.port === undefined ? 0 : Number(v.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error(`auth-service: --port must be a port number, got "${v.port}"`);
  // The optional PUBLIC exchange face (see the module header). The three flags travel together:
  // a public URL or trusted-proxy setting without a listener to apply them to is a config error.
  const publicPortRaw = v["exchange-public-port"];
  const publicPort = publicPortRaw === undefined ? undefined : Number(publicPortRaw);
  if (publicPort !== undefined && (!Number.isInteger(publicPort) || publicPort < 0 || publicPort > 65535))
    throw new Error(`auth-service: --exchange-public-port must be a port number, got "${publicPortRaw}"`);
  const publicUrlFlag = v["exchange-public-url"];
  if (publicUrlFlag !== undefined && !/^https:\/\//.test(publicUrlFlag))
    throw new Error(`auth-service: --exchange-public-url must be an https:// URL (TLS terminates at the reverse proxy), got "${publicUrlFlag}"`);
  const trustedProxy = v["exchange-trusted-proxy"] !== undefined;
  if (publicPort === undefined && (publicUrlFlag !== undefined || trustedProxy))
    throw new Error("auth-service: --exchange-public-url/--exchange-trusted-proxy require --exchange-public-port");
  const advertisedServer = v["advertised-server"];
  if (advertisedServer !== undefined && publicPort === undefined)
    throw new Error("auth-service: --advertised-server rides the public bundle - it requires --exchange-public-port");
  if (advertisedServer !== undefined) {
    const badAdvertised = checkAdvertisedServer(advertisedServer);
    if (badAdvertised) throw new Error(badAdvertised);
  }
  const agentProvisioningUrl = v["agent-provisioning-url"];
  if (agentProvisioningUrl !== undefined && publicPort === undefined)
    throw new Error("auth-service: --agent-provisioning-url rides the public bundle - it requires --exchange-public-port");
  if (agentProvisioningUrl !== undefined) {
    const badProvisioning = checkAgentProvisioningUrl(agentProvisioningUrl);
    if (badProvisioning) throw new Error(badProvisioning);
  }

  // The provider's space-scoped state dir for NON-SEAM material (ledger, IdP pin, discovery). The
  // layout fact is workspace-owned (userAuthStateDir); this daemon never touches `.cotal/auth/auth.json`.
  const root = findCotalRoot();
  const dir = userAuthStateDir(root, space);
  const secrets = store ?? workspaceSecretStore(root);
  // Scrub any stale discovery file FIRST — a dead prior daemon's entry must never satisfy a
  // readiness poll for THIS start (the provider's ready() also pid-checks; belt and braces).
  clearAuthServiceInfo(dir);
  const keys = await loadServiceKeys(secrets, space);
  const callout = await loadCalloutAuth(secrets, space);
  const issuer = await loadIssuer(secrets, space);
  const ownerSecret = await loadOwnerSecret(secrets, space);
  const idp = loadPinnedIdp(dir);
  if (!keys || !callout || !issuer || !ownerSecret || !idp) {
    const missing = [
      ...(keys ? [] : ["service keys"]),
      ...(callout ? [] : ["callout account"]),
      ...(issuer ? [] : ["issuer keys"]),
      ...(ownerSecret ? [] : ["owner secret"]),
      ...(idp ? [] : [`IdP pin under ${dir}`]),
    ];
    throw new Error(
      `auth-service: user-auth material is missing (${missing.join(", ")}) - ${store ? "the hosted composition must provision the secret store before starting this daemon" : "enable it with `cotal up --user-auth --idp <url>`"}`,
    );
  }
  if (issuer.issuer !== spaceIssuer(space))
    throw new Error(`auth-service: issuer pin ${issuer.issuer} does not match space "${space}"`);

  if (!(await isReachable(server, { creds: callout.calloutCreds })))
    throw new Error(`auth-service: can't reach the broker at ${server} with the callout creds - is the mesh up (with the callout account preloaded)?`);

  // ---- The authority plane (R1): stores ensured + registry + supervised reader, BEFORE the
  // callout exists — a connect must never be answered without the credential arm bound.
  const plane = await openAuthAuthorityPlane({
    server,
    space,
    dir,
    dataAccount: { pub: keys.dataAccount.pub, signingSeed: keys.dataAccount.signingSeed },
    log: (l) => console.error(l),
  });

  // ---- Plane 2: the callout, on its own callout-account connection ----
  const nc: NatsConnection = await connect({
    servers: server,
    authenticator: credsAuthenticator(new TextEncoder().encode(callout.calloutCreds)),
    name: `cotal:auth-service:${space}`,
  });
  startAuthCallout(nc as never, {
    xkeySeed: callout.xkey.seed,
    authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
    dataAccount: { pub: keys.dataAccount.pub, signingSeed: keys.dataAccount.signingSeed },
    space,
    token: { key: issuer.localKeySet(), issuer: issuer.issuer },
    authorizeActor: plane.authorizeConnect,
    permissionsFor: calloutPermissions(ledgerAclResolver(dir)),
    log: (l) => console.error(l),
  });
  // The subscription must be ON the broker before readiness is signaled — an `up` that recorded a
  // usable user mesh while the SUB was still in flight would intermittently deny first connects.
  await nc.flush();

  // ---- Plane 1: the exchange + JWKS, loopback HTTP ----
  const bridge = createIdpBridge({
    idp: { issuer: idp.issuer, audience: idp.audience, key: pinnedJwksResolver(idp.jwksUri) },
    space,
    spaceSecret: ownerSecret,
    issuer,
    authorizeActor: ledgerAuthorizeGrant(dir),
    mintConnectCredential: plane.mintConnectCredential,
  });
  const cap = randomBytes(32).toString("hex"); // per-start exchange capability (rotates with the daemon)
  const failures: number[] = []; // rolling-window timestamps of REFUSED exchanges
  const badCaps: number[] = []; // rolling-window timestamps of invalid-capability attempts
  const ctx: HandlerCtx = { issuer, bridge, cap, failures, badCaps, space, dir, mintConnectCredential: plane.mintConnectCredential };
  const http = createServer((req, res) => void handle(req, res, ctx));
  await new Promise<void>((resolvePort, reject) => {
    http.once("error", reject);
    http.listen(port, "127.0.0.1", () => resolvePort());
  });
  const addr = http.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;
  const url = `http://127.0.0.1:${boundPort}`;

  // The optional PUBLIC face: its own server, its own closed route table, its own budgets — also
  // loopback-bound (the operator's reverse proxy terminates TLS and forwards here).
  let publicHttp: ReturnType<typeof createServer> | undefined;
  let publicUrl: string | undefined;
  if (publicPort !== undefined) {
    // The discovery bundle is GENERATED from the daemon's own recorded config — the pinned IdP,
    // the flags, the callout material — so it cannot drift from what this process enforces.
    // `endpoints.url` is finalized AFTER bind (the closure sees the mutation): with `--port 0`
    // the pre-bind port would advertise an address nothing listens on.
    const bundle = composeUserBundle({
      space,
      // What participants DIAL, not what the callout dials: the daemon reaches the broker on its
      // loopback/LAN address (--server), which is meaningless off this machine. --advertised-server
      // is the publicly dialable address (e.g. wss://… through the reverse proxy).
      server: advertisedServer ?? server,
      idp: { url: idp.url, issuer: idp.issuer, audience: idp.audience },
      sentinelCreds: callout.sentinelCreds,
      ...(agentProvisioningUrl ? { agentProvisioningUrl } : {}),
    });
    publicHttp = createServer(makePublicHandler(ctx, makePublicPolicy(trustedProxy), bundle));
    await new Promise<void>((resolvePort, reject) => {
      publicHttp!.once("error", reject);
      publicHttp!.listen(publicPort, "127.0.0.1", () => resolvePort());
    });
    const paddr = publicHttp.address();
    const boundPublic = typeof paddr === "object" && paddr ? paddr.port : publicPort;
    publicUrl = publicUrlFlag ?? `http://127.0.0.1:${boundPublic}`;
    finalizeUserBundleEndpoint(bundle, publicUrl);
  }

  // All planes bound — NOW write the discovery file (its existence is the readiness signal).
  saveAuthServiceInfo(dir, { url, pid: process.pid, cap, ...(publicUrl !== undefined ? { publicUrl } : {}) });
  console.log(
    `✓ auth service up (space ${space}) - callout on ${server}, exchange/JWKS at ${url}${publicUrl !== undefined ? `, public exchange at ${publicUrl}` : ""}`,
  );

  const stop = async () => {
    clearAuthServiceInfo(dir); // a dead service must not satisfy the next start's readiness poll
    http.close();
    publicHttp?.close();
    await plane.close().catch(() => {});
    await nc.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());

  // A dropped broker connection is fatal-loud, not a zombie: the supervising `up`/`down` lifecycle
  // owns restarts, and a callout that silently stopped answering would hang every user connect.
  // A FENCED plane is equally fatal (SPEC 13.13): its scanners are no longer whole, every authority
  // operation already refuses, and a daemon that stayed up would look healthy while a successor
  // reclaims — down the whole service instead.
  await Promise.race([
    (nc as { closed(): Promise<Error | void> }).closed().then((err) => {
      clearAuthServiceInfo(dir);
      if (err) {
        console.error(`✗ auth-service: broker connection closed (${err.message}) - exiting`);
        process.exit(1);
      }
      process.exit(0);
    }),
    plane.fenced.then((reason) => {
      clearAuthServiceInfo(dir);
      console.error(`✗ auth-service: ${reason} - exiting`);
      process.exit(1);
    }),
  ]);
}

interface HandlerCtx {
  issuer: UserTokenIssuer;
  bridge: IdpBridge;
  cap: string;
  failures: number[];
  badCaps: number[];
  space: string;
  /** The provider state dir — the AGENT grant type reads its ledger rows fresh per exchange. */
  dir: string;
  /** The authority plane's root-credential ensure — the agent-exchange arm stamps from it (the
   *  human arm stamps inside the bridge). */
  mintConnectCredential: (args: { owner: string; actor: string; lifecycleUid: string }) => Promise<string>;
}

/** Per-listener policy for `POST /exchange` — how a caller is proven, attributed, and throttled on
 *  the face the request arrived on. The loopback face demands the per-start capability (a same-uid
 *  file-ACL boundary via the 0600 discovery file) and attributes peers by socket address; the
 *  public face demands no capability (it has no remote meaning — the credential is the proof) and
 *  buckets failures per peer. Each face owns its budgets — neither can starve the other. */
interface ExchangePolicy {
  /** Demand `Authorization: Bearer <cap>` (the discovery-file capability) before anything else. */
  requireCapability: boolean;
  /** Refuse any `view` request outright — elevated operator surfaces stay loopback-only. */
  refuseViews: boolean;
  /** Name the requesting peer for failure attribution. */
  peerKey(req: IncomingMessage): string;
  /** True when this face's refused-exchange budget (for `peer`) is exhausted; prunes the window. */
  throttled(ctx: HandlerCtx, peer: string): boolean;
  /** Record a refused exchange against this face's budget (for `peer`). */
  recordFailure(ctx: HandlerCtx, peer: string): void;
}

/** The loopback face: capability-gated; peers keyed by socket remote address; one shared
 *  refused-exchange window (the pre-public behavior, unchanged). */
const LOOPBACK_POLICY: ExchangePolicy = {
  requireCapability: true,
  refuseViews: false,
  peerKey: (req) => req.socket.remoteAddress ?? "loopback",
  throttled: (ctx) => {
    const now = Date.now();
    while (ctx.failures.length && now - ctx.failures[0] > 60_000) ctx.failures.shift();
    return ctx.failures.length >= FAILED_EXCHANGE_PER_MIN;
  },
  recordFailure: (ctx) => ctx.failures.push(Date.now()),
};

/** The public face's policy: no capability, views refused, and failures bucketed per peer in a
 *  bounded LRU — peer A's refusal flood throttles peer A, not peer B, and never the loopback
 *  face. With `trustedProxy`, the peer is the LAST X-Forwarded-For hop (the one address the
 *  operator's own reverse proxy appended — earlier hops are attacker-writable); without it the
 *  header is ignored entirely and the socket remote address attributes the peer. */
function makePublicPolicy(trustedProxy: boolean): ExchangePolicy {
  const buckets = new Map<string, number[]>(); // insertion order = recency (touched keys re-insert)
  const bucket = (peer: string): number[] => {
    const existing = buckets.get(peer);
    if (existing !== undefined) {
      buckets.delete(peer); // re-insert → most-recently-used
      buckets.set(peer, existing);
      return existing;
    }
    if (buckets.size >= PUBLIC_PEER_BUCKETS_MAX) buckets.delete(buckets.keys().next().value as string);
    const fresh: number[] = [];
    buckets.set(peer, fresh);
    return fresh;
  };
  return {
    requireCapability: false,
    refuseViews: true,
    peerKey: (req) => {
      if (trustedProxy) {
        const xff = req.headers["x-forwarded-for"];
        const last = (Array.isArray(xff) ? xff[xff.length - 1] : xff)?.split(",").pop()?.trim();
        if (last) return last;
      }
      return req.socket.remoteAddress ?? "unknown";
    },
    throttled: (_ctx, peer) => {
      const b = bucket(peer);
      const now = Date.now();
      while (b.length && now - b[0] > 60_000) b.shift();
      return b.length >= PUBLIC_FAILED_PER_MIN;
    },
    recordFailure: (_ctx, peer) => bucket(peer).push(Date.now()),
  };
}

/** JSON reply helper. No CORS headers, ever — a browser context must never be granted a readable
 *  response here. */
function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** An HTTP-shaped request refusal found while reading the body. Keeping the status on the error
 *  lets both listeners return the SAME exact wire response rather than collapsing a deliberate
 *  size refusal into the generic malformed-request 400. */
class RequestBodyError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function sendRequestError(res: ServerResponse, e: unknown): void {
  if (e instanceof RequestBodyError) return send(res, e.status, { error: e.message });
  send(res, 400, { error: e instanceof Error ? e.message : String(e) });
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx) => void | Promise<void>;

/** The loopback route table: /health, /jwks (public keys, cacheable), /exchange (IdP JWT →
 *  bearer; capability-gated). Anything else 404s. A `Map` (not an object literal) so a hostile
 *  request-target like `toString` can never resolve through the prototype chain. */
const ROUTES = new Map<string, RouteHandler>([
  ["/health", (_req, res, ctx) => send(res, 200, { ok: true, issuer: ctx.issuer.issuer })],
  [
    "/jwks",
    (req, res, ctx) => {
      if (req.method !== "GET") return send(res, 405, { error: "GET only" });
      // The explicit cache contract (see the module doc): max-age bounds how stale a verifier's set
      // may be, which in turn floors how long a retired kid must stay published after rotation.
      return send(res, 200, ctx.issuer.jwks(), { "cache-control": `max-age=${JWKS_MAX_AGE_SEC}` });
    },
  ],
  ["/exchange", (req, res, ctx) => handleExchange(req, res, ctx, LOOPBACK_POLICY)],
]);

/** Route one HTTP request against the loopback route table. Errors are JSON `{ error }`. */
async function handle(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx): Promise<void> {
  try {
    const route = ROUTES.get(req.url ?? "");
    if (!route) return send(res, 404, { error: "unknown path - /health, /jwks, /exchange" });
    await route(req, res, ctx);
  } catch (e) {
    sendRequestError(res, e);
  }
}

/** The exchange body, shared by every face; `policy` says how this face proves and attributes the
 *  caller. Behavior on the loopback face is unchanged from the pre-route-table handler. */
async function handleExchange(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx, policy: ExchangePolicy): Promise<void> {
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  // Browser exclusion: a cross-site page CAN reach loopback, but its requests carry `Origin`
  // (and can't strip it). The CLI never sends one. Reject before touching anything else.
  if (req.headers.origin !== undefined) return send(res, 403, { error: "browser-origin requests are not served here" });
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? ""))
    return send(res, 415, { error: "content-type must be application/json" });
  if (policy.requireCapability) {
    // The capability gate: same-user file ACL on the 0600 discovery file is the boundary. An
    // invalid/missing cap is still a failed exchange attempt — audited and throttled, in its own
    // window (see BAD_CAP_PER_MIN), before anything downstream is touched.
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${ctx.cap}`) {
      const now = Date.now();
      while (ctx.badCaps.length && now - ctx.badCaps[0] > 60_000) ctx.badCaps.shift();
      ctx.badCaps.push(now);
      console.error("auth-service: rejected an exchange with a missing/invalid capability");
      if (ctx.badCaps.length > BAD_CAP_PER_MIN)
        return send(res, 429, { error: "too many invalid-capability attempts - wait a minute and retry" });
      return send(res, 401, { error: "missing/invalid exchange capability - read it from the space's auth-service.json" });
    }
  }
  // Refused-exchange rate limit (probing protection): count only FAILURES, on THIS face's budget.
  const peer = policy.peerKey(req);
  if (policy.throttled(ctx, peer))
    return send(res, 429, { error: "too many refused exchanges - wait a minute and retry" });
  const body = await readJsonBody(req);
  const { idpToken, actor, actorToken, owner, ttlSec, view } = body as {
    idpToken?: unknown;
    actor?: unknown;
    actorToken?: unknown;
    owner?: unknown;
    ttlSec?: unknown;
    view?: unknown;
  };
  if (ttlSec !== undefined && typeof ttlSec !== "number") return send(res, 400, { error: "ttlSec must be a number" });
  if (view !== undefined && typeof view !== "string") return send(res, 400, { error: "view must be a string when present" });
  // The one-line class-closer: elevated views never ride the public face — operator surfaces are
  // loopback-only, whatever the credential presented.
  if (policy.refuseViews && view !== undefined)
    return send(res, 403, { error: "elevated views are a loopback operator surface - the public exchange never serves them" });
  // TWO grant types, disjoint by construction: a HUMAN exchange proves an IdP session
  // (idpToken), an AGENT exchange proves a spawn-time ledger secret (owner + actorToken).
  // A request presenting both is malformed — refuse rather than pick.
  if (idpToken !== undefined && actorToken !== undefined)
    return send(res, 400, { error: "exchange takes idpToken (human) OR owner+actorToken (agent), never both" });
  if (actorToken !== undefined) {
    // Elevated views are for signed-in HUMANS only: an agent's secret exchange never mints one,
    // whatever its ledger row carries (v1 — agents hold no god views).
    if (view !== undefined)
      return send(res, 400, { error: "the managed (agent-secret) exchange never mints elevated views - views ride a signed-in human exchange" });
    if (typeof owner !== "string" || !owner || typeof actor !== "string" || !actor || typeof actorToken !== "string" || !actorToken)
      return send(res, 400, { error: "agent exchange needs { owner: string, actor: string, actorToken: string, ttlSec?: number }" });
    try {
      const grant = ledgerAuthorizeAgentExchange(ctx.dir, owner, actor, actorToken);
      if (typeof grant.lifecycleUid !== "string" || !grant.lifecycleUid)
        throw new Error(`actor "${actor}" has no lifecycleUid on its ledger row - respawn it (bearers are lifecycle-bound from v0.4)`);
      // Credential-BIND the bearer (SPEC 13.1, R1): the incarnation's live root credential is
      // ensured (minted release-last on first exchange) BEFORE the bearer bytes are signed,
      // and rides act.credentialId — the connect arm requires it against the LIVE cred row.
      const credentialId = await ctx.mintConnectCredential({ owner, actor, lifecycleUid: grant.lifecycleUid });
      const token = await ctx.issuer.issue({
        owner,
        space: ctx.space,
        actor,
        scope: grant.scope,
        parent: grant.parent,
        // Lifecycle-BIND the bearer (SPEC 13.1): the row's uid rides act.lifecycleUid, and the
        // callout refuses a mismatch against the CURRENT row at connect — a predecessor's
        // still-unexpired bearer dies at the alias's respawn instead of minting the
        // successor's broker authority.
        lifecycleUid: grant.lifecycleUid,
        credentialId,
        ttlSec: Math.min(ttlSec ?? AGENT_BEARER_TTL_SEC, AGENT_BEARER_TTL_SEC),
      });
      const { exp } = decodeJwt(token);
      return send(res, 200, { token, owner, exp });
    } catch (e) {
      policy.recordFailure(ctx, peer);
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`auth-service: refused an agent exchange: ${reason}`);
      return send(res, 401, { error: reason });
    }
  }
  if (typeof idpToken !== "string" || !idpToken || typeof actor !== "string" || !actor)
    return send(res, 400, { error: "exchange needs { idpToken: string, actor: string, ttlSec?: number, view?: string }" });
  try {
    // The bridge validates `view` against the closed enum and the fresh ledger grant — an
    // unknown or under-scoped view is a refused exchange (audited + throttled like any other).
    const r = await ctx.bridge.exchange(idpToken, { actor, ttlSec, view: view as UserTokenView | undefined });
    return send(res, 200, r);
  } catch (e) {
    // A refused exchange (bad IdP token, ungranted actor, expired proof) is an AUTHENTICATED
    // denial with the reason — the client shows it to the operator verbatim.
    policy.recordFailure(ctx, peer);
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`auth-service: refused an exchange: ${reason}`);
    return send(res, 401, { error: reason });
  }
}

/** The advertised broker address the public bundle carries — the URL participants will dial, so
 *  the same scheme family `cotal meshes add` accepts. Exported for the producer/consumer contract
 *  smoke; returns the refusal sentence, or undefined when the address is usable. */
export function checkAdvertisedServer(raw: string): string | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `auth-service: --advertised-server is not a URL, got "${raw}"`;
  }
  if (!["nats:", "tls:", "ws:", "wss:"].includes(u.protocol))
    return `auth-service: --advertised-server must be a broker URL (nats://, tls://, ws:// or wss://), got ${u.protocol}//`;
  return undefined;
}

/** Compose the user bundle the public face serves at /.well-known/cotal-mesh. ONE producer,
 *  exported so the consumer contract (`checkUserBundle` in the CLI) can be asserted against the
 *  real composition rather than a copy. The trust pins ride a `userAuth` arm because that is the
 *  shape the consumer records: registration passes it through `assertUserAuthInfo` and lands it
 *  in the registry entry (plus `remote: true` and the sentinel PATH). `endpoints.url` starts
 *  empty — the daemon finalizes it with {@link finalizeUserBundleEndpoint} after the public
 *  listener binds. */
export function composeUserBundle(args: {
  space: string;
  server: string;
  idp: { url: string; issuer: string; audience: string };
  sentinelCreds: string;
  /** The deployment's remote agent-provisioning endpoint (U6): where `cotal spawn` POSTs the
   *  login bearer to mint a managed agent in the owner's envelope. Optional — a mesh without one
   *  simply has no self-service remote spawn, and the client refuses with a named message. */
  agentProvisioningUrl?: string;
}): Record<string, unknown> {
  return {
    space: args.space,
    server: args.server,
    tlsRequired: true,
    userAuth: {
      // The same provider name the LOCAL arm records (provider.ts registers publicAuth with
      // provider "cotal") — a remote entry must dispatch to the same provider a local one does.
      provider: "cotal",
      idp: args.idp,
      endpoints: {
        url: "",
        ...(args.agentProvisioningUrl ? { agentProvisioningUrl: args.agentProvisioningUrl } : {}),
      },
    },
    sentinelCreds: args.sentinelCreds,
  };
}

/** Pin the bundle's exchange endpoint once the public listener is bound (with `--port 0` the
 *  pre-bind port would advertise an address nothing listens on). Mutates `url` IN PLACE rather
 *  than replacing the endpoints object — replacement once silently dropped every sibling field
 *  the composer had set (agentProvisioningUrl). */
export function finalizeUserBundleEndpoint(bundle: Record<string, unknown>, publicUrl: string): void {
  (bundle.userAuth as { endpoints: { url: string } }).endpoints.url = publicUrl;
}

/** The advertised agent-provisioning endpoint: HTTPS only — spawn sends the login bearer to it,
 *  and a plaintext or non-URL value must be refused at startup, not discovered by a participant.
 *  Exported for the producer/consumer contract smoke; returns the refusal, or undefined when
 *  usable. */
export function checkAgentProvisioningUrl(raw: string): string | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `auth-service: --agent-provisioning-url is not a URL, got "${raw}"`;
  }
  if (u.protocol !== "https:")
    return `auth-service: --agent-provisioning-url must be https:// (the login bearer rides the request), got ${u.protocol}//`;
  return undefined;
}

/** Build the PUBLIC listener's request handler: its own closed route table (/health, /jwks,
 *  /exchange under the public policy, /.well-known/cotal-mesh — 404 everything else), behind a
 *  global concurrent-admission cap and a hard wall-clock deadline. All of it is public-face-local
 *  state: nothing here touches the loopback face's windows. */
function makePublicHandler(
  ctx: HandlerCtx,
  policy: ExchangePolicy,
  bundle: Record<string, unknown>,
): (req: IncomingMessage, res: ServerResponse) => void {
  const routes = new Map<string, RouteHandler>([
    [
      "/health",
      (req, res, c) => {
        if (req.method !== "GET") return send(res, 405, { error: "GET only" });
        return send(res, 200, { ok: true, issuer: c.issuer.issuer });
      },
    ],
    [
      "/jwks",
      (req, res, c) => {
        if (req.method !== "GET") return send(res, 405, { error: "GET only" });
        return send(res, 200, c.issuer.jwks(), { "cache-control": `max-age=${JWKS_MAX_AGE_SEC}` });
      },
    ],
    ["/exchange", (req, res, c) => handleExchange(req, res, c, policy)],
    [
      "/.well-known/cotal-mesh",
      (req, res) => {
        if (req.method !== "GET") return send(res, 405, { error: "GET only" });
        // GENERATED from the daemon's own recorded config (flags + pinned IdP + callout material)
        // — never hand-written, so it can't drift from what the service actually enforces.
        return send(res, 200, bundle);
      },
    ],
  ]);
  let inFlight = 0;
  return (req, res) => {
    // Global concurrent-admission cap: total public work is bounded regardless of source — and
    // (its own counter) can never consume the loopback face's capacity.
    if (inFlight >= PUBLIC_MAX_IN_FLIGHT) return send(res, 503, { error: "busy - retry shortly" });
    inFlight++;
    // Hard request deadline: a stalled or slow-dripping request is answered and cut, never held.
    const deadline = setTimeout(() => {
      if (!res.headersSent) send(res, 503, { error: "request deadline exceeded" });
      req.destroy();
    }, PUBLIC_DEADLINE_MS);
    res.on("close", () => {
      clearTimeout(deadline);
      inFlight--;
    });
    void (async () => {
      try {
        const route = routes.get(req.url ?? "");
        if (!route) return send(res, 404, { error: "unknown path - /health, /jwks, /exchange, /.well-known/cotal-mesh" });
        await route(req, res, ctx);
      } catch (e) {
        if (!res.headersSent) sendRequestError(res, e);
      }
    })();
  };
}

/** Read + parse a small JSON body, bounded — the exchange payload is an IdP JWT plus an actor name;
 *  64 KB clears any sane JWT while keeping the loopback surface un-floodable. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const MAX = 64 * 1024;
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX) {
        // Stop retaining bytes immediately, but keep draining the request so the client receives
        // the explicit 413 JSON response. Destroying the socket hid the server's decision behind
        // an undici transport error and made the size-bound smoke unable to prove this guard.
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(c);
    });
    req.on("end", () => {
      if (tooLarge) return reject(new RequestBodyError(413, "request body too large (maximum 65536 bytes)"));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new RequestBodyError(400, "request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}
