/** Controller-owned whole-stack startup: broker first, then native stream setup, the auth service
 *  for a user stack, the delivery credential and delivery, then the manager. An open stack has no
 *  delivery member and mints no credential: its broker serves the prepared open configuration and
 *  its manager reports through the child's own local receipt. A user stack's manager needs the
 *  invoking user's existing login and grant; without it the manager is not attempted and the result
 *  is a known `AUTH_REQUIRED` partial. Every member is a saved root-bound definition and an
 *  exact service-controller instance. Trust and the broker configuration are prepared explicitly
 *  here, outside any adapter plan. A failure after the first effect is reported as partial or
 *  unknown with the members it changed; nothing already started is rolled back. */
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { basename, join, resolve } from "node:path";
import { JetStreamApiCodes, JetStreamApiError } from "@nats-io/jetstream";
import { awaitDeadDeliveryLease, deliveryLeaseHolderFor, describeChatHistory, formatChatAge, isJetStreamMissing, isReachable, LEASE_TTL_MS, mintCreds, newIdentity, openPrivateAppend, type BrokerTransport, type ChatHistoryChange, type ParsedArgs } from "@cotal-ai/core";
import {
  CommandFailure,
  accountInventory,
  authDir,
  canonicalRoot,
  codeSpan,
  deliveryCredsKey,
  findMesh,
  findPreparedSpace,
  getCurrent,
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
  MIN_FILE_STORE,
  type MaintenanceLock,
  type OutputWarning,
  type Report,
  type ServiceDefinitionInput,
  type UserAuthInfo,
  unparsableDaemonCreds,
  loopbackListeners,
  readProcessCommand,
  resolveMeshTarget,
  processStopped,
} from "@cotal-ai/workspace";
import { liveMeshProcesses } from "./clean.js";
import { addressHolder, brokerListenAddress, listenerBindError } from "../lib/broker-service.js";
import { brokerStoreWrite, jetStreamDisabled, jetStreamDisabledRefusal, readStoredBytes, storeDamageNotice, storeFull } from "../lib/broker-store-health.js";
import { shellWord } from "../lib/endpoint-errors.js";
import { seedDefaultPersona } from "../lib/default-persona.js";
import { noManagerCredentialWarning } from "../lib/daemon-credential-warning.js";
import { definitionListeners, exposedPlaintext, listenerRow, type StackListener } from "../lib/stack-listeners.js";
import { definitionRootMatch, serviceDefinitionStore, validateServiceDefinition, type ServiceDefinitionSnapshot } from "../lib/service-definitions.js";
import { instanceProjection, observeServiceProcess, serviceInstances, serviceInstanceStore, serviceRecordsWriteProblem, type ServiceInstance, type ServiceInstanceSnapshot } from "../lib/service-instances.js";
import { prepareKernelServiceStop, prepareProcessService, readServiceLog, removeStoppedInstanceRecords, settleExitedInstances, startProcessService, stopProcessService } from "../lib/service-process.js";
import { listLedgerFiles } from "../lib/manifest/ledger.js";
import { listAdditiveTeamAttempts, retainedAdditiveTeamAttempts, type AdditiveTeamAttempt } from "../lib/team-additive-attempt.js";
import { freshTeamAttemptSettled, listFreshTeamAttempts, listFreshTeamSummaries } from "../lib/team-fresh.js";
import { foreignLocalProcesses, newStackOperation, readStackJournal, runningStackRoles, serviceHeldRecords, settleRetainedStackStops, settleStackOperation, STACK_ADAPTER, STACK_DEFINITION, STACK_ROLES, stackDefinitionsAt, stackMaintenanceFence, stackNeverStarted, stackOperationUnsettled, stackRoleApplies, stackSettlementNotice, withSettledMembers, writeStackJournal, type StackJournal, type StackJournalSnapshot, type StackMember, type StackMode, type StackRole, type StackSettlement } from "../lib/stack-journal.js";
import { natsServerLabel, type NatsServer } from "../lib/nats-bin.js";
import { missingStoreWarning, sharedStoreAtStart, sharedStoreWarning, type StoreTenant } from "../lib/store-dir.js";
import { assertManagerLogin, assertUserStackTransport, confirmUserAuthEndpoints, preflightUserStack, provisionalUserAuth, userRegistrationIncomplete, type StackUserPrepared } from "./stack-user-auth.js";

/** Callbacks into the native broker preparation that `up.ts` owns. They hold private authority
 *  material and are passed in, so this module never re-derives trust or a transport decision. */
export interface StackUpNative {
  /** `userAuth` asks the native `authSetup` user arm (`prepareServer`) and must return its private
   *  `user` material; any other mode must return none. */
  prepareBroker(opts: { transport: BrokerTransport; server: string; space: string; open: boolean; userAuth?: { idpUrl?: string }; host?: string; storeDir?: string; existingStore?: ExistingStorePin; maxFileStore?: number; logFile?: string; logfileSizeLimit?: number; logfileMaxNum?: number; authTimeout?: number; maxPayload?: number; channels?: string; seed?: unknown }): Promise<{ root: string; server: string; space: string; storeDir: string; transport: BrokerTransport; setup?: { creds: string; wsPort: number }; user?: StackUserPrepared; confPath: string; bin: string; source: "path" | "bundled"; version: string | null; seedFile?: unknown; authTimeout?: number; maxPayload?: number }>;
  /** `recreateIssuedStores` is the `--recreate-issued-stores` backup directory, for a fresh broker
   *  only. Returns the chat history limit it moved off the legacy pair, if it moved one. */
  initializeStreams(server: string, space: string, setup: { creds: string } | undefined, seedFile: unknown, recreateIssuedStores?: string): Promise<ChatHistoryChange | undefined>;
  /** On a broker the stack reuses, create the space's streams again when every one of them is gone,
   *  as after `cotal space delete`, and say whether it did. */
  recreateDeletedStreams(opts: { root: string; space: string; server: string; mode: StackMode; channels?: string; seed?: unknown }): Promise<boolean>;
  recordMesh(entry: { space: string; server: string; root: string; mode: StackMode; tlsRequired: boolean; storeDir: string; userAuth?: UserAuthInfo; maxSessions?: number; attachHost?: string; maxFileStore?: number }): void;
  /** Record the transport, and the auth callout timeout and payload limit the prepared
   *  configuration rendered. */
  commitTransport(root: string, transport: BrokerTransport, limits?: { authTimeout?: number; maxPayload?: number }): void;
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
  maxSessions?: number;
  channels?: string;
  foreground: boolean;
  presentation: ReturnType<typeof presentationOf>;
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
    seed: unknown;
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
  /** The chat history limit this call's broker start moved off the legacy pair. */
  chatHistory?: ChatHistoryChange;
  /** The system-account rotation this call made before it prepared the broker. */
  rotation?: { generation: number; expiresAt: string | null };
  /** The recorded store, when another space also uses it. */
  storeShared?: { path: string; tenants: StoreTenant[] };
  /** The recorded store this call's broker started on, when it was missing and so started empty. */
  storeMissing?: string;
}

/** Inputs that name a legacy-only startup refuse on the controller route. They are not dropped. A
 *  recorded stack takes `rotate-sys` on a stopped start; a first start refuses it, because it mints
 *  the space's system account new. */
const CONTROLLER_UNSUPPORTED = ["file", "dry-run", "restore", "restore-only", "accept-missing-source", "accept-stale-checkpoint", "rotate-sys", "exchange-public-port", "exchange-public-url", "exchange-trusted-proxy", "advertised-server", "agent-provisioning-url", "tls-cert", "tls-key"] as const;

/** The inputs that ask for a TLS broker, which the controller stack does not serve: the certificate
 *  pair, and a `--server` that names a `tls://` address. */
const TLS_INPUTS: readonly string[] = ["tls-cert", "tls-key", "server tls://"];

const namesTlsServer = (values: ParsedArgs["values"]): boolean => typeof values.server === "string" && /^tls:\/\//i.test(values.server);

/** A `--server` broker URL as `up` records and compares it: the scheme in lower case, with no bare
 *  trailing `/`. Any other value comes back as given, for the address checks to refuse. */
export function canonicalServer(server: string): string {
  let url: URL;
  try { url = new URL(server); } catch { return server; }
  if ((url.protocol !== "nats:" && url.protocol !== "tls:") || url.username || url.password || url.search || url.hash || (url.pathname !== "" && url.pathname !== "/") || server.includes(",")) return server;
  return `${url.protocol}//${url.host}`;
}

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
  const manifest = prepared && options.every((name) => MANIFEST_ROUTE.includes(name));
  const rotation = prepared && options.includes("rotate-sys") ? "; a first start mints the space's $SYS creds, so there is nothing to rotate" : "";
  return new CommandFailure("refused", "UNSUPPORTED", `${prepared ? "this root is prepared for a controller-owned stack" : "this root's stack is owned by the service controller"}, which has no route for ${named}; nothing was started through the legacy launcher`, {
    target: { root, options },
    remedy: manifest && options.some((name) => TLS_INPUTS.includes(name))
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

/** The next step when an explicit mode is not the one a root's first whole-stack `up` recorded.
 *  Nothing converts a root's mode: `reset`, `clean` and `space forget` keep the stack journal that
 *  records it. So the step keeps that mode, or starts the requested one in another folder. */
function pinnedModeRemedy(recorded: StackMode, requested: StackMode): string {
  const flag = requested === "open" ? " --open" : requested === "user" ? " --user-auth" : "";
  return `run bare \`cotal up\` to keep ${MODE_NAME[recorded]} here, or for ${MODE_NAME[requested]} run \`cotal space create <space>\`, then \`cotal up${flag}\`, in another folder`;
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
    if (requested !== undefined && requested !== recorded.journal.mode) throw new CommandFailure("refused", "CONFLICT", `this root's controller stack is pinned to ${MODE_NAME[recorded.journal.mode]}; the requested mode does not convert it`, { target: { root: canonical, recorded: recorded.journal.mode, requested }, remedy: pinnedModeRemedy(recorded.journal.mode, requested) });
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

/** Returns a settled active restore of the recorded stack that was admitted, for the result to name. */
function stackPreflight(root: string, space: string, recorded: StackJournal | undefined, ownAttempt?: string): string | undefined {
  // Its members' own pidfiles would read as legacy processes under a Cotal home with no record of them.
  if (recorded && stackRunsUnderOtherHome(root, recorded)) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "this root's controller stack runs under another Cotal home; this one holds no record of its members, so nothing was started, adopted or replaced", { target: { root, space, cotalHome: homeCotalDir() }, remedy: stackHomeRemedy() });
  const maintenance: { fenced: boolean; admittedRestore?: string } = recorded ? stackMaintenanceFence(root, recorded) : { fenced: readMaintenanceJournal(root) !== undefined };
  if (maintenance.fenced) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "this root retains a maintenance or recovery attempt; the controller stack did not substitute an ordinary startup", { target: { root, space } });
  const legacy = foreignLocalProcesses(root, space);
  // A service of this space started at this root, such as a `manager` preset, writes its own record
  // here. It is named with the stop `down` names for it; the stack still neither adopts nor replaces it.
  const held = legacy.length && !existsSync(join(root, ".cotal", NATS_PIDFILE)) ? serviceHeldRecords(root, space) : [];
  if (held.length && held.length === legacy.length)
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `${held.map((row) => `the ${row.definition} service of this space runs this root's ${row.record.name} (pid ${row.record.pid}, instance ${row.instanceId})`).join("; ")}, outside the controller stack, which neither adopts nor replaces it`, {
      target: { root, space, processes: legacy, services: held.map((row) => ({ definition: row.definition, instanceId: row.instanceId })) },
      remedy: `stop ${held.length === 1 ? "it" : "each"} with ${held.map((row) => `\`cotal svc stop ${row.definition} --instance ${row.instanceId} --space ${space} --yes\``).join(", ")}, then run \`cotal up\` again`,
    });
  if (legacy.length || existsSync(join(root, ".cotal", NATS_PIDFILE))) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "legacy pidfile-owned processes or records remain under this root; the controller stack neither adopts nor replaces them", { target: { root, space, processes: legacy } });
  if (localMeshesForRoot(root).some((mesh) => mesh.space !== space)) throw new CommandFailure("refused", "CONFLICT", "another locally started space uses this root; a single-space controller stack cannot share its broker", { target: { root, space } });
  let ledgers, additive, boots, summaries;
  try { ledgers = listLedgerFiles(root, { requireReadable: true }); additive = listAdditiveTeamAttempts(root); boots = listFreshTeamAttempts(root); summaries = listFreshTeamSummaries(root); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "team records under this root could not be read; no empty team state was inferred", { target: { root, space } }); }
  const settled = new Map(summaries.valid.map((summary) => [summary.deploymentId, summary]));
  // A channel-only deployment that returned onto this recorded stack stays with it across a stop: its
  // cards are in this broker's store, so starting the stack again adopts nothing and its records stay
  // as they are. Any other retained deployment still blocks.
  const carried = (attempt: AdditiveTeamAttempt) => recorded !== undefined && attempt.requestedAgents.length === 0 && additive.returned.some((row) => row.deploymentId === attempt.deploymentId)
    && attempt.space === recorded.space && canonicalRoot(attempt.root) === canonicalRoot(root) && attempt.server === recorded.server && attempt.authMode === recorded.mode;
  const retained = retainedAdditiveTeamAttempts(additive).filter((attempt) => !carried(attempt));
  const unsettledBoots = boots.valid.filter((attempt) => attempt.deploymentId !== ownAttempt && !freshTeamAttemptSettled(attempt, settled.get(attempt.deploymentId)));
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
    store.commit(name, existing, undefined, () => removeStoppedInstanceRecords(space, name));
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
  return `selected "${space}": a command without --space targets it, except in another space's project folder`;
}

/** What `up` says when another selected space stays selected. */
export function keptOnUp(space: string, kept: string): string {
  return `"${space}" up; "${kept}" stays selected for commands run outside this folder - \`cotal use ${space}\` to switch`;
}

/** What `cotal up` says when its broker start moved a space's chat stream off the legacy history
 *  limit. It names the new policy; whether any post was old enough to be deleted is not read. */
export function chatHistoryMigratedNotice(space: string, change: ChatHistoryChange): string {
  return `the chat history limit of space ${space} moved from ${describeChatHistory(change.from)} to ${describeChatHistory(change.to)}; the broker now deletes posts older than ${formatChatAge(change.to.maxAgeMs)}`;
}

/** `cotal up`'s controller route: start, seed the default persona into the root, then write its
 *  own receipt, which names the saved services it does not start. The stack is up by then, so a
 *  persona that cannot be written, or saved services that cannot be listed, is a warning. */
export async function stackUp(request: StackUpRequest, native: StackUpNative): Promise<void> {
  const before = usableSelection();
  const { journal, changed, allReused, admittedRestore, settled, brokerExecutable, streamsRecreated, chatHistory, rotation, storeShared, storeMissing } = await startControllerStack(request, native);
  const { root, space, server, mode } = journal;
  const managed = journal.members.some((row) => row.role === "manager" && (row.state === "started" || row.state === "reused"));
  // The receipt says when the start selected its space, and when another space stays selected.
  const current = usableSelection();
  const keptCurrent = current !== space ? current : undefined;
  const selected = current === space && before !== space;
  const written: { what: string; path: string }[] = [];
  const warnings: OutputWarning[] = settled ? [{ code: "OPERATION_SETTLED", target: { root, space, operation: settled.operation.id }, message: stackSettlementNotice(settled) }] : [];
  if (chatHistory) warnings.push({ code: "CHAT_HISTORY_MIGRATED", target: { root, space, stream: chatHistory.stream }, message: chatHistoryMigratedNotice(space, chatHistory) });
  if (storeMissing) warnings.push({ code: "STORE_MISSING", target: { root, space, storeDir: storeMissing }, message: missingStoreWarning(storeMissing) });
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
  writeResult(request.presentation, { command: "up", target: { root, space, server }, result: { kind: "controller-stack-up", root, space, server, mode, operation: journal.operation, members: journal.members, changed, foreground: request.foreground, admittedRestore: admittedRestore ?? null, settledOperation: settled ?? null, brokerExecutable: brokerExecutable ?? null, streamsRecreated: streamsRecreated === true, rotatedSystemAccount: rotation ?? null, listeners: stackListeners(journal), written, savedServices, inheritedServices, selection: { current: current ?? null, changed: current === space && before !== space } }, warnings, ...(allReused && written.length === 0 && !streamsRecreated ? { noOp: true } : {}) }, (result) => {
    const members = membersView({ ...journal, members: result.members }, allReused ? "Controller stack already running" : "Controller stack started", result.brokerExecutable, result.streamsRecreated);
    const exposed = result.listeners && exposedPlaintext(result.listeners);
    const listening: Report["sections"] = [{ title: "Listeners", blocks: [
      result.listeners ? { kind: "fields", rows: result.listeners.map(listenerRow) } : { kind: "lines", lines: ["The broker's configuration could not be read, so its listeners are not listed."] },
      ...(exposed ? [{ kind: "lines" as const, lines: [{ text: exposed, tone: "waiting" as const }] }] : []),
    ] }];
    const view: Report = { ...members, sections: [...members.sections, ...listening, ...(result.written.length ? [{ blocks: [{ kind: "fields" as const, rows: result.written.map((w): [string, string] => ["wrote", `${w.what}: ${w.path}`]) }] }] : [])] };
    // `down` stops only the stack of the folder it runs in, so from another folder the Next says where.
    const elsewhere = request.invokedRoot !== undefined && request.invokedRoot !== canonicalRoot(root);
    const next: Report["sections"] = request.foreground ? [] : [{ title: "Next", blocks: [{ kind: "commands", items: [
      // A bare spawn targets the selected space, which this up does not change when one is set.
      managed ? { command: `cotal spawn --space ${space}`, description: "Launch your default agent" } : { command: elsewhere ? `cotal up --root ${root}` : "cotal up", description: "Add the manager to this stack" },
      { command: "cotal down", description: elsewhere ? `Stop every recorded member; run it from ${root}` : "Stop every recorded member" },
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

/** What holds a stopped stack's recorded broker address, as bare up's own bind check finds it, with
 *  the listening processes of this account named. Undefined while the address is free, could not be
 *  checked, or this stack's broker runs there. */
async function recordedAddressHeld(space: string, server: string): Promise<{ says: string; frees: string } | undefined> {
  const brokerRows = serviceInstances(space, STACK_DEFINITION.broker);
  if (brokerRows.length === 1 && observeServiceProcess(brokerRows[0]!.record.value) === "running") return undefined;
  const bindError = await listenerBindError(server);
  if (bindError === undefined || bindError === "timeout" || bindError.code !== "EADDRINUSE") return undefined;
  const { host, port } = brokerListenAddress(server);
  const held = addressHolder("that address", host, port);
  const holders = loopbackListeners(server).map((pid) => {
    const command = readProcessCommand(pid);
    return command.kind === "command" ? `${pid} (${basename(command.command.split(" ")[0]!)})` : String(pid);
  });
  return holders.length ? { says: `${held.says}, where process ${holders.join(", ")} of this account listens`, frees: held.frees } : held;
}

/** The broker's store over its recorded cap, read over an observer credential after a member failed
 *  to start. Every write is refused until there is room, a delivery daemon's lease included.
 *  Undefined while the store is under its cap, with no cap recorded, or when it cannot be read. */
async function storeFullAfterStart(root: string, space: string): Promise<ReturnType<typeof storeFull>> {
  let used: number | undefined;
  try { used = await readStoredBytes(resolveMeshTarget(root, { space, readOnly: true }), "up-diagnosis"); } catch { used = undefined; }
  return used === undefined ? undefined : storeFull(root, space, used);
}

/** The two ways out of a full store for an up whose member could not start: making room purges the
 *  space's channel history, and raising the cap keeps it but needs the broker restarted, so the
 *  manager's own process is ended first where it runs, as a full store refuses its stop. */
function fullStoreUpRemedy(root: string, space: string): string {
  const pid = serviceInstances(space, STACK_DEFINITION.manager).map((row) => row.record.value).find((value) => observeServiceProcess(value) === "running")?.process?.pid;
  return `from ${root}, make room with \`cotal history clear --yes\`, which purges all of this space's channel history, then run \`cotal up\` again; to keep that history, ${pid !== undefined ? `end the manager on this host with kill -TERM ${pid}, which stops its agents by its default policy, then ` : ""}run \`cotal down --yes\` and \`cotal up --max-file-store <bytes>\` with a larger cap`;
}

/** The running broker of an unregistered space: what an up stopped before registration leaves. */
function strandedBroker(space: string): ServiceInstance | undefined {
  if (findMesh(space)) return undefined;
  const rows = serviceInstances(space, STACK_DEFINITION.broker);
  return rows.length === 1 && observeServiceProcess(rows[0]!.record.value) === "running" ? rows[0]!.record.value : undefined;
}

/** What a detached up interrupted by a signal left: the members that run, and the command that
 *  finishes the start or stops them. An up given `--no-manager` names `cotal up --no-manager`, since
 *  bare `up` adds the manager. */
export function stackUpInterruptNotice(root: string, space: string, noManager = false): string {
  const up = `cotal up${noManager ? " --no-manager" : ""}`;
  const stranded = strandedBroker(space);
  if (stranded) return `Interrupted before the space was registered; its broker keeps running as pid ${stranded.process?.pid}. Run \`cotal down --yes\`, then \`${up}\`.`;
  const running = runningStackRoles(space);
  return running.length
    ? `Interrupted while starting the stack in ${root}; ${running.join(", ")} ${running.length === 1 ? "keeps" : "keep"} running. Run \`${up}\` to finish the start, or \`cotal down --yes\` to stop ${running.length === 1 ? "it" : "them"}.`
    : `Interrupted before any member of the stack in ${root} started. Run \`${up}\` to start it.`;
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
  if (unwritable) throw new CommandFailure("refused", "PERMISSION_DENIED", `this account cannot write ${unwritable}, where up records the stack's services; nothing was started or written`, { target: { root, space, path: unwritable }, remedy: `make it writable with chmod u+w ${unwritable}, then run \`cotal up\` again` });
  const recorded = readStackJournal(root);
  if (request.expectPriorDown && (!recorded || recorded.sha256 !== request.expectPriorDown.journalSha256 || recorded.journal.operation.id !== request.expectPriorDown.operationId))
    throw new CommandFailure("refused", "CONFLICT", "the stopped stack changed after the team boot checked it; nothing was started", { target: { root, space, expected: request.expectPriorDown.operationId } });
  // A stack none of whose members ever launched, such as one whose first up was refused at a busy
  // address, pins nothing: this up plans it as a first up from the request and only replaces its
  // journal file. Broker inputs an earlier attempt recorded stay the default for any it does not name.
  const unstarted = recorded !== undefined && stackNeverStarted(recorded.journal) ? recorded.journal : undefined;
  const previous = unstarted ? undefined : recorded;
  // A stopped stack's broker is prepared again from its own recorded inputs. An explicit request for
  // a different store, cap or bind host refuses; none is replaced by a default.
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
  const capReplaced = newCap && !serviceInstances(space, STACK_DEFINITION.broker).some((row) => observeServiceProcess(row.record.value) === "running");
  const recordedBroker = recordedInputs && { ...recordedInputs, ...(strayHost !== undefined ? { host: request.host } : {}), ...(capReplaced ? { maxFileStore: request.maxFileStore } : {}) };
  const changedInputs = recordedBroker ? [
    request.storeDir !== undefined && resolve(request.storeDir) !== recordedBroker.storeDir ? `--store-dir ${resolve(request.storeDir)} (recorded: ${recordedBroker.storeDir})` : undefined,
    request.maxFileStore !== undefined && request.maxFileStore !== recordedBroker.maxFileStore ? `--max-file-store ${request.maxFileStore} (recorded: ${recordedBroker.maxFileStore ?? "none"})` : undefined,
    request.host !== undefined && request.host !== recordedBroker.host ? `--host ${request.host} (recorded: ${recordedBroker.host ?? "none"})` : undefined,
    request.logFile !== undefined && resolve(request.logFile) !== recordedBroker.logFile ? `--log-file ${resolve(request.logFile)} (recorded: ${recordedBroker.logFile ?? "none"})` : undefined,
    request.logfileSizeLimit !== undefined && request.logfileSizeLimit !== recordedBroker.logfileSizeLimit ? `--logfile-size-limit ${request.logfileSizeLimit} (recorded: ${recordedBroker.logfileSizeLimit ?? "none"})` : undefined,
    request.logfileMaxNum !== undefined && request.logfileMaxNum !== recordedBroker.logfileMaxNum ? `--logfile-max-num ${request.logfileMaxNum} (recorded: ${recordedBroker.logfileMaxNum ?? "none"})` : undefined,
  ].filter((input) => input !== undefined) : [];
  if (changedInputs.length)
    throw new CommandFailure("refused", "CONFLICT", `${changedInputs.join(", ")} ${changedInputs.length === 1 ? "differs" : "differ"} from this stack's recorded broker inputs; nothing was prepared`, { target: { root, space, recorded: recordedBroker }, remedy: `run bare \`cotal up\` from ${root} to start it with its recorded inputs${newCap ? `; a new --max-file-store applies once the broker is stopped with \`cotal down --yes\`` : ""}` });
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
  const brokerStore = recordedBroker?.storeDir ?? request.storeDir ?? unstarted?.broker?.storeDir;
  const brokerCap = recordedBroker ? recordedBroker.maxFileStore : request.maxFileStore ?? unstarted?.broker?.maxFileStore;
  const brokerHost = recordedBroker ? recordedBroker.host : request.host ?? unstarted?.broker?.host;
  const brokerLogFile = recordedBroker ? recordedBroker.logFile : request.logFile ?? unstarted?.broker?.logFile;
  const brokerLogfileSizeLimit = recordedBroker ? recordedBroker.logfileSizeLimit : request.logfileSizeLimit ?? unstarted?.broker?.logfileSizeLimit;
  const brokerLogfileMaxNum = recordedBroker ? recordedBroker.logfileMaxNum : request.logfileMaxNum ?? unstarted?.broker?.logfileMaxNum;
  // The manager's session ceiling is kept by its saved definition, so a bare up starts it with the
  // ceiling an earlier up set rather than the default. An explicit --max-sessions replaces it.
  const savedManager = serviceDefinitionStore(space).read(STACK_DEFINITION.manager)?.record.value.launch;
  const savedSessions = savedManager?.type === "adapter" && savedManager.options.root === root ? savedManager.options["max-sessions"] : undefined;
  const maxSessions = request.maxSessions ?? (typeof savedSessions === "number" ? savedSessions : undefined);
  // The mode is pinned by the first whole-stack up. A conflicting explicit request refuses here,
  // before any preflight write, preparation or launch.
  if (previous && request.mode !== undefined && request.mode !== previous.journal.mode)
    throw new CommandFailure("refused", "CONFLICT", "this root's controller stack is pinned to another auth mode; a running or stopped stack is not converted", { target: { root, space, recorded: previous.journal.mode, requested: request.mode }, remedy: pinnedModeRemedy(previous.journal.mode, request.mode) });
  const mode: StackMode = previous?.journal.mode ?? request.mode ?? "auth";
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
    // An open stack renders the open broker configuration, which carries no payload limit.
    if (mode === "open") throw new CommandFailure("refused", "USAGE_INVALID", "--max-payload sets the broker's message size limit, which the open broker configuration does not render; nothing was prepared", { target: { root, space }, remedy: "drop --max-payload" });
    // A running broker keeps the limit it was started with, which the same record carries.
    const recordedPayload = readBrokerPolicy(root)?.maxPayload;
    if (request.maxPayload !== recordedPayload && brokerIsRunning())
      throw new CommandFailure("refused", "CONFLICT", `--max-payload ${request.maxPayload} differs from the running broker's (${recordedPayload === undefined ? "nats-server's default" : `${recordedPayload} bytes`}), which is fixed at its start; nothing was prepared`, { target: { root, space }, remedy: `stop the stack with \`cotal down --yes\` from ${root}, then run \`cotal up --max-payload ${request.maxPayload}\`` });
  }
  const admittedRestore = stackPreflight(root, space, previous?.journal, request.manifest?.deploymentId);
  // A recorded stack keeps its space and broker address. The refusal names what is recorded and the
  // bare up that starts it there.
  const recordedTarget = { root, space, recorded: { space: previous?.journal.space, server: previous?.journal.server }, requested: { space, server: request.server } };
  if (previous && previous.journal.space !== space)
    throw new CommandFailure("refused", "CONFLICT", `this root's controller stack is recorded for space ${previous.journal.space}, and this up asked for ${space}; it was not rebound`, { target: recordedTarget, remedy: `run bare \`cotal up\` from ${root} to start ${previous.journal.space}` });
  // No command moves a stack that ran to another address. While another program holds the recorded
  // one, bare up refuses too, so the refusal names that holder rather than sending the operator there.
  if (previous && canonicalServer(previous.journal.server) !== canonicalServer(request.server)) {
    const held = await recordedAddressHeld(space, previous.journal.server);
    throw new CommandFailure("refused", "CONFLICT", `this root's controller stack is recorded at ${previous.journal.server}, and this up asked for ${request.server}; a recorded stack is not moved to another address${held ? `, and ${held.says}` : ""}`, { target: recordedTarget, remedy: held ? `${held.frees}, then run bare \`cotal up\` from ${root}; no command moves a stack that ran to another address, so it starts only at ${previous.journal.server}` : `run bare \`cotal up\` from ${root} to start it at ${previous.journal.server}` });
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
  const storeMissing = recordedBroker !== undefined && !existsSync(storePath);
  // An up stopped after its broker served and before it registered the space leaves a broker whose
  // stream setup and registration only that up's own preparation could finish, and trust is never
  // prepared again under a running broker. This start refuses before any write and names the stop.
  const stranded = registration ? undefined : strandedBroker(space);
  if (stranded)
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `the stack's broker runs as pid ${stranded.process?.pid}, but the \`cotal up\` that started it stopped before it registered the space, so this up cannot finish that start; nothing was changed`, { target: { root, space, broker: stranded.instanceId, pid: stranded.process?.pid }, remedy: "stop that broker with `cotal down --yes`, then run `cotal up` again" });
  // A broker stopped by a signal accepts connections and never answers, so every step through it would
  // wait out its budget, and its readiness check would record a listener that serves nothing. This
  // start refuses before any write and names the signal that resumes it.
  const brokerPid = serviceInstances(space, STACK_DEFINITION.broker).map((row) => row.record.value).find((value) => observeServiceProcess(value) === "running")?.process?.pid;
  if (brokerPid !== undefined && processStopped(brokerPid))
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `the stack's broker, pid ${brokerPid}, is stopped, so it accepts connections at ${previous?.journal.server ?? request.server} and never answers; nothing was started or written`, { target: { root, space, pid: brokerPid }, remedy: `resume it with kill -CONT ${brokerPid} and run \`cotal up\` again` });
  // An earlier up or down that never recorded its outcome is settled from its members' process
  // evidence under the held maintenance lock. Only a preserve or resume can remain unsettled here.
  // A member stop an earlier down could not confirm in time is settled from its own receipt first.
  if (previous) await settleRetainedStackStops(previous.journal);
  const { snapshot: current, settled } = previous ? settleStackOperation(request.maintenanceLock, previous) : { snapshot: undefined, settled: undefined };
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
  // Check provider inputs before preparation or a journal write. A supplied IdP is always checked,
  // including a live refresh; only an unpinned first enable probes JWKS. Preparation checks again.
  if (mode === "user") {
    const brokerRows = serviceInstances(space, STACK_DEFINITION.broker);
    if (request.idp !== undefined || !(brokerRows.length === 1 && observeServiceProcess(brokerRows[0]!.record.value) === "running")) await preflightUserStack(root, space, request.idp);
  }
  const roles = STACK_ROLES.filter((role) => stackRoleApplies(mode, role) && !(role === "manager" && request.noManager));
  // A replacement an earlier `up` journaled is resolved from its own record before it is carried over.
  const recordedMembers = current ? withSettledMembers(current.journal, undefined).members : [];
  const members: StackMember[] = STACK_ROLES.map((role) => ({ role, definition: STACK_DEFINITION[role], instanceId: recordedMembers.find((row) => row.role === role)?.instanceId ?? null, state: roles.includes(role) ? "planned" : "not-attempted" }));
  let journal: StackJournal = { schemaVersion: 1, kind: "cotal-stack-controller", root, space, server, mode, ...(recordedBroker ? { broker: recordedBroker } : {}), members, operation: newStackOperation("up"), updatedAt: new Date().toISOString() };
  // The whole scoped plan is durable before the first effect. A crash after this reads as unsettled
  // until the next whole-stack operation settles it from its members' evidence.
  let snapshot: StackJournalSnapshot = writeStackJournal(root, current ?? recorded, journal);
  const changed: unknown[] = [];
  const settle = (phase: StackJournal["operation"]["phase"]) => {
    journal = { ...journal, operation: { ...journal.operation, phase }, updatedAt: new Date().toISOString() };
    snapshot = writeStackJournal(root, snapshot, journal);
  };
  const mark = (role: StackRole, change: Partial<StackMember>) => {
    journal = { ...journal, members: journal.members.map((row) => row.role === role ? { ...row, ...change } : row), updatedAt: new Date().toISOString() };
    snapshot = writeStackJournal(root, snapshot, journal);
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
    const started = await startProcessService(definition, replacement ? { replacement: { instanceId: replacement.instanceId, launchRequestId: replacement.launchRequestId } } : current[0] ? { instance: current[0].name } : {});
    mark(role, { instanceId: started.instance.name, state: started.noOp ? "reused" : "started", replacement: undefined });
    if (!started.noOp) changed.push(instanceProjection(started.instance));
    return started.instance;
  };
  settle("applying");
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
  let chatHistory: ChatHistoryChange | undefined;
  let launch: { path: string; sha256: string } | undefined;
  // Only a broker this call starts gets the space's streams created.
  let brokerReused = false;
  let rotation: StackUpResult["rotation"];
  try {
    // Broker. Trust and configuration are prepared only when this broker is not already serving
    // under its own recorded instance, never as an adapter planning step.
    const brokerRows = serviceInstances(space, STACK_DEFINITION.broker);
    const brokerRunning = brokerRows.length === 1 && observeServiceProcess(brokerRows[0]!.record.value) === "running";
    brokerReused = brokerRunning;
    if (!brokerRunning && await isReachable(server, { timeoutMs: 1500 })) {
      // Name the space this machine registered at the address. A first start can take another
      // address; a stack that ran keeps its recorded one, so whatever answers there must stop first.
      const holder = loadMeshes().find((mesh) => mesh.space !== space && mesh.server === server);
      const local = holder && (holder.origin === undefined || holder.origin === "up");
      const stopHolder = holder ? local ? `stop space ${holder.space} with \`cotal down\` from ${holder.root}` : `stop the broker of space ${holder.space}` : `stop what answers at ${server}`;
      const address = new URL(server);
      throw new CommandFailure("refused", "CONFLICT", `something already answers at the stack's broker address ${server}${holder ? `, where space ${holder.space} is registered` : ""}, without this stack's broker instance; it was not adopted or stopped`, {
        target: { root, space, server, ...(holder ? { registered: { space: holder.space, root: holder.root } } : {}) },
        remedy: previous === undefined
          ? `start this stack at another address with \`cotal up --server ${address.protocol}//${address.hostname}:<port>\` from ${root}, or ${stopHolder} and run \`cotal up\` again`
          : `${stopHolder}, then run bare \`cotal up\` from ${root}; this stack keeps its recorded address`,
      });
    }
    // A program that holds the address without answering NATS, such as a web server, is refused here
    // too, before any broker instance is recorded, so a first start names another address.
    const bindError = brokerRunning ? undefined : await listenerBindError(server);
    if (bindError !== undefined && bindError !== "timeout" && bindError.code === "EADDRINUSE") {
      const { host, port } = brokerListenAddress(server), address = new URL(server);
      const { says, frees } = addressHolder("the stack's broker address", host, port);
      throw new CommandFailure("refused", "CONFLICT", `${says} (bind failed: address already in use); no broker was launched`, {
        target: { root, space, server, bindError: bindError.code },
        remedy: previous === undefined
          ? `start this stack at another address with \`cotal up --server ${address.protocol}//${address.hostname}:<port>\` from ${root}, or ${frees} and run \`cotal up\` again`
          : `${frees}, then run bare \`cotal up\` from ${root}; this stack keeps its recorded address`,
      });
    }
    let prepared: Awaited<ReturnType<StackUpNative["prepareBroker"]>> | undefined;
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
      prepared = await native.prepareBroker({ transport: request.transport, server, space, open: mode === "open", ...(mode === "user" ? { userAuth: request.idp !== undefined ? { idpUrl: request.idp } : {} } : {}), ...(brokerHost ? { host: brokerHost } : {}), ...(brokerStore ? { storeDir: brokerStore } : {}), ...(storePin ? { existingStore: storePin } : {}), ...(brokerCap !== undefined ? { maxFileStore: brokerCap } : {}), ...(brokerLogFile !== undefined ? { logFile: brokerLogFile } : {}), ...(brokerLogfileSizeLimit !== undefined ? { logfileSizeLimit: brokerLogfileSizeLimit } : {}), ...(brokerLogfileMaxNum !== undefined ? { logfileMaxNum: brokerLogfileMaxNum } : {}), ...(request.authTimeout !== undefined ? { authTimeout: request.authTimeout } : {}), ...(request.maxPayload !== undefined ? { maxPayload: request.maxPayload } : {}), ...(request.manifest ? { seed: request.manifest.seed } : request.channels ? { channels: request.channels } : {}) });
      if (canonicalRoot(prepared.root) !== root || prepared.space !== space || prepared.server !== server || (prepared.setup === undefined) !== (mode === "open") || (prepared.user === undefined) !== (mode !== "user")) throw new CommandFailure("refused", "CONFLICT", "the prepared broker configuration names another root, space, address or auth mode; the stack did not continue");
      if (mode === "user") assertUserStackTransport(server, prepared.transport.kind === "tls-required");
      // The validated transport decision is recorded before the broker child starts, so its
      // listener-report check compares against the transport this configuration actually serves.
      native.commitTransport(root, prepared.transport, { authTimeout: prepared.authTimeout, maxPayload: prepared.maxPayload });
      journal = { ...journal, broker: { storeDir: resolve(prepared.storeDir), ...(brokerCap !== undefined ? { maxFileStore: brokerCap } : {}), ...(brokerHost ? { host: brokerHost } : {}), ...(brokerLogFile !== undefined ? { logFile: resolve(brokerLogFile) } : {}), ...(brokerLogfileSizeLimit !== undefined ? { logfileSizeLimit: brokerLogfileSizeLimit } : {}), ...(brokerLogfileMaxNum !== undefined ? { logfileMaxNum: brokerLogfileMaxNum } : {}) }, updatedAt: new Date().toISOString() };
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
    const brokerInstance = await start("broker", broker);
    if (brokerLogFile !== undefined) {
      let fd: number | undefined;
      try { fd = openPrivateAppend(resolve(brokerLogFile)); } finally { if (fd !== undefined) closeSync(fd); }
    }
    if (prepared) {
      startedBroker = { definition: broker, id: brokerInstance.name };
      // The broker's own stream and registry setup, on the native space path, after it serves.
      failedRole = "broker";
      failedStage = "broker-streams";
      chatHistory = await native.initializeStreams(server, space, prepared.setup, prepared.seedFile, request.recreateIssuedStores);
      failedStage = "broker-registration";
      // A user registration is recorded here, before its auth service exists, because the native
      // auth-service child resolves a registered user target. It carries only the prepared trust
      // pins and stays incomplete until that child's own readiness is confirmed below.
      native.recordMesh({ space, server, root, mode, tlsRequired: prepared.transport.kind === "tls-required", storeDir: prepared.storeDir, ...(prepared.user ? { userAuth: provisionalUserAuth(prepared.user) } : {}), ...(maxSessions !== undefined ? { maxSessions } : {}), ...(brokerHost ? { attachHost: brokerHost } : {}), ...(brokerCap !== undefined ? { maxFileStore: brokerCap } : {}) });
      failedStage = undefined;
      failedRole = undefined;
    } else if (mode !== "user") {
      // `cotal space delete` removes the streams from a broker that keeps running; it has no user-auth
      // route. When every one is gone they are created again here, as a broker start would, and a
      // partial loss is left alone.
      failedRole = "broker";
      streamsRecreated = await native.recreateDeletedStreams({ root, space, server, mode, ...(request.manifest ? { seed: request.manifest.seed } : request.channels ? { channels: request.channels } : {}) });
      failedRole = undefined;
    }
    // Auth service, user stacks only. Its native preparation came from this broker preparation, so
    // a stopped auth service under an already-running broker is not started from guessed material.
    if (mode === "user") {
      const authRows = serviceInstances(space, STACK_DEFINITION.auth);
      const authRunning = authRows.length === 1 && observeServiceProcess(authRows[0]!.record.value) === "running";
      if (!prepared?.user && !authRunning) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the user stack's auth service is stopped while its broker still runs; its native preparation runs only with a broker start, so it was not started from other material", { target: { root, space }, remedy: "stop the stack with bare `cotal down`, then run bare `cotal up`" });
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
    // Delivery. Its scoped native credential is minted into the root's own store key, the same
    // material the native daemon reads; the adapter is handed only that protected path. A user
    // stack uses the same hosting-root space signer as native `ensureDelivery` does on a user root.
    // An open stack has no delivery member, so no trust is read and no credential is minted.
    if (mode !== "open") {
      const store = workspaceSecretStore(root), auth = await getSpaceAuth(store, space);
      if (!auth) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the static space trust is missing; no delivery credential was minted from another signer", { target: { root, space } });
      const credsKey = deliveryCredsKey(space, { injected: false, root });
      const credsPath = join(root, ".cotal", credsKey);
      const deliveryRows = serviceInstances(space, STACK_DEFINITION.delivery);
      if (!(deliveryRows.length === 1 && observeServiceProcess(deliveryRows[0]!.record.value) === "running")) {
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
    // A user stack's manager is read as the invoking user's existing login, confirmed with its IdP
    // as `manager start` confirms it. Without a signed-in, granted login, or with one the IdP
    // rejects, it is not attempted; nothing is launched for it.
    if (!request.noManager && mode === "user") {
      try { await assertManagerLogin(root, space, "run bare `cotal up` again"); }
      catch (error) {
        if (!isCommandFailure(error) || error.code !== "AUTH_REQUIRED") throw error;
        loginBlock = error;
      }
    }
    if (!request.noManager && !loginBlock) {
      const options: Record<string, unknown> = { root, runtime: request.runtime, server };
      if (prepared?.setup?.wsPort !== undefined) options["ws-port"] = prepared.setup.wsPort;
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
      await start("manager", manager);
    }
    if (!loginBlock) settle("completed");
  } catch (caught) {
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
      const storeRemedy = `with at least ${MIN_FILE_STORE} bytes, the least the space's streams start on, plus room for messages`;
      throw new CommandFailure("failed", "OPERATION_FAILED", `the broker this command started could not create the space's streams${unserved.outOfFiles ? ", because it ran out of open files" : noStorage ? `, because its JetStream file store${brokerCap !== undefined ? ` cap (--max-file-store ${brokerCap})` : ""} has too little room for them` : ""}, so it was stopped again; nothing of the stack runs`, {
        target: { root, space, operation: journal.operation.id, members: journal.members, ...(unserved.log ? { brokerLog: unserved.log } : {}) },
        changed: [instanceProjection(unserved.stopped)],
        ...(nativeCause ? { native: nativeCause } : {}),
        remedy: unserved.outOfFiles
          ? `raise the open-file limit (ulimit -n) of the shell that runs \`cotal up\`, then run \`cotal up\` again from ${root}`
          : noStorage
            ? brokerCap !== undefined
              ? `run \`cotal up --max-file-store <bytes>\` from ${root} ${storeRemedy}`
              : `free space on the filesystem that holds ${brokerStore ?? join(root, ".cotal", "nats")}, or run \`cotal up --max-file-store <bytes>\` from ${root} ${storeRemedy}`
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
    throw new CommandFailure(outcome, uncertain ? "OPERATION_UNKNOWN" : changed.length ? "OPERATION_PARTIAL" : failure!.code, none ? `the controller stack started no member${cause}; nothing was retried` : `the controller stack did not start every planned member${cause}; started members were kept and nothing was retried`, { target: { root, space, operation: journal.operation.id, members: journal.members, ...(failedStage ? { stage: failedStage } : {}) }, changed, ...(nativeCause ? { native: nativeCause } : {}), remedy: starved !== undefined ? `stop the stack with \`cotal down --yes\` from ${root}, raise the open-file limit (ulimit -n) of the shell that runs \`cotal up\`, then run \`cotal up\` there again` : full ? fullStoreUpRemedy(root, space) : !uncertain && failure?.remedy ? failure.remedy : `inspect the stack's members with ${codeSpan(`cotal service --space ${shellWord(space)}`)} before another \`cotal up\`; a later bare \`cotal down\` stops only the recorded members` });
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
  return { journal, changed, allReused, ...(storeTenants.length ? { storeShared: { path: storePath, tenants: storeTenants } } : {}), ...(storeMissing && !brokerReused ? { storeMissing: storePath } : {}), ...(launch ? { launch } : {}), ...(admittedRestore ? { admittedRestore } : {}), ...(settled ? { settled } : {}), ...(brokerExecutable ? { brokerExecutable } : {}), ...(streamsRecreated ? { streamsRecreated: true as const } : {}), ...(chatHistory ? { chatHistory } : {}), ...(rotation ? { rotation } : {}) };
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
  console.log(renderReport({ space, sections: [{ title: "Foreground stack lifetime", blocks: [{ kind: "lines", lines: [`${holds} Terminal loss or an external kill is not a confirmed stop.`] }] }] }, presentation, process.stdout));
}
