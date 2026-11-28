/** The auth service's process and context host: `runAuthService` (the daemon lifecycle), the lane and
 *  multi-tenant host runners, `startAuthService` with its handle and platform control input, and
 *  `startAuthContext`, which serves one authority plane's routes and user bundle. */
import { makePublicPolicy } from "./service-exchange-routes.js";
import { createToolResultConsentSigner, type ToolResultConsentSignerOptions } from "./tool-result-consent.js";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { dialerFor, endpointToken, assertDerivedOwnerToken, EpEnvelopeError, isReachable, parseSecretStoreIdentity, sameSecretStoreIdentity, invokeCommand, resolveService, mintLifecycleUid, type EpAttributedReply, type EpCaller, type EpGateState, type ParsedArgs, type PlatformControlAssignment, type PlatformControlAuthorityRequest, type PlatformControlAuthorityResult, type PlatformControlInnerRequest, type RemoteRetainedAgentValidationRequest, type SecretStore } from "@cotal-ai/core";
import { findCotalRoot, loadManagerInstanceIdentity, runSpaceHost, userAuthStateDir, workspaceSecretStore, type SpaceLane, type HostedContextInputs, type HostedContextKey, type HostedServiceHandle, type HostedServiceState, type ManagerInstanceIdentity } from "@cotal-ai/workspace";
import { platformControlOwner } from "./derive.js";
import { makePlatformControlAuthority, makePlatformControlReadiness, type ManagerAuthorityHolder } from "./platform-control.js";
import { OwnedConnections, type AuthConnectionState, type AuthServiceClosed } from "./owned-connections.js";
import { makePlatformSupervisorAuthority, makePlatformSupervisorEnd, requirePlatformSupervisorAdmin, type PlatformSupervisorInput, type PlatformSupervisorAuthorityRequest } from "./platform-supervisor.js";
import { calloutLimits, type AuthCalloutLimits } from "./callout.js";
import { runCalloutHost } from "./callout-host.js";
import { runAuthCalloutReplica } from "./callout-replica.js";
import { serveCallout } from "./callout-authority.js";
import { ConnectLimiter, type ConnectLimits } from "./connect-limit.js";
import { createIdpBridge } from "./idp.js";
import { pinnedJwksResolver } from "./issuer.js";
import { completeRemoteRetainedAgentValidation } from "./retained-manager-validation.js";
import { type ObserveManagerGate } from "./managed-agent-enrollment.js";
import { validateRetainedManagedAgent } from "./continuity.js";
import { openAuthorityClient, platformReadinessGrants, type AuthorityClient } from "./authority-client.js";
import { type ServiceEndpointHost } from "./service-host-contract.js";
import { serviceEndpointsOption } from "./own-broker-caller-payload.js";
import type { DelegatedUserIntentIncarnation } from "./delegated-user-intent.js";
import { registry as extensionRegistry, type RegistryService } from "@cotal-ai/core";
import {
  ledgerAuthorizeGrant,
} from "./ledger.js";
import {
  clearAuthServiceInfo,
  clearAuthServiceRefusal,
  loadCalloutAuth,
  loadIssuer,
  loadOwnerSecret,
  loadPinnedIdp,
  loadServiceKeys,
  saveAuthServiceInfo,
  saveAuthServiceRefusal,
  spaceIssuer,
} from "./store.js";
import { authServiceConfiguration, authHostSettings, checkPublicFace, type PublicFaceInput } from "./service-config.js";
import {
  type AuthAuthorityPlane,
  type AuthServiceRuntimeOptions,
  composeUserBundle,
  finalizeUserBundleEndpoint,
  handle,
  type HandlerCtx,
  HOST_FENCE_POLL_MS,
  hostedServiceEndpoints,
  makePublicHandler,
  type OpenAuthAuthorityPlaneOptions,
  openAuthAuthorityPlaneWithCustody,
  PUBLIC_DEADLINE_MS,
  runtimeSelection,
  serviceHostCalloutOf,
  serviceHostEngineOf,
} from "./service.js";

/** Trusted local embedding hooks. They carry no prepared key material or loopback capability. */
interface AuthDaemonLifecycle extends AuthServiceRuntimeOptions {
  readonly root: string;
  readonly onReady: () => void | Promise<void>;
  readonly onClosed: () => void | Promise<void>;
  readonly quiet?: true;
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
export async function runAuthService(args: ParsedArgs, store?: SecretStore, options: AuthServiceRuntimeOptions | AuthDaemonLifecycle = {}): Promise<void> {
  const interactiveManagerSelection = runtimeSelection(options);
  const lifecycle = "root" in options ? options : undefined;
  const { space, spaces, server, port, publicFace, serviceEndpoints, registry: registryEnabled, calloutOnly, calloutLimits: limits } = authServiceConfiguration(args);
  if (calloutOnly && (options.registry !== undefined || options.registryCredentialTtlSeconds !== undefined))
    throw new Error("auth-service: a callout-only replica cannot host a registry");
  const registry = options.registry ?? (registryEnabled ? await extensionRegistry.load<RegistryService>("registry-service", "builtin") : undefined);
  // The provider's space-scoped state dir for NON-SEAM material (ledger, IdP pin, discovery). The
  // layout fact is workspace-owned (userAuthStateDir); this daemon never touches `.cotal/auth/auth.json`.
  const root = lifecycle?.root ?? findCotalRoot();
  // A replica never reads or writes the space's one discovery file: that file names the primary.
  if (spaces !== undefined && calloutOnly) return runCalloutHost({ manifest: spaces, server, root, eventPayloadsWithheld: options.eventPayloadsWithheld, ...(limits !== undefined ? { limits } : {}) }, store);
  if (calloutOnly) return runAuthCalloutReplica({ space, server, root, eventPayloadsWithheld: options.eventPayloadsWithheld, ...(limits !== undefined ? { limits } : {}) }, store);
  if (spaces !== undefined) {
    if (lifecycle) throw new Error("auth-service: the auth-service service preset runs one space - run --spaces from the auth-service entry or an embedder's runAuthService call");
    return runAuthServiceHost({ manifest: spaces, server, root, runtime: options, ...(limits !== undefined ? { limits } : {}) }, store);
  }
  const dir = userAuthStateDir(root, space);
  const secrets = store ?? workspaceSecretStore(root);
  // Scrub any stale discovery file FIRST — a dead prior daemon's entry must never satisfy a
  // readiness poll for THIS start (the provider's ready() also pid-checks; belt and braces).
  clearAuthServiceInfo(dir);
  clearAuthServiceRefusal(dir);
  // SMOKE-ONLY startup hold: holds THIS daemon's startup between the discovery scrub and the
  // authority-plane open (before any broker or listener footprint), for the pid-bound readiness
  // cells. A live `up` never sets it; when set, it delays this many ms and a plain integer is
  // REQUIRED (a malformed value throws rather than silently starting without the hold).
  {
    const holdRaw = process.env.COTAL_SMOKE_AUTH_STARTUP_HOLD_MS;
    if (holdRaw !== undefined) {
      const hold = Number(holdRaw);
      if (!Number.isSafeInteger(hold) || hold < 0)
        throw new Error(`auth-service: COTAL_SMOKE_AUTH_STARTUP_HOLD_MS must be a non-negative integer (got ${JSON.stringify(holdRaw)})`);
      console.error(`auth-service: smoke startup hold for ${hold}ms (before the authority plane opens)`);
      await new Promise((r) => setTimeout(r, hold));
    }
  }
  // Own-broker caller issuance rides the retained system-account signing seed, when this root has
  // one; otherwise the engine and door open without it and caller grants refuse as unsupported.
  const endpoints = await serviceEndpointsOption(secrets, space, serviceEndpoints);
  if (endpoints.log !== undefined) console.error(`auth-service: ${endpoints.log}`);
  const started = await startAuthContext({
    space,
    server,
    port,
    dir,
    identityRoot: root,
    secrets,
    hostedStore: store !== undefined,
    ...(publicFace !== undefined ? { publicFace } : {}),
    ...(endpoints.option !== undefined ? { serviceEndpoints: endpoints.option } : {}),
    // The CLI composition's local manager is this workspace root's persisted instance, re-read per
    // selection exactly as before. A hosted context passes no local manager at all.
    localManager: () => loadManagerInstanceIdentity(root, space),
    eventPayloadsWithheld: options.eventPayloadsWithheld,
    ...(interactiveManagerSelection !== undefined ? { interactiveManagerSelection } : {}),
    ...(options.runCancelLimits !== undefined ? { runCancelLimits: options.runCancelLimits } : {}),
    ...(registry !== undefined ? { registry } : {}),
    ...(options.registryCredentialTtlSeconds !== undefined ? { registryCredentialTtlSeconds: options.registryCredentialTtlSeconds } : {}),
    ...(limits !== undefined ? { calloutLimits: limits } : {}),
  }).catch((e: unknown) => {
    // The launching `up` sees only this process exit. Leave a typed refusal (a plane-claim
    // refusal's code and reason, SPEC 13.13) where its readiness wait reads it (#3947).
    if (e instanceof EpEnvelopeError) saveAuthServiceRefusal(dir, { pid: process.pid, code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) });
    throw e;
  });

  // All planes bound — NOW write the discovery file (its existence is the readiness signal).
  const { url, publicUrl, cap } = started.handle;
  saveAuthServiceInfo(dir, { url, pid: process.pid, cap, ...(publicUrl !== undefined ? { publicUrl } : {}) });
  if (!lifecycle?.quiet) console.log(
    `✓ auth service up (space ${space}) - callout on ${server}${limits?.authTimeoutMs !== undefined ? ` with a ${limits.authTimeoutMs / 1000}s authorization timeout` : ""}, exchange/JWKS at ${url}${publicUrl !== undefined ? `, public exchange at ${publicUrl}` : ""}`,
  );

  // The CLI wrapper, not the context, owns process signals and exit codes.
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    clearAuthServiceInfo(dir); // a dead service must not satisfy the next start's readiness poll
    try {
      await started.handle.close();
      await lifecycle?.onClosed();
    } catch (e) {
      console.error(lifecycle ? "✗ native auth-service shutdown did not confirm completion; custody was retained" : `✗ auth-service: ${(e as Error).message} - exiting`);
      process.exit(1);
    }
    process.exit(0);
  })();
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  if (lifecycle) {
    try { await lifecycle.onReady(); }
    catch {
      clearAuthServiceInfo(dir);
      try { await started.handle.close(); await lifecycle.onClosed(); } catch { /* Unknown close keeps custody. */ }
      throw new Error("the native auth-service startup receipt was not published; no new launch was retried");
    }
  }

  // A dropped broker connection is fatal-loud, not a zombie: the supervising `up`/`down` lifecycle
  // owns restarts, and a callout that silently stopped answering would hang every user connect.
  // A FENCED plane is equally fatal (SPEC 13.13): its scanners are no longer whole, every authority
  // operation already refuses, and a daemon that stayed up would look healthy while a successor
  // reclaims — down the whole service instead.
  const ended = await started.ended;
  clearAuthServiceInfo(dir);
  if (ended.kind === "fenced") {
    console.error(lifecycle ? "✗ native auth-service authority was fenced; custody was retained" : `✗ auth-service: ${ended.cause} - exiting`);
    process.exit(1);
  }
  if (ended.cause !== undefined) {
    console.error(lifecycle ? "✗ native auth-service broker connection closed; custody was retained" : `✗ auth-service: broker connection closed (${ended.cause}) - exiting`);
    process.exit(1);
  }
  await lifecycle?.onClosed();
  process.exit(0);
}

/** One space's full auth service held by a multi-space host ({@link runAuthServiceHost}): the
 *  context `--space` runs, plus that space's discovery file, with no process-level concern. It
 *  installs no signal handler and never exits; a fence or a broker loss closes this lane alone. */
async function openAuthServiceLane(o: {
  space: string;
  server: string;
  root: string;
  secrets: SecretStore;
  hostedStore: boolean;
  publicFace: PublicFaceInput | null;
  serviceEndpoints: boolean;
  registry: boolean;
  limits?: AuthCalloutLimits;
  runtime: AuthServiceRuntimeOptions;
  log: (line: string) => void;
}): Promise<SpaceLane> {
  const { space, root, log } = o;
  const dir = userAuthStateDir(root, space);
  // No discovery scrub before the claim: while another process still serves this space, the file is
  // its own, and a stale one names a dead pid that every reader treats as not running.
  const endpoints = await serviceEndpointsOption(o.secrets, space, o.serviceEndpoints);
  if (endpoints.log !== undefined) log(`auth-service: ${endpoints.log}`);
  const selection = runtimeSelection(o.runtime);
  const registry = o.registry ? o.runtime.registry ?? await extensionRegistry.load<RegistryService>("registry-service", "builtin") : undefined;
  const started = await startAuthContext({
    space,
    server: o.server,
    port: 0,
    dir,
    identityRoot: root,
    secrets: o.secrets,
    hostedStore: o.hostedStore,
    ...(o.publicFace !== null ? { publicFace: o.publicFace } : {}),
    ...(endpoints.option !== undefined ? { serviceEndpoints: endpoints.option } : {}),
    localManager: () => loadManagerInstanceIdentity(root, space),
    eventPayloadsWithheld: o.runtime.eventPayloadsWithheld,
    ...(selection !== undefined ? { interactiveManagerSelection: selection } : {}),
    ...(o.runtime.runCancelLimits !== undefined ? { runCancelLimits: o.runtime.runCancelLimits } : {}),
    ...(registry !== undefined ? { registry, ...(o.runtime.registryCredentialTtlSeconds !== undefined ? { registryCredentialTtlSeconds: o.runtime.registryCredentialTtlSeconds } : {}) } : {}),
    ...(o.limits !== undefined ? { calloutLimits: o.limits } : {}),
    log,
  });
  const { url, publicUrl, cap } = started.handle;
  try {
    saveAuthServiceInfo(dir, { url, pid: process.pid, cap, ...(publicUrl !== undefined ? { publicUrl } : {}) });
  } catch (e) {
    // A lane the host never received would keep serving, untracked, past any removal.
    await started.handle.close().catch(() => started.abandon());
    throw e;
  }
  log(`✓ auth service lane up (space ${space}) - exchange/JWKS at ${url}${publicUrl !== undefined ? `, public exchange at ${publicUrl}` : ""}`);

  let settle!: (what: string) => void;
  const lost = new Promise<string>((r) => { settle = r; });
  let ending: Promise<void> | undefined;
  const end = (what: string): Promise<void> => ending ??= (async () => {
    // Before the claim is released, so a successor that wins it never has its file removed here. A
    // file that cannot be removed never keeps the lane serving: the close below runs either way.
    try {
      clearAuthServiceInfo(dir);
    } catch (e) {
      log(`✗ auth-service: could not remove its auth-service.json (${e instanceof Error ? e.message : String(e)}) - closing the lane anyway`);
    }
    try {
      await started.handle.close();
    } catch (e) {
      // A single-space process exits here and the kernel closes its sockets. A lane does the same
      // to what it holds; the claim row stays held by connections that are gone, which the next
      // open reclaims once the broker confirms them gone (SPEC 13.13).
      log(`✗ auth-service: closing did not complete (${e instanceof Error ? e.message : String(e)}) - closed every listener and connection the lane still held`);
      await started.abandon();
    }
    settle(what);
  })();
  void started.ended.then((e) => end(e.kind === "fenced" ? `its authority plane (${e.cause})` : `its broker connection${e.cause !== undefined ? ` (${e.cause})` : ""}`));
  return { space, lost, close: () => end("a deliberate close") };
}

/** Run one multi-space auth service host (`auth-service --spaces <manifest>`) until a signal ends it:
 *  one full auth service lane per space the version 2 manifest names, on the one `--server`, with the
 *  public face and service endpoints its entry sets. It
 *  starts with the spaces it can serve and retries the rest, and acknowledges each manifest in
 *  `<manifest>.applied` once every space it does not name is closed. `store`, when given, is every
 *  lane's only source of secret material. */
async function runAuthServiceHost(args: { manifest: string; server: string; root: string; limits?: AuthCalloutLimits; runtime: AuthServiceRuntimeOptions }, store?: SecretStore): Promise<void> {
  const { server, root } = args;
  const log = (l: string) => console.error(l);
  const secrets = store ?? workspaceSecretStore(root);
  const host = await runSpaceHost({
    manifest: args.manifest,
    settings: authHostSettings,
    startup: "servable",
    open: (space, entry) => openAuthServiceLane({
      space, server, root, secrets, hostedStore: store !== undefined, publicFace: entry.publicFace,
      serviceEndpoints: entry.serviceEndpoints, registry: entry.registry === true, runtime: args.runtime, log: (l) => log(`[${space}] ${l}`),
      ...(args.limits !== undefined ? { limits: args.limits } : {}),
    }),
    label: "auth service host",
    entry: "auth-service --spaces",
    serving: "serving",
    log,
  });
  // Every list in manifest order. The lanes open together, so the map holds them in the order
  // their opens settled.
  const serving = host.named.filter((space) => host.lanes.has(space));
  const opening = host.named.filter((space) => host.opening.has(space));
  const queued = host.named.filter((space) => host.queued.has(space));
  const waiting = host.named.filter((space) => !host.lanes.has(space) && !host.opening.has(space) && !host.queued.has(space));
  console.log(`✓ auth service host up (${serving.length} of ${host.named.length} space(s) serving${serving.length ? `: ${serving.join(", ")}` : ""}${opening.length ? `; still opening ${opening.join(", ")}` : ""}${queued.length ? `; queued ${queued.join(", ")}` : ""}${waiting.length ? `; retrying ${waiting.join(", ")}` : ""}) - callout on ${server}${args.limits?.authTimeoutMs !== undefined ? ` with a ${args.limits.authTimeoutMs / 1000}s authorization timeout` : ""}, each space's exchange/JWKS in its own auth-service.json`);
  process.exit(await host.ended);
}

/** An embedded auth-service context: what `runAuthService` writes to `auth-service.json` (the
 *  loopback URL, the public URL and the capability) plus the hosted lifecycle handle. */
export interface AuthServiceHandle extends HostedServiceHandle {
  /** Leader-served routing state for host-side delegated launch admission. */
  resolvePluginChannelState: AuthAuthorityPlane["resolvePluginChannelState"];
  /** Trusted host door. The embedder authenticates the space operator or same-account owner. */
  deregisterEndpoint: AuthAuthorityPlane["deregisterEndpoint"];
  /** Settles after clean-close ordering and every owned connection's terminal closed signal.
   * A failed close leaves it pending while any connection has not ended. Retry close after repair. */
  readonly closed: Promise<AuthServiceClosed>;
  /** Snapshot of all connections acquired by this context, including replaced readers. */
  connections(): AuthConnectionState[];
  readonly url: string;
  readonly publicUrl?: string;
  /** The per-start loopback capability. It alone authorizes the loopback host actions (lifecycle
   *  retirement, managed-agent enrollment verification), so it stays in the authority process and
   *  never reaches a control worker. */
  readonly cap: string;
  /** The platform control door (SPEC 13.1). Present only when `platformControl` was supplied to
   *  {@link startAuthService}. In-process and typed: no route, no capability, and no signer or
   *  capability in the result. */
  platformControlAuthority?<R extends PlatformControlInnerRequest>(
    request: PlatformControlAuthorityRequest<R>,
  ): Promise<PlatformControlAuthorityResult<R>>;
  /** The service endpoint host (SPEC 13.1). Present only when `serviceEndpoints` was supplied to
   *  {@link startAuthService}. In-process and typed: no route and no capability of its own. The
   *  embedder authenticates the granter it passes. Rejects `unavailable` while the context is not
   *  ready, before the host reads or writes anything. The owner-proved public register and status
   *  door is the separate `/service-endpoint-authority` route on both faces. */
  serviceEndpointHost?: ServiceEndpointHost;
  /** The platform readiness read (SPEC 13.9). Present only with `platformControl`. Answers the
   *  `status` of the currently assigned manager instance and refuses any other instance. It reads
   *  over this context's own connection, whose grant is that instance's `describe` and `status`;
   *  neither the connection nor its credential leaves the process. */
  platformControlReadiness?(instanceId: string): Promise<EpAttributedReply>;
  /** Bind one administrative composition caller to one owner's recorded supervisor assignment.
   * The returned door accepts only that owner's existing registration and renewal request family. */
  platformSupervisorAuthority?(owner: string): Promise<(request: PlatformSupervisorAuthorityRequest) => Promise<import("@cotal-ai/core").RemoteManagerAuthorityMaterial>>;
  /** End one owner's supervisor issuance after the host recorded the assignment `ended`. It retires
   *  the manager gate and the issued generations, so registration, activation and renewal refuse
   *  material returned earlier even before that material expires. */
  endPlatformSupervisorAssignment?(owner: string): Promise<void>;
  /** The manager gate the delegated user intent decisions read (SPEC 13.16). Present only with
   *  `platformControl`. It reads over the context's own authority connection, so a host opens no
   *  second data-account connection, and it returns the gate alone. */
  observeManagerGate?: ObserveManagerGate;
  /** The activation a delegated launch runs at its pinned uid before any row or durable, and its
   *  compensation runs before the terminal barrier (SPEC 13.16). Present only with
   *  `platformControl`. It refuses every state in which a retirement at that uid has begun, and
   *  throws the activation saga's `EpEnvelopeError` unchanged. A retirement there has begun or
   *  completed only when `lifecycleBlockedFrom(err)` is defined and its `gateState` is `"retired"`
   *  or its `blockedOp` is `"retirement"`. A gate frozen by a takeover or a registration is a
   *  barrier in flight, and `already-exists`, `conflict`, `unavailable`, `not-found` and a
   *  `permission-denied` without that detail are not retirement. */
  activateManagedLifecycle?: AuthAuthorityPlane["activateManagedLifecycle"];
  /** The host incarnation a delegated user intent pins as its executor (SPEC 13.16). Present only
   *  with `platformControl.host`. It registers `instanceId` of the host endpoint in this context's
   *  account through the §13.7 ceremony the auth plane runs for itself. The host calls it at every
   *  start with its persisted instance id, before it admits or recovers any flight, so each start
   *  fences its predecessor and advances the process epoch. It returns the epoch this registration
   *  committed, a coordinate that a later start of the same instance can fence at any moment, even
   *  before this call returns. A later start that registers before this registration's confirming
   *  read of the gate makes it refuse with `conflict`; the host learns of every other through
   *  `awaitHostFence`. */
  registerHostIncarnation?(instanceId: string): Promise<DelegatedUserIntentIncarnation>;
  /** A sweeper's point-in-time read of an executor's issuance gate on the host endpoint (SPEC
   *  13.16). Present only with `platformControl.host`. Null is an absent gate. It reads over the
   *  context's own authority connection and writes nothing. */
  observeHostGate?(instanceId: string): Promise<EpGateState | null>;
  /** Resolves with the gate once the issuance gate of `instanceId` on the host endpoint is no longer
   *  open at `processEpoch`: a later registration moved the epoch, a barrier froze or retired it, or
   *  it is absent (null). Present only with `platformControl.host`. The host arms it with the
   *  incarnation `registerHostIncarnation` returned, before it admits or recovers any flight, and
   *  stops serving when it resolves. It rejects once the context is no longer ready or a read
   *  fails. */
  awaitHostFence?(instanceId: string, processEpoch: number): Promise<EpGateState | null>;
}

/** The platform composition's input for the platform control door. */
export interface PlatformControlInput {
  /** The one current assignment for this account, or null. Read fresh on every door call. */
  observeAssignment(space: string, accountPublicKey: string): Promise<PlatformControlAssignment | null>;
  /** The host process that executes delegated user intents (SPEC 13.16): its reverse-DNS endpoint
   *  name, the closure digest of the §13.7 cluster it registers, and every contract artifact that
   *  closure needs. The auth plane self-authorizes this one name. Absent: the handle has no
   *  `registerHostIncarnation` or `observeHostGate`. */
  host?: { endpoint: string; clusterDigest: string; artifacts: unknown[] };
}

/** Start one account-scoped auth-service context. Every input is explicit: the state dir, the
 *  injected store with its proved identity, the assigned data account and the broker. The context
 *  installs no process signal handler, never exits the process, never selects a root from cwd,
 *  and has no local manager. It returns only after the authority plane, the callout subscription
 *  and the loopback listener are bound. A failed start releases what it acquired and throws. A
 *  mid-life fence or broker loss makes only this context `unavailable` and closes its resources.
 *  `close()` rejects when the context did not release its plane claim (SPEC 13.13): the row was
 *  no longer its own, or the release write failed. A retryable release refusal keeps the barrier
 *  open so `close()` can be retried after reconnection; the context stays draining. */
export async function startAuthService(inputs: HostedContextInputs & {
  port?: number;
  /** Absent: the handle has no `publicUrl` and nothing serves the discovery bundle. */
  publicFace?: PublicFaceInput;
  /** Present only in a platform composition. Absent: the handle has no platform control door. */
  platformControl?: PlatformControlInput;
  /** Host-authenticated administrative issuance for one owner's supervisor, with no human login. */
  platformSupervisor?: PlatformSupervisorInput;
  /** Trusted-host only. Forwarded unchanged to {@link openAuthAuthorityPlane}, which bounds it to
   *  5..86400 seconds. Absent: the 24h default. No CLI flag and no request field sets it. */
  standingRenewableTtlSeconds?: number;
  /** Trusted-host only. Forwarded unchanged to {@link openAuthAuthorityPlane}, which bounds it to
   *  5..300 seconds. Absent: the five-minute default. No CLI flag and no request field sets it. */
  issuerSessionTtlSeconds?: number;
  /** Opt-in trusted-host consent signer, with seed material already in the private store. */
  toolResultConsents?: ToolResultConsentSignerOptions;
  /** Default off. Forwarded unchanged to {@link openAuthAuthorityPlane}. No CLI flag sets it. */
  serviceEndpoints?: OpenAuthAuthorityPlaneOptions["serviceEndpoints"];
  /** Default off. Auth hosts this registry using this context's own assigned secret store. */
  registry?: RegistryService;
  /** Trusted-host-only credential lifetime for registry renewal rehearsal, 5..900 seconds. */
  registryCredentialTtlSeconds?: number;
  /** This context's callout limits. `authTimeoutMs` must match the broker's `authorization
   *  { timeout }`. Absent: every default. No CLI flag sets it. */
  calloutLimits?: AuthCalloutLimits;
  /** Trusted-host only: connects a minute per actor, per owner and per client host whose bearer
   *  does not verify. Absent fields keep the defaults, 60, 600 and 60. No CLI flag sets it. */
  connectLimits?: Partial<ConnectLimits>;
}): Promise<AuthServiceHandle> {
  if (!inputs.context?.accountPublicKey || !inputs.context.lifecycleUid || !inputs.space || !inputs.servers || !inputs.stateDir)
    throw new Error("auth-service: hosted context needs an account, lifecycle, space, server and stateDir");
  if (inputs.store.identity === undefined)
    throw new Error("auth-service: hosted SecretStore must declare a stable identity");
  const actual = parseSecretStoreIdentity(inputs.store.identity);
  if (actual.kind !== "injected" || !sameSecretStoreIdentity(actual, inputs.storeIdentity))
    throw new Error("auth-service: hosted SecretStore identity does not match the assigned store identity");
  const port = inputs.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`auth-service: port must be a port number, got ${port}`);
  if (inputs.toolResultConsents !== undefined &&
      (!inputs.toolResultConsents || typeof inputs.toolResultConsents.keyId !== "string" ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(inputs.toolResultConsents.keyId) || typeof inputs.toolResultConsents.resolveAnchor !== "function"))
    throw new Error("auth-service: tool-result consent signer requires a key id and fresh anchor resolver");
  if (inputs.platformControl !== undefined && typeof inputs.platformControl?.observeAssignment !== "function")
    throw new Error("auth-service: platformControl requires an observeAssignment function");
  const host = inputs.platformControl?.host;
  if (host !== undefined) {
    endpointToken(host.endpoint);
    if (!host.endpoint.includes("."))
      throw new Error(`auth-service: platformControl.host.endpoint "${host.endpoint}" must be a reverse-DNS name; single-label names are reserved (SPEC 13.2)`);
  }
  const badFace = inputs.publicFace && checkPublicFace(inputs.publicFace);
  if (badFace) throw new Error(badFace);
  if (inputs.calloutLimits !== undefined) calloutLimits(inputs.calloutLimits);
  const started = await startAuthContext({
    space: inputs.space,
    server: inputs.servers,
    port,
    dir: resolve(inputs.stateDir),
    identityRoot: resolve(inputs.stateDir),
    secrets: inputs.store,
    hostedStore: true,
    localManager: () => undefined,
    context: inputs.context,
    ...(inputs.publicFace !== undefined ? { publicFace: inputs.publicFace } : {}),
    ...(inputs.platformControl !== undefined ? { platformControl: inputs.platformControl } : {}),
    ...(inputs.platformSupervisor !== undefined ? { platformSupervisor: inputs.platformSupervisor } : {}),
    ...(inputs.standingRenewableTtlSeconds !== undefined ? { standingRenewableTtlSeconds: inputs.standingRenewableTtlSeconds } : {}),
    ...(inputs.issuerSessionTtlSeconds !== undefined ? { issuerSessionTtlSeconds: inputs.issuerSessionTtlSeconds } : {}),
    ...(inputs.toolResultConsents !== undefined ? { toolResultConsents: inputs.toolResultConsents } : {}),
    ...(inputs.serviceEndpoints !== undefined ? { serviceEndpoints: inputs.serviceEndpoints } : {}),
    ...(inputs.registry !== undefined ? { registry: inputs.registry } : {}),
    ...(inputs.registryCredentialTtlSeconds !== undefined ? { registryCredentialTtlSeconds: inputs.registryCredentialTtlSeconds } : {}),
    ...(inputs.calloutLimits !== undefined ? { calloutLimits: inputs.calloutLimits } : {}),
    ...(inputs.connectLimits !== undefined ? { connectLimits: inputs.connectLimits } : {}),
  });
  return { ...started.handle, readiness: (): HostedServiceState => ({ ...started.status(), context: inputs.context }) };
}

type AuthContextEnd = { kind: "fenced"; cause: string } | { kind: "broker"; cause?: string };

/** The shared builder's state, without a key: only the hosted entry point has an assigned context
 *  to report it under, so the CLI composition never carries one. */
type AuthContextStatus = { state: "ready" | "draining" } | { state: "unavailable"; cause: string };

interface AuthContextOptions extends AuthServiceRuntimeOptions {
  toolResultConsents?: ToolResultConsentSignerOptions;
  space: string;
  server: string;
  port: number;
  dir: string;
  identityRoot: string;
  secrets: SecretStore;
  hostedStore: boolean;
  publicFace?: PublicFaceInput;
  localManager: () => ManagerInstanceIdentity | undefined;
  /** Present only for a hosted context: the assigned account the loaded data account must match. */
  context?: HostedContextKey;
  /** Present only for a hosted platform composition: builds the platform control door. */
  platformControl?: PlatformControlInput;
  platformSupervisor?: PlatformSupervisorInput;
  standingRenewableTtlSeconds?: number;
  issuerSessionTtlSeconds?: number;
  serviceEndpoints?: OpenAuthAuthorityPlaneOptions["serviceEndpoints"];
  calloutLimits?: AuthCalloutLimits;
  connectLimits?: Partial<ConnectLimits>;
  /** Diagnostics sink. Default `console.error`. */
  log?: (line: string) => void;
}

async function startAuthContext(o: AuthContextOptions): Promise<{ handle: Omit<AuthServiceHandle, "readiness">; status(): AuthContextStatus; ended: Promise<AuthContextEnd>; abandon(): Promise<void> }> {
  const { space, server, dir, secrets, port } = o;
  const log = o.log ?? ((l: string) => console.error(l));
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
      `auth-service: user-auth material is missing (${missing.join(", ")}) - ${o.hostedStore ? "the hosted composition must provision the secret store before starting this daemon" : "enable it with `cotal up --user-auth --idp <url>`"}`,
    );
  }
  if (issuer.issuer !== spaceIssuer(space))
    throw new Error(`auth-service: issuer pin ${issuer.issuer} does not match space "${space}"`);
  if (o.context !== undefined && keys.dataAccount.pub !== o.context.accountPublicKey)
    throw new Error("auth-service: the store's data account does not match the assigned hosted context");

  if (!(await isReachable(server, { creds: callout.calloutCreds })))
    throw new Error(`auth-service: can't reach the broker at ${server} with the callout creds - is the mesh up (with the callout account preloaded)?`);

  // ---- The authority plane (R1): stores ensured + registry + supervised reader, BEFORE the
  // callout exists — a connect must never be answered without the credential arm bound.
  const owned = new OwnedConnections();
  const onConnection = (nc: NatsConnection, label: string) => owned.track(nc, label);
  const plane = await openAuthAuthorityPlaneWithCustody({
    server,
    space,
    dir,
    identityRoot: o.identityRoot,
    ...(o.context !== undefined ? { identityStore: secrets } : {}),
    dataAccount: { pub: keys.dataAccount.pub, signingSeed: keys.dataAccount.signingSeed },
    log,
    localManager: o.localManager,
    eventPayloadsWithheld: o.eventPayloadsWithheld,
    ...(o.interactiveManagerSelection !== undefined ? { interactiveManagerSelection: o.interactiveManagerSelection } : {}),
    ...(o.runCancelLimits !== undefined ? { runCancelLimits: o.runCancelLimits } : {}),
    ...(o.standingRenewableTtlSeconds !== undefined ? { standingRenewableTtlSeconds: o.standingRenewableTtlSeconds } : {}),
    ...(o.issuerSessionTtlSeconds !== undefined ? { issuerSessionTtlSeconds: o.issuerSessionTtlSeconds } : {}),
    ...(o.serviceEndpoints !== undefined ? { serviceEndpoints: o.serviceEndpoints } : {}),
    sessionCalloutTimeoutMs: o.calloutLimits?.authTimeoutMs ?? 2000,
    ...(o.registry !== undefined ? { registry: o.registry, registryStore: secrets } : {}),
    ...(o.registryCredentialTtlSeconds !== undefined ? { registryCredentialTtlSeconds: o.registryCredentialTtlSeconds } : {}),
  }, onConnection);
  let nc: NatsConnection | undefined;
  let http: ReturnType<typeof createServer> | undefined;
  let publicHttp: ReturnType<typeof createServer> | undefined;
  // Stop admission, let accepted requests settle within the public request deadline, then cut
  // whatever is still open so a stuck client cannot hold this context's close forever.
  const closeServer = async (srv: ReturnType<typeof createServer> | undefined): Promise<void> => {
    if (srv === undefined || !srv.listening) return;
    const closed = new Promise<void>((r) => srv.close(() => r()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([closed, new Promise<void>((r) => { timer = setTimeout(r, PUBLIC_DEADLINE_MS); })]);
    clearTimeout(timer);
    srv.closeAllConnections();
    await closed;
  };
  try {
    // ---- Plane 2: the callout, on its own callout-account connection ----
    nc = await dialerFor(server)({
      servers: server,
      authenticator: credsAuthenticator(new TextEncoder().encode(callout.calloutCreds)),
      name: `cotal:auth-service:${space}`,
    });
    onConnection(nc, `cotal:auth-service:${space}`);
    const serviceCallout = plane.serviceEndpointHost !== undefined ? serviceHostCalloutOf(plane.serviceEndpointHost) : undefined;
    // One limiter for the callout and the exchange: an actor whose connects are refused is refused a
    // fresh bearer too.
    const connectLimiter = new ConnectLimiter(o.connectLimits);
    serveCallout(nc as never, {
      eventPayloadsWithheld: o.eventPayloadsWithheld,
      space,
      dir,
      callout,
      dataAccount: { pub: keys.dataAccount.pub, signingSeed: keys.dataAccount.signingSeed },
      issuer,
      hooks: plane,
      ...(serviceCallout !== undefined ? { serviceAuthority: serviceCallout } : {}),
      connectLimiter,
      ...(o.calloutLimits !== undefined ? { limits: o.calloutLimits } : {}),
    });
    // The subscription must be ON the broker before readiness is signaled — an `up` that recorded a
    // usable user mesh while the SUB was still in flight would intermittently deny first connects.
    await nc.flush();

    // ---- Plane 1: the exchange + JWKS, loopback HTTP ----
    const bridgeIdp = { issuer: idp.issuer, audience: idp.audience, key: pinnedJwksResolver(idp.jwksUri) };
    const authorizeActor = ledgerAuthorizeGrant(dir);
    const bridge = createIdpBridge({
      idp: bridgeIdp,
      space,
      spaceSecret: ownerSecret,
      issuer,
      authorizeActor,
      mintConnectCredential: plane.mintConnectCredential,
      ...(idp.dmReaderAudience !== undefined ? { dmReaderAudience: idp.dmReaderAudience } : {}),
      connectLimiter,
    });
    const cap = randomBytes(32).toString("hex"); // per-start exchange capability (rotates with the daemon)
    // Set once the public face binds. An enrolled child's bearer exchanges there without the
    // loopback capability, so enrollment needs that face.
    let publicUrl: string | undefined;
    const failures: number[] = []; // rolling-window timestamps of REFUSED exchanges
    const badCaps: number[] = []; // rolling-window timestamps of invalid-capability attempts
    const issueToolResultConsent = o.toolResultConsents === undefined ? undefined : createToolResultConsentSigner({
      space, accountPublicKey: keys.dataAccount.pub, dir, store: secrets, idp: bridgeIdp, ownerSecret,
      signer: o.toolResultConsents, record: plane.recordToolResultConsent,
    });
    const serviceEngine = plane.serviceEndpointHost !== undefined ? serviceHostEngineOf(plane.serviceEndpointHost) : undefined;
    const ctx: HandlerCtx = {
      connectLimiter,
      ...(issueToolResultConsent ? { issueToolResultConsent } : {}),
      ...(serviceEngine !== undefined ? { serviceAuthority: { space, accountPublicKey: keys.dataAccount.pub, engine: serviceEngine, material: issuer } } : {}),
      ...(plane.serviceEndpointHost !== undefined ? { serviceHost: plane.serviceEndpointHost } : {}),
      issuer,
      bridge,
      bridgeIdp,
      ownerSecret,
      authorizeActor,
      managerServiceAuthority: plane.issueManagerServiceAuthority,
      deregisterEndpoint: plane.deregisterEndpoint,
      maintainRemoteManager: plane.maintainRemoteManager,
      validateRetainedAgent: plane.validateRetainedAgent,
      verifyManagedAgentEnrollment: plane.verifyManagedAgentEnrollment,
      verifyManagedAgentPrepareRetirement: plane.verifyManagedAgentPrepareRetirement,
      verifyManagedAgentRuntime: plane.verifyManagedAgentRuntime,
      enrollManagedAgent: (args) => {
        if (publicUrl === undefined)
          throw new EpEnvelopeError("failed-precondition", "managed agent enrollment needs the public exchange face, where the enrolled agent's bearer exchanges - start the auth service with --exchange-public-port");
        return plane.enrollManagedAgent({ ...args, sentinelCreds: callout.sentinelCreds, agentBearerExchangeUrl: publicUrl });
      },
      prepareManagedAgentRetirement: plane.prepareManagedAgentRetirement,
      scanManagerGoalIndex: plane.scanManagerGoalIndex,
      authorizeManagerAdmin: plane.authorizeManagerAdmin,
      authorizeManagerParticipation: plane.authorizeManagerParticipation,
      admitManagerRun: plane.admitManagerRun,
      submitManagerRun: plane.submitManagerRun,
      revokeManagerRun: plane.revokeManagerRun,
      cancelManagerRun: plane.cancelManagerRun,
      issueManagerRunAttempt: plane.issueManagerRunAttempt,
      secrets,
      retireInteractiveLifecycle: plane.retireInteractiveLifecycle,
      retireManagedLifecycle: plane.retireManagedLifecycle,
      activateManagedLifecycle: plane.activateManagedLifecycle,
      accountPublicKey: keys.dataAccount.pub,
      cap,
      failures,
      badCaps,
      space,
      dir,
      mintConnectCredential: plane.mintConnectCredential,
      resolvePluginChannelState: plane.resolvePluginChannelState,
      selectManagerInstance: plane.selectManagerInstance,
      listManagerInstances: plane.listManagerInstances,
      verifySession: plane.verifySession,
      openChatSession: plane.openChatSession,
      chatSessionBearer: plane.chatSessionBearer,
      retireChatSession: plane.retireChatSession,
    };
    const loopback = createServer((req, res) => void handle(req, res, ctx));
    http = loopback;
    await new Promise<void>((resolvePort, reject) => {
      loopback.once("error", reject);
      loopback.listen(port, "127.0.0.1", () => resolvePort());
    });
    const addr = loopback.address();
    const boundPort = typeof addr === "object" && addr ? addr.port : port;
    const url = `http://127.0.0.1:${boundPort}`;

    // The optional PUBLIC face: its own server, its own closed route table, its own budgets — also
    // loopback-bound (the operator's reverse proxy terminates TLS and forwards here).
    if (o.publicFace !== undefined) {
      const face = o.publicFace;
      // The discovery bundle is GENERATED from the daemon's own recorded config — the pinned IdP,
      // the flags, the callout material — so it cannot drift from what this process enforces.
      // `endpoints.url` is finalized AFTER bind (the closure sees the mutation): with `--port 0`
      // the pre-bind port would advertise an address nothing listens on.
      const bundle = composeUserBundle({
        space,
        // What participants DIAL, not what the callout dials: the daemon reaches the broker on its
        // loopback/LAN address (--server), which is meaningless off this machine. --advertised-server
        // is the publicly dialable address (e.g. wss://… through the reverse proxy).
        server: face.advertisedServer ?? server,
        idp: { url: idp.url, issuer: idp.issuer, audience: idp.audience },
        sentinelCreds: callout.sentinelCreds,
        eventPayloadsWithheld: o.eventPayloadsWithheld,
        ...(face.agentProvisioningUrl ? { agentProvisioningUrl: face.agentProvisioningUrl } : {}),
      });
      const pub = createServer(makePublicHandler(ctx, makePublicPolicy(face.trustedProxy), bundle));
      publicHttp = pub;
      await new Promise<void>((resolvePort, reject) => {
        pub.once("error", reject);
        pub.listen(face.port, "127.0.0.1", () => resolvePort());
      });
      const paddr = pub.address();
      const boundPublic = typeof paddr === "object" && paddr ? paddr.port : face.port;
      publicUrl = face.url ?? `http://127.0.0.1:${boundPublic}`;
      finalizeUserBundleEndpoint(bundle, publicUrl);
    }

    const callNc = nc;
    let state: HostedServiceState["state"] = "ready";
    let cause: string | undefined;
    let closePromise: Promise<void> | undefined;
    let closeAdmission: Promise<void> | undefined;
    let closeStarted = false;
    // The readiness reader: one standing connection pinned to the assigned instance, replaced when
    // the assignment names another instance.
    let reader: { instanceId: string; caller: EpCaller; client: Promise<AuthorityClient> } | undefined;
    const close = (): Promise<void> => {
      if (closePromise !== undefined) return closePromise;
      closeStarted = true;
      if (state === "ready") state = "draining";
      const flight = (async () => {
        const admissionFlight = closeAdmission ??= (async () => {
          await Promise.all([closeServer(http), closeServer(publicHttp)]);
          await reader?.client.then((c) => c.close(), () => {});
        })();
        let admissionFailure: unknown;
        try { await admissionFlight; }
        catch (e) { admissionFailure = e; if (closeAdmission === admissionFlight) closeAdmission = undefined; }
        let planeFailure: unknown;
        try { await plane.close(); } catch (e) { planeFailure = e; }
        let calloutFailure: unknown;
        try { await callNc.close(); }
        catch (cause) { calloutFailure = new Error(`auth connection cotal:auth-service:${space} failed to close`, { cause }); }
        const failures = [admissionFailure, planeFailure, calloutFailure].filter((e) => e !== undefined);
        if (failures.length > 1) throw new AggregateError(failures, "auth context close failed");
        if (failures.length) throw failures[0];
        await owned.closeRemaining();
        owned.complete();
      })();
      closePromise = flight;
      void flight.catch(() => {
        if (closePromise === flight) closePromise = undefined;
      });
      return flight;
    };
    const ended: Promise<AuthContextEnd> = Promise.race([
      (callNc as { closed(): Promise<Error | void> }).closed().then((err): AuthContextEnd => ({ kind: "broker", ...(err ? { cause: err.message } : {}) })),
      plane.fenced.then((reason): AuthContextEnd => ({ kind: "fenced", cause: reason })),
    ]).then((end) => {
      // A clean broker close after this context's own close() is the orderly end, not a failure.
      if (end.kind === "fenced" || end.cause !== undefined || !closeStarted) {
        state = "unavailable";
        cause = end.kind === "fenced" ? end.cause : `broker connection closed${end.cause !== undefined ? ` (${end.cause})` : ""}`;
        if (!closeStarted) close().catch(() => {});
      }
      return end;
    });
    const platformControl = o.platformControl;
    const host = platformControl?.host;
    // The human route's retained-validation composition, for the platform holder.
    const validateRetainedForHolder = async (holder: Extract<ManagerAuthorityHolder, { holder: "platform" }>, request: RemoteRetainedAgentValidationRequest) => {
      const retained = await plane.validateRetainedAgent({ ...holder, request });
      const authority = await validateRetainedManagedAgent({
        store: secrets,
        dir,
        space,
        owner: retained.target.owner,
        actor: retained.target.actor,
        actorToken: retained.actorToken,
        sentinelCreds: retained.sentinelCreds,
      });
      return completeRemoteRetainedAgentValidation(retained, holder.owner, authority);
    };
    const refuseUnlessReady = () => {
      if (state !== "ready" || closePromise !== undefined)
        throw new EpEnvelopeError("unavailable", "auth-service context is not ready");
    };
    const platformDeps = platformControl === undefined ? undefined : {
      space,
      accountPublicKey: keys.dataAccount.pub,
      owner: platformControlOwner(ownerSecret, space, keys.dataAccount.pub),
      observeAssignment: (s: string, a: string) => platformControl.observeAssignment(s, a),
      observeManagerInstance: plane.observeManagerInstance,
    };
    const readStatus = (owner: string) => async (instanceId: string): Promise<EpAttributedReply> => {
      refuseUnlessReady();
      if (reader?.instanceId !== instanceId) {
        void reader?.client.then((c) => c.close(), () => {}).catch((e: unknown) => {
          log(`auth readiness reader close failed: ${e instanceof Error ? e.message : String(e)}`);
        });
        const caller = { owner, actor: `manager_ready_${instanceId}`, uid: mintLifecycleUid() };
        const client = openAuthorityClient({
          onConnection,
          server,
          space,
          dataAccount: { pub: keys.dataAccount.pub, signingSeed: keys.dataAccount.signingSeed },
          label: `cotal:platform-readiness:${space}`,
          grants: (id) => platformReadinessGrants(space, id, caller, instanceId),
          log,
        });
        // A failed open is not cached: the next read opens again.
        client.catch(() => { if (reader?.client === client) reader = undefined; });
        reader = { instanceId, caller, client };
      }
      const { caller, client } = reader;
      const { nc: readerNc } = await client;
      return await invokeCommand(readerNc, space, await resolveService(readerNc, space, "manager", caller, { instanceId, commands: ["status"] }), "status", undefined, {});
    };
    const service: Omit<AuthServiceHandle, "readiness"> = {
      deregisterEndpoint: (request, granter) => { refuseUnlessReady(); return plane.deregisterEndpoint(request, granter); },
      resolvePluginChannelState: (requestedSpace) => { refuseUnlessReady(); return plane.resolvePluginChannelState(requestedSpace); },
      url,
      ...(publicUrl !== undefined ? { publicUrl } : {}),
      cap,
      closed: owned.closed,
      connections: () => owned.connections(),
      ...(plane.serviceEndpointHost !== undefined ? { serviceEndpointHost: hostedServiceEndpoints(plane.serviceEndpointHost, refuseUnlessReady) } : {}),
      ...(o.platformSupervisor !== undefined ? {
        platformSupervisorAuthority: async (owner: string) => {
          refuseUnlessReady();
          assertDerivedOwnerToken(owner);
          const input = o.platformSupervisor!;
          await requirePlatformSupervisorAdmin(input, owner);
          return makePlatformSupervisorAuthority({
            ...input, owner, space, accountPublicKey: keys.dataAccount.pub, ready: refuseUnlessReady,
            observePrincipal: async (instanceId) => (await plane.observeManagerInstance(instanceId)).gate?.principal,
            issue: (boundOwner, supervisorExpiresAt, request) => plane.issueManagerServiceAuthority({
              owner: boundOwner, scope: ["supervise"], supervisorExpiresAt, request,
            }),
          });
        },
        endPlatformSupervisorAssignment: makePlatformSupervisorEnd({
          ...o.platformSupervisor, space, accountPublicKey: keys.dataAccount.pub, ready: refuseUnlessReady,
          end: (owner, instanceId, lifecycleUid) => plane.endPlatformSupervisor({ owner, instanceId, lifecycleUid }),
        }),
      } : {}),
      ...(platformDeps !== undefined ? {
        platformControlAuthority: makePlatformControlAuthority({
          ...platformDeps,
          dispatch: (holder, request) => {
            refuseUnlessReady();
            switch (request.kind) {
              case "manager-service-authority": return plane.issueManagerServiceAuthority({ ...holder, request });
              case "manager-service-maintenance": return plane.maintainRemoteManager({ ...holder, request });
              case "manager-goal-index-scan": return plane.scanManagerGoalIndex({ ...holder, request });
              case "manager-admin-authorization": return plane.authorizeManagerAdmin({ ...holder, request });
              case "manager-run-admission": return plane.admitManagerRun({ ...holder, request });
              case "manager-run-submission": return plane.submitManagerRun({ ...holder, request });
              case "manager-run-attempt": return plane.issueManagerRunAttempt({ ...holder, request });
              case "manager-retained-agent-validation": return validateRetainedForHolder(holder, request);
            }
          },
        }),
        platformControlReadiness: makePlatformControlReadiness({ ...platformDeps, readStatus: readStatus(platformDeps.owner) }),
        observeManagerGate: async (instanceId: string) => {
          refuseUnlessReady();
          return (await plane.observeManagerInstance(instanceId)).gate;
        },
        activateManagedLifecycle: async (target) => {
          refuseUnlessReady();
          await plane.activateManagedLifecycle(target);
        },
      } : {}),
      ...(host !== undefined ? {
        registerHostIncarnation: async (instanceId: string) => {
          refuseUnlessReady();
          return { instanceId, processEpoch: await plane.registerHostInstance(host, instanceId) };
        },
        observeHostGate: async (instanceId: string) => {
          refuseUnlessReady();
          return await plane.observeEndpointGate(host.endpoint, instanceId);
        },
        awaitHostFence: async (instanceId: string, processEpoch: number) => {
          if (!Number.isSafeInteger(processEpoch) || processEpoch < 0)
            throw new EpEnvelopeError("bad-request", `processEpoch must be a non-negative integer, got ${String(processEpoch)}`);
          // No runtime credential may create a consumer on the auth bucket (SPEC 13.9), so the
          // gate cannot be watched; the hook polls its leader-served read.
          for (;;) {
            refuseUnlessReady();
            const gate = await plane.observeEndpointGate(host.endpoint, instanceId);
            if (gate?.state !== "open" || gate.processEpoch !== processEpoch) return gate;
            await new Promise((r) => setTimeout(r, HOST_FENCE_POLL_MS));
          }
        },
      } : {}),
      drain: close,
      close,
    };
    const status = (): AuthContextStatus =>
      state === "unavailable" ? { state, cause: cause ?? "auth-service context is unavailable" } : { state: closeStarted ? "draining" : "ready" };
    /** After a close that did not complete: end what it left open, as a process exit would, and
     *  leave the claim row as the failed close left it. */
    const abandon = async (): Promise<void> => {
      for (const srv of [http, publicHttp]) if (srv?.listening) { srv.closeAllConnections(); srv.close(); }
      await owned.closeRemaining().catch(() => {});
      owned.complete();
    };
    return { handle: service, status, ended, abandon };
  } catch (e) {
    // A failed start releases only what THIS context acquired, in reverse order.
    await closeServer(publicHttp).catch(() => {});
    await closeServer(http).catch(() => {});
    await nc?.close().catch(() => {});
    await plane.close().catch((r: unknown) => log(r instanceof Error ? r.message : String(r)));
    throw e;
  }
}
