/** Controller-owned whole-stack startup: broker first, then native stream setup, the delivery
 *  credential and delivery, the auth service for a user stack, then the manager. An open stack has no
 *  delivery member and mints no credential: its broker serves the prepared open configuration and
 *  its manager reports through the child's own local receipt. A user stack's manager needs the
 *  invoking user's existing login and grant; without it the manager is not attempted and the result
 *  is a known `AUTH_REQUIRED` partial. Every member is a saved root-bound definition and an
 *  exact service-controller instance. Trust and the broker configuration are prepared explicitly
 *  here, outside any adapter plan. A failure after the first effect is reported as partial or
 *  unknown with the members it changed; nothing already started is rolled back. */
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { displayCmd } from "../lib/self-exec.js";
import { localDiagnostic } from "../telemetry.js";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { JetStreamApiCodes, JetStreamApiError } from "@nats-io/jetstream";
import { awaitDeadDeliveryLease, CONTRACT_ARTIFACT_MAX_BYTES, deliveryLeaseHolderFor, isJetStreamMissing, isReachable, LEASE_TTL_MS, MANAGER_START_PAYLOAD_FLOOR, mintCreds, newIdentity, openPrivateAppend, type BrokerTransport, type ChannelRegistryFile, type ParsedArgs } from "@cotal-ai/core";
import {
  CommandFailure,
  accountInventory,
  authDir,
  brokerUrlKey,
  canonicalRoot,
  codeSpan,
  deliveryCredsKey,
  findMesh,
  findPreparedSpace,
  getCurrent,
  readCurrentSelection,
  getSpaceAuth,
  hasUserAuthState,
  homeCotalDir,
  isCommandFailure,
  loadMeshes,
  localMeshesForRoot,
  NATS_PIDFILE,
  presentationOf,
  readBrokerPolicy,
  readMaintenanceJournal,
  renderReport,
  resolveNativeServiceTarget,
  resolveOnPath,
  rotateSystemCreds,
  SPACE_NAME_MAX,
  spaceNameTooLong,
  stackHomeRemedy,
  stackRunsUnderOtherHome,
  workspaceSecretStore,
  writeResult,
  type MaintenanceLock,
  type OutputWarning,
  type Report,
  type SeatCap,
  type ServiceDefinitionInput,
  type UserAuthInfo,
  unparsableDaemonCreds,
  loopbackListeners,
  readProcessCommand,
  resolveMeshTarget,
  processStopped,
  WEB_SERVICE_ADAPTER,
} from "@cotal-ai/workspace";
import { liveMeshProcesses } from "./clean.js";
import { addressHolder, brokerListenAddress, canonicalServer, listenerBindError } from "../lib/broker-service.js";
import { brokerStoreWrite, jetStreamDisabled, jetStreamDisabledRefusal, readStoredBytes, storeDamageNotice, storeFull } from "../lib/broker-store-health.js";
import { loadChannelsFile } from "../lib/channel-seed.js";
import { shellWord } from "../lib/endpoint-errors.js";
import { seedDefaultPersona } from "../lib/default-persona.js";
import { noManagerCredentialWarning } from "../lib/daemon-credential-warning.js";
import { definitionListeners, exposedPlaintext, listenerRow, type StackListener } from "../lib/stack-listeners.js";
import { controlsRecordedAdapter } from "../lib/service-adapters.js";
import { definitionRootMatch, serviceDefinitionStore, validateServiceDefinition, type ServiceDefinitionSnapshot } from "../lib/service-definitions.js";
import { instanceProjection, observeServiceProcess, serviceInstances, serviceInstanceStore, serviceRecordsWriteProblem, type ServiceInstance, type ServiceInstanceSnapshot } from "../lib/service-instances.js";
import { prepareKernelServiceStop, prepareProcessService, readOwnedLogTail, readServiceLog, removeServiceLogs, removeStoppedInstanceRecords, settleExitedInstances, startProcessService, stopProcessService } from "../lib/service-process.js";
import { listLedgerFiles } from "../lib/manifest/ledger.js";
import { listAdditiveTeamAttempts, retainedAdditiveTeamAttempts, type AdditiveTeamAttempt } from "../lib/team-additive-attempt.js";
import { freshTeamAttemptSettled, listFreshTeamAttempts, listFreshTeamSummaries } from "../lib/team-fresh.js";
import { foreignLocalProcesses, legacyBrokerPidfileBlock, newStackOperation, readStackJournal, removeStaleLocalRecords, runningStackRoles, serviceHeldRecords, settleRetainedStackStops, settleStackOperation, STACK_ADAPTER, STACK_DEFINITION, STACK_ROLES, stackDefinitionsAt, stackMaintenanceFence, stackNeverStarted, stackRecoveryHost, stackOperationUnsettled, stackRoleApplies, stackSettlementNotice, staleRecordWarning, withSettledMembers, writeStackJournal, type LocalRecord, type StackJournal, type StackJournalSnapshot, type StackMember, type StackMode, type StackRole, type StackSettlement } from "../lib/stack-journal.js";
import { stackRetryServer } from "../lib/up-broker-address.js";
import { withManagerName } from "../lib/up-manager-name.js";
import { NATS_DEFAULT_MAX_PAYLOAD, natsServerLabel, type NatsServer } from "../lib/nats-bin.js";
import { sharedStoreAtStart, sharedStoreWarning, type StoreTenant } from "../lib/store-dir.js";
import { readStoreIdentity, stackStoreWarnings } from "../lib/store-identity.js";
import { assertManagerLogin, assertUserStackTransport, confirmUserAuthEndpoints, preflightUserStack, provisionalUserAuth, userRegistrationIncomplete, type StackUserPrepared } from "./stack-user-auth.js";

/** How many times a broker start is launched again after another process took its websocket port. */
const BROKER_WEBSOCKET_RELAUNCHES = 4;

/** Whether a broker launch exited because its websocket listener could not bind `wsPort`. nats-server
 *  logs that bind failure as its last line: in its own `logFile` when it has one, otherwise in the
 *  startup log whose last line the start failure quotes. */
function websocketPortTaken(error: unknown, wsPort: number, logFile: string | undefined): boolean {
  if (!isCommandFailure(error) || error.code !== "OPERATION_FAILED") return false;
  let last = error.message;
  if (logFile !== undefined) {
    try { last = readOwnedLogTail(logFile, 1).lines.at(-1) ?? ""; } catch { return false; }
  }
  return last.includes("Unable to listen for websocket connections: ") && last.includes(`:${wsPort}: bind: address already in use`);
}

/** Callbacks into the native broker preparation that `up.ts` owns. They hold private authority
 *  material and are passed in, so this module never re-derives trust or a transport decision. */
export interface StackUpNative {
  /** `userAuth` asks the native `authSetup` user arm (`prepareServer`) and must return its private
   *  `user` material; any other mode must return none. */
  prepareBroker(opts: { transport: BrokerTransport; server: string; space: string; open: boolean; userAuth?: { idpUrl?: string }; host?: string; wsPort?: number; storeDir?: string; existingStore?: ExistingStorePin; maxFileStore?: number; logFile?: string; logfileSizeLimit?: number; logfileMaxNum?: number; authTimeout?: number; maxPayload?: number; accountResolver?: "memory" | "full"; noManager?: boolean }): Promise<{ root: string; server: string; space: string; storeDir: string; transport: BrokerTransport; setup?: { mintProvisioner(): Promise<string>; wsPort: number; moveWebsocketPort(): Promise<number> }; user?: StackUserPrepared; confPath: string; bin: string; source: "path" | "bundled"; version: string | null; authTimeout?: number; maxPayload?: number; accountResolver?: "memory" | "full" }>;
  /** Recreation options are accepted only on a fresh broker before space services start. */
  initializeStreams(server: string, space: string, setup: { mintProvisioner(): Promise<string> } | undefined, seedFile: ChannelRegistryFile | undefined, recreateIssuedStores?: string, recreateMembershipStore?: boolean): Promise<void>;
  /** On a broker the stack reuses, create the space's streams again when every one of them is gone,
   *  as after `cotal space delete`, and say whether it did. */
  recreateDeletedStreams(opts: { root: string; space: string; server: string; mode: StackMode; readSeed: () => ChannelRegistryFile | undefined }): Promise<boolean>;
  recordMesh(entry: { space: string; server: string; root: string; mode: StackMode; tlsRequired: boolean; storeDir: string; userAuth?: UserAuthInfo; maxSessions?: number; attachHost?: string; maxFileStore?: number }): void;
  /** Record the transport, and the auth callout timeout, payload limit and account resolver the
   *  prepared configuration rendered. */
  commitTransport(root: string, transport: BrokerTransport, limits?: { authTimeout?: number; maxPayload?: number; accountResolver?: "memory" | "full" }): void;
}

/** The identity of an existing broker store that a start must reuse and never create. */
export interface ExistingStorePin { named: string; path: string; dev: string; ino: string; birthtimeNs: string }

/** Pin a named store that must already exist as a real directory, refusing a missing path, a
 *  non-directory and a symlink. The pin and its rechecks narrow the window in which another local
 *  process can replace the path. They cannot close it: neither Node nor nats-server opens a
 *  directory by identity, and the last recheck still precedes the broker's own open. */
export function pinExistingStore(named: string, target: Record<string, unknown>): ExistingStorePin {
  let pin: ExistingStorePin | undefined;
  try {
    const link = lstatSync(named, { bigint: true });
    if (link.isDirectory() && !link.isSymbolicLink()) {
      const path = realpathSync.native(named), stat = lstatSync(path, { bigint: true });
      if (stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === link.dev && stat.ino === link.ino)
        pin = { named, path, dev: stat.dev.toString(), ino: stat.ino.toString(), birthtimeNs: stat.birthtimeNs.toString() };
    }
  } catch { pin = undefined; }
  if (!pin) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the named broker store is not an existing real directory; no store was created and nothing was prepared", { target: { ...target, storeDir: named } });
  return pin;
}

/** Check a pinned store again: the named path must still resolve to the pinned directory. A missing,
 *  replaced or relinked store refuses. */
export function recheckExistingStore(pin: ExistingStorePin, target: Record<string, unknown>): void {
  let stat;
  try {
    const link = lstatSync(pin.named, { bigint: true });
    stat = link.isDirectory() && !link.isSymbolicLink() && realpathSync.native(pin.named) === pin.path ? lstatSync(pin.path, { bigint: true }) : undefined;
  } catch { stat = undefined; }
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev.toString() !== pin.dev || stat.ino.toString() !== pin.ino || stat.birthtimeNs.toString() !== pin.birthtimeNs)
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the named broker store disappeared, was replaced or became a link after it was checked; no store was created and the broker was not started", { target: { ...target, storeDir: pin.named } });
}

export interface StackUpRequest {
  /** The root maintenance lock the caller holds for this whole start. Holding it proves no other
   *  whole-stack operation is in flight, which is what lets an unsettled earlier one be settled. */
  maintenanceLock: MaintenanceLock;
  root: string;
  space: string;
  server: string;
  transport: BrokerTransport;
  runtime: string;
  noManager: boolean;
  /** An explicitly requested mode. Omitted keeps the journal's pinned mode, or static auth. */
  mode?: StackMode;
  /** The IdP a first user-auth enable pins (`--idp`); refused outside user mode. */
  idp?: string;
  host?: string;
  storeDir?: string;
  maxFileStore?: number;
  logFile?: string;
  logfileSizeLimit?: number;
  logfileMaxNum?: number;
  /** The auth callout timeout in seconds (`--auth-timeout`), user stacks only. Absent: the recorded one. */
  authTimeout?: number;
  /** The broker's payload limit in bytes (`--max-payload`). Absent: the recorded one. */
  maxPayload?: number;
  /** How the broker resolves space accounts (`--account-resolver`). Absent: the recorded one. */
  accountResolver?: "memory" | "full";
  maxSessions?: number;
  managerName?: string;
  managerSeatCap?: SeatCap;
  channels?: string;
  foreground: boolean;
  presentation: ReturnType<typeof presentationOf>;
  /** True when a targeted restart accounts for all supplied CLI options. */
  simpleTargetedStartup?: boolean;
  /** A complete, locally printable retry for an occupied recorded address, when available. */
  retryAtRecordedAddress?(): string | undefined;
  /** CLI advice that retries this invocation at a free broker port. Team boot has its own recovery. */
  retryAtAnotherAddress?(bindHost: string): Promise<string | undefined>;
  /** The root of the folder `up --root` was run from, when it is not this stack's root. */
  invokedRoot?: string;
  /** A fresh team boot's frozen manifest inputs. `seed` replaces `channels` for the broker's native
   *  channel registry seed. `launchSpec` runs once, after broker (and user auth-service)
   *  preparation and immediately before the manager member is defined, and returns the private
   *  native launch spec the manager service pins by digest. It is never called for a reused manager. */
  manifest?: {
    /** The boot's own retained fresh intent, which is unsettled by design until its summary. Only
     *  this exact ID is exempt from the unsettled-attempt refusal; every other one still refuses. */
    deploymentId: string;
    seed: ChannelRegistryFile;
    launchSpec(context: { root: string; space: string; server: string; mode: StackMode; user?: StackUserPrepared }): Promise<{ path: string; sha256: string }>;
  };
  /** Compare-and-swap binding for a team boot that resumes an exact stopped stack: the journal bytes
   *  read by its eligibility gate under the same maintenance lock. Any change before this call's
   *  own read refuses; nothing is re-planned from different records. */
  expectPriorDown?: { journalSha256: string; operationId: string };
  /** `--rotate-sys`: rotate the space's system account and re-mint its two `$SYS` creds just before
   *  the broker is prepared, so the broker this start launches loads the successor. Only a stopped
   *  static-auth or user-auth stack takes it. */
  rotateSys?: boolean;
  /** `--recreate-issued-stores`: the new backup directory the fresh broker's stream setup backs up
   *  the space's pre-retention issued-authority stores into before it creates them again. Only a
   *  stopped stack takes it, since the step must run before any issuer of the space. */
  recreateIssuedStores?: string;
  /** Explicitly replace the stopped space's legacy File-backed derived membership store. */
  recreateMembershipStore?: boolean;
}

/** The domain outcome of a successful whole-stack start, for a caller that renders its own receipt.
 *  Every refusal, partial or unknown outcome is still thrown as a classified failure. */
export interface StackUpResult {
  journal: StackJournal;
  changed: unknown[];
  allReused: boolean;
  /** The manager's pinned launch spec, when this call defined one. */
  launch?: { path: string; sha256: string };
  /** A settled active restore of this stack that its retained journal did not fence. */
  admittedRestore?: string;
  /** An earlier operation with no recorded outcome that this call settled before it started. */
  settled?: StackSettlement;
  /** The nats-server this call started the broker with. */
  brokerExecutable?: NatsServer;
  /** This call created the space's streams again on the running broker it reused. */
  streamsRecreated?: true;
  /** The system-account rotation this call made before it prepared the broker. */
  rotation?: { generation: number; expiresAt: string | null };
  /** The recorded store, when another space also uses it. */
  storeShared?: { path: string; tenants: StoreTenant[] };
  /** Store loss observed before this call reused or started the broker. */
  storeWarnings?: OutputWarning[];
  /** Process records under the root that fronted no process, which this call removed before it started a member. */
  clearedRecords?: LocalRecord[];
}

const PUBLIC_EXCHANGE_INPUTS: readonly string[] = ["exchange-public-port", "exchange-public-url", "exchange-trusted-proxy", "advertised-server", "agent-provisioning-url"];

/** Inputs that name a legacy-only startup refuse on the controller route. They are not dropped. A
 *  recorded stack takes `rotate-sys` on a stopped start; a first start refuses it, because it mints
 *  the space's system account new. */
const CONTROLLER_UNSUPPORTED = ["file", "dry-run", "restore", "restore-only", "accept-missing-source", "accept-stale-checkpoint", "rotate-sys", ...PUBLIC_EXCHANGE_INPUTS, "tls-cert", "tls-key"] as const;

/** The inputs that ask for a TLS broker, which the controller stack does not serve: the certificate
 *  pair, and a `--server` that names a `tls://` address. */
const TLS_INPUTS: readonly string[] = ["tls-cert", "tls-key", "server tls://"];

const namesTlsServer = (values: ParsedArgs["values"]): boolean => typeof values.server === "string" && /^tls:\/\//i.test(values.server);

/** Whether an `up` invocation asks for a TLS broker. */
export function requestsTls(values: ParsedArgs["values"]): boolean {
  return values["tls-cert"] !== undefined || values["tls-key"] !== undefined || namesTlsServer(values);
}

/** Of those, the ones `up -f <cotal.yaml>` takes on a prepared root. */
const MANIFEST_ROUTE: readonly string[] = ["dry-run", ...TLS_INPUTS];

/** The refusal of startup options the controller stack has no route for, before anything starts.
 *  A prepared root that has not run a stack yet is also offered the manifest route. */
function controllerUnsupported(root: string, options: readonly string[], prepared: boolean): CommandFailure {
  const flags = options.map((name) => `--${name}`);
  const named = flags.length === 1 ? flags[0]! : `${flags.slice(0, -1).join(", ")} and ${flags.at(-1)!}`;
  const publicExchange = options.every((name) => PUBLIC_EXCHANGE_INPUTS.includes(name));
  const manifest = prepared && options.every((name) => MANIFEST_ROUTE.includes(name));
  const rotation = prepared && options.includes("rotate-sys") ? "; a first start mints the space's $SYS creds, so there is nothing to rotate" : "";
  return new CommandFailure("refused", "UNSUPPORTED", `${prepared ? "this root is prepared for a controller-owned stack" : "this root's stack is owned by the service controller"}, which has no route for ${named}; nothing was started through the legacy launcher`, {
    target: { root, options },
    remedy: publicExchange
      ? "to serve a public exchange, run `cotal up --user-auth --idp <auth base URL>` from a new, unprepared project folder without running `cotal space create` first. Keep the broker and public exchange flags, use `--space <unused-name>`, and omit `--root`, `--json` and `--plain`"
      : manifest && options.some((name) => TLS_INPUTS.includes(name))
      ? `run \`cotal up\` without ${named} to serve plaintext, or serve TLS from a manifest whose broker.servers names a tls:// address, with \`cotal up -f <cotal.yaml> --tls-cert <cert.pem> --tls-key <key.pem>\``
      : manifest ? `run \`cotal up\` without ${named}, or start the space from a manifest with \`cotal up -f <cotal.yaml>\`, which takes ${flags.length === 1 ? "it" : "them"}` : `run \`cotal up\` without ${named}${rotation}`,
  });
}

/** Any account record, readable or not, means the root carries static trust an open stack would bypass. */
function holdsBrokerAccount(root: string): boolean {
  const inventory = accountInventory(authDir(root));
  return inventory.spaces.length > 0 || inventory.corrupt.length > 0;
}

const MODE_NAME: Record<StackMode, string> = { auth: "static auth", open: "open", user: "user auth" };

/** The broker already has a journal. Repeat only the target and the settings for the unstarted manager. */
function stackLoginRetry(request: StackUpRequest): string {
  const bare = "run bare `cotal up` again";
  if (request.manifest) return bare;
  const { root, space, runtime, managerName, managerSeatCap, maxSessions, foreground, presentation } = request;
  const options = [
    ...(runtime !== "pty" ? ["--runtime", shellWord(runtime)] : []), ...(managerName ? ["--manager-name", shellWord(managerName)] : []),
    ...(managerSeatCap !== undefined ? ["--seat-cap", String(managerSeatCap)] : []), ...(maxSessions !== undefined ? ["--max-sessions", String(maxSessions)] : []),
    ...(foreground ? ["--foreground"] : []), ...(presentation === "rich" ? [] : [`--${presentation}`]),
  ];
  if (!options.length && (!request.invokedRoot || request.invokedRoot === root)) return bare;
  return `run ${codeSpan([presentation === "json" ? "cotal" : displayCmd(), "up", "--root", shellWord(root), "--space", shellWord(space), ...options].join(" "))} again`;
}

/** The next step when an explicit mode is not the one a root's first whole-stack `up` recorded.
 *  Nothing converts a root's mode: `reset`, `clean` and `space forget` keep the stack journal that
 *  records it. So the step keeps that mode, or starts the requested one in another folder. */
function pinnedModeRemedy(recorded: StackMode, requested: StackMode, noManager: boolean): string {
  const flag = requested === "open" ? " --open" : requested === "user" ? " --user-auth --idp <auth base URL>" : "";
  const members = noManager ? " --no-manager" : "";
  return `run \`cotal up${members}\` to keep ${MODE_NAME[recorded]} here, or for ${MODE_NAME[requested]} run \`cotal space create <space>\`, then \`cotal up${flag}${members}\`, in another folder`;
}

/** The mode an invocation explicitly asks for, or none for a bare `up`. */
export function requestedStackMode(values: ParsedArgs["values"]): StackMode | undefined {
  return values["user-auth"] === true ? "user" : values.open === true ? "open" : undefined;
}

/** A root takes the controller route when it already has a stack journal, or when it is a fresh
 *  root prepared here with nothing legacy, maintenance or team-owned retained under it. A root with
 *  neither, its space registered by `up` included, keeps the retained path. On either, an input the
 *  controller has no route for refuses `UNSUPPORTED`; a prepared root the retained launcher already
 *  started keeps that launcher for such an input. A recorded stack that launched a
 *  member keeps its auth mode. A static-auth request needs an `up`
 *  registration in auth mode or none. An `--open` request needs an open registration or none, and
 *  a root that holds no broker account. A prepared user-auth root uses the same controller with
 *  its native auth service. Anything else keeps the retained path. */
export function controllerStackApplies(root: string, space: string, values: ParsedArgs["values"]): boolean {
  const canonical = canonicalRoot(root);
  const recorded = readStackJournal(canonical);
  const requested = requestedStackMode(values);
  const unsupported: string[] = CONTROLLER_UNSUPPORTED.filter((name) => values[name] !== undefined && values[name] !== false);
  if (namesTlsServer(values)) unsupported.push("server tls://");
  if (recorded) {
    const refused = unsupported.filter((name) => name !== "rotate-sys");
    if (refused.length) throw controllerUnsupported(canonical, refused, false);
    // A stack that never launched a member pins no mode; its next up plans a first start.
    if (stackNeverStarted(recorded.journal)) return true;
    if (requested !== undefined && requested !== recorded.journal.mode) throw new CommandFailure("refused", "CONFLICT", `this root's controller stack is pinned to ${MODE_NAME[recorded.journal.mode]}; the requested mode does not convert it`, { target: { root: canonical, recorded: recorded.journal.mode, requested }, remedy: pinnedModeRemedy(recorded.journal.mode, requested, values["no-manager"] === true) });
    if (values.idp !== undefined && recorded.journal.mode !== "user") throw new CommandFailure("refused", "USAGE_INVALID", "--idp belongs to a user-auth stack", { target: { root: canonical } });
    return true;
  }
  const wanted: StackMode = requested ?? "auth";
  if (canonical === canonicalRoot(homedir()) || wanted !== "user" && hasUserAuthState(canonical, space, { readOnly: true })) return false;
  if (wanted === "open" && holdsBrokerAccount(canonical)) return false;
  const registered = findMesh(space);
  if (registered && (registered.origin !== "up" || canonicalRoot(registered.root) !== canonical || registered.mode !== wanted)) return false;
  // Only a space prepared at this very root qualifies. An absent prepared record is not a root: an
  // empty path would canonicalize to the working directory and admit an unprepared legacy folder.
  const prepared = findPreparedSpace(space);
  const preparedHere = prepared !== undefined && canonicalRoot(prepared.root) === canonical;
  // A registration alone is no prepared root. The retained launcher wrote it, and the root keeps what
  // that launcher left there: a legacy `down` keeps the registration of a space named after its
  // folder, and a stack stopped without `down` keeps it along with its pid files and user-auth state.
  if (!preparedHere) return false;
  if (readMaintenanceJournal(canonical)) return false;
  if (existsSync(join(canonical, ".cotal", NATS_PIDFILE)) || liveMeshProcesses(canonical, space).length) return false;
  if (unsupported.length) {
    // A prepared root the retained launcher already started holds the user-auth state it wrote, and
    // keeps that launcher for an option only it takes.
    if (wanted === "user" && hasUserAuthState(canonical, space, { readOnly: true })) return false;
    // A fresh prepared root never falls through to the legacy launcher, so an option the controller
    // stack has no route for refuses here as it does on a root whose stack the controller owns.
    throw controllerUnsupported(canonical, unsupported, true);
  }
  return true;
}

export function refuseForegroundStackHolder(root: string, space: string, holderPid: number, noManager: boolean, maxPayload?: number, maxFileStore?: number, maxSessions?: number): never {
  const home = readStackJournal(root)?.journal.recovery?.home;
  const cmd = home !== undefined && home !== resolve(homeCotalDir()) ? `COTAL_HOME=${shellWord(home)} ${displayCmd()}` : "cotal";
  const retry = `${cmd} up --foreground${noManager ? " --no-manager" : ""}${maxPayload !== undefined ? ` --max-payload ${maxPayload}` : ""}${maxFileStore !== undefined ? ` --max-file-store ${maxFileStore}` : ""}${maxSessions !== undefined ? ` --max-sessions ${maxSessions}` : ""}`;
  throw new CommandFailure("refused", "CONFLICT", `a foreground \`cotal up\` in process ${holderPid} already holds this stack's lifetime; this terminal did not take it over and nothing was started`, {
    target: { root, space, holderPid },
    remedy: `use the terminal that runs process ${holderPid}, where Ctrl-C stops the stack, or stop it with ${codeSpan(`${cmd} down --yes`)} from ${root} and run ${codeSpan(retry)} again`,
  });
}

/** An independently owned observer can stay up while its recorded broker is recovered in place. */
function recoveringObserverBroker(request: StackUpRequest, recorded: StackJournal | undefined, observer: ReturnType<typeof serviceHeldRecords>[number]): boolean {
  const { root, space, server, transport } = request;
  if (recorded?.mode !== "auth" || recorded.space !== space || canonicalServer(recorded.server) !== canonicalServer(server) ||
      request.manifest || request.rotateSys || request.recreateIssuedStores !== undefined || request.recreateMembershipStore || request.channels !== undefined) return false;
  const registration = findMesh(space), policy = readBrokerPolicy(root);
  if (registration?.origin !== "up" || canonicalRoot(registration.root) !== root || registration.server !== recorded.server ||
      (policy?.transport.kind ?? "plaintext") !== transport.kind || (transport.kind === "tls-required" &&
        (policy?.transport.kind !== "tls-required" || policy.transport.certFile !== transport.certFile || policy.transport.keyFile !== transport.keyFile)) ||
      (request.maxPayload !== undefined && request.maxPayload !== (policy?.maxPayload ?? NATS_DEFAULT_MAX_PAYLOAD)) ||
      (request.accountResolver !== undefined && request.accountResolver !== (policy?.accountResolver ?? "memory"))) return false;
  const member = recorded.members.find((row) => row.role === "broker");
  const brokers = serviceInstances(space, STACK_DEFINITION.broker);
  const broker = brokers[0]?.record.value;
  if (brokers.length !== 1 || !member?.process || !broker?.process || member.instanceId !== broker.instanceId ||
      member.process.pid !== broker.process.pid || member.process.token !== broker.process.token || observeServiceProcess(broker) !== "gone") return false;
  const web = serviceInstanceStore(space).read(observer.instanceId)?.record.value;
  const saved = serviceDefinitionStore(space).read(observer.definition)?.record;
  const launch = saved?.value.launch;
  return web?.adapter?.name === WEB_SERVICE_ADAPTER && web.process?.pid === observer.record.pid && observeServiceProcess(web) === "running" &&
    saved?.revision === web.definitionRevision && launch?.type === "adapter" && launch.adapter === WEB_SERVICE_ADAPTER &&
    launch.options.root === root && launch.options["read-only"] === true;
}

/** Returns a settled active restore of the recorded stack that was admitted, for the result to name. */
function stackPreflight(request: StackUpRequest, recorded: StackJournal | undefined, repeatsBrokerInputs: boolean): string | undefined {
  const { root, space, noManager, invokedRoot, foreground, manifest } = request;
  // Its members' own pidfiles would read as legacy processes under a Cotal home with no record of them.
  if (recorded && stackRunsUnderOtherHome(root, recorded)) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "this root's controller stack has missing member records in this Cotal home; nothing was started, adopted or replaced", { target: { root, space, cotalHome: homeCotalDir() }, remedy: stackHomeRemedy(recorded.recovery?.home) });
  const maintenance: { fenced: boolean; admittedRestore?: string } = recorded ? stackMaintenanceFence(root, recorded) : { fenced: readMaintenanceJournal(root) !== undefined };
  if (maintenance.fenced) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "this root retains a maintenance or recovery attempt; the controller stack did not substitute an ordinary startup", { target: { root, space } });
  let legacy = foreignLocalProcesses(root, space);
  const brokerPidfile = legacyBrokerPidfileBlock(root);
  // A service of this space started at this root, such as a `manager` preset, writes its own record
  // here. It is named with the stop `down` names for it; the stack still neither adopts nor replaces it.
  let held = legacy.length && !brokerPidfile ? serviceHeldRecords(root, space) : [];
  const observer = held.length === 1 ? held[0] : undefined;
  if (repeatsBrokerInputs && observer?.record.name === "web" && legacy.length === 1 && legacy[0] === `web (pid ${observer.record.pid})` &&
      recoveringObserverBroker(request, recorded, observer)) {
    legacy = [];
    held = [];
  }
  if (held.length && held.length === legacy.length) {
    const cmd = displayCmd();
    const retryRoot = invokedRoot !== undefined && invokedRoot !== root ? ` --root ${shellWord(root)}` : "";
    const retry = noManager || retryRoot ? `${cmd} up --space ${shellWord(space)}${noManager ? " --no-manager" : ""}${retryRoot}` : `${cmd} up`;
    const format = request.presentation === "rich" ? "" : ` --${request.presentation}`;
    const next = foreground ? "repeat your original foreground startup command from the same folder with the same options"
      : request.simpleTargetedStartup ? `run ${codeSpan(retry + format)} again` : "repeat your original startup command from the same folder with the same options";
    throw localDiagnostic(new CommandFailure("refused", "LIFECYCLE_BLOCKED", `${held.map((row) => `the ${row.definition} service of this space runs this root's ${row.record.name} (pid ${row.record.pid}, instance ${row.instanceId})`).join("; ")}, outside the controller stack, which neither adopts nor replaces it`, {
      target: { root, space, processes: legacy, services: held.map((row) => ({ definition: row.definition, instanceId: row.instanceId })) },
      remedy: `stop ${held.length === 1 ? "it" : "each"} with ${held.map((row) => codeSpan(`${cmd} svc stop ${row.definition} --instance ${row.instanceId} --space ${shellWord(space)} --yes`)).join(", ")}, then ${next}`,
    }));
  }
  if (legacy.length || brokerPidfile) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", brokerPidfile?.message ?? "legacy pidfile-owned processes or records remain under this root; the controller stack neither adopts nor replaces them", { target: { root, space, processes: legacy }, remedy: brokerPidfile?.remedy });
  if (localMeshesForRoot(root).some((mesh) => mesh.space !== space)) throw new CommandFailure("refused", "CONFLICT", "another locally started space uses this root; a single-space controller stack cannot share its broker", { target: { root, space } });
  let ledgers, additive, boots, summaries;
  try { ledgers = listLedgerFiles(root, { requireReadable: true }); additive = listAdditiveTeamAttempts(root); boots = listFreshTeamAttempts(root); summaries = listFreshTeamSummaries(root); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "team records under this root could not be read; no empty team state was inferred", { target: { root, space } }); }
  const settled = new Map(summaries.valid.map((summary) => [summary.deploymentId, summary]));
  // Ordinary startup of the recorded stack does not replay returned additive launches or adopt their
  // cards. Fresh boots, broker maintenance and unsettled removals retain the agent deployment fence.
  const ordinaryUp = !manifest && !request.rotateSys && request.recreateIssuedStores === undefined && !request.recreateMembershipStore && request.channels === undefined;
  const removing = new Set([...(additive.removal?.attempts ?? []), ...(additive.channelRemoval?.attempts ?? [])].map((row) => row.deploymentId));
  const carried = (attempt: AdditiveTeamAttempt) => recorded !== undefined && additive.returned.some((row) => row.deploymentId === attempt.deploymentId)
    && attempt.space === recorded.space && canonicalRoot(attempt.root) === canonicalRoot(root) && attempt.server === recorded.server && attempt.authMode === recorded.mode
    && (attempt.requestedAgents.length === 0 || (ordinaryUp && !removing.has(attempt.deploymentId) && space === recorded.space
      && canonicalServer(request.server) === canonicalServer(recorded.server) && attempt.tlsRequired === (request.transport.kind === "tls-required")));
  const retained = retainedAdditiveTeamAttempts(additive).filter((attempt) => !carried(attempt));
  const unsettledBoots = boots.valid.filter((attempt) => attempt.deploymentId !== manifest?.deploymentId && !freshTeamAttemptSettled(attempt, settled.get(attempt.deploymentId)));
  if (ledgers.valid.length || ledgers.refused.length || retained.length || additive.refused.length || boots.refused.length || summaries.refused.length || unsettledBoots.length) {
    const ids = [...new Set([...retained.map((attempt) => attempt.deploymentId), ...ledgers.valid.map(({ ledger }) => ledger.runId), ...unsettledBoots.map((attempt) => attempt.deploymentId)])];
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "team deployments or unsettled boot records remain under this root; the controller stack did not adopt their resources", { target: { root, space, deployments: ids },
      remedy: ids.length ? `inspect each with ${ids.map((id) => `\`cotal team show ${id}\``).join(", ")}; nothing was started` : `list the records with \`cotal team\` in ${root}; nothing was started` });
  }
  return maintenance.admittedRestore;
}

/** The broker binary that preparation already selected, canonicalized to its file. A bare PATH name
 *  is resolved under the same environment; no second selection or fallback is made. */
function canonicalBinary(bin: string): string {
  const found = bin.includes("/") ? bin : resolveOnPath(bin);
  if (!found) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the selected nats-server could not be resolved to a file; no other binary was selected");
  return realpathSync.native(found);
}

/** Save a stack definition, or verify an existing one is this root's stack definition. A saved
 *  definition naming another adapter or root refuses. One whose volatile launch options differ (the
 *  broker's freshly allocated websocket port, a different selected binary) is redefined only when
 *  every recorded instance of it is stopped with its terminal receipt; those stopped records are
 *  removed with the definition under its writer lock, exactly as `service remove` requires. `replace`
 *  journals the replacement's IDs before that retirement and the new definition's revision after it,
 *  so an `up` cut off before the replacement's readiness is recorded leaves a resolvable transition. */
function ensureDefinition(space: string, role: StackRole, input: ServiceDefinitionInput, root: string, replace: (definitionRevision?: string) => void): ServiceDefinitionSnapshot {
  const store = serviceDefinitionStore(space), name = STACK_DEFINITION[role];
  const existing = store.read(name);
  const wanted = input.launch;
  if (existing) {
    const launch = existing.record.value.launch;
    if (launch.type !== "adapter" || wanted.type !== "adapter" || launch.adapter !== STACK_ADAPTER[role] || launch.options.root !== root) {
      const other = launch.type === "adapter" && launch.adapter === STACK_ADAPTER[role] && typeof launch.options.root === "string" ? launch.options.root : undefined;
      if (other) throw new CommandFailure("refused", "CONFLICT", `the saved ${name} definition belongs to the stack at ${other}; it was not replaced`, { target: { space, definition: name, root: other },
        remedy: `if ${other} no longer runs ${space}, remove the stack definitions saved for it (${stackDefinitionsAt(space, other).map((row) => row.name).join(", ")}) with \`cotal service remove <name> --space ${space} --yes\`` });
      throw new CommandFailure("refused", "CONFLICT", "a saved definition under a stack name belongs to another adapter or root; it was not replaced", { target: { space, definition: name }, remedy: `inspect \`cotal service show ${name} --space ${space}\`` });
    }
    if (JSON.stringify(launch.options) === JSON.stringify(wanted.options)) return existing;
    // A running member keeps the definition it was launched from; it is reused, never redefined.
    if (serviceInstances(space, name).some((row) => observeServiceProcess(row.record.value) === "running")) return existing;
    // A member that crashed is recorded as such first, so its record can go with the definition.
    settleExitedInstances(existing);
    replace();
    let retired: string[] = [];
    store.commit(name, existing, undefined, () => { retired = removeStoppedInstanceRecords(space, name); });
    removeServiceLogs(space, retired);
  }
  store.commit(name, undefined, validateServiceDefinition(input, space));
  const saved = store.read(name)!;
  if (existing) replace(saved.record.revision);
  return saved;
}

function adapterDefinition(space: string, adapter: string, options: Record<string, unknown>, timeoutMs: number): ServiceDefinitionInput {
  return { schemaVersion: 1, space, launch: { type: "adapter", adapter, options }, readiness: { type: "adapter", timeoutMs } };
}

function membersView(journal: StackJournal, title: string, executable?: NatsServer | null, streamsRecreated = false): Report {
  // A role the stack's mode never plans (auth on a static or open stack, delivery on an open one)
  // is not a member of it; it stays in the journal and JSON only.
  const members = journal.members.filter((member) => stackRoleApplies(journal.mode, member.role));
  return { sections: [{ title, blocks: [
    { kind: "fields", rows: [["Space", journal.space], ["Root", journal.root], ["Broker", journal.server], ["Mode", journal.mode === "open" ? "open, no authentication" : journal.mode === "user" ? "user auth" : "static auth"], ["Operation", `${journal.operation.kind} ${journal.operation.phase}`], ...(executable ? [["Broker executable", natsServerLabel(executable)] as [string, string]] : []), ...(streamsRecreated ? [["Space streams", "created again, empty, on the running broker"] as [string, string]] : []), ...(journal.mode === "user" ? [["Registration", userRegistrationIncomplete(journal.space) ? "incomplete: no confirmed auth-service endpoint" : "auth-service endpoint confirmed by its provider"] as [string, string]] : [])] },
    { kind: "table", columns: [{ key: "role", label: "Member" }, { key: "definition", label: "Definition" }, { key: "instance", label: "Full instance" }, { key: "state", label: "Result" }], rows: members.map((member) => ({ role: member.role, definition: member.definition, instance: member.instanceId ?? "not allocated", state: { text: member.state.replaceAll("-", " "), tone: ["started", "reused", "stopped", "already-stopped"].includes(member.state) ? "ok" as const : ["refused", "failed"].includes(member.state) ? "failed" as const : "waiting" as const } })) },
    { kind: "lines", lines: [journal.mode === "open"
      ? "Open stack: no authentication, no delivery member and no delivery credential. Each member is one exact service-controller instance. Broker readiness means its own process reported its listener; manager readiness is the child's own local receipt, not an attributed endpoint response. This is not agent or task readiness, and a partial start is not rolled back."
      : journal.mode === "user"
        ? "User-auth stack: each member is one exact service-controller instance. Auth-service readiness is its startup receipt plus the provider's readiness for that exact process; delivery readiness is its startup receipt; manager readiness is its endpoint read as your signed-in, granted login. This is not agent or task readiness, and a partial start is not rolled back."
        : "Each member is one exact service-controller instance. Broker readiness means its own process reported its listener; delivery readiness is its process startup receipt; manager readiness is its attributed native endpoint. This is not agent or task readiness, and a partial start is not rolled back."] },
  ] }] };
}

/** The warning a start gives for daemon credentials the NATS client cannot parse. `up` mints only a
 *  missing one and the manager re-signs only one that holds its key, so it names the step that
 *  replaces it. */
export function unparsableDaemonCredsNotice(kinds: readonly string[]): string {
  const them = kinds.length === 1 ? "it" : "them";
  return `${kinds.join(" and ")} cannot be parsed, so the delivery daemon runs without ${them} and the manager cannot re-sign ${them}; stop the stack with \`cotal down\`, then run \`cotal doctor auth --fix\`, which mints ${them} again`;
}

/** The listeners the stack's running broker and manager opened, from their saved definitions. Null
 *  when the broker's configuration could not be read, so no list is given rather than a short one. */
function stackListeners(journal: StackJournal): StackListener[] | null {
  const store = serviceDefinitionStore(journal.space), listeners: StackListener[] = [];
  for (const member of journal.members) {
    if (member.role !== "broker" && member.role !== "manager" || member.state !== "started" && member.state !== "reused") continue;
    const definition = store.read(member.definition);
    const found = definition && definitionListeners(definition);
    if (!found) return null;
    listeners.push(...found);
  }
  return listeners;
}

/** The selection a start finds: one that names a registered or prepared space, else none. */
function usableSelection(): string | undefined {
  const current = getCurrent();
  return current && (findMesh(current) || findPreparedSpace(current)) ? current : undefined;
}

/** What `up` says when it selects the space it started, because nothing usable was selected. */
export function selectedOnUp(space: string): string {
  return `automatically selected "${space}": commands target it except in another space's running project; \`cotal use ${space}\` selects it in every folder`;
}

/** What `up` says when another selected space stays selected. */
export function keptOnUp(space: string, kept: string): string {
  return readCurrentSelection()?.source === "explicit"
    ? `"${space}" up; commands here still target the selected space "${kept}" - use --space ${space} or \`cotal use --clear\` to reach this folder's space`
    : `"${space}" up; "${kept}" stays automatically selected outside this folder - \`cotal use ${space}\` selects this space in every folder`;
}

/** `cotal up`'s controller route: start, seed the default persona into the root, then prepare its
 *  receipt, which the caller prints after releasing the startup lock. A persona that cannot be
 *  written, or saved services that cannot be listed, is a warning. */
export async function stackUp(request: StackUpRequest, native: StackUpNative): Promise<{ journal: StackJournal; writeReceipt: () => void }> {
  const before = usableSelection();
  const { journal, changed, allReused, admittedRestore, settled, brokerExecutable, streamsRecreated, rotation, storeShared, storeWarnings, clearedRecords } = await startControllerStack(request, native);
  const { root, space, server, mode } = journal;
  const managed = journal.members.some((row) => row.role === "manager" && (row.state === "started" || row.state === "reused"));
  // The receipt says when the start selected its space, and when another space stays selected.
  const current = usableSelection();
  const keptCurrent = current !== space ? current : undefined;
  const selected = current === space && before !== space;
  const written: { what: string; path: string }[] = [];
  const warnings: OutputWarning[] = settled ? [{ code: "OPERATION_SETTLED", target: { root, space, operation: settled.operation.id }, message: stackSettlementNotice(settled) }] : [];
  warnings.push(...storeWarnings ?? [], ...(clearedRecords ?? []).map((row) => staleRecordWarning(root, row)));
  if (storeShared) warnings.push({ code: "STORE_SHARED", target: { root, space, storeDir: storeShared.path, otherSpaces: storeShared.tenants }, message: sharedStoreWarning(storeShared.path, storeShared.tenants) });
  // Damage the broker found while it restored its stored files is logged by now.
  const damage = brokerStoreWrite(root, space);
  if (damage.state === "damaged") warnings.push({ code: "STORE_DAMAGE_LOGGED", target: { root, space, brokerLog: damage.log }, message: storeDamageNotice(damage) });
  try {
    const persona = seedDefaultPersona(root);
    if (persona) written.push(persona);
  } catch (error) {
    warnings.push({ code: "PERSONA_NOT_WRITTEN", target: { root, space }, message: `the default persona was not written in ${root}: ${(error as Error).message}` });
  }
  if (mode !== "open") {
    if (request.noManager) warnings.push(await noManagerCredentialWarning(root, space));
    const unparsable = await unparsableDaemonCreds(root, space);
    if (unparsable.length) warnings.push({ code: "DAEMON_CREDENTIAL_UNPARSABLE", target: { root, space, credentials: unparsable }, message: unparsableDaemonCredsNotice(unparsable) });
  }
  // The receipt names each saved service up does not start, and which of them a space forgotten
  // under this name left from another root, as `cotal service` marks them inherited.
  const stackDefinitions = new Set(Object.values(STACK_DEFINITION));
  let savedServices: string[] = [], inheritedServices: string[] = [];
  try {
    const rows = serviceDefinitionStore(space).list().filter((row) => !stackDefinitions.has(row.name));
    savedServices = rows.map((row) => row.name);
    inheritedServices = rows.filter((row) => definitionRootMatch(row.record.value, canonicalRoot(root)) === "inherited").map((row) => row.name);
  } catch (error) {
    warnings.push({ code: "SAVED_SERVICES_NOT_READ", target: { root, space }, message: `the saved services of ${space} could not be listed: ${(error as Error).message}` });
  }
  const listeners = stackListeners(journal);
  const elsewhere = request.invokedRoot !== undefined && request.invokedRoot !== canonicalRoot(root);
  const brokerPayload = request.maxPayload ?? (request.presentation === "json" ? undefined : readBrokerPolicy(root)?.maxPayload);
  const writeReceipt = () => writeResult(request.presentation, { command: "up", target: { root, space, server }, result: { kind: "controller-stack-up", root, space, server, mode, operation: journal.operation, members: journal.members, changed, foreground: request.foreground, admittedRestore: admittedRestore ?? null, settledOperation: settled ?? null, brokerExecutable: brokerExecutable ?? null, streamsRecreated: streamsRecreated === true, rotatedSystemAccount: rotation ?? null, listeners, written, savedServices, inheritedServices, selection: { current: current ?? null, changed: current === space && before !== space } }, warnings, ...(allReused && written.length === 0 && !streamsRecreated ? { noOp: true } : {}) }, (result) => {
    const members = membersView({ ...journal, members: result.members }, allReused ? "Controller stack already running" : "Controller stack started", result.brokerExecutable, result.streamsRecreated);
    const exposed = result.listeners && exposedPlaintext(result.listeners);
    const listening: Report["sections"] = [{ title: "Listeners", blocks: [
      result.listeners ? { kind: "fields", rows: result.listeners.map(listenerRow) } : { kind: "lines", lines: ["The broker's configuration could not be read, so its listeners are not listed."] },
      ...(exposed ? [{ kind: "lines" as const, lines: [{ text: exposed, tone: "waiting" as const }] }] : []),
    ] }];
    const view: Report = { ...members, sections: [...members.sections, ...listening, ...(result.written.length ? [{ blocks: [{ kind: "fields" as const, rows: result.written.map((w): [string, string] => ["wrote", `${w.what}: ${w.path}`]) }] }] : [])] };
    // The payload limit is fixed at the broker's start, so a bare up cannot add a manager to a
    // broker-only stack whose limit is below the floor the manager starts on: the Next names the
    // stop and restart that can, instead of the bare up that would refuse.
    const managerBelowFloor = !managed && brokerPayload !== undefined && brokerPayload < MANAGER_START_PAYLOAD_FLOOR;
    const next: Report["sections"] = request.foreground ? [] : [{ title: "Next", blocks: [{ kind: "commands", items: [
      // A bare spawn targets the selected space, which this up does not change when one is set.
      managed ? { command: `${displayCmd()} spawn --space ${space}`, description: "Launch your default agent" } : managerBelowFloor ? { command: `${displayCmd()} up${elsewhere ? ` --root ${shellWord(root)}` : ""} --max-payload ${NATS_DEFAULT_MAX_PAYLOAD}`, description: "Add the manager: stop the broker first, then restart it with a payload it can start on" } : { command: elsewhere ? `${displayCmd()} up --root ${shellWord(root)}` : `${displayCmd()} up`, description: "Add the manager to this stack" },
      { command: `${displayCmd()} down`, description: elsewhere ? `Stop every recorded member; run it from ${root}` : "Stop every recorded member" },
    ] }] }];
    const selection = keptCurrent ? keptOnUp(space, keptCurrent) : selected ? selectedOnUp(space) : undefined;
    const kept: Report["sections"] = selection ? [{ blocks: [{ kind: "lines", lines: [{ text: selection, tone: "hint" }] }] }] : [];
    const saved: Report["sections"] = result.savedServices.length ? [{ blocks: [{ kind: "lines", lines: [
      { text: `saved services up does not start: ${result.savedServices.join(", ")}`, tone: "hint" },
      ...(result.inheritedServices.length ? [{ text: `  ${result.inheritedServices.join(", ")} came from a space forgotten under the name ${space} in another folder and ${result.inheritedServices.length === 1 ? "does" : "do"} not start here; \`cotal service remove <name> --space ${space} --yes\` forgets one`, tone: "hint" as const }] : []),
      { text: `  \`cotal service show <name> --space ${space}\` shows what one runs`, tone: "hint" },
    ] }] }] : [];
    const rotated: Report["sections"] = result.rotatedSystemAccount ? [{ title: "System account rotated", blocks: [
      { kind: "fields", rows: [["Generation", String(result.rotatedSystemAccount.generation)], ["$SYS creds valid to", result.rotatedSystemAccount.expiresAt?.slice(0, 10) ?? "no expiry"]] },
      { kind: "lines", lines: ["membership-observer.creds and connection-evictor.creds were minted against the new system account, and the broker started on a configuration rendered from it. The data account, every agent credential and the JetStream store are unchanged. Old $SYS creds are refused by any broker that loads this configuration."] },
    ] }] : [];
    return { ...view, sections: [...view.sections, ...rotated, ...(admittedRestore ? [{ title: "Retained restore journal", blocks: [{ kind: "lines" as const, lines: [`Active restore ${admittedRestore} stays in this root's maintenance journal. It was read and not changed.`] }] }] : []), ...saved, ...kept, ...next] };
  });
  return { journal, writeReceipt: () => {
    if (request.foreground && request.presentation !== "json") stackUpForegroundNotice(request.presentation, space, allReused);
    writeReceipt();
  } };
}

/** The refusal of an up whose running broker disabled JetStream after a store write failure: no
 *  stream check or later member start reaches it. Undefined for an error already classified. */
function reusedWithoutJetStream(caught: unknown, brokerReused: boolean, root: string, space: string): CommandFailure | undefined {
  if (!brokerReused || isCommandFailure(caught) && caught.outcome !== "unknown") return undefined;
  const disabled = jetStreamDisabled(root, space);
  if (!disabled) return undefined;
  const manager = serviceInstances(space, STACK_DEFINITION.manager).map((row) => row.record.value).find((value) => observeServiceProcess(value) === "running");
  return jetStreamDisabledRefusal(disabled, root, space, "up cannot check the space's streams on it", "its running members were left as they are", { root, space }, manager?.process?.pid);
}

/** What holds a stack's recorded broker address, as bare up's own bind check finds it, with
 *  the listening processes of this account named. Undefined while the address is free, could not be
 *  checked, or this stack's broker runs there. */
async function recordedAddressHeld(space: string, server: string, bindHost?: string): Promise<{ says: string; frees: string } | undefined> {
  const brokerRows = serviceInstances(space, STACK_DEFINITION.broker);
  if (brokerRows.length === 1 && observeServiceProcess(brokerRows[0]!.record.value) === "running") return undefined;
  const bindError = await listenerBindError(server, bindHost);
  if (bindError === undefined || bindError === "timeout" || bindError.code !== "EADDRINUSE") return undefined;
  const { host: dialHost, port } = brokerListenAddress(server);
  const host = bindHost ?? dialHost;
  const held = await addressHolder("that address", host, port);
  const holders = loopbackListeners(server).map((pid) => {
    const command = readProcessCommand(pid);
    return command.kind === "command" ? `${pid} (${basename(command.command.split(" ")[0]!)})` : String(pid);
  });
  return holders.length ? { says: `${held.says}, where process ${holders.join(", ")} of this account listens`, frees: held.frees } : held;
}

/** The live address blocker for a stopped stack or refused first start at its recorded broker address. */
export async function stackStartAddressProblem(root: string, space: string, server?: string): Promise<{ message: string; remedy: string } | undefined> {
  try {
    const journal = readStackJournal(root)?.journal;
    if (journal?.space !== space || (server !== undefined && brokerUrlKey(server) !== brokerUrlKey(journal.server))) return undefined;
    const { kind, phase } = journal.operation;
    const cleanStop = kind === "down" && phase === "completed";
    const refusedStart = kind === "up" && phase === "refused"
      && journal.members.some((row) => row.role === "broker" && row.state === "refused");
    if (!cleanStop && !refusedStart) return undefined;
    const held = await recordedAddressHeld(space, journal.server, journal.broker?.host);
    if (!held) return undefined;
    if (refusedStart && stackNeverStarted(journal)) {
      const alternate = await stackRetryServer(journal.server, journal.broker?.host ?? brokerListenAddress(journal.server).host);
      return { message: held.says, remedy: `${held.frees}, then repeat your original startup command from the same folder${alternate ? `, or repeat it from that folder with ${codeSpan(`--server ${alternate}`)} and all other options unchanged` : ""}` };
    }
    const noManager = journal.members.some((row) => row.role === "manager" && row.state === "not-attempted" && (cleanStop || row.instanceId === null));
    const restart = `${displayCmd()} up${noManager ? " --no-manager" : ""}`;
    return { message: held.says, remedy: `${held.frees}, then run ${codeSpan(restart)} in ${root}; this stack keeps its recorded address` };
  } catch (error) {
    // An unreadable local record does not establish an address conflict.
    if (!isCommandFailure(error)) throw error;
    return undefined;
  }
}

/** The broker's store over its recorded cap, read over an observer credential after a member failed
 *  to start. Every write is refused until there is room, a delivery daemon's lease included.
 *  Undefined while the store is under its cap, with no cap recorded, or when it cannot be read. */
async function storeFullAfterStart(root: string, space: string): Promise<ReturnType<typeof storeFull>> {
  let used: number | undefined;
  try { used = await readStoredBytes(resolveMeshTarget(root, { space, readOnly: true }), "up-diagnosis"); } catch { used = undefined; }
  return used === undefined ? undefined : storeFull(root, space, used);
}

/** The way out of a full store for an up whose member could not start: a larger cap, which keeps the
 *  store's history but needs the broker restarted, so the manager's own process is ended first where
 *  it runs, as a full store refuses its stop. It names no history purge: a purge frees only the
 *  channel history's bytes, which may leave the store over its cap, as on a new space whose cap is
 *  below the stack's own first writes. */
function fullStoreUpRemedy(root: string, space: string): string {
  const pid = serviceInstances(space, STACK_DEFINITION.manager).map((row) => row.record.value).find((value) => observeServiceProcess(value) === "running")?.process?.pid;
  return `from ${root}, ${pid !== undefined ? `end the manager on this host with kill -TERM ${pid}, which stops its agents by its default policy, then ` : ""}run \`cotal down --yes\` and \`cotal up --max-file-store <bytes>\` with a larger cap; the store keeps its history`;
}

/** The running broker of an unregistered space: what an up stopped before registration leaves. */
function strandedBroker(space: string): ServiceInstance | undefined {
  if (findMesh(space)) return undefined;
  const rows = serviceInstances(space, STACK_DEFINITION.broker);
  return rows.length === 1 && observeServiceProcess(rows[0]!.record.value) === "running" ? rows[0]!.record.value : undefined;
}

function strandedBrokerRemedy(root: string, noManager: boolean, invokedRoot?: string): string {
  if (invokedRoot === undefined || invokedRoot === root) return `Run \`cotal down --yes\`, then \`cotal up${noManager ? " --no-manager" : ""}\`.`;
  const stop = `cd ${shellWord(root)} && ${displayCmd({ fromAnyFolder: true })} down --yes`;
  return `Stop that broker with ${codeSpan(stop)}, then repeat your original startup command from the folder where you invoked it.`;
}

/** What a detached up interrupted by a signal left: the members that run, and the command that
 *  finishes the start or stops them. An up given `--no-manager` names `cotal up --no-manager`, since
 *  bare `up` adds the manager. */
export function stackUpInterrupted(root: string, space: string, noManager = false, invokedRoot?: string): CommandFailure {
  const up = `cotal up${noManager ? " --no-manager" : ""}`;
  const stranded = strandedBroker(space);
  const running = runningStackRoles(space);
  const message = stranded
    ? `Interrupted before the space was registered; its broker keeps running as pid ${stranded.process?.pid}.`
    : running.length
      ? `Interrupted while starting the stack in ${root}; ${running.join(", ")} ${running.length === 1 ? "keeps" : "keep"} running.`
      : `Interrupted before any member of the stack in ${root} started.`;
  const remedy = stranded
    ? strandedBrokerRemedy(root, noManager, invokedRoot)
    : running.length
      ? `Run \`${up}\` to finish the start, or \`cotal down --yes\` to stop ${running.length === 1 ? "it" : "them"}.`
      : `Run \`${up}\` to start it.`;
  return new CommandFailure(running.length ? "unknown" : "failed", running.length ? "OPERATION_UNKNOWN" : "OPERATION_FAILED", message, {
    target: { root, space }, changed: running.map((role) => ({ role, state: "running" })), remedy,
  });
}

/** Whether a broker bound to `host` is reached at `server`'s address: a wildcard bind is reached at
 *  any address, and any other host must name that address. */
export function bindReaches(host: string, server: string): boolean {
  if (host === "0.0.0.0" || host === "::" || host === "[::]") return true;
  try {
    return new URL(`nats://${isIP(host) === 6 ? `[${host}]` : host}:1`).hostname === new URL(server).hostname;
  } catch {
    return false;
  }
}

function recordedAddressRemedy(request: StackUpRequest, freeAddress: string): string {
  const retry = request.retryAtRecordedAddress?.() ?? "repeat your original startup command from the same folder with the same options";
  return `${freeAddress}, then ${retry}; this stack keeps its recorded address`;
}

/** Refuse a busy broker address before launch. Only a recorded address held by TIME-WAIT gets a bounded retry. */
async function assertStackBrokerAddress(request: StackUpRequest, root: string, space: string, server: string, bindHost: string | undefined, recorded: boolean): Promise<void> {
  const { host: dialHost, port } = brokerListenAddress(server);
  const host = bindHost ?? dialHost;
  let deadline: number | undefined;
  for (;;) {
    const bindError = await listenerBindError(server, bindHost);
    if (bindError === undefined || bindError === "timeout" || bindError.code !== "EADDRINUSE") return;
    const { says, frees, timeWait } = await addressHolder("the stack's broker address", host, port);
    if (recorded && timeWait) {
      if (deadline === undefined) {
        // Linux can retain a TIME-WAIT socket briefly after its 60-second timer reaches zero.
        const waitSeconds = 65;
        deadline = performance.now() + waitSeconds * 1000;
        if (request.presentation !== "json") process.stderr.write(`Waiting up to ${waitSeconds} seconds for TIME-WAIT to clear on the stack's broker address ${host}:${port}\n`);
      }
      const remaining = deadline - performance.now();
      if (remaining > 0) {
        await delay(Math.min(500, remaining));
        continue;
      }
    }
    // The socket can clear between a failed bind and the observation that ends the wait.
    if (deadline !== undefined && !timeWait && await listenerBindError(server, bindHost) === undefined) return;
    const retry = recorded ? undefined : await request.retryAtAnotherAddress?.(host);
    throw new CommandFailure("refused", "CONFLICT", `${says} (bind failed: address already in use); no broker was launched`, {
      target: { root, space, server, bindError: bindError.code },
      remedy: recorded
        ? recordedAddressRemedy(request, frees)
        : `${retry !== undefined ? `${retry}, or ` : ""}${frees} and retry this start`,
    });
  }
}

/** The websocket port the saved manager definition records for this root, when it records one. */
function recordedStackWebsocketPort(launch: ServiceDefinitionInput["launch"] | undefined, root: string): number | undefined {
  if (launch?.type !== "adapter" || launch.adapter !== STACK_ADAPTER.manager || launch.options.root !== root) return undefined;
  const port = launch.options["ws-port"];
  return typeof port === "number" ? port : undefined;
}

/** A running manager of a non-open stack advertises this port, so a broker start must not move it. */
function advertisedWebsocketPort(port: number | undefined, mode: string, space: string, revision: string | undefined): number | undefined {
  if (port === undefined || mode === "open") return undefined;
  const running = serviceInstances(space, STACK_DEFINITION.manager).some((row) =>
    row.record.value.definitionRevision === revision && observeServiceProcess(row.record.value) === "running");
  return running ? port : undefined;
}

/** Start the recorded stack and return its domain result without writing any receipt. */
export async function startControllerStack(request: StackUpRequest, native: StackUpNative): Promise<StackUpResult> {
  const root = canonicalRoot(request.root), space = request.space;
  if (request.transport.kind !== "plaintext" && request.transport.kind !== "tls-required") throw new CommandFailure("refused", "UNSUPPORTED", "unknown broker transport");
  // A space an earlier release prepared under a longer name refuses here, before its journal or any
  // member's file is written, instead of failing on the first file name that does not fit.
  const tooLong = spaceNameTooLong(space);
  if (tooLong) throw new CommandFailure("refused", "USAGE_INVALID", `${tooLong}; nothing was started or written`, { target: { root, space }, remedy: `forget it with \`cotal space forget ${space}\`, then create one with a name of at most ${SPACE_NAME_MAX} characters with \`cotal space create <name>\`` });
  // Each member's start is recorded under the space's service records. A folder there this account
  // cannot write refuses here, naming it, instead of an unknown outcome after a member started.
  const unwritable = serviceRecordsWriteProblem(space, ["definitions", "instances"]);
  if (unwritable) throw new CommandFailure("refused", "PERMISSION_DENIED", `this account cannot write ${unwritable}, where up records the stack's services; nothing was started or written`, { target: { root, space, path: unwritable }, remedy: `make it writable with chmod u+wx ${shellWord(unwritable)}, then run \`cotal up\` again` });
  const recorded = readStackJournal(root);
  if (request.expectPriorDown && (!recorded || recorded.sha256 !== request.expectPriorDown.journalSha256 || recorded.journal.operation.id !== request.expectPriorDown.operationId))
    throw new CommandFailure("refused", "CONFLICT", "the stopped stack changed after the team boot checked it; nothing was started", { target: { root, space, expected: request.expectPriorDown.operationId } });
  // A stack none of whose members ever launched, such as one whose first up was refused at a busy
  // address, pins nothing: this up plans it as a first up from the request and only replaces its
  // journal file. Broker inputs an earlier attempt recorded stay the default for any it does not name.
  const unstarted = recorded !== undefined && stackNeverStarted(recorded.journal) ? recorded.journal : undefined;
  const previous = unstarted ? undefined : recorded;
  // A stopped stack's broker is prepared again from its own recorded inputs. An explicit request for
  // a different store or bind host refuses; none is replaced by a default.
  const recordedInputs = previous?.journal.broker;
  // The broker binds its recorded host, or 127.0.0.1 when none was recorded. A bind that does not
  // serve the recorded address starts a broker its clients never reach, so it pins nothing: while
  // the broker is stopped, an explicit --host that serves the recorded address replaces it, and any
  // other up refuses before anything starts and names that step.
  const recordedBind = recordedInputs ? recordedInputs.host ?? "127.0.0.1" : undefined;
  const strayHost = recordedBind !== undefined && !bindReaches(recordedBind, previous!.journal.server) ? recordedBind : undefined;
  if (strayHost !== undefined) {
    const brokerRuns = serviceInstances(space, STACK_DEFINITION.broker).some((row) => observeServiceProcess(row.record.value) === "running");
    if (request.host === undefined || !bindReaches(request.host, previous!.journal.server) || brokerRuns)
      throw new CommandFailure("refused", "CONFLICT", `this stack's broker binds ${strayHost}${recordedInputs!.host === undefined ? ", as no bind host was recorded," : ","} which does not serve its recorded address ${previous!.journal.server}, so its clients cannot reach it; nothing was started`, {
        target: { root, space, recorded: recordedInputs },
        remedy: `${brokerRuns ? `stop its broker with \`cotal down --yes\` from ${root}, then ` : ""}run \`cotal up --host ${new URL(previous!.journal.server).hostname}\` from ${root}`,
      });
  }
  // The cap is fixed while the broker runs. A stopped broker starts again with an explicit new cap,
  // which replaces the recorded one, as after a cap too small for the space's streams.
  const newCap = recordedInputs !== undefined && request.maxFileStore !== undefined && request.maxFileStore !== recordedInputs.maxFileStore;
  const newLog = recordedInputs !== undefined && (
    request.logFile !== undefined && resolve(request.logFile) !== recordedInputs.logFile ||
    request.logfileSizeLimit !== undefined && request.logfileSizeLimit !== recordedInputs.logfileSizeLimit ||
    request.logfileMaxNum !== undefined && request.logfileMaxNum !== recordedInputs.logfileMaxNum
  );
  const brokerStopped = (newCap || newLog) && !serviceInstances(space, STACK_DEFINITION.broker).some((row) => observeServiceProcess(row.record.value) === "running");
  const recordedBroker = recordedInputs && {
    ...recordedInputs,
    ...(strayHost !== undefined ? { host: request.host } : {}),
    ...(newCap && brokerStopped ? { maxFileStore: request.maxFileStore } : {}),
    // Native logging is fixed for the running process too. Keep omitted settings on its next start.
    ...(newLog && brokerStopped ? {
      ...(request.logFile !== undefined ? { logFile: resolve(request.logFile) } : {}),
      ...(request.logfileSizeLimit !== undefined ? { logfileSizeLimit: request.logfileSizeLimit } : {}),
      ...(request.logfileMaxNum !== undefined ? { logfileMaxNum: request.logfileMaxNum } : {}),
    } : {}),
  };
  const brokerBind = recordedBroker?.host ?? "127.0.0.1";
  const changedInputs = recordedBroker ? [
    request.storeDir !== undefined && resolve(request.storeDir) !== recordedBroker.storeDir ? `--store-dir ${resolve(request.storeDir)} (recorded: ${recordedBroker.storeDir})` : undefined,
    request.maxFileStore !== undefined && request.maxFileStore !== recordedBroker.maxFileStore ? `--max-file-store ${request.maxFileStore} (recorded: ${recordedBroker.maxFileStore ?? "none"})` : undefined,
    request.host !== undefined && request.host !== brokerBind ? `--host ${request.host} (recorded: ${brokerBind})` : undefined,
    request.logFile !== undefined && resolve(request.logFile) !== recordedBroker.logFile ? `--log-file ${resolve(request.logFile)} (recorded: ${recordedBroker.logFile ?? "none"})` : undefined,
    request.logfileSizeLimit !== undefined && request.logfileSizeLimit !== recordedBroker.logfileSizeLimit ? `--logfile-size-limit ${request.logfileSizeLimit} (recorded: ${recordedBroker.logfileSizeLimit ?? "none"})` : undefined,
    request.logfileMaxNum !== undefined && request.logfileMaxNum !== recordedBroker.logfileMaxNum ? `--logfile-max-num ${request.logfileMaxNum} (recorded: ${recordedBroker.logfileMaxNum ?? "none"})` : undefined,
  ].filter((input) => input !== undefined) : [];
  if (changedInputs.length) {
    const up = codeSpan(request.noManager ? "cotal up --no-manager" : "cotal up");
    throw new CommandFailure("refused", "CONFLICT", `${changedInputs.join(", ")} ${changedInputs.length === 1 ? "differs" : "differ"} from this stack's recorded broker inputs; nothing was prepared`, { target: { root, space, recorded: recordedBroker }, remedy: `run ${up} from ${root} to start it with its recorded inputs${newCap ? `; a new --max-file-store applies once the broker is stopped with \`cotal down --yes\`` : ""}${newLog ? `; new native log settings apply once the broker is stopped with \`cotal down --yes\`, then ${up} with the requested log flags` : ""}` });
  }
  // A journal written before broker inputs were recorded cannot tell which store, cap or bind host
  // its stopped broker used: `cotal down` removed the registration that held them, and broker
  // preparation would otherwise fall back to the default `.cotal/nats` store with no cap. Such a
  // restart is refused before any effect unless the caller names the store explicitly; the cap and
  // host are then taken exactly as given and recorded, never inferred from a default.
  const brokerRows0 = previous && !recordedBroker ? serviceInstances(space, STACK_DEFINITION.broker) : [];
  const legacyStopped = previous !== undefined && !recordedBroker && !(brokerRows0.length === 1 && observeServiceProcess(brokerRows0[0]!.record.value) === "running");
  if (legacyStopped && request.storeDir === undefined)
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "this stopped stack was recorded before its broker store, cap and bind host were kept; the broker is not prepared from a default store", { target: { root, space, operation: previous!.journal.operation.id }, remedy: `name the stack's original store explicitly: \`cotal up --store-dir <original store dir> [--max-file-store <bytes>] [--host <host>] --space ${space}\`; omit --max-file-store and --host only if the original start set neither` });
  // The named store must already exist as a real directory: preparation would otherwise create
  // an empty store at a mistyped path and start the stack on it. Its identity is pinned here and
  // checked again by preparation, which never creates a pinned store, and just before the broker starts.
  const storePin = legacyStopped ? pinExistingStore(resolve(request.storeDir!), { root, space }) : undefined;
  const savedBroker = !previous ? serviceDefinitionStore(space).read(STACK_DEFINITION.broker)?.record.value.launch : undefined;
  const savedConfig = savedBroker?.type === "adapter" && savedBroker.adapter === STACK_ADAPTER.broker && savedBroker.options.root === root && typeof savedBroker.options.config === "string" ? savedBroker.options.config : undefined;
  const savedText = savedConfig === undefined ? undefined : readFileSync(savedConfig, "utf8");
  const savedStore = savedText === undefined ? undefined : /jetstream \{ store_dir: ("(?:[^"\\]|\\.)*")/.exec(savedText)?.[1];
  const recoveredStore = savedStore === undefined ? undefined : resolve(root, JSON.parse(savedStore) as string);
  const brokerStore = recordedBroker?.storeDir ?? request.storeDir ?? unstarted?.broker?.storeDir ?? recoveredStore;
  const brokerCap = recordedBroker ? recordedBroker.maxFileStore : request.maxFileStore ?? unstarted?.broker?.maxFileStore;
  const brokerHost = recordedBroker ? recordedBroker.host : request.host ?? unstarted?.broker?.host;
  const brokerLogFile = recordedBroker ? recordedBroker.logFile : request.logFile ?? unstarted?.broker?.logFile;
  const brokerLogfileSizeLimit = recordedBroker ? recordedBroker.logfileSizeLimit : request.logfileSizeLimit ?? unstarted?.broker?.logfileSizeLimit;
  const brokerLogfileMaxNum = recordedBroker ? recordedBroker.logfileMaxNum : request.logfileMaxNum ?? unstarted?.broker?.logfileMaxNum;
  if (brokerLogFile === undefined && (request.logfileSizeLimit !== undefined || request.logfileMaxNum !== undefined))
    throw new CommandFailure("refused", "USAGE_INVALID", "--logfile-size-limit and --logfile-max-num require --log-file");
  // The manager's session ceiling is kept by its saved definition, so a bare up starts it with the
  // ceiling an earlier up set rather than the default. An explicit --max-sessions replaces it only
  // once the manager is stopped; a live refresh must not silently discard the requested ceiling.
  const managerDefinition = serviceDefinitionStore(space).read(STACK_DEFINITION.manager);
  const savedManager = managerDefinition?.record.value.launch;
  const savedSessions = savedManager?.type === "adapter" && savedManager.options.root === root ? savedManager.options["max-sessions"] : undefined;
  const maxSessions = request.maxSessions ?? (typeof savedSessions === "number" ? savedSessions : undefined);
  if (request.maxSessions !== undefined) {
    for (const row of serviceInstances(space, STACK_DEFINITION.manager).filter((row) => observeServiceProcess(row.record.value) === "running")) {
      const applied = row.record.value.definitionRevision === managerDefinition?.record.revision && savedManager?.type === "adapter" && savedManager.adapter === STACK_ADAPTER.manager && savedManager.options.root === root
        ? typeof savedSessions === "number" ? savedSessions : 64
        : undefined;
      if (applied !== request.maxSessions)
        throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `the running manager ${applied === undefined ? "has no matching saved launch definition for its session ceiling" : `uses --max-sessions ${applied}`} and cannot change it at runtime; nothing was started or written`, {
          target: { root, space, instanceId: row.name, maxSessions: applied ?? null, requestedMaxSessions: request.maxSessions },
          remedy: `stop the stack with \`cotal down --yes\`, then run \`cotal up --max-sessions ${request.maxSessions}\``,
        });
    }
  }
  // The mode is pinned by the first whole-stack up. A conflicting explicit request refuses here,
  // before any preflight write, preparation or launch.
  if (previous && request.mode !== undefined && request.mode !== previous.journal.mode)
    throw new CommandFailure("refused", "CONFLICT", "this root's controller stack is pinned to another auth mode; a running or stopped stack is not converted", { target: { root, space, recorded: previous.journal.mode, requested: request.mode }, remedy: pinnedModeRemedy(previous.journal.mode, request.mode, request.noManager) });
  // An adopted journal has no started members here, but a bare up still uses its recorded mode.
  const mode: StackMode = previous?.journal.mode ?? request.mode ?? unstarted?.mode ?? (savedConfig === join(root, ".cotal", "server-open.conf") ? "open" : "auth");
  if (mode === "open" && holdsBrokerAccount(root))
    throw new CommandFailure("refused", "CONFLICT", "this root holds a broker account; an open stack does not bypass its recorded authorization", { target: { root, space } });
  if (mode === "user") assertUserStackTransport(previous?.journal.server ?? request.server, request.transport.kind === "tls-required");
  else if (request.idp !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "--idp belongs to a user-auth stack; nothing was prepared", { target: { root, space } });
  const brokerIsRunning = () => serviceInstances(space, STACK_DEFINITION.broker).some((row) => observeServiceProcess(row.record.value) === "running");
  if (request.authTimeout !== undefined) {
    if (mode !== "user") throw new CommandFailure("refused", "USAGE_INVALID", "--auth-timeout sets the auth callout's timeout, which only a user-auth stack has; nothing was prepared", { target: { root, space }, remedy: "drop --auth-timeout" });
    // A running broker keeps the timeout it was started with, which the broker policy records.
    const recordedTimeout = readBrokerPolicy(root)?.authTimeout;
    if (request.authTimeout !== recordedTimeout && brokerIsRunning())
      throw new CommandFailure("refused", "CONFLICT", `--auth-timeout ${request.authTimeout} differs from the running broker's (${recordedTimeout === undefined ? "nats-server's default" : `${recordedTimeout} seconds`}), which is fixed at its start; nothing was prepared`, { target: { root, space }, remedy: `stop the stack with \`cotal down --yes\` from ${root}, then run \`cotal up --auth-timeout ${request.authTimeout}\`` });
  }
  if (request.maxPayload !== undefined) {
    // A running broker keeps the limit it was started with, which the same record carries.
    const recordedPayload = readBrokerPolicy(root)?.maxPayload;
    if (request.maxPayload !== (recordedPayload ?? NATS_DEFAULT_MAX_PAYLOAD) && brokerIsRunning())
      throw new CommandFailure("refused", "CONFLICT", `--max-payload ${request.maxPayload} differs from the running broker's (${recordedPayload === undefined ? "nats-server's default" : `${recordedPayload} bytes`}), which is fixed at its start; nothing was prepared`, { target: { root, space }, remedy: `stop the stack with \`cotal down --yes\` from ${root}, then run \`cotal up${request.noManager ? " --no-manager" : ""} --max-payload ${request.maxPayload}\`` });
  }
  if (request.accountResolver !== undefined) {
    // An open stack renders the open broker configuration, which has no accounts to resolve.
    if (mode === "open") throw new CommandFailure("refused", "USAGE_INVALID", "--account-resolver sets how the broker resolves space accounts, and the open broker configuration has none; nothing was prepared", { target: { root, space }, remedy: "drop --account-resolver" });
    // nats-server switches resolvers only at start, and refuses a reload that changes one.
    const recordedResolver = readBrokerPolicy(root)?.accountResolver ?? "memory";
    if (request.accountResolver !== recordedResolver && brokerIsRunning())
      throw new CommandFailure("refused", "CONFLICT", `--account-resolver ${request.accountResolver} differs from the running broker's (${recordedResolver}), which is fixed at its start; nothing was prepared`, { target: { root, space }, remedy: `stop the stack with \`cotal down --yes\` from ${root}, then run \`cotal up --account-resolver ${request.accountResolver}\`` });
  }
  // The broker this start uses, whether it is about to be prepared or already serving. A manager
  // publishes its contract on that limit, so the floor applies before any member starts, including
  // when a bare up adds a manager to a broker an earlier --no-manager left running.
  const effectivePayload = request.maxPayload ?? readBrokerPolicy(root)?.maxPayload;
  if (!request.noManager && effectivePayload !== undefined && effectivePayload < MANAGER_START_PAYLOAD_FLOOR)
    throw new CommandFailure("refused", "USAGE_INVALID", `--max-payload ${effectivePayload} is below ${MANAGER_START_PAYLOAD_FLOOR} bytes, the least the space's manager starts on: it publishes its contract artifacts, one message each, and the largest is bounded at ${CONTRACT_ARTIFACT_MAX_BYTES} bytes with ${MANAGER_START_PAYLOAD_FLOOR - CONTRACT_ARTIFACT_MAX_BYTES} more for the publish; nothing was started`, {
      target: { root, space },
      remedy: brokerIsRunning()
        ? `from the stack's project root, run \`cotal down --yes\`, then \`cotal up --max-payload ${NATS_DEFAULT_MAX_PAYLOAD}\`, or keep it broker-only with \`cotal up --no-manager\``
        : `pass --max-payload ${MANAGER_START_PAYLOAD_FLOOR} or more, or pass --no-manager to start the broker without a manager`,
    });
  const admittedRestore = stackPreflight({ ...request, root, space }, previous?.journal, recordedInputs !== undefined && strayHost === undefined && !newCap && !newLog);
  // A recorded stack keeps its space and broker address.
  const recordedTarget = { root, space, recorded: { space: previous?.journal.space, server: previous?.journal.server }, requested: { space, server: request.server } };
  if (previous && previous.journal.space !== space)
    throw new CommandFailure("refused", "CONFLICT", `this root's controller stack is recorded for space ${previous.journal.space}, and this up asked for ${space}; it was not rebound`, { target: recordedTarget, remedy: `run bare \`cotal up\` from ${root} to start ${previous.journal.space}` });
  // No command moves a stack that ran to another address. While another program holds the recorded
  // one, bare up refuses too, so the refusal names that holder rather than sending the operator there.
  if (previous && canonicalServer(previous.journal.server) !== canonicalServer(request.server)) {
    const held = await recordedAddressHeld(space, previous.journal.server, brokerHost);
    const address = previous.journal.server;
    const retry = request.manifest ? `use the recorded broker address ${address} in the manifest, then repeat your original command`
      : `repeat your original startup command from the same folder with ${codeSpan(`--server ${shellWord(address)}`)} and all other options unchanged`;
    throw new CommandFailure("refused", "CONFLICT", `this root's controller stack is recorded at ${address}, and this up asked for ${request.server}; a recorded stack is not moved to another address${held ? `, and ${held.says}` : ""}`, { target: recordedTarget, remedy: held ? `${held.frees}, then ${retry}` : retry });
  }
  // The broker service's own address rules run before anything is written, so an address it would
  // refuse never becomes this root's recorded broker address.
  brokerListenAddress(request.server);
  // The broker service launches only for a space registered or prepared at this root. That is
  // checked here, before trust, configuration, definitions, instances or the journal are written,
  // so the refusal leaves the folder as it was.
  const registration = findMesh(space), preparedSpace = findPreparedSpace(space);
  if (registration && (registration.origin !== "up" || canonicalRoot(registration.root) !== root || registration.server !== (previous?.journal.server ?? request.server)))
    throw new CommandFailure("refused", "CONFLICT", "the space is registered to another root, broker address or external origin; nothing was prepared or started", { target: { root, space }, remedy: `inspect it with \`cotal space show ${space}\`` });
  if (!registration && (!preparedSpace || canonicalRoot(preparedSpace.root) !== root))
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the space has no prepared or locally started registration at this root; nothing was prepared or started", { target: { root, space }, remedy: `prepare it with ${codeSpan(`cotal space create ${space} --root ${shellWord(root)}`)}, then run \`cotal up\`` });
  // A store folder belongs to one space. A --store-dir no record of this stack names refuses while
  // another space uses it; the recorded or default store starts, and the receipt warns.
  const storePath = brokerStore !== undefined ? resolve(brokerStore) : join(root, ".cotal", "nats");
  const storeTenants = sharedStoreAtStart(storePath, space, recordedBroker !== undefined || legacyStopped || request.storeDir === undefined);
  const storeWarnings = previous ? stackStoreWarnings(previous.journal, !brokerIsRunning()) : [];
  // An up stopped after its broker served and before it registered the space leaves a broker whose
  // stream setup and registration only that up's own preparation could finish, and trust is never
  // prepared again under a running broker. This start refuses before any write and names the stop.
  const stranded = registration ? undefined : strandedBroker(space);
  if (stranded)
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `the stack's broker runs as pid ${stranded.process?.pid}, but the \`cotal up\` that started it stopped before it registered the space, so this up cannot finish that start; nothing was changed`, { target: { root, space, broker: stranded.instanceId, pid: stranded.process?.pid }, remedy: strandedBrokerRemedy(root, request.noManager, request.invokedRoot) });
  // A broker stopped by a signal accepts connections and never answers, so every step through it would
  // wait out its budget, and its readiness check would record a listener that serves nothing. This
  // start refuses before any write and names the signal that resumes it.
  const brokerPid = serviceInstances(space, STACK_DEFINITION.broker).map((row) => row.record.value).find((value) => observeServiceProcess(value) === "running")?.process?.pid;
  if (brokerPid !== undefined && processStopped(brokerPid))
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `the stack's broker, pid ${brokerPid}, is stopped, so it accepts connections at ${previous?.journal.server ?? request.server} and never answers; nothing was started or written`, { target: { root, space, pid: brokerPid }, remedy: `resume it with kill -CONT ${brokerPid} and run \`${displayCmd()} up\` again` });
  // An earlier up or down that never recorded its outcome is settled from its members' process
  // evidence under the held maintenance lock. Only a preserve or resume can remain unsettled here.
  // A member stop an earlier down could not confirm in time is settled from its own receipt first.
  if (previous) await settleRetainedStackStops(previous.journal);
  const { snapshot: current, settled } = previous ? settleStackOperation(request.maintenanceLock, previous, request.invokedRoot) : { snapshot: undefined, settled: undefined };
  if (current && stackOperationUnsettled(current.journal))
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "an earlier preserve or resume on this root has no settled outcome; it is decided by its own maintenance attempt and no member was started", { target: { root, space, operation: current.journal.operation }, remedy: `inspect the root's maintenance attempt and the stack's members with \`cotal service --space ${space}\` before another whole-stack operation` });
  const server = previous?.journal.server ?? request.server;
  if (request.noManager) {
    const running = serviceInstances(space, STACK_DEFINITION.manager).filter((row) => observeServiceProcess(row.record.value) === "running");
    if (running.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "--no-manager cannot keep an already-running controller manager; no member was started or stopped", { target: { root, space, instances: running.map((row) => row.name) }, remedy: `stop the recorded manager with \`cotal service stop ${STACK_DEFINITION.manager} --space ${space} --yes\` before requesting --no-manager` });
  }
  // A rotation is a stopped, fresh boot. A member that still runs would keep the retired system
  // account, so every member must be stopped before anything is rotated or started.
  if (request.rotateSys) {
    if (mode === "open") throw new CommandFailure("refused", "UNSUPPORTED", "an open stack has no system account or $SYS credentials to rotate; nothing was started", { target: { root, space }, remedy: `run bare \`cotal up\` from ${root} to start it` });
    const running = STACK_ROLES.flatMap((role) => serviceInstances(space, STACK_DEFINITION[role])).filter((row) => observeServiceProcess(row.record.value) === "running");
    if (running.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "this stack has running members, and a running broker keeps serving the retired system account; nothing was rotated or started", { target: { root, space, instances: running.map((row) => row.name) }, remedy: "stop the stack with `cotal down --yes`, then run `cotal up --rotate-sys`" });
    const trust = await getSpaceAuth(workspaceSecretStore(root), space);
    if (!trust?.operator.seed) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", trust ? "this root holds the space's trust without the broker operator seed, so it cannot rotate the system account; nothing was started" : "this stack has no system account yet, so nothing was rotated or started", { target: { root, space }, remedy: trust ? "run the rotation where the broker trust record lives" : `run bare \`cotal up\` from ${root}; a first start mints the $SYS creds` });
  }
  if (request.recreateIssuedStores !== undefined) {
    const running = STACK_ROLES.flatMap((role) => serviceInstances(space, STACK_DEFINITION[role])).filter((row) => observeServiceProcess(row.record.value) === "running");
    if (running.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "this stack has running members, and the issued-authority stores are recreated only on a fresh broker start, before any issuer runs; nothing was changed", { target: { root, space, instances: running.map((row) => row.name) }, remedy: `stop the stack with \`cotal down --yes\` from ${root}, then run \`cotal up --recreate-issued-stores <backup-dir>\` again` });
  }
  if (request.recreateMembershipStore) {
    const running = STACK_ROLES.flatMap((role) => serviceInstances(space, STACK_DEFINITION[role])).filter((row) => observeServiceProcess(row.record.value) === "running");
    if (running.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "this stack has running members, and membership storage conversion deletes the derived feed before recreating it; nothing was changed", { target: { root, space, instances: running.map((row) => row.name) }, remedy: `stop the stack with \`cotal down --yes\` from ${root}, then run \`cotal up --recreate-membership-store\` again` });
  }
  // Check provider inputs before preparation or a journal write. A supplied IdP is always checked,
  // including a live refresh; only an unpinned first enable probes JWKS. Preparation checks again.
  if (mode === "user") {
    const brokerRows = serviceInstances(space, STACK_DEFINITION.broker);
    if (request.idp !== undefined || !(brokerRows.length === 1 && observeServiceProcess(brokerRows[0]!.record.value) === "running")) await preflightUserStack(root, space, request.idp, request.mode === undefined ? request.presentation : undefined);
  }
  const brokerRows = serviceInstances(space, STACK_DEFINITION.broker);
  const brokerRunning = brokerRows.length === 1 && observeServiceProcess(brokerRows[0]!.record.value) === "running";
  const readSeed = () => request.manifest?.seed ?? loadChannelsFile(root, request.channels, mode === "open");
  const seed = brokerRunning ? undefined : readSeed();
  // A record under the root whose process is gone, or whose pid now runs another start than its pin
  // records, fronts nothing, as after a reboot. It is removed before any member starts, as a complete
  // `down` removes it, because a process this up starts can take its pid and make it read as live.
  let clearedRecords: LocalRecord[];
  try { clearedRecords = removeStaleLocalRecords(root, space); }
  catch (error) { throw new CommandFailure("refused", "CONFLICT", `a stale process record under the root was not removed (${(error as Error).message}); nothing was started`, { target: { root, space }, remedy: "inspect the process records under the root's .cotal, then run `cotal up` again" }); }
  const roles = STACK_ROLES.filter((role) => stackRoleApplies(mode, role) && !(role === "manager" && request.noManager));
  // A replacement an earlier `up` journaled is resolved from its own record before it is carried over.
  const recordedMembers = current ? withSettledMembers(current.journal, undefined).members : [];
  const members: StackMember[] = STACK_ROLES.map((role) => {
    const recorded = recordedMembers.find((row) => row.role === role);
    return { role, definition: STACK_DEFINITION[role], instanceId: recorded?.instanceId ?? null, process: roles.includes(role) ? undefined : recorded?.process, state: roles.includes(role) ? "planned" : "not-attempted" };
  });
  let journal: StackJournal = { schemaVersion: 1, kind: "cotal-stack-controller", root, space, server, mode, recovery: { home: resolve(homeCotalDir()), host: stackRecoveryHost() }, ...(recordedBroker ? { broker: recordedBroker } : {}), members, operation: { ...newStackOperation("up"), id: request.maintenanceLock.owner.id }, updatedAt: new Date().toISOString() };
  // The whole scoped plan is durable before the first effect. It is written only once the broker
  // address checks below pass, so a restart refused there keeps the proof that the stack stopped
  // cleanly. Until that first write, settle and mark adjust only the in-memory plan.
  let snapshot: StackJournalSnapshot | undefined;
  const changed: unknown[] = [];
  const settle = (phase: StackJournal["operation"]["phase"]) => {
    journal = { ...journal, operation: { ...journal.operation, phase }, updatedAt: new Date().toISOString() };
    if (snapshot !== undefined) snapshot = writeStackJournal(root, snapshot, journal);
  };
  const mark = (role: StackRole, change: Partial<StackMember>) => {
    journal = { ...journal, members: journal.members.map((row) => row.role === role ? { ...row, ...change } : row), updatedAt: new Date().toISOString() };
    if (snapshot !== undefined) snapshot = writeStackJournal(root, snapshot, journal);
  };
  // A redefinition retires the member's recorded instance with its old definition. The replacement's
  // IDs are journaled before that retirement and the new definition's revision before its launch.
  const replace = (role: StackRole) => (definitionRevision?: string) => {
    const row = journal.members.find((member) => member.role === role)!;
    mark(role, { replacement: definitionRevision === undefined ? { operation: journal.operation.id, instanceId: randomUUID(), launchRequestId: randomUUID() } : { ...row.replacement!, definitionRevision } });
  };
  const start = async (role: StackRole, definition: ServiceDefinitionSnapshot) => {
    prepareProcessService(definition);
    const current = serviceInstances(space, definition.name);
    if (current.length > 1) throw new CommandFailure("refused", "TARGET_AMBIGUOUS", "a stack definition has several instance records; no instance was chosen", { target: { space, definition: definition.name, candidates: current.map((row) => row.name) } });
    const { instanceId: recorded, replacement } = journal.members.find((row) => row.role === role)!;
    if (current[0] && recorded && current[0].name !== recorded) throw new CommandFailure("refused", "CONFLICT", "the stack journal and the definition's instance record name different instances; neither was adopted", { target: { space, definition: definition.name } });
    // A readiness wait can take many seconds, so a text run says what it waits for instead of going silent.
    if (request.presentation !== "json" && !(current[0] && observeServiceProcess(current[0].record.value) === "running"))
      process.stderr.write(`Starting ${definition.name}; waiting up to ${Math.round(definition.record.value.readiness.timeoutMs / 1000)}s for its readiness check\n`);
    // A redefined member starts its replacement under the IDs the journal already names.
    const started = await startProcessService(definition, {
      ...(replacement ? { replacement: { instanceId: replacement.instanceId, launchRequestId: replacement.launchRequestId } } : current[0] ? { instance: current[0].name } : {}),
      ...(role === "manager" && request.managerSeatCap !== undefined ? { managerSeatCap: request.managerSeatCap } : {}),
    });
    mark(role, { instanceId: started.instance.name, state: started.noOp ? "reused" : "started", replacement: undefined, process: started.instance.record.value.process });
    if (!started.noOp) changed.push(instanceProjection(started.instance));
    return started.instance;
  };
  // Set only when a user stack's manager is withheld for want of an existing login and grant. That
  // is a known pre-effect refusal of one member, never a launch and never an unknown outcome.
  let loginBlock: CommandFailure | undefined;
  // A failure in a step that belongs to an already-started member is attributed to that member,
  // never to the next planned one.
  let failedRole: StackRole | undefined;
  let failedStage: "broker-streams" | "broker-registration" | undefined;
  let startedBroker: { definition: ServiceDefinitionSnapshot; id: string } | undefined;
  let brokerExecutable: NatsServer | undefined;
  let streamsRecreated = false;
  let launch: { path: string; sha256: string } | undefined;
  // Only a broker this call starts gets the space's streams created.
  let brokerReused = false;
  let rotation: StackUpResult["rotation"];
  // How many times the broker was launched again on a new websocket port after another process took one.
  let brokerRelaunches = 0;
  try {
    // Broker. Trust and configuration are prepared only when this broker is not already serving
    // under its own recorded instance, never as an adapter planning step.
    brokerReused = brokerRunning;
    if (!brokerRunning && await isReachable(server, { timeoutMs: 1500 })) {
      // Name the space this machine registered at the address. A first start can take another
      // address; a stack that ran keeps its recorded one, so whatever answers there must stop first.
      const holder = loadMeshes().find((mesh) => mesh.space !== space && mesh.server === server);
      const local = holder && (holder.origin === undefined || holder.origin === "up");
      const stopHolder = holder ? local ? `stop space ${holder.space} with \`cotal down\` from ${holder.root}` : `stop the broker of space ${holder.space}` : `stop what answers at ${server}`;
      const retry = previous === undefined ? await request.retryAtAnotherAddress?.(brokerHost ?? brokerListenAddress(server).host) : undefined;
      throw new CommandFailure("refused", "CONFLICT", `something already answers at the stack's broker address ${server}${holder ? `, where space ${holder.space} is registered` : ""}, without this stack's broker instance; it was not adopted or stopped`, {
        target: { root, space, server, ...(holder ? { registered: { space: holder.space, root: holder.root } } : {}) },
        remedy: previous === undefined
          ? `${retry !== undefined ? `${retry}, or ` : ""}${stopHolder} and retry this start`
          : recordedAddressRemedy(request, stopHolder),
      });
    }
    if (!brokerRunning) await assertStackBrokerAddress(request, root, space, server, brokerHost, previous !== undefined);
    if (!brokerRunning && previous === undefined && request.retryAtAnotherAddress) {
      const holder = loadMeshes().find((mesh) => mesh.space !== space && mesh.server === server);
      if (holder) throw new CommandFailure("refused", "CONFLICT", `another registration names this exact broker address: space ${holder.space} in ${holder.root} reserves ${server}; no shared broker was launched or stopped`, {
        remedy: await request.retryAtAnotherAddress(brokerHost ?? brokerListenAddress(server).host)
          ?? "choose an unreserved broker address and retry with `--server`",
      });
    }
    snapshot = writeStackJournal(root, current ?? recorded, journal);
    settle("applying");
    let prepared: Awaited<ReturnType<StackUpNative["prepareBroker"]>> | undefined;
    const recordedWsPort = !brokerRunning ? recordedStackWebsocketPort(savedManager, root) : undefined;
    const pinnedWsPort = !brokerRunning ? advertisedWebsocketPort(recordedWsPort, mode, space, managerDefinition?.record.revision) : undefined;
    if (!brokerRunning) {
      if (request.rotateSys) {
        // Rotated here, after the address check, so no broker can still serve the retired account.
        // Preparation then renders the broker configuration from the rotated trust record.
        failedRole = "broker";
        try {
          const rotated = await rotateSystemCreds(root, space);
          rotation = { generation: rotated.gen, expiresAt: rotated.expiresAt ? new Date(rotated.expiresAt * 1000).toISOString() : null };
        } catch (error) {
          throw new CommandFailure("unknown", "OPERATION_UNKNOWN", `the system account rotation did not finish: ${(error as Error).message}`, { target: { root, space } });
        }
        failedRole = undefined;
      }
      const requestedWsPort = pinnedWsPort ?? recordedWsPort;
      prepared = await native.prepareBroker({ transport: request.transport, server, space, open: mode === "open", ...(mode === "user" ? { userAuth: request.idp !== undefined ? { idpUrl: request.idp } : {} } : {}), ...(brokerHost ? { host: brokerHost } : {}), ...(requestedWsPort !== undefined ? { wsPort: requestedWsPort } : {}), ...(brokerStore ? { storeDir: brokerStore } : {}), ...(storePin ? { existingStore: storePin } : {}), ...(brokerCap !== undefined ? { maxFileStore: brokerCap } : {}), ...(brokerLogFile !== undefined ? { logFile: brokerLogFile } : {}), ...(brokerLogfileSizeLimit !== undefined ? { logfileSizeLimit: brokerLogfileSizeLimit } : {}), ...(brokerLogfileMaxNum !== undefined ? { logfileMaxNum: brokerLogfileMaxNum } : {}), ...(request.authTimeout !== undefined ? { authTimeout: request.authTimeout } : {}), ...(request.maxPayload !== undefined ? { maxPayload: request.maxPayload } : {}), ...(request.accountResolver !== undefined ? { accountResolver: request.accountResolver } : {}), ...(request.noManager ? { noManager: true } : {}) });
      if (canonicalRoot(prepared.root) !== root || prepared.space !== space || prepared.server !== server || (prepared.setup === undefined) !== (mode === "open") || (prepared.user === undefined) !== (mode !== "user")) throw new CommandFailure("refused", "CONFLICT", "the prepared broker configuration names another root, space, address or auth mode; the stack did not continue");
      if (mode === "user") assertUserStackTransport(server, prepared.transport.kind === "tls-required");
      // The validated transport decision is recorded before the broker child starts, so its
      // listener-report check compares against the transport this configuration actually serves.
      native.commitTransport(root, prepared.transport, { authTimeout: prepared.authTimeout, maxPayload: prepared.maxPayload, accountResolver: prepared.accountResolver });
      journal = { ...journal, broker: { storeDir: resolve(prepared.storeDir), ...(recordedBroker?.storeIdentity ? { storeIdentity: recordedBroker.storeIdentity } : {}), ...(brokerCap !== undefined ? { maxFileStore: brokerCap } : {}), ...(brokerHost ? { host: brokerHost } : {}), ...(brokerLogFile !== undefined ? { logFile: resolve(brokerLogFile) } : {}), ...(brokerLogfileSizeLimit !== undefined ? { logfileSizeLimit: brokerLogfileSizeLimit } : {}), ...(brokerLogfileMaxNum !== undefined ? { logfileMaxNum: brokerLogfileMaxNum } : {}) }, updatedAt: new Date().toISOString() };
      snapshot = writeStackJournal(root, snapshot, journal);
    }
    // A running stack broker keeps its saved definition; a fresh one is defined from this preparation.
    const savedBroker = serviceDefinitionStore(space).read(STACK_DEFINITION.broker);
    const savedOptions = savedBroker?.record.value.launch.type === "adapter" ? savedBroker.record.value.launch.options : undefined;
    if (!prepared && !savedOptions) throw new CommandFailure("refused", "CONFLICT", "a broker instance runs without its saved stack definition; it was not adopted", { target: { space, definition: STACK_DEFINITION.broker } });
    if (prepared) brokerExecutable = { path: canonicalBinary(prepared.bin), source: prepared.source, version: prepared.version };
    const brokerOptions = prepared && brokerExecutable ? { root, config: prepared.confPath, binary: brokerExecutable.path, server, ...(brokerLogFile !== undefined ? { logFile: resolve(brokerLogFile) } : {}) } : { ...savedOptions! };
    const broker = ensureDefinition(space, "broker", adapterDefinition(space, STACK_ADAPTER.broker, brokerOptions, 30000), root, replace("broker"));
    if (storePin) recheckExistingStore(storePin, { root, space });
    const storeIdentity = prepared ? readStoreIdentity(prepared.storeDir) : undefined;
    // Retry a websocket bind failure on another port only when no running manager advertises it.
    let brokerInstance: ServiceInstanceSnapshot;
    for (;;) {
      try { brokerInstance = await start("broker", broker); break; }
      catch (error) {
        if (!prepared?.setup || brokerRelaunches === BROKER_WEBSOCKET_RELAUNCHES || !websocketPortTaken(error, prepared.setup.wsPort, brokerLogFile === undefined ? undefined : resolve(brokerLogFile))) throw error;
        if (pinnedWsPort !== undefined) throw new CommandFailure("failed", "OPERATION_FAILED", `the broker could not bind websocket port ${pinnedWsPort}, which the running manager still advertises`, { remedy: `free websocket port ${pinnedWsPort}, then run \`cotal up\` again` });
        const wsPort = await prepared.setup.moveWebsocketPort();
        if (request.presentation !== "json") process.stderr.write(`another process took the broker's websocket port ${prepared.setup.wsPort} before the broker bound it; launching the broker again with port ${wsPort}\n`);
        prepared = { ...prepared, setup: { ...prepared.setup, wsPort } };
        // A replacement's launch left its instance record, which the next launch starts again.
        const replacement = journal.members.find((row) => row.role === "broker")?.replacement;
        if (replacement) mark("broker", { instanceId: replacement.instanceId, replacement: undefined });
        brokerRelaunches++;
      }
    }
    if (storeIdentity && journal.broker) {
      journal = { ...journal, broker: { ...journal.broker, storeIdentity }, updatedAt: new Date().toISOString() };
      snapshot = writeStackJournal(root, snapshot, journal);
    }
    if (brokerLogFile !== undefined) {
      let fd: number | undefined;
      try { fd = openPrivateAppend(resolve(brokerLogFile)); } finally { if (fd !== undefined) closeSync(fd); }
    }
    if (prepared) {
      if (journal.members.find((row) => row.role === "broker")?.state !== "started")
        throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the broker became reused during preparation; no space infrastructure was changed", { target: { root, space }, remedy: "stop the stack first, then run `cotal up --recreate-membership-store`" });
      startedBroker = { definition: broker, id: brokerInstance.name };
      // The broker's own stream and registry setup, on the native space path, after it serves.
      failedRole = "broker";
      failedStage = "broker-streams";
      await native.initializeStreams(server, space, prepared.setup, seed, request.recreateIssuedStores, request.recreateMembershipStore);
      failedStage = "broker-registration";
      // A user registration is recorded here, before its auth service exists, because the native
      // auth-service child resolves a registered user target. It carries only the prepared trust
      // pins and stays incomplete until that child's own readiness is confirmed below.
      native.recordMesh({ space, server, root, mode, tlsRequired: prepared.transport.kind === "tls-required", storeDir: prepared.storeDir, ...(prepared.user ? { userAuth: provisionalUserAuth(prepared.user) } : {}), ...(maxSessions !== undefined ? { maxSessions } : {}), ...(brokerHost ? { attachHost: brokerHost } : {}), ...(brokerCap !== undefined ? { maxFileStore: brokerCap } : {}) });
      failedStage = undefined;
      failedRole = undefined;
    } else {
      // User-auth stacks only inspect the derived membership store; their running streams
      // are never recreated through this callback.
      // `cotal space delete` removes the streams from a broker that keeps running; it has no user-auth
      // route. When every one is gone they are created again here, as a broker start would, and a
      // partial loss is left alone.
      failedRole = "broker";
      streamsRecreated = await native.recreateDeletedStreams({ root, space, server, mode, readSeed });
      failedRole = undefined;
    }
    // A stopped user-auth service under an already-running broker is refused before delivery
    // mints a credential or starts; its native preparation runs only with a broker start.
    if (mode === "user" && !prepared?.user) {
      const authRows = serviceInstances(space, STACK_DEFINITION.auth);
      if (authRows.length !== 1 || observeServiceProcess(authRows[0]!.record.value) !== "running") throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the user stack's auth service is stopped while its broker still runs; its native preparation runs only with a broker start, so it was not started from other material", { target: { root, space }, remedy: "stop the stack with bare `cotal down`, then run bare `cotal up`" });
    }
    // Delivery, before a user stack's auth service so its liveness oracle answers a plane-claim
    // reclaim. Its native credential is minted into the root's own store key; the adapter gets only
    // that protected path. An open stack has no delivery member and mints no credential.
    if (mode !== "open") {
      const store = workspaceSecretStore(root), auth = await getSpaceAuth(store, space);
      if (!auth) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the static space trust is missing; no delivery credential was minted from another signer", { target: { root, space } });
      const credsKey = deliveryCredsKey(space, { injected: false, root });
      const credsPath = join(root, ".cotal", credsKey);
      const deliveryRows = serviceInstances(space, STACK_DEFINITION.delivery);
      const runningDelivery = deliveryRows.length === 1 && observeServiceProcess(deliveryRows[0]!.record.value) === "running" ? deliveryRows[0] : undefined;
      const stoppedDelivery = prepared && runningDelivery && await stopDeliveryForBrokerRepair(root, recordedMembers, runningDelivery);
      if (!runningDelivery || stoppedDelivery) {
        const creds = await mintCreds(auth, newIdentity(), "delivery");
        // A daemon that was killed, or that exited when its broker went away, cannot release shard 0,
        // and a replacement started inside the row's TTL loses the create and refuses to bind. No
        // daemon runs here, so a row held by the credential this folder gave the previous one is that
        // dead daemon's: wait for the bucket TTL to remove it. A row written again meanwhile has a
        // live holder, and that is refused.
        const previous = await store.get(credsKey);
        if (previous !== undefined) {
          const waited = await awaitDeadDeliveryLease({
            servers: server, space, creds, tls: resolveNativeServiceTarget(root, space, server).tlsRequired,
            deadHolder: deliveryLeaseHolderFor(previous), ttlMs: LEASE_TTL_MS,
            onWait: (ms) => { if (request.presentation !== "json") process.stderr.write(`${STACK_DEFINITION.delivery}: shard 0 is still leased to this folder's previous delivery daemon, which is not running; waiting ${Math.ceil(ms / 1000)}s for the lease to expire\n`); },
          });
          if (waited === "rewritten") throw new CommandFailure("refused", "CONFLICT", "shard 0 of the delivery lease names this folder's previous delivery daemon and was written again while up waited for it to expire, so a live daemon holds it; no second daemon was started", { target: { root, space }, remedy: `find the process running delivery for space ${space} and stop it or keep it; \`cotal down\` does not reach a daemon this folder has no record of` });
        }
        await store.put(credsKey, creds);
      }
      const delivery = ensureDefinition(space, "delivery", adapterDefinition(space, STACK_ADAPTER.delivery, { root, creds: credsPath, server }, 40000), root, replace("delivery"));
      await start("delivery", delivery);
    }
    if (mode === "user") {
      // The callout's deadline is the timeout this broker configuration rendered, never a second setting.
      const authOptions = { root, server, ...(prepared?.authTimeout !== undefined ? { "auth-timeout": String(prepared.authTimeout) } : {}) };
      const authService = ensureDefinition(space, "auth", adapterDefinition(space, STACK_ADAPTER.auth, authOptions, 60000), root, replace("auth"));
      const instance = await start("auth", authService);
      if (prepared?.user) {
        failedRole = "auth";
        const confirmed = await confirmUserAuthEndpoints(prepared.user, space, instance);
        native.recordMesh({ space, server, root, mode, tlsRequired: prepared.transport.kind === "tls-required", storeDir: prepared.storeDir, userAuth: confirmed, ...(maxSessions !== undefined ? { maxSessions } : {}), ...(brokerHost ? { attachHost: brokerHost } : {}), ...(brokerCap !== undefined ? { maxFileStore: brokerCap } : {}) });
        failedRole = undefined;
      }
    }
    // A user stack's manager is read as the invoking user's existing login, confirmed with its IdP
    // as `manager start` confirms it. Without a signed-in, granted login, or with one the IdP
    // rejects, it is not attempted; nothing is launched for it.
    if (!request.noManager && mode === "user") {
      try { await assertManagerLogin(root, space, () => stackLoginRetry(request)); }
      catch (error) {
        if (!isCommandFailure(error) || error.code !== "AUTH_REQUIRED") throw error;
        loginBlock = error;
      }
    }
    if (!request.noManager && !loginBlock) {
      const options: Record<string, unknown> = { root, runtime: request.runtime, server };
      const wsPort = prepared?.setup?.wsPort ?? definitionListeners(broker)?.find((listener) => listener.name === "websocket")?.port;
      if (wsPort != null) options["ws-port"] = wsPort;
      if (maxSessions !== undefined) options["max-sessions"] = maxSessions;
      if (brokerHost) options["console-host"] = brokerHost;
      if (request.manifest) {
        // The manager carries the manifest launch only when this call starts it. A running manager
        // keeps the launch it was started with; nothing is re-launched or re-pinned under it.
        const managerRows = serviceInstances(space, STACK_DEFINITION.manager);
        if (managerRows.some((row) => observeServiceProcess(row.record.value) === "running")) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a controller manager already runs for this space; a fresh manifest launch was not attached to it", { target: { root, space, instances: managerRows.map((row) => row.name) } });
        failedRole = "manager";
        launch = await request.manifest.launchSpec({ root, space, server, mode, ...(prepared?.user ? { user: prepared.user } : {}) });
        failedRole = undefined;
        options.launch = launch.path;
        options["launch-sha256"] = launch.sha256;
      }
      const manager = ensureDefinition(space, "manager", adapterDefinition(space, STACK_ADAPTER.manager, options, 60000), root, replace("manager"));
      await withManagerName({ root, space }, request.managerName, () => start("manager", manager));
    }
    if (!loginBlock) settle("completed");
  } catch (caught) {
    // A refused first start still records that the stack never started, so a later stop reports a no-op.
    if (snapshot === undefined && current === undefined) snapshot = writeStackJournal(root, current ?? recorded, journal);
    // A reused broker that lost some of the space's streams, but not all of them as `cotal space delete`
    // leaves it, gets none back here; a broker start creates the missing ones.
    const error = brokerReused && isJetStreamMissing(caught, JetStreamApiCodes.StreamNotFound)
      ? new CommandFailure("refused", "TARGET_NOT_FOUND", "the running broker is missing some of this space's streams, and up creates them on a running broker only when every one is gone, as after `cotal space delete`", { remedy: "restart the stack with `cotal down --yes`, then `cotal up`, which creates the missing ones" })
      : reusedWithoutJetStream(caught, brokerReused, root, space) ?? caught;
    // A broker this call started that could not create the space's streams serves no stack, and a
    // later up would reuse it and fail the same way. It is stopped again here, so the next up starts
    // a fresh broker, and the run is a failure whose cause its log names.
    const unserved = failedStage === "broker-streams" && startedBroker ? await stopUnservedBroker(space, startedBroker.definition, startedBroker.id) : undefined;
    // A refusal from the stream setup, such as issued-authority stores created before bounded
    // retention, stays a refusal: the broker it ran on is stopped again and nothing else started.
    const refusal = unserved && isCommandFailure(error) && error.outcome === "refused" ? error : undefined;
    if (unserved && refusal) {
      mark("broker", { state: "stopped", code: refusal.code });
      for (const row of journal.members.filter((member) => member.state === "planned")) mark(row.role, { state: "not-attempted" });
      settle("refused");
      throw new CommandFailure("refused", refusal.code, refusal.message, { target: { root, space, operation: journal.operation.id, members: journal.members }, changed: [instanceProjection(unserved.stopped)], ...(refusal.remedy ? { remedy: refusal.remedy } : {}) });
    }
    if (unserved) {
      mark("broker", { state: "stopped", code: "OPERATION_FAILED" });
      for (const row of journal.members.filter((member) => member.state === "planned")) mark(row.role, { state: "not-attempted" });
      settle("failed");
      const nativeCause = error instanceof JetStreamApiError && Number.isSafeInteger(error.code) ? { code: String(error.code) } : undefined;
      // JetStream answers 10047, insufficient storage resources, when the file store cannot hold a
      // stream's reservation; the broker logs nothing about it.
      const noStorage = error instanceof JetStreamApiError && error.code === 10047;
      throw new CommandFailure("failed", "OPERATION_FAILED", `the broker this command started could not create the space's streams${unserved.outOfFiles ? ", because it ran out of open files" : noStorage ? `, because its JetStream file store${brokerCap !== undefined ? ` cap (--max-file-store ${brokerCap})` : ""} has too little room for them` : ""}, so it was stopped again; nothing of the stack runs`, {
        target: { root, space, operation: journal.operation.id, members: journal.members, ...(unserved.log ? { brokerLog: unserved.log } : {}) },
        changed: [instanceProjection(unserved.stopped)],
        ...(nativeCause ? { native: nativeCause } : {}),
        remedy: unserved.outOfFiles
          ? `raise the open-file limit (ulimit -n) of the shell that runs \`cotal up\`, then run \`cotal up\` again from ${root}`
          : noStorage
            ? brokerCap !== undefined
              ? `run \`cotal up --max-file-store <bytes>\` from ${root} with a larger cap and room for messages`
              : `free space on the filesystem that holds ${brokerStore ?? join(root, ".cotal", "nats")}, or run \`cotal up --max-file-store <bytes>\` from ${root} with room for messages`
            : `fix what the broker's log${unserved.log ? ` at ${unserved.log}` : ""} names, then run \`cotal up\` again from ${root}`,
      });
    }
    const failure = isCommandFailure(error) ? error : undefined;
    const uncertain = failure === undefined || failure.outcome === "unknown";
    const pending = failedRole ? journal.members.find((row) => row.role === failedRole) : journal.members.find((row) => row.state === "planned");
    if (pending) mark(pending.role, { state: uncertain ? "unknown" : failure?.outcome === "refused" ? "refused" : "failed", code: failure?.code ?? "OPERATION_UNKNOWN" });
    for (const row of journal.members.filter((member) => member.state === "planned")) mark(row.role, { state: "not-attempted" });
    settle(uncertain ? "unknown" : changed.length ? "partial" : failure?.outcome === "failed" ? "failed" : "refused");
    const outcome = uncertain ? "unknown" : changed.length ? "partial" : failure!.outcome;
    // Keep typed broker codes, never the server's arbitrary description or the raw error object.
    const nativeCause = failure ? { code: failure.code, outcome: failure.outcome, detail: failure.message }
      : error instanceof JetStreamApiError && Number.isSafeInteger(error.code) && error.code >= 10000 && error.code < 20000
        ? { code: String(error.code), ...(Number.isSafeInteger(error.status) && error.status >= 400 && error.status < 600 ? { detail: { status: error.status } } : {}) }
        : undefined;
    // The member's own sentence and remedy are what a reader can act on, such as a busy broker port.
    // A member that could not connect to a broker which ran out of open files names only that; the
    // broker's log names the cause, and a running broker keeps the limit it started with.
    const starved = pending && failure && pending.role !== "broker" ? brokerOutOfFilesLog(space) : undefined;
    // A member that writes to the store, as delivery writes its lease, cannot start while the store
    // is over its cap: the broker refuses that write as every other until there is room.
    const full = pending && failure && pending.role !== "broker" && starved === undefined ? await storeFullAfterStart(root, space) : undefined;
    const cause = pending && failure ? ` (${pending.role}: ${failure.message}${starved !== undefined ? `; the broker's log${starved ? ` at ${starved}` : ""} records that it ran out of open files` : full ? `; the broker's JetStream store ${full.path} is full at its --max-file-store cap of ${full.cap} bytes, so it refuses every write` : ""})` : "";
    // A refusal or failure with no member started or reused leaves nothing of the stack running.
    const none = !uncertain && !journal.members.some((row) => row.state === "started" || row.state === "reused");
    throw new CommandFailure(outcome, uncertain ? "OPERATION_UNKNOWN" : changed.length ? "OPERATION_PARTIAL" : failure!.code, none ? `the controller stack started no member${cause}; ${brokerRelaunches ? `the broker was launched again on ${brokerRelaunches} other websocket port${brokerRelaunches === 1 ? "" : "s"} and nothing else was retried` : "nothing was retried"}` : `the controller stack did not start every planned member${cause}; started members were kept and nothing was retried`, { target: { root, space, operation: journal.operation.id, members: journal.members, ...(failedStage ? { stage: failedStage } : {}) }, changed, ...(nativeCause ? { native: nativeCause } : {}), remedy: starved !== undefined ? `stop the stack with \`cotal down --yes\` from ${root}, raise the open-file limit (ulimit -n) of the shell that runs \`cotal up\`, then run \`cotal up\` there again` : full ? fullStoreUpRemedy(root, space) : !uncertain && failure?.remedy ? failure.remedy : `inspect the stack's members with ${codeSpan(`cotal service --space ${shellWord(space)}`)} before another \`cotal up\`; a later bare \`cotal down\` stops only the recorded members` });
  }
  if (loginBlock) {
    mark("manager", { state: "not-attempted", code: "AUTH_REQUIRED" });
    // Other members that this call started or found already running under their own recorded
    // instances are known live state, so the outcome is partial even when nothing new launched.
    // `changed` stays exactly what this call launched; reused members are not reported as launches.
    const live = journal.members.filter((row) => row.role !== "manager" && (row.state === "started" || row.state === "reused"));
    settle(live.length ? "partial" : "refused");
    const detail = { root, space, operation: journal.operation.id, members: journal.members, registration: userRegistrationIncomplete(space) ? "incomplete" : "confirmed" };
    if (!live.length) throw new CommandFailure("refused", "AUTH_REQUIRED", loginBlock.message, { target: detail, ...(loginBlock.remedy ? { remedy: loginBlock.remedy } : {}) });
    throw new CommandFailure("partial", "OPERATION_PARTIAL", changed.length
      ? "the user stack started its other members; the manager was not attempted because no signed-in, granted login exists. This is not whole-stack readiness"
      : "the user stack's other members were already running and were reused; the manager was not attempted because no signed-in, granted login exists. This is not whole-stack readiness", { target: detail, changed, native: { code: "AUTH_REQUIRED", outcome: "refused", detail: loginBlock.message }, ...(loginBlock.remedy ? { remedy: loginBlock.remedy } : {}) });
  }
  const allReused = journal.members.every((row) => row.state === "reused" || row.state === "not-attempted");
  return { journal, changed, allReused, ...(storeTenants.length ? { storeShared: { path: storePath, tenants: storeTenants } } : {}), ...(storeWarnings.length ? { storeWarnings } : {}), ...(clearedRecords.length ? { clearedRecords } : {}), ...(launch ? { launch } : {}), ...(admittedRestore ? { admittedRestore } : {}), ...(settled ? { settled } : {}), ...(brokerExecutable ? { brokerExecutable } : {}), ...(streamsRecreated ? { streamsRecreated: true as const } : {}), ...(rotation ? { rotation } : {}) };
}

/** A delivery process can still be exiting after broker loss. Stop the stack's exact recorded
 * member so the ordinary start waits for its lease and requires fresh delivery readiness. */
async function stopDeliveryForBrokerRepair(root: string, members: StackMember[], selected: ServiceInstanceSnapshot): Promise<boolean> {
  const value = selected.record.value;
  const member = members.find((row) => row.role === "delivery");
  if (member?.instanceId !== selected.name || !member.process || !value.process || member.process.pid !== value.process.pid || member.process.token !== value.process.token) return false;
  const definition = serviceDefinitionStore(value.space).read(STACK_DEFINITION.delivery);
  const launch = definition?.record.value.launch;
  if (!definition || definition.record.revision !== value.definitionRevision || launch?.type !== "adapter" || launch.adapter !== STACK_ADAPTER.delivery || launch.options.root !== root) return false;
  if (!controlsRecordedAdapter(value, prepareProcessService(definition).adapter)) return false;
  await stopProcessService(definition, selected);
  return true;
}

/** Stop a broker this call started, through its exact kernel stop, and read whether its log says it
 *  ran out of open files. A stop that does not confirm returns nothing, so the caller reports the
 *  run as unknown and names the inspection step instead. */
async function stopUnservedBroker(space: string, definition: ServiceDefinitionSnapshot, id: string): Promise<{ stopped: ServiceInstanceSnapshot; log: string | null; outOfFiles: boolean } | undefined> {
  try {
    const current = serviceInstanceStore(space).read(id);
    if (!current) return undefined;
    const plan = await prepareKernelServiceStop(definition, current);
    const { instance } = await stopProcessService(definition, current, undefined, undefined, { plan });
    if (observeServiceProcess(instance.record.value) === "running") return undefined;
    const log = readServiceLog(space, id, 200);
    return { stopped: instance, log: log.path, outOfFiles: log.lines.some((line) => /too many open files/i.test(line)) };
  } catch {
    return undefined;
  }
}

/** This space's broker log when its tail records that the broker ran out of open files, or null when
 *  that log has no path. Undefined when it records no such thing or cannot be read. */
function brokerOutOfFilesLog(space: string): string | null | undefined {
  try {
    const rows = serviceInstances(space, STACK_DEFINITION.broker);
    if (rows.length !== 1) return undefined;
    const log = readServiceLog(space, rows[0]!.name, 200);
    return log.lines.some((line) => /too many open files/i.test(line)) ? log.path : undefined;
  } catch {
    return undefined;
  }
}

/** The member table and evidence text a caller embeds in its own receipt. */
export function stackMembersView(journal: StackJournal, title: string): Report {
  return membersView(journal, title);
}

/** The notice a foreground `up` prints before it blocks. With `takeover`, the stack already runs, started
 *  by a background `up` or a foreground one that has exited, and this terminal takes its lifetime over. */
export function stackUpForegroundNotice(presentation: ReturnType<typeof presentationOf>, space: string, takeover = false): void {
  if (presentation === "json") return;
  const holds = takeover
    ? "This stack is already running, and this terminal now takes over its lifetime. Ctrl-C or SIGTERM here stops the whole stack, though another command started it, with the same guarded whole-stack stop as bare `cotal down`, including its manager impact review."
    : "This terminal holds the stack's lifetime. Ctrl-C or SIGTERM runs the same guarded whole-stack stop as bare `cotal down`, including its manager impact review.";
  console.log(renderReport({ space, sections: [{ title: "Foreground stack lifetime", blocks: [{ kind: "lines", lines: [`${holds} Terminal loss or an external kill is not a confirmed stop. A closed terminal leaves the stack running; \`cotal down\` stops it.`] }] }] }, presentation, process.stdout));
}
