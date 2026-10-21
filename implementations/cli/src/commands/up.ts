import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { homedir, hostname } from "node:os";
import {
  mkdirSync,
  readFileSync,
  existsSync,
  openSync,
  fstatSync,
  statSync,
  readSync,
  closeSync,
  lstatSync,
  realpathSync,
  readdirSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  isReachable,
  DEFAULT_SERVER,
  createSpaceAuth,
  serverConfig,
  openServerConfig,
  validateTlsMaterial,
  type BrokerTransport,
  mintCreds,
  mintLifecycleUid,
  DEV_OWNER,
  mintConnectionEvictorCreds,
  mintMembershipObserverCreds,
  newIdentity,
  setupSpaceStreams,
  reconcileSpaceTtls,
  ttlBuckets,
  standaloneConnectOpts,
  requireBrokerFloor,
  parseServerVersion,
  presenceBucket,
  seedChannelRegistry,
  ensureDefaultDeliveryClass,
  LEASE_TTL_MS,
  mkSecretDir,
  openPrivateAppend,
  realDirNoSymlink,
  writeSecretFile,
  type AuthPrepared,
  type SpaceAuth,
  type ChannelRegistryFile,
  type ParsedArgs,
  type FlagSpec,
  type CompletionResult,
} from "@cotal-ai/core";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager, StorageType } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  CommandFailure,
  commandFailureReport,
  isCommandFailure,
  jsonFlag,
  plainFlag,
  renderReport,
  terminalWidth,
  assertSingleSpaceBroker,
  assertUserAuthInfo,
  authDir,
  brokerAddressForDisplay,
  getSoleSpaceAuth,
  soleSpaceOf,
  getSpaceAuth,
  hasUserAuthState,
  listSpaceAccounts,
  preloadSpaceAccounts,
  putSpaceAuth,
  canonicalRoot,
  clearCurrent,
  findMesh,
  findPreparedSpace,
  homeCotalDir,
  getCurrent,
  loadMeshes,
  preparedSpaceAt,
  removePreparedSpace,
  localMeshesForRoot,
  oneLine,
  presentationOf,
  writeResult,
  type Report,
  connectionEvictorCredsKey,
  membershipConfigPath,
  membershipObserverCredsKey,
  membershipRwCredsKey,
  MEMBERSHIP_CONFIG_KIND,
  MEMBERSHIP_RW_CREDS_KIND,
  parsePositiveIntegerFlag,
  recordMesh,
  meshesForRoot,
  removeMesh,
  rotateSystemCreds,
  setCurrent,
  staleSystemCreds,
  SYSTEM_CREDS_FILES,
  userAuthStateDir,
  userAuthSpacesOnDisk,
  workspaceSecretStore,
  type MeshEntry,
  type UserAuthInfo,
  acquireMaintenanceLock,
  assertStoreIdentity,
  assessRestoreClaim,
  beginOrdinaryResume,
  bindOrdinaryResumeListener,
  consumeRetiredMaintenance,
  markOrdinaryResumeActive,
  markOrdinaryResumeDegraded,
  replaceDeadOrdinaryResumeListener,
  localProcessOwnerStatus,
  readMaintenanceJournal,
  readMaintenanceResumeDocument,
  seatCheckpointDir,
  readStoreIdentity,
  recordOrdinaryResumeManagerCommit,
  releaseMaintenanceLock,
  retireOrdinaryResume,
  settleTokenHandoff,
  sweepTokenHandoff,
  writeTokenHandoff,
  sameStoreIdentity,
  type JsonValue,
  type MaintenanceLock,
  type CommitIntentRecord,
  type MaintenanceReadyRecord,
  type RestoreActiveRecord,
  type RestoreDegradedRecord,
  type RestoreManagerCommittedRecord,
  cutController,
  type ManagerCommitEvidence,
  type ManagerFinalizeEvidence,
  type ProcessOwner,
  type RestoreListenerProof,
  type StoreIdentity,
  readBrokerPolicy,
  writeBrokerPolicy,
  removePidPair,
  writePidPair,
  isLoopbackHost,
  connectUserControlOrThrow,
  userViewAuth,
  recordOperationSpace,
} from "@cotal-ai/workspace";
import { ensureAuthService, resolveAuthProvider, stopAuthService } from "../lib/auth-proc.js";
import { resolveSpace } from "../lib/status.js";
import { c } from "../ui.js";
import { admitAndRestoreSeatCheckpoints, type StaleCheckpointConsent } from "../lib/seat-resume.js";
import { resolveNatsServer } from "../lib/nats-bin.js";
import { cotalPath, cotalRoot } from "../lib/paths.js";
import { renderDetachedSummary } from "../lib/up-report.js";
import { seedDefaultPersona } from "../lib/default-persona.js";
import { upSystemdSupervisionWarning } from "../lib/systemd-supervision.js";
import { deliveryStoppedByDown, deliveryUp, ensureControlPlane, ensureDelivery, stopDelivery } from "../lib/delivery-proc.js";
import { RESPONDER_UNBOUND_CONSEQUENCE } from "../lib/delivery-responder.js";
import { displayCmd } from "../lib/self-exec.js";
import { clearManagerArtifacts, liveManagerWouldApplyMaxSessions, managerHasDeliveryMarker, managerLogDisplayPath, managerRecordState, managerUp, stopManager } from "../lib/manager-proc.js";
import { loadManifest, type PreparedManifest } from "../lib/manifest/index.js";
import { buildLaunchSpec, genRunId, manifestToChannels, preflightConnectors, writeLaunchSpec } from "../lib/manifest/apply.js";
import { listLedgerFiles } from "../lib/manifest/ledger.js";
import { freshTeamAttemptSettled, listFreshTeamAttempts, listFreshTeamSummaries, writeFreshTeamAttempt, writeFreshTeamSummary } from "../lib/team-fresh.js";
import { listAdditiveTeamAttempts, retainedAdditiveTeamAttempts } from "../lib/team-additive-attempt.js";
import { renderUpPlan, renderInherited, renderWarnings } from "../lib/manifest/render.js";
import { idpUrlProblem, serverUrlProblems } from "../lib/manifest/resolve.js";
import { failManifest, refuseManifestSpaceMismatch } from "./topology.js";
import { liveMeshProcesses } from "./clean.js";
import { controllerStackApplies, recheckExistingStore, requestedStackMode, stackUp, stackUpForegroundNotice, type ExistingStorePin, type StackUpNative } from "./stack-up.js";
import { assertUserStackTransport, preflightUserStack } from "./stack-user-auth.js";
import { stackDown } from "./stack-down.js";
import {
  assertControllerCoupling, assertControllerMembersLive, assertControllerResumeEligible, beginControllerResume, bindControllerBroker, controllerAttemptBrokerInstance,
  currentControllerAttempt, managerResumeAttempt, relaunchCommittedManager, settleControllerResume, startControllerMember, startControllerMembers,
} from "../lib/controller-resume.js";
import { removeRetiredBrokerInstance } from "../lib/controller-restore.js";
import { acquireStackOperationLock, admittedStackRestore, readStackJournal, refuseControllerCut } from "../lib/stack-journal.js";
import { serviceInstances } from "../lib/service-instances.js";
import { serviceSupervisorStore } from "../lib/service-supervision.js";
import { serviceInstallIntents } from "../lib/service-install-intent.js";
import { serviceUninstallIntents } from "../lib/service-uninstall-intent.js";
import { serviceUnitActionStore } from "../lib/service-unit-action.js";
import { extensionNames, preflightRuntime } from "../ext-loader.js";
import { completingFlagValue } from "../lib/completion.js";
import { metadataPositionals } from "../lib/command-path.js";
import { askManager, type ControlAuth } from "../lib/control.js";
import {
  bindPreparedRestoreListener,
  isManagerCommitResult,
  isManagerFinalizeResult,
  isManagerCommittedRestore,
  markPreparedRestoreActive,
  markPreparedRestoreDegraded,
  heldRestoreAttempt,
  prepareRestore,
  recordPreparedRestoreManagerCommit,
  rehydratePreparedRestore,
  replacePreparedDeadRestoreListener,
  type PreparedRestore,
  type RestoreFlags,
} from "../lib/restore.js";

const pendingRestores = new Map<string, PreparedRestore>();

/** What a guarded restore returned, for `backup restore` to report as its own receipt. `up --restore`
 *  never sets a sink and its output is unchanged. Delivered only after the native activation wrote
 *  the active journal; every earlier failure still throws through the same restore guards. */
export interface RestoreStartupResult {
  attemptId: string;
  space: string;
  root: string;
  server: string;
  mode: PreparedRestore["mode"];
  selection: PreparedRestore["selection"];
  targetPath: string;
  runtime: string;
  brokerPid: number;
  delivery: boolean;
  authService: boolean;
  controlPlane: boolean;
  manager: boolean;
}
const restoreSinks = new Map<string, (result: RestoreStartupResult) => void>();

/** Run the guarded `up --restore` startup and return its result instead of printing it. The
 *  restore inputs and fences are exactly `up --restore`'s; this adds no route, flag or authority. */
export async function startRestore(values: { restore: string; "restore-only"?: string; "accept-missing-source"?: boolean; "store-dir"?: string }): Promise<RestoreStartupResult> {
  let returned: RestoreStartupResult | undefined;
  await up({ values: { ...values }, positionals: [], raw: [] }, undefined, false, (result) => { returned = result; });
  if (!returned) {
    const root = cotalRoot(), held = heldRestoreAttempt(root);
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the guarded restore returned without its activation result; the journal records its state and no step was repeated", { target: { root, ...(held ? { attemptId: held.attemptId, journalState: held.journalState } : {}) }, remedy: held?.remedy ?? "this root's maintenance journal names no restore attempt; check it with cotal status" });
  }
  return returned;
}
interface PendingOrdinaryResume {
  root: string;
  attemptId: string;
  space: string;
  mode: "open" | "auth" | "user";
  server: string;
  storeDir: string;
  /** The JetStream file storage cap the preserved launch recorded, re-rendered on resume. */
  maxFileStore?: number;
  runtime?: string;
  detached: boolean;
  inventory: JsonValue;
  journalState: "resume-intent" | "resume-active" | "resume-committed" | "resume-degraded";
  managerCommit?: ManagerCommitEvidence;
  serverName: string;
  serverNonce: string;
  /** Present when a live bound listener from a prior coordinator should be adopted, not respawned. */
  adoptProof?: RestoreListenerProof;
}
const pendingOrdinaryResumes = new Map<string, PendingOrdinaryResume>();

/** `cotal up` flags — colocated with the command (like `spawnFlags`) so its completion can read them. */
export const upFlags: FlagSpec[] = [
  { name: "server", type: "string", value: "<url>", description: "listen URL override" },
  { name: "host", type: "string", value: "<host>", description: "bind host override (an IP/hostname, not a URL; the URL is --server)" },
  { name: "space", type: "string", value: "<s>", description: "space name (default: the folder's)" },
  { name: "root", type: "string", value: "<dir>", description: "use this existing prepared local root instead of the current folder" },
  { name: "store-dir", type: "string", value: "<dir>", description: "JetStream store directory" },
  { name: "max-file-store", type: "string", value: "<bytes>", description: "JetStream file storage cap in bytes (default: nats-server's dynamic cap). Fixed at broker start; recorded and kept across `down --preserve-state`" },
  { name: "channels", type: "string", value: "<path>", description: "channel-registry seed file (JSON; default .cotal/channels.json)" },
  { name: "tls-cert", type: "string", value: "<file>", description: "serve the broker over TLS with this certificate (requires --tls-key)" },
  { name: "tls-key", type: "string", value: "<file>", description: "the private key for --tls-cert" },
  { name: "restore", type: "string", value: "<dir>", description: "restore an offline backup before exposing the normal listener" },
  { name: "restore-only", type: "string", value: "<registry>", description: "restore only the registry component" },
  { name: "accept-missing-source", type: "boolean", description: "explicit disaster consent when the inode-bound preserved source is absent" },
  { name: "accept-stale-checkpoint", type: "boolean", description: "explicit consent to resume a seat checkpoint captured outside its recorded recency horizon" },
  { name: "open", type: "boolean", description: "unauthenticated dev mesh (no JWT/ACLs)" },
  { name: "user-auth", type: "boolean", description: "per-USER auth: login + bearer through the space's auth service" },
  { name: "idp", type: "string", value: "<url>", description: "with --user-auth: the IdP auth base URL to pin (first enable)" },
  { name: "exchange-public-port", type: "string", value: "<n>", description: "with --user-auth: also serve the PUBLIC exchange face on this loopback port (TLS terminates at a reverse proxy)" },
  { name: "exchange-public-url", type: "string", value: "<https://…>", description: "with --exchange-public-port: the advertised public base URL (the reverse proxy's address)" },
  { name: "exchange-trusted-proxy", type: "boolean", description: "with --exchange-public-port: attribute peers by the last X-Forwarded-For hop (opt-in; default: socket address)" },
  { name: "advertised-server", type: "string", value: "<url>", description: "with --exchange-public-port: the broker address the public bundle advertises - what participants dial (default: --server)" },
  { name: "agent-provisioning-url", type: "string", value: "<https://…>", description: "with --exchange-public-port: the deployment's remote agent-provisioning endpoint the public bundle advertises" },
  { name: "rotate-sys", type: "boolean", description: "renew the expired/expiring $SYS creds by rotating the system account (agents, data and creds survive; needs a stopped mesh)" },
  { name: "detach", type: "boolean", description: "run in the background (the default; stop with cotal down)" },
  { name: "foreground", type: "boolean", description: "keep a non-manifest native stack in this terminal; -f currently refuses" },
  { name: "runtime", type: "string", value: "<name>", description: "agent runtime for the mesh manager (default pty; extension runtimes are explicit-only, see `cotal runtimes`); with -f overrides the manifest's runtime" },
  { name: "max-sessions", type: "string", value: "<n>", description: "live-session ceiling for the mesh manager (default 64; one session per console pane, so size for agents × panes). Recorded and reused by later manager launches" },
  { name: "no-manager", type: "boolean", description: "broker-only boot: start the broker and, in auth mode, the delivery daemon, and no local manager (refuses on a mesh whose manager is live)" },
  { name: "file", type: "string", short: "f", value: "<cotal.yaml>", description: "launch a whole mesh from a manifest" },
  { name: "dry-run", type: "boolean", description: "with -f: print the plan, mutate nothing" },
  { ...jsonFlag, description: "controller-owned stack only: one structured receipt on stdout" },
  { ...plainFlag, description: "controller-owned stack only: plain line-oriented receipt" },
];

/** Completion for `cotal up` — `--runtime <TAB>` offers `pty` + installed runtime providers (the same
 *  offline source `spawn` uses; a <TAB> never imports or probes). Run `cotal runtimes` to also see the
 *  official ones that aren't installed yet. Declared flags are offered only while options remain open. */
export function upComplete(argv: string[]): CompletionResult {
  if (metadataPositionals({ flags: upFlags }, argv, { completing: true }).optionsEnded) return { items: [], directive: "nofiles" };
  const flag = completingFlagValue(argv, upFlags);
  if (flag?.name === "runtime")
    return { items: ["pty", ...extensionNames("runtime")].filter((v, i, a) => a.indexOf(v) === i).map((value) => ({ value })), directive: "nofiles" };
  if (flag?.name === "restore-only")
    return { items: [{ value: "registry" }], directive: "nofiles" };
  if (flag && ["root", "restore", "file", "channels", "tls-cert", "tls-key", "store-dir"].includes(flag.name)) return { items: [], directive: "default" };
  if (flag) return { items: [], directive: "nofiles" };
  const items = upFlags.map((f) => ({ value: `--${f.name}`, description: f.description }));
  return { items, directive: items.length ? "nofiles" : "default" };
}

/** Launch intent is checked by the kernel before seed or effect preparation. A recovery
 *  re-entry supplies its recorded mode explicitly rather than inheriting the new public default. */
export function validateUpArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  if (args.values["user-auth"] === true && args.values.open === true)
    throw new CommandFailure("refused", "USAGE_INVALID", "--user-auth and --open contradict - a user-auth space cannot run unauthenticated", { remedy: "drop --open for user auth, or drop --user-auth for an open space" });
  if (args.values.idp !== undefined && args.values["user-auth"] !== true && !args.values.file)
    throw new CommandFailure("refused", "USAGE_INVALID", '--idp is for user-auth spaces; pair it with --user-auth, or set broker.auth: "user" in a manifest', { remedy: "use --user-auth --idp <auth base URL>, without --open" });
  if (args.values["no-manager"] === true && args.values.runtime !== undefined)
    throw new CommandFailure("refused", "USAGE_INVALID", "--no-manager cannot be combined with --runtime because no manager starts", { remedy: "drop --runtime, or drop --no-manager to select a manager runtime" });
  if (args.values["no-manager"] === true && args.values["max-sessions"] !== undefined)
    throw new CommandFailure("refused", "USAGE_INVALID", "--no-manager cannot be combined with --max-sessions because no manager starts", { remedy: "drop --max-sessions, or drop --no-manager to set the manager session ceiling" });
  if (args.values.foreground === true && args.values.detach === true) throw new CommandFailure("refused", "USAGE_INVALID", "choose --foreground or --detach, not both");
  // A manifest boot checks its own `--server` override against `broker.servers`.
  const serverProblem = args.values.server !== undefined && !args.values.file ? upServerProblem(String(args.values.server)) : undefined;
  if (serverProblem) throw new CommandFailure("refused", "USAGE_INVALID", `${serverProblem}; nothing was started or written`, { remedy: "pass the address the local broker listens on, for example --server nats://127.0.0.1:4222" });
  if (args.values.file !== undefined && args.values.foreground === true) throw new CommandFailure("refused", "UNSUPPORTED", "manifest boot has no native foreground custody path; a detached broker was not substituted for the requested terminal-bound lifetime");
  if (args.values.foreground === true && (args.values.json === true || args.values.plain === true)) throw new CommandFailure("refused", "USAGE_INVALID", "foreground up keeps native terminal custody and cannot produce a finite JSON or plain receipt");
  // Flag values and combinations are usage, so they refuse here, before any effect. The run keeps
  // its own checks for maintenance re-entries, which do not pass through this validation.
  parsePositiveIntegerFlag("--max-sessions", args.values["max-sessions"] as string | undefined);
  parsePositiveIntegerFlag("--max-file-store", args.values["max-file-store"] as string | undefined);
  const restoreOnly = args.values["restore-only"];
  if (restoreOnly !== undefined && restoreOnly !== "registry") throw new CommandFailure("refused", "USAGE_INVALID", `--restore-only takes registry (got ${JSON.stringify(restoreOnly)})`);
  if (!args.values.restore && (restoreOnly !== undefined || args.values["accept-missing-source"] === true)) throw new CommandFailure("refused", "USAGE_INVALID", "--restore-only and --accept-missing-source require --restore <dir>");
  if (args.values.restore && (args.values.file !== undefined || args.values.channels !== undefined)) throw new CommandFailure("refused", "USAGE_INVALID", "--restore cannot be combined with --file/-f or --channels");
  if (args.values.restore && args.values["rotate-sys"] === true) throw new CommandFailure("refused", "USAGE_INVALID", "--restore cannot be combined with --rotate-sys", { remedy: "restore the space and verify it first, then rotate: cotal down, then cotal up --rotate-sys" });
  if (args.values.root !== undefined) preparedUpRoot(String(args.values.root));
  else {
    const inheritedRoot = inheritedMachineHomeRoot();
    if (inheritedRoot && !(args.values.file && args.values["dry-run"] === true))
      throw new CommandFailure("refused", "CONFLICT", "this folder inherits the machine's home .cotal; up did not start a stack in that home root", { target: { root: process.cwd(), inheritedRoot }, remedy: "prepare this folder with cotal space create <space> --root ., then use cotal up --root .; to start the home stack, run up from home itself" });
  }
  if (args.values.restore !== undefined) refuseControllerCut(args.values.root !== undefined ? preparedUpRoot(String(args.values.root)) : cotalRoot(), "up --restore");
}

/** Why `--server` cannot be the address a local broker listens on, or undefined when it can. Both
 *  launch routes need one nats:// or tls:// URL with a host and a TCP port, and without this check
 *  a typo reached their first write. The message never repeats the value, which may carry a
 *  credential. */
function upServerProblem(server: string): string | undefined {
  let url: URL;
  try { url = new URL(server); } catch { return "--server is not a URL"; }
  if (url.protocol !== "nats:" && url.protocol !== "tls:") return "--server must be a nats:// or tls:// URL";
  if (url.username || url.password) return "--server must not embed credentials";
  if (url.search || url.hash || (url.pathname && url.pathname !== "/") || server.includes(",")) return "--server must be one broker URL without a path, query or fragment";
  if (!url.hostname) return "--server names no host";
  if (url.port === "0") return "--server needs a TCP port from 1 to 65535";
  return undefined;
}

function inheritedMachineHomeRoot(): string | undefined {
  const root = cotalRoot();
  const machineHome = canonicalRoot(root) === canonicalRoot(homedir()) || canonicalRoot(join(root, ".cotal")) === canonicalRoot(homeCotalDir());
  return machineHome && canonicalRoot(process.cwd()) !== canonicalRoot(root) ? root : undefined;
}

/** An explicit root is an existing local workspace, not a hint to find another ancestor or
 *  create trust in an arbitrary directory. Validation runs before the dispatcher seeds extensions. */
export function preparedUpRoot(value: string): string {
  if (!value) throw new CommandFailure("refused", "USAGE_INVALID", "--root needs an existing prepared project directory; an empty value is not the current folder");
  let root: string;
  try {
    root = realpathSync(resolve(value));
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
    const cotal = lstatSync(join(root, ".cotal"));
    if (!cotal.isDirectory() || cotal.isSymbolicLink()) throw new Error("not a private project directory");
  } catch {
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "--root must name an existing prepared local project with its own .cotal directory; no ancestor or other space was selected", { target: { root: resolve(value) }, remedy: "prepare it with cotal space create <space> --root <dir>, then retry with that root" });
  }
  if (canonicalRoot(root) === canonicalRoot(homedir()) || canonicalRoot(join(root, ".cotal")) === canonicalRoot(homeCotalDir()))
    throw new CommandFailure("refused", "CONFLICT", "--root names the machine's home store, not a prepared project; no stack was started there", { target: { root }, remedy: "prepare the space in a project folder with cotal space create <space> --root <dir>" });
  return root;
}

/** The fresh team entry refuses retained custody before `up -f` can write a launch spec,
 *  regenerate trust or stop a leftover manager. Only a recorded local root is eligible. */
function assertFreshTeamBootOwnership(root: string, space: string, mode?: "open" | "auth" | "user", own?: { deploymentId: string; server: string; manifestPath: string }): void {
  const current = findMesh(space), prepared = findPreparedSpace(space);
  if (!current && !prepared) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "fresh team boot needs a prepared local space; no checkout or machine-home root was guessed", { target: { root, space } });
  if (current && (current.origin !== "up" || canonicalRoot(current.root) !== canonicalRoot(root)) || prepared && canonicalRoot(prepared.root) !== canonicalRoot(root)) throw new CommandFailure("refused", "CONFLICT", "the selected space is externally registered or its prepared root moved; no fresh local boot was started", { target: { root, space } });
  if (current && mode && current.mode !== mode) throw new CommandFailure("refused", "CONFLICT", "the requested fresh boot changes the locally recorded authentication mode; no trust was replaced", { target: { root, space, recordedMode: current.mode, requestedMode: mode } });
  assertSingleSpaceBroker(authDir(root), "team boot");
  const accounts = listSpaceAccounts(authDir(root));
  if (mode === "open" && accounts.length) throw new CommandFailure("refused", "CONFLICT", "the selected root retains a broker account; an open team boot did not bypass its recorded authorization", { target: { root, space } });
  if (accounts.some((hosted) => hosted !== space)) throw new CommandFailure("refused", "CONFLICT", "the local broker root retains another space's account; team boot did not reassign that trust", { target: { root, space } });
  const userSpaces = userAuthSpacesOnDisk(authDir(root));
  if (mode === "user" && (userSpaces.some((hosted) => hosted !== space) || (accounts.includes(space) && !userSpaces.includes(space))))
    throw new CommandFailure("refused", "CONFLICT", "the selected root holds another user-auth space or static trust without matching user-auth state; team boot did not convert its identity", { target: { root, space } });
  if (mode && mode !== "user" && userSpaces.length) throw new CommandFailure("refused", "CONFLICT", "this root retains user-auth state; a static or open team boot did not re-mode its identity", { target: { root, space } });
  if (localMeshesForRoot(root).some((entry) => entry.space !== space)) throw new CommandFailure("refused", "CONFLICT", "another locally registered space uses this broker root; fresh team boot did not reuse or replace its stack", { target: { root, space } });
  if (readMaintenanceJournal(root)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "this root retains a recovery or maintenance attempt; team boot cannot substitute an ordinary startup", { target: { root, space } });
  const manager = managerRecordState(undefined, undefined, space, root);
  if (manager.state !== "absent") throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a manager record remains, including when its process appears dead; team boot will not stop or overwrite it", { target: { root, space, state: manager.state, path: manager.path }, remedy: "inspect the recorded manager and reconcile its own lifecycle before a fresh team boot" });
  const processes = liveMeshProcesses(root, space);
  if (processes.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a local component may still own this stack; team boot did not replace it", { target: { root, space, processes } });
  const instances = serviceInstances(space), supervisors = serviceSupervisorStore(space).list();
  if (instances.length || supervisors.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "service-controller instances or supervisor receipts remain for this space; their ownership was not replaced by fresh team boot", { target: { root, space, instances: instances.map((row) => row.name), supervisors: supervisors.map((row) => row.name) }, remedy: "inspect each service instance and its native supervisor before booting the whole stack" });
  const actions = serviceUnitActionStore(space).list();
  if (actions.some((row) => row.name !== row.record.value.instanceId))
    throw new CommandFailure("refused", "SCHEMA_INVALID", "a retained native action filename differs from its full instance ID; no fresh boot ownership was inferred", { target: { root, space } });
  const attempts = [
    ...serviceInstallIntents(space).map((row) => ({ kind: "install", instanceId: row.name, attemptId: row.record.value.attemptId })),
    ...serviceUninstallIntents(space).map((row) => ({ kind: "uninstall", instanceId: row.name, attemptId: row.record.value.attemptId })),
    ...actions.map((row) => ({ kind: "unit-action", instanceId: row.name, attemptId: row.record.value.attemptId })),
  ];
  if (attempts.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "native service attempts remain for this space; a submitted step may have changed state, so fresh team boot did not replace their custody", { target: { root, space, attempts }, remedy: "inspect and reconcile each retained attempt on its original service instance before fresh boot" });
  let ledgers: ReturnType<typeof listLedgerFiles>;
  try { ledgers = listLedgerFiles(root, { requireReadable: true }); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the root's additive ledger directory could not be inspected; no absence of prior owned resources was inferred", { target: { root, space } }); }
  if (ledgers.valid.length || ledgers.refused.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "additive ownership ledgers or unreadable ledger records remain under this root; fresh team boot did not adopt or erase them", { target: { root, space, deploymentIds: ledgers.valid.map(({ ledger }) => ledger.runId), unreadable: ledgers.refused.map(({ path }) => path) }, remedy: "inspect and finish each additive deployment's own lifecycle before a fresh team boot" });
  let additiveAttempts: ReturnType<typeof listAdditiveTeamAttempts>;
  try { additiveAttempts = listAdditiveTeamAttempts(root); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the root's additive attempt inventory could not be read; fresh boot did not assume it was empty", { target: { root, space } }); }
  if (retainedAdditiveTeamAttempts(additiveAttempts).length || additiveAttempts.refused.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "an additive deployment attempt remains under this root; its native outcome was not adopted as whole-stack ownership", { target: { root, space, deploymentIds: retainedAdditiveTeamAttempts(additiveAttempts).map((attempt) => attempt.deploymentId), unreadable: additiveAttempts.refused.map(({ path }) => path) } });
  let bootAttempts: ReturnType<typeof listFreshTeamAttempts>, summaries: ReturnType<typeof listFreshTeamSummaries>;
  try { bootAttempts = listFreshTeamAttempts(root); summaries = listFreshTeamSummaries(root); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "fresh boot attempt or summary records could not be read; no earlier startup was assumed settled", { target: { root, space } }); }
  const byId = new Map(summaries.valid.map((summary) => [summary.deploymentId, summary]));
  const ownAttempt = own && bootAttempts.valid.find((attempt) => attempt.deploymentId === own.deploymentId);
  if (own && (!ownAttempt || ownAttempt.space !== space || ownAttempt.root !== root || ownAttempt.server !== own.server || ownAttempt.manifestPath !== own.manifestPath || ownAttempt.authMode !== mode || byId.has(own.deploymentId)))
    throw new CommandFailure("refused", "CONFLICT", "this fresh boot's own intent changed or acquired a summary during preparation; no launch spec was written", { target: { root, space, deploymentId: own.deploymentId } });
  const unsettled = bootAttempts.valid.filter((attempt) => attempt.deploymentId !== own?.deploymentId && !freshTeamAttemptSettled(attempt, byId.get(attempt.deploymentId)));
  if (bootAttempts.refused.length || summaries.refused.length || unsettled.length)
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a prior fresh boot attempt lacks a matching readable summary, or an attempt/summary is unreadable; its outcome was not treated as absent", { target: { root, space, unsettledIds: unsettled.map((attempt) => attempt.deploymentId), unreadable: [...bootAttempts.refused, ...summaries.refused].map(({ path }) => path) }, remedy: "inspect each full boot attempt and its original listener before another fresh start; do not retry an unknown boot" });
}

/** Foreground controller stack: the terminal holds the stack's lifetime until SIGINT or SIGTERM,
 *  which runs the same guarded whole-stack stop as bare `down`, acknowledged by the signal. A failed
 *  or unknown stop is reported with its retained members; nothing is force-killed. */
export function holdForegroundStack(root: string): Promise<void> {
  return new Promise<void>((resolveHold) => {
    // The hold ends on its own when another command completes a whole-stack stop or preserve of this
    // root: a later operation recorded as completed is that evidence. Any other later operation,
    // such as a refresh, keeps the hold. The poll also keeps Node alive, which a pending promise and
    // signal listeners alone do not.
    const recorded = () => { try { return readStackJournal(root)?.journal.operation; } catch { return undefined; } };
    const held = recorded()?.id;
    let stopping = false;
    const lifetime = setInterval(() => {
      const operation = recorded();
      if (stopping || !operation || operation.id === held || operation.phase !== "completed" || operation.kind !== "down" && operation.kind !== "preserve") return;
      stopping = true;
      process.off("SIGINT", interrupt); process.off("SIGTERM", terminate);
      clearInterval(lifetime);
      process.stderr.write(`${renderReport({ sections: [{ title: "Foreground stack released", blocks: [{ kind: "lines", lines: [`Another command completed a ${operation.kind === "down" ? "stop" : "preserve"} of this stack (operation ${operation.id}). This terminal no longer holds it.`] }] }] }, "rich", terminalWidth(process.stderr))}\n`);
      resolveHold();
    }, 1000);
    const stop = (signal: "SIGINT" | "SIGTERM") => {
      if (stopping) return;
      stopping = true;
      process.off("SIGINT", interrupt); process.off("SIGTERM", terminate);
      clearInterval(lifetime);
      void stackDown(root, { yes: true }).catch((error) => {
        process.stderr.write(`${renderReport(commandFailureReport(isCommandFailure(error) ? error : new CommandFailure("unknown", "OPERATION_UNKNOWN", "the foreground stack stop did not confirm its outcome; its members were retained")), "rich", terminalWidth(process.stderr))}\n`);
      }).finally(() => { process.exitCode = signal === "SIGINT" ? 130 : 143; resolveHold(); });
    };
    const interrupt = () => stop("SIGINT");
    const terminate = () => stop("SIGTERM");
    process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  });
}

/** The registered `up` command. When a background run is the main process of a systemd unit, it
 *  names that unit and the `--foreground` remedy once startup returns: controller stack, retained
 *  launcher, refresh and restore alike. It never changes the run's mode. Internal callers of
 *  {@link up} print nothing. */
export async function upCommand(args: ParsedArgs): Promise<void> {
  await up(args);
  const warning = upSystemdSupervisionWarning(args.values);
  if (warning) console.error(c.yellow(warning));
}

/** `inheritedLock` is the root maintenance lock a recovery re-entry hands down (see the re-entry
 *  below). Ownership transfers with it: this call releases it at its own release point. */
export async function up(args: ParsedArgs, inheritedLock?: MaintenanceLock, freshTeamBoot = false, restoreSink?: (result: RestoreStartupResult) => void): Promise<void> {
  // A re-entry owns its inherited lock even if mode validation refuses before runUp adopts it.
  let adopted = false;
  try {
    validateUpArguments(args);
    const root = args.values.root === undefined ? undefined : preparedUpRoot(String(args.values.root));
    const previousCwd = process.cwd();
    // Path flags still mean paths relative to the invoking directory, not the selected root.
    // The recursive restore/resume re-entries inherit absolute paths and the same absolute root.
    const paths = root ? Object.fromEntries(["file", "restore", "channels", "tls-cert", "tls-key", "store-dir"].filter((key) => typeof args.values[key] === "string" && args.values[key] !== "").map((key) => [key, resolve(String(args.values[key]))])) : {};
    const invocation: ParsedArgs = { ...args, values: { ...args.values, ...paths, ...(root ? { root } : {}), detach: args.values.foreground !== true } };
    if (root) {
      try { process.chdir(root); }
      catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the prepared --root became inaccessible before startup; no alternate directory was selected", { target: { root } }); }
      // A root replaced with an inherited/symlinked store between validation and the effect
      // must refuse. No implicit walk toward ~/.cotal is permitted for explicit targeting.
      try {
        const record = lstatSync(join(root, ".cotal"));
        if (!record.isDirectory() || record.isSymbolicLink() || canonicalRoot(cotalRoot()) !== canonicalRoot(root)) throw new Error("changed root");
      } catch {
        process.chdir(previousCwd);
        throw new CommandFailure("refused", "CONFLICT", "the selected --root changed before startup; no inherited workspace was used", { target: { root } });
      }
    }
    try { return await runUp(invocation, inheritedLock, () => { adopted = true; }, freshTeamBoot, restoreSink); }
    finally { if (root) process.chdir(previousCwd); }
  } finally {
    if (inheritedLock && !adopted) releaseMaintenanceLock(inheritedLock);
  }
}

const NO_MANAGER_DURING_RECOVERY = "--no-manager is refused while this root has a maintenance attempt to recover - a resume needs a manager to commit the preserved inventory; recover it (`cotal up` alone) or roll it back first";

async function runUp(args: ParsedArgs, inheritedLock?: MaintenanceLock, onAdopt?: () => void, freshTeamBoot = false, restoreSink?: (result: RestoreStartupResult) => void): Promise<void> {
  const values = args.values as {
    server?: string; "store-dir"?: string; "max-file-store"?: string; space?: string; root?: string; open?: boolean; "user-auth"?: boolean; idp?: string;
    "exchange-public-port"?: string; "exchange-public-url"?: string; "exchange-trusted-proxy"?: boolean; "advertised-server"?: string; "agent-provisioning-url"?: string;
    channels?: string; detach?: boolean; foreground?: boolean; host?: string; runtime?: string; file?: string; "dry-run"?: boolean;
    restore?: string; "restore-only"?: string; "accept-missing-source"?: boolean; "rotate-sys"?: boolean;
    "accept-stale-checkpoint"?: boolean;
    "tls-cert"?: string; "tls-key"?: string;
    "max-sessions"?: string;
    "no-manager"?: boolean;
    json?: boolean; plain?: boolean;
    __restoreAttempt?: string;
    __ordinaryResumeAttempt?: string;
  };
  if (freshTeamBoot && (!values.file || values.restore || values.__restoreAttempt || values.__ordinaryResumeAttempt || values["rotate-sys"] || values["no-manager"])) throw new CommandFailure("refused", "USAGE_INVALID", "fresh team boot accepts one manifest and its selected lifetime, not a restore, rotation or manager-free override");
  if (values.restore) {
    if (values.file || values.channels)
      throw new Error("--restore cannot be combined with --file/-f or --channels");
    // A restore REINSTATES a trust root from an artifact; a rotation SUPERSEDES the one on disk.
    // Together they would restore a system account and retire it in the same command, leaving the
    // operator unable to say which authority the mesh actually came up on, and the artifact's own
    // $SYS creds overwritten by the rotation before anyone verified the restore. Restore, verify,
    // then rotate as its own deliberate step.
    if (values["rotate-sys"])
      throw new Error("--restore cannot be combined with --rotate-sys - restore the space and verify it first, then rotate: `cotal down` then `cotal up --rotate-sys`");
    // A restore rewrites the shared store and the trust root under it, from an artifact that names
    // one space (see `cotal backup`) - it cannot leave the root's other tenants standing.
    assertSingleSpaceBroker(authDir(cotalRoot()), "cotal up --restore");
    // A `backup restore` owns stdout for its receipt, so its seat admission lines go to stderr.
    const prepared = await prepareRestore(cotalRoot(), values as RestoreFlags, restoreSink ? (line) => console.error(line) : undefined);
    pendingRestores.set(prepared.attemptId, prepared);
    const committed = readMaintenanceJournal(prepared.root);
    if (committed && cutController(committed.cut)) {
      // A controller restore continues through its recorded members. A member
      // that cannot start holds the attempt at commit intent for bare `cotal up` to continue; it is
      // not marked degraded, because a degraded attempt starts nothing.
      const lock = acquireMaintenanceLock(prepared.root);
      let foreground: boolean;
      try { foreground = await resumeControllerStack(lock, prepared.root, values, restoreSink); }
      finally {
        pendingRestores.delete(prepared.attemptId);
        releaseMaintenanceLock(lock);
      }
      if (foreground) await holdForegroundStack(prepared.root);
      return;
    }
    if (restoreSink) restoreSinks.set(prepared.attemptId, restoreSink);
    const next = {
      ...values,
      restore: undefined,
      "restore-only": undefined,
      "accept-missing-source": undefined,
      __restoreAttempt: prepared.attemptId,
      space: values.space ?? prepared.space,
      server: values.server ?? prepared.server,
      host: values.host ?? prepared.host,
      runtime: values.runtime ?? prepared.runtime,
      open: prepared.mode === "open",
      "user-auth": prepared.mode === "user",
    };
    try {
      await up({ ...args, values: next });
    } catch (error) {
      pendingRestores.delete(prepared.attemptId);
      restoreSinks.delete(prepared.attemptId);
      // The one journal writer deliberately NOT handed a lock, and the reason is structural rather
      // than stylistic: no lock is held in this frame either way. This invocation returns just below
      // without ever reaching the `startupLock` acquire, and the re-entry that did hold one released
      // it in its own `finally` on the way out through this very throw. So the helper must take its
      // own — passing something here would mean passing `undefined`, which reads as an oversight.
      markPreparedRestoreDegraded(prepared.root, prepared.attemptId, (error as Error).message);
      throw error;
    }
    restoreSinks.delete(prepared.attemptId);
    return;
  }
  // A result sink belongs to the explicit restore entry above, never to a recovery, resume or
  // ordinary start. Any other arrival with one is a caller bug, refused rather than ignored.
  if (restoreSink) throw new Error("a restore result sink requires --restore <dir>");
  if (values["restore-only"] || values["accept-missing-source"])
    throw new Error("--restore-only and --accept-missing-source require --restore <dir>");
  // MAINTENANCE RE-ENTRY. `--restore` is refused with `--rotate-sys` above, but that guard only sees
  // the EXPLICIT flag: a restore/resume re-entry arrives with `restore` cleared and an `__*Attempt`
  // set, and an auto-recovered journal reaches the same place with no restore flag ever typed. Both
  // re-entries then hit adopt-the-live-listener paths that RETURN before `authSetup`, so the flag
  // would be accepted, nothing would rotate, and the command would exit 0. That is the silent
  // success this whole change exists to remove, so it is refused here, before any attempt state is
  // read. A rotation is a stopped, fresh boot; a half-finished maintenance attempt is neither.
  if (values["rotate-sys"] && (values.__restoreAttempt || values.__ordinaryResumeAttempt))
    throw new Error("--rotate-sys cannot run during a restore/resume re-entry - finish or roll back the maintenance attempt, then `cotal down` and `cotal up --rotate-sys`");
  // Same seam, same reason: a restore/resume re-entry needs the manager to commit the preserved
  // inventory (completeResumeActivation asks it for resumePreserved/commitResume/finalizeResume), so
  // a broker-only ask there is a contradiction to refuse, never a flag to drop mid-recovery.
  if (values["no-manager"] && (values.__restoreAttempt || values.__ordinaryResumeAttempt))
    throw new Error("--no-manager cannot run during a restore/resume re-entry - the resume needs a manager to commit the preserved inventory; finish or roll back the maintenance attempt first");
  if (!values.__restoreAttempt && !values.__ordinaryResumeAttempt && !values.file) {
    const root = cotalRoot();
    // Same refusal for the AUTO-recovered journal, raised before the recovery is prepared and
    // re-entered, so the operator reads one clear error instead of one thrown from inside a nested
    // `up` that has already begun adopting a maintenance attempt.
    if (values["rotate-sys"] && readMaintenanceJournal(root))
      throw new Error("--rotate-sys is refused while this root has a maintenance attempt to recover - finish or roll back that attempt (`cotal up` alone recovers it), then `cotal down` and `cotal up --rotate-sys`");
    // Raised here for the stronger reason the journal itself carries: a pending maintenance attempt
    // means the store is mid-recovery, and a broker-only boot over it is wrong with or without the
    // manager half. The manager half is why the FLAG specifically cannot apply. A settled active
    // restore of this root's own controller stack has nothing left to commit; it takes the
    // controller stack route below, which applies --no-manager as an ordinary start does.
    if (values["no-manager"] && readMaintenanceJournal(root) && !admittedStackRestore(root))
      throw new Error(NO_MANAGER_DURING_RECOVERY);
    // Refuse first-enable IdP failures and explicit pin conflicts before even recovery's lock
    // creates its layout. Existing recovery keeps its own recorded startup and trust checks.
    const stackSpace = values.space ?? folderSpace();
    recordOperationSpace(stackSpace);
    if (!readMaintenanceJournal(root) && controllerStackApplies(root, stackSpace, values)) {
      const recordedStack = readStackJournal(root);
      if ((recordedStack?.journal.mode ?? requestedStackMode(values)) === "user" && (!recordedStack || values.idp !== undefined)) {
        const server = values.server ?? recordedStack?.journal.server ?? localMeshesForRoot(root).find((m) => m.space === stackSpace)?.server ?? (values.host ? reconcileHostAndServer(values.host, undefined) : DEFAULT_SERVER);
        const transport = resolveTransport(values, undefined, root, { persist: false, quiet: true });
        assertUserStackTransport(server, transport.kind === "tls-required");
        await preflightUserStack(root, stackSpace, values.idp);
      }
    }
    // A runtime with no installed provider refuses here, before the lock creates its layout and
    // before any member starts. The manager member resolves the same name through the same
    // installed-extension lookup when it boots, so this check and the manager cannot disagree.
    if (values.runtime) {
      try { await preflightRuntime(values.runtime); }
      catch (error) { throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the requested runtime did not pass preflight; nothing was started", { target: { root, space: stackSpace, runtime: values.runtime }, remedy: error instanceof Error ? error.message : "inspect the selected runtime provider" }); }
    }
    const lock = acquireMaintenanceLock(root);
    let pending: PendingOrdinaryResume | undefined;
    let recoveredRestore: PreparedRestore | undefined;
    // Set only at the moment the lock is passed to a re-entry, which then owns releasing it. Any
    // other exit from this block — including a throw after `pending` was built — still releases.
    let handedOff = false;
    try {
      const journal = readMaintenanceJournal(root);
      if (journal?.state === "restore-ready") {
        // Ordinary up NEVER rolls back an in-progress restore: a live attempt's target may still be
        // written by its isolated broker. Refuse with the exact recovery recourse instead.
        const attempt = journal.restore.attemptId;
        const assessment = assessRestoreClaim(journal);
        if (assessment === "live")
          throw new Error(`cotal up is refused: restore attempt ${attempt} is in progress (claim live until ${journal.claim.deadline}); wait for it to complete or become provably stale`);
        if (assessment === "ambiguous")
          throw new Error(`cotal up is refused: restore attempt ${attempt} owners cannot be proven dead; inspect the recorded coordinator, watchdog, and broker processes before recovery`);
        throw new Error(`cotal up is refused: stale restore attempt ${attempt} holds the store; roll it back with \`cotal clean restore-attempt --attempt ${attempt} --force\`, or recover it with \`cotal up --restore\``);
      }
      const controllerCut = journal ? cutController(journal.cut) : undefined;
      if (journal && controllerCut && journal.state !== "cut-intent" && journal.state !== "cut-committed" && journal.state !== "resume-retired") {
        // A controller cut resumes or restores only through its recorded members. A settled active
        // restore of this stack no longer fences it, as legacy bare down admits it, so it falls
        // through to the controller stack route below. The lock is released before a
        // foreground stack holds this terminal. `--no-manager` is rechecked here, under the lock.
        if (!admittedStackRestore(root)) {
          if (values["no-manager"]) throw new Error(NO_MANAGER_DURING_RECOVERY);
          const foreground = await resumeControllerStack(lock, root, values);
          // Released here, once, so the foreground hold below does not keep the maintenance lock.
          handedOff = true;
          releaseMaintenanceLock(lock);
          if (foreground) await holdForegroundStack(root);
          return;
        }
      } else if (journal && (journal.state === "commit-intent" || journal.state === "manager-committed" || journal.state === "degraded")) {
        recoveredRestore = rehydratePreparedRestore(root, journal);
        pendingRestores.set(recoveredRestore.attemptId, recoveredRestore);
      } else if (journal?.state === "active") {
        if (!isManagerCommittedRestore(journal))
          throw new Error(`restore attempt ${journal.restore.attemptId} is active without durable manager commit evidence`);
        if (!journal.listenerProof)
          throw new Error(`restore attempt ${journal.restore.attemptId} is active without a bound listener proof`);
        const status = localProcessOwnerStatus(journal.listenerProof.processOwner);
        if (status === "unknown")
          throw new Error(`restore attempt ${journal.restore.attemptId} active listener ownership is ambiguous; refusing ordinary startup`);
        if (status === "alive") {
          recoveredRestore = rehydratePreparedRestore(root, journal);
          pendingRestores.set(recoveredRestore.attemptId, recoveredRestore);
        }
      } else if (journal?.state === "ready") {
        const resume = readMaintenanceResumeDocument(root, journal.resume);
        const attemptId = `resume-${randomUUID()}`;
        const launch = resume.launch as { server?: unknown; storeDir?: unknown; maxFileStore?: unknown };
        const agents = (resume.inventory as { agents?: Array<{ launch?: { runtime?: unknown } }> }).agents ?? [];
        const runtimes = [...new Set(agents.map((agent) => agent.launch?.runtime).filter((value): value is string => typeof value === "string"))];
        if (runtimes.length > 1) throw new Error(`resume inventory requires multiple runtimes: ${runtimes.join(", ")}`);
        const resumeServer = values.server ?? (typeof launch.server === "string" ? launch.server : DEFAULT_SERVER);
        const requestedStore = values["store-dir"] ?? (typeof launch.storeDir === "string" ? launch.storeDir : journal.source.path);
        // Ordinary up resumes the exact preserved source: a different valid store passed via
        // --store-dir must not consume this maintenance cut under the recorded space's trust.
        if (!sameStoreIdentity(readStoreIdentity(resolve(requestedStore)), journal.source))
          throw new Error(`--store-dir ${requestedStore} is not the preserved source store; ordinary up resumes exactly ${journal.source.path}`);
        // Journal the CANONICAL identity-checked path, never the caller's spelling: a relative or
        // symlinked spelling re-resolved later (other cwd, retargeted link) could open another store.
        const resumeStore = journal.source.path;
        // The cap is part of the preserved launch, like the store: a resume re-renders it, and a
        // different --max-file-store is refused rather than silently resizing the preserved broker.
        const resumeMaxFileStore = journaledMaxFileStore(launch.maxFileStore);
        const requestedMaxFileStore = parsePositiveIntegerFlag("--max-file-store", values["max-file-store"]);
        if (requestedMaxFileStore !== undefined && requestedMaxFileStore !== resumeMaxFileStore)
          throw new Error(`--max-file-store ${requestedMaxFileStore} is not the preserved launch cap (${resumeMaxFileStore ?? "unset"}); ordinary up resumes exactly the preserved cap - omit --max-file-store`);
        if (values.runtime && runtimes[0] && values.runtime !== runtimes[0])
          throw new Error(`--runtime ${values.runtime} contradicts the preserved agent runtime ${runtimes[0]}; omit it to resume the same principals`);
        const resumeRuntime = values.runtime ?? runtimes[0] ?? "pty";
        // Admit every seat checkpoint the cut wrote and take custody, BEFORE the resume attempt is
        // journalled and long before a manager starts. A refusal here costs nothing because
        // nothing has been started; the same refusal after a launch would be a second writer.
        const staleConsent = admitAndRestoreSeatCheckpoints(root, journal.space, journal.cut.attemptId, values, resume.inventory);
        const serverNonce = randomUUID().replaceAll("-", "");
        const serverName = `${attemptId}-${serverNonce}`;
        beginOrdinaryResume(lock, {
          attemptId,
          launch: {
            server: resumeServer,
            storeDir: resumeStore,
            ...(resumeMaxFileStore !== undefined ? { maxFileStore: resumeMaxFileStore } : {}),
            runtime: resumeRuntime,
            detached: Boolean(values.detach),
            serverName,
            serverNonce,
            // Durable evidence of consent, not a print. An operator asking later why a seat resumed
            // from a checkpoint past its horizon must be able to read that it was admitted, for
            // which seat, and by how far, from the journal rather than from a lost terminal.
            ...(staleConsent.length
              ? { acceptedStaleCheckpoints: staleConsent.map((seat) => ({ ...seat })) }
              : {}),
          },
        });
        pending = {
          root,
          attemptId,
          space: journal.space,
          mode: journal.mode,
          server: resumeServer,
          storeDir: resumeStore,
          ...(resumeMaxFileStore !== undefined ? { maxFileStore: resumeMaxFileStore } : {}),
          runtime: resumeRuntime,
          detached: Boolean(values.detach),
          inventory: resume.inventory,
          journalState: "resume-intent",
          serverName,
          serverNonce,
        };
        pendingOrdinaryResumes.set(attemptId, pending);
      } else if (journal && (journal.state === "resume-intent" || journal.state === "resume-active" || journal.state === "resume-committed" || journal.state === "resume-degraded")) {
        const resume = readMaintenanceResumeDocument(root, journal.resume);
        const launch = journal.ordinaryResume.launch as {
          server?: unknown; storeDir?: unknown; maxFileStore?: unknown; runtime?: unknown; detached?: unknown;
          serverName?: unknown; serverNonce?: unknown;
        };
        const attemptId = journal.ordinaryResume.attemptId;
        const recoveredMaxFileStore = journaledMaxFileStore(launch.maxFileStore);
        const requestedMaxFileStore = parsePositiveIntegerFlag("--max-file-store", values["max-file-store"]);
        if (requestedMaxFileStore !== undefined && requestedMaxFileStore !== recoveredMaxFileStore)
          throw new Error(`--max-file-store ${requestedMaxFileStore} is not the preserved launch cap (${recoveredMaxFileStore ?? "unset"}); resume attempt ${attemptId} re-renders exactly the preserved cap - omit --max-file-store`);
        // Recovery re-asserts the source identity rather than trusting the journaled spelling.
        assertStoreIdentity(journal.source);
        // The bound listener decides re-entry: a live exact listener is ADOPTED, a provably dead
        // one is durably retired before a fresh spawn, ambiguity refuses, and a manager-committed
        // resume never replaces the listener its durable token is bound to.
        let adoptProof: RestoreListenerProof | undefined;
        let recoveredProof = journal.listenerProof;
        let recoveredState: PendingOrdinaryResume["journalState"] = journal.state;
        if (recoveredProof) {
          const status = localProcessOwnerStatus(recoveredProof.processOwner);
          if (status === "unknown")
            throw new Error(`resume attempt ${attemptId} listener ownership is ambiguous; refusing replacement`);
          if (status === "alive") {
            adoptProof = recoveredProof;
          } else if (journal.state === "resume-committed") {
            throw new Error(`resume attempt ${attemptId} is manager-committed but its bound listener is dead; preserving the commit token and retained suppression`);
          } else {
            if (journal.state === "resume-active") {
              markOrdinaryResumeDegraded(lock, "bound resume listener died after activation", [{
                action: "repair",
                description: "Retire the dead listener and re-run the same-principal activation.",
                paths: [journal.source.path],
              }]);
              recoveredState = "resume-degraded";
            }
            replaceDeadOrdinaryResumeListener(lock, recoveredProof);
            recoveredProof = undefined;
          }
        }
        const freshNonce = randomUUID().replaceAll("-", "");
        const serverNonce = adoptProof?.serverNonce ??
          (recoveredProof || typeof launch.serverNonce !== "string" || journal.listenerReplacements?.length
            ? freshNonce
            : launch.serverNonce);
        const serverName = adoptProof?.serverName ?? `${attemptId}-${serverNonce}`;
        pending = {
          root,
          attemptId,
          space: journal.space,
          mode: journal.mode,
          server: typeof launch.server === "string" ? launch.server : DEFAULT_SERVER,
          storeDir: journal.source.path,
          ...(recoveredMaxFileStore !== undefined ? { maxFileStore: recoveredMaxFileStore } : {}),
          runtime: typeof launch.runtime === "string" ? launch.runtime : "pty",
          detached: launch.detached === true,
          inventory: resume.inventory,
          journalState: recoveredState,
          managerCommit: journal.state === "resume-committed" ? journal.managerCommit : undefined,
          serverName,
          serverNonce,
          ...(adoptProof ? { adoptProof } : {}),
        };
        pendingOrdinaryResumes.set(attemptId, pending);
      } else if (journal?.state === "resume-retired") {
        consumeRetiredMaintenance(lock);
      } else if (journal) {
        throw new Error(`cotal up is refused while maintenance state is ${journal.state}; follow the recorded recovery`);
      }
      // The re-entries run INSIDE this block, under the lock the journal was just written with, and
      // inherit it rather than letting it drop. Releasing here and re-acquiring in the nested `up`
      // left the journal reading `resume-intent` with the lock free — the window a concurrent `up`
      // could render the whole-broker server.conf through (design doc §4, P2).
      if (recoveredRestore) {
        handedOff = true;
        try {
          await up({
            ...args,
            values: {
              ...values,
              __restoreAttempt: recoveredRestore.attemptId,
              space: recoveredRestore.space,
              server: recoveredRestore.server,
              host: recoveredRestore.host,
              "store-dir": recoveredRestore.targetPath,
              runtime: recoveredRestore.runtime,
              detach: recoveredRestore.detached,
              foreground: !recoveredRestore.detached,
              open: recoveredRestore.mode === "open",
              "user-auth": recoveredRestore.mode === "user",
            },
          }, lock);
        } catch (error) {
          // The nested `up` released the inherited lock on its way out, so this takes its own.
          markPendingResumeDegraded(recoveredRestore.attemptId, error instanceof Error ? error.message : String(error));
          throw error;
        }
        return;
      }
      if (pending) {
        handedOff = true;
        try {
          await up({
            ...args,
            values: {
              ...values,
              __ordinaryResumeAttempt: pending.attemptId,
              space: pending.space,
              server: pending.server,
              "store-dir": pending.storeDir,
              "max-file-store": pending.maxFileStore === undefined ? undefined : String(pending.maxFileStore),
              runtime: pending.runtime,
              detach: pending.detached,
              foreground: !pending.detached,
              open: pending.mode === "open",
              "user-auth": pending.mode === "user",
            },
          }, lock);
        } catch (error) {
          markPendingResumeDegraded(pending.attemptId, error instanceof Error ? error.message : String(error));
          throw error;
        }
        return;
      }
    } finally {
      if (!handedOff) releaseMaintenanceLock(lock);
    }
  }
  const wantUser = Boolean(values["user-auth"]);
  // BROKER-ONLY MODE (#1417). `--no-manager` names what it omits, and the two manager-shaping flags
  // are refused beside it rather than silently dropped: a runtime selected or a ceiling recorded for
  // a manager that will never start is a misunderstanding, and dropping it quietly is the exact
  // silent-no-op shape this repo refuses everywhere else.
  const noManager = Boolean(values["no-manager"]);
  const publicExchange = publicExchangeArgs(values, wantUser);
  const maxSessions = parsePositiveIntegerFlag("--max-sessions", values["max-sessions"]);
  const maxFileStore = parsePositiveIntegerFlag("--max-file-store", values["max-file-store"]);
  // The manifest path renders its broker from the manifest, which has no store fields, so the flag
  // would be accepted and never rendered. Refuse it rather than drop it.
  if (maxFileStore !== undefined && values.file)
    throw new Error("--max-file-store cannot be combined with --file/-f - a manifest launch does not render a store cap; drop --max-file-store, or start the mesh without -f");
  // An open mesh has no operator, no system account, and no $SYS creds, so there is nothing to
  // rotate; the request is a misunderstanding to name, never a silent no-op that reports success.
  if (values["rotate-sys"] && values.open) {
    throw new Error("--rotate-sys is for auth meshes: an open mesh (--open) has no system account or $SYS credentials to rotate");
  }
  // THE EFFECTIVE PROJECT ROOT IS PINNED BEFORE THE TRANSPORT IS DECIDED.
  //
  // `ensureRootForSpace` may create `cwd/.cotal` when the nearest ancestor root already owns a
  // different auth space — the child becomes its own mesh root. That pin used to run AFTER
  // `resolveTransport`, so a TLS policy was written to the PARENT root while the listener and
  // MeshEntry landed on the CHILD. First `up --tls-*` looked green (transport was in memory);
  // `down` then bare `up` from the child found no policy and served plaintext, rewriting
  // `tlsRequired: false`. Same class as B4/B5: operator-visible TLS success, silent cleartext on
  // the documented retain path. Also polluted the parent's policy file.
  //
  // Dry-run must not pin (mkdir is a mutation). Validation still uses whatever root is visible;
  // persistence is already suppressed below.
  if (!values["dry-run"]) {
    const spaceForRoot = values.space ?? folderSpace();
    if (values.file) {
      try {
        const prepared = loadManifest(resolve(values.file));
        // A --space that names another space is refused by the -f path below, before anything is written.
        if (values.space === undefined || values.space === prepared.manifest.space) ensureRootForSpace(prepared.manifest.space);
      } catch {
        // Manifest errors are reported by the -f path with the same load; do not double-print.
      }
    } else {
      ensureRootForSpace(spaceForRoot);
    }
  }

  // THE TRANSPORT IS DECIDED HERE, ABOVE EVERY BRANCH, AND THIS POSITION IS THE FIX.
  //
  // It used to be resolved inside the foreground path only, which meant three routes to a listener
  // never saw it: `up -f` (manifest), `up --detach`, and the already-running refresh. Each accepted
  // `--tls-cert`/`--tls-key`, validated nothing, and served PLAINTEXT while printing `✓ mesh up`.
  // Every one of those was a separate exit from the same room, and closing them one at a time is
  // what produced three rounds of the same defect.
  //
  // A guard only fences what comes AFTER it, so the decision has to dominate the branch rather than
  // sit in one arm of it. The dial-host SAN is deliberately NOT checked here — the effective host is
  // not known until a route picks it — so each route re-asserts it via `assertServesDialHost` once
  // it does. Decide early so nothing can skip it; check late so it checks the right host.
  // `persist` is false on a dry run, and that is a REGRESSION THIS HOIST CAUSED. Before the move,
  // `resolveTransport` ran inside the launch path and a `--dry-run` never reached it. Hoisting it
  // above the branch is what makes the transport dominate every route — and it also put a WRITE in
  // front of a command whose entire contract is "mutate nothing", so `up -f --dry-run --tls-cert`
  // printed "Dry run - nothing was changed" and left a broker-policy.json behind.
  //
  // Validation still runs: a dry run should absolutely refuse an expired or unreadable cert, and
  // reporting that is the point of it. Only the persistence is suppressed. An instrument that
  // modifies what it inspects is a defect even when everything it reports is true.
  //
  // The root argument is the PINNED root (or the walked root on dry-run). One root for policy,
  // auth, store, and MeshEntry — never a second walk that can disagree after a later pin.
  //
  // PERSIST IS ALWAYS FALSE HERE (commit-after-apply). resolveTransport used to write the policy
  // before the already-running refresh branch could refuse a transport change, so a failed
  // `up --tls-*` against a live plaintext mesh left tls-required on disk; the next bare `up`
  // printed "TLS: inheriting" / "TLS: serving" / green already-running over a cleartext listener
  // (S5). Decide and validate early so every branch sees the transport; write only after a
  // matching listener is started and proved (`commitTransportPolicy`), never on a refuse path.
  // `quiet` suppresses the serving/inheriting lines until that commit (or a dry-run announce).
  // An unprepared manifest preview reads no home policy: applying from this folder would first
  // require its own project root, while dry-run must write nothing to create one.
  const previewRoot = values.file && values["dry-run"] && !values.root && inheritedMachineHomeRoot() ? process.cwd() : undefined;
  const meshRoot = previewRoot ?? cotalRoot();
  const transport = resolveTransport(values, undefined, meshRoot, {
    persist: false,
    quiet: true,
  });

  // CONTROLLER-OWNED STACK. A root whose stack the service controller owns, or a fresh prepared
  // static-auth, open or user-auth root with nothing legacy retained, starts as exact controller members instead
  // of the pidfile launcher. The decision is made once here; neither route falls back to the other.
  if (!values.file && controllerStackApplies(meshRoot, values.space ?? folderSpace(), values)) {
    const stackSpace = values.space ?? folderSpace();
    recordOperationSpace(stackSpace);
    const stackServer = values.server ?? readStackJournal(meshRoot)?.journal.server ?? localMeshesForRoot(meshRoot).find((m) => m.space === stackSpace)?.server ?? (values.host ? reconcileHostAndServer(values.host, undefined) : DEFAULT_SERVER);
    const stackMode = requestedStackMode(values);
    const presentation = presentationOf(values);
    const stackLock = acquireStackOperationLock(meshRoot);
    const native = controllerStackNative();
    try {
      if (values.foreground && presentation !== "json") stackUpForegroundNotice(presentation, stackSpace);
      await stackUp({ maintenanceLock: stackLock, root: meshRoot, space: stackSpace, server: stackServer, transport, runtime: values.runtime ?? "pty", noManager, ...(stackMode ? { mode: stackMode } : {}), ...(values.idp ? { idp: values.idp } : {}), ...(values.host ? { host: values.host } : {}), ...(values["store-dir"] ? { storeDir: values["store-dir"] } : {}), ...(maxFileStore !== undefined ? { maxFileStore } : {}), ...(maxSessions !== undefined ? { maxSessions } : {}), ...(values.channels ? { channels: values.channels } : {}), foreground: values.foreground === true, presentation }, native);
    } finally { releaseMaintenanceLock(stackLock); }
    if (values.foreground) await holdForegroundStack(meshRoot);
    return;
  }
  if (values.json || values.plain) throw new CommandFailure("refused", "UNSUPPORTED", "this startup uses the retained native launcher, which has no structured or plain receipt; nothing was started", { target: { root: meshRoot }, remedy: "use a fresh prepared root with static auth, --open, or plain-loopback --user-auth for the controller-owned stack, or omit --json/--plain" });
  // `up -f cotal.yaml` is a distinct path: bring up a FRESH mesh described by a manifest (broker +
  // channels + booted agents). It owns the whole space; the additive team deploy route is separate.
  // CLI flags override the manifest (flag > manifest > default) so the same file runs at a different
  // port / runtime / auth without editing it. Its space is its target: `--space` may only repeat it.
  if (values.file) {
    if (values["dry-run"]) {
      await upManifest(values.file, {
        transport,
        dryRun: true,
        server: values.server,
        host: values.host,
        space: values.space,
        root: values.root,
        runtime: values.runtime,
        open: values.open,
        userAuth: wantUser,
        idp: values.idp,
        rotateSys: values["rotate-sys"],
        maxSessions,
        noManager,
      });
      if (previewRoot) console.log(c.yellow("! this preview used the invoking folder, not the inherited home store; before applying, prepare it with `cotal space create <space> --root .`"));
      return;
    }
    const lock = acquireMaintenanceLock(cotalRoot());
    try {
      if (freshTeamBoot) {
        if (!values.space) throw new CommandFailure("refused", "USAGE_INVALID", "fresh team boot needs the manifest's exact selected space");
        assertFreshTeamBootOwnership(cotalRoot(), values.space);
      }
      assertOrdinaryUpAllowed(cotalRoot());
      await upManifest(values.file, {
        transport,
        dryRun: Boolean(values["dry-run"]),
        freshTeamBoot,
        presentation: freshTeamBoot ? presentationOf(values) : undefined,
        server: values.server,
        host: values.host,
        space: values.space,
        root: values.root,
        runtime: values.runtime,
        open: values.open,
        userAuth: wantUser,
        idp: values.idp,
        rotateSys: values["rotate-sys"],
        maxSessions,
        noManager,
      });
    } finally {
      releaseMaintenanceLock(lock);
    }
    return;
  }
  // `--runtime <name>` selects the backend the mesh's manager spawns agents through. The `-f` path
  // preflights inside upManifest; the no-manifest path must too, or the flag is silently dropped and
  // the detached manager boots the default pty. Resolve + probe the runtime NOW, in the operator's
  // process, so an uninstalled/unreachable runtime fails loud HERE (with the `cotal ext add`
  // recourse) instead of a silent fallback in a detached child. No fallbacks. (`pty`/unset: no-op.)
  if (values.runtime) await preflightRuntime(values.runtime);
  const resumeAttempt = values.__restoreAttempt ?? values.__ordinaryResumeAttempt;
  // Held for EVERY `up`, resume re-entry included. A re-entry used to hold no lock at all and still
  // reach the renderer below, so a concurrent `cotal up` could rewrite the whole-broker server.conf
  // — every tenant's trust, unserialized — while a resume was mid-flight (design doc §4, P2). A
  // re-entry INHERITS the recovery's lock rather than taking its own: the recovery journals
  // `resume-intent` under that lock, so releasing it to re-acquire here would leave exactly the
  // window the probe catches — the journal already in a resume state with the lock free.
  //
  // Inheriting makes handing this lock down MANDATORY, not tidy: the lock is not reentrant, and it
  // cannot stale-reap its way out either, because the recorded owner is alive — it is us. A helper
  // that self-acquired would take the "held by a live owner" refusal and fail the resume outright.
  // So EVERY helper below that journals under this lock takes it as a parameter, on both the restore
  // and the ordinary side: the two ADOPT paths (proven-restore and proven-ordinary listeners, which
  // recover by adopting an already-live listener rather than spawning a competitor), the spawn-path
  // listener binds (detached and foreground, restore and ordinary), the dead-listener replacement,
  // `completeResumeActivation` and the manager-commit / activation / degraded writers it calls.
  //
  // Read that list as a rule, not an inventory. The trap is that a call site with no lock ARGUMENT
  // says nothing about whether the CALLEE acquires: the restore-side writers took no parameter and
  // self-acquired, so handing the lock to the sites that visibly named it left `up --restore` dead
  // on its first pass — it died in the listener bind, before any of the seams. If you add a helper
  // that journals, give it `heldLock` and hand it down from here; do not audit by call-site shape.
  // The one caller that does NOT pass it is the prepare-failure path above, where the lock has
  // genuinely not been taken yet in this frame and the helper is meant to take its own.
  let startupLock: MaintenanceLock | undefined = inheritedLock ?? acquireMaintenanceLock(cotalRoot());
  onAdopt?.(); // from here the release below owns it, inherited or not
  const releaseStartupLock = () => {
    if (!startupLock) return;
    releaseMaintenanceLock(startupLock);
    startupLock = undefined;
  };
  try {
    // Gated on the ATTEMPT, not on holding the lock. The lock is now always held, and this refuses
    // whenever a journal exists — which is precisely the state a resume re-entry is in, so gating
    // it on the lock would refuse the very resume the lock is here to protect.
    // Without --server the default URL only seeds a first boot. A first boot that found it taken ran
    // on a free port, which this root's record keeps; a re-run must start from that URL, or every
    // lookup below misses its own mesh and the space claim refuses it (#3889).
    const recordedSpace = values.space ?? folderSpace();
    const implicitServer = localMeshesForRoot(cotalRoot()).find((m) => m.space === recordedSpace)?.server ?? DEFAULT_SERVER;
    let server = values.server ?? implicitServer;
    const host = values.host ?? "127.0.0.1";
    // `--host` is the BIND address; `server` is the URL the readiness probe, the mesh registry, and
    // every later client use. They must name the SAME address. Left independent, `--host <non-loopback>`
    // bound correctly and was then probed on the loopback default, found nothing, timed out, and
    // SIGTERM'd a broker that had started perfectly — so `--host` alone could never succeed.
    // Derive the URL from `--host` when no explicit `--server` pins it, and refuse a contradicting
    // pair rather than starting a broker nothing can reach.
    if (values.host) server = reconcileHostAndServer(values.host, values.server, "--host", "--server", implicitServer);
    // A same-root repair reopens the store the mesh record names, ONCE, before the ordinary-up
    // assertion below reads --store-dir (#2218): an ordinary `up` on a space whose broker died must
    // not silently fall back to the root's default store while the record still names a custom one.
    // Never runs during a resume attempt, which keeps its own store checks. The reachability probe
    // here is reused as `listenerReachable` further down instead of probing twice.
    let repairProbe: boolean | undefined;
    if (!resumeAttempt) {
      const repairSpace = values.space ?? folderSpace();
      const repairRoot = cotalRoot();
      const heldForRepair = loadMeshes().find(
        (m) => m.origin !== "manual" && m.origin !== "catalog" && m.server === server && m.root === repairRoot && m.space === repairSpace,
      );
      if (heldForRepair) {
        repairProbe = await isReachable(server);
        if (!repairProbe) {
          if (values["store-dir"] !== undefined) {
            const requestedStoreDir = resolve(values["store-dir"]);
            if (heldForRepair.storeDir !== undefined && requestedStoreDir !== heldForRepair.storeDir) {
              console.error(
                c.red(
                  `✗ mesh "${repairSpace}" is recorded at ${server} with store ${heldForRepair.storeDir} - a stopped broker can't change --store-dir (it is fixed at start); repair it with \`cotal up --store-dir ${heldForRepair.storeDir}\`, or \`cotal down\` it first`,
                ),
              );
              process.exit(1);
            }
          } else if (heldForRepair.storeDir !== undefined) {
            values["store-dir"] = heldForRepair.storeDir;
            console.log(c.dim(`reopening the recorded store ${heldForRepair.storeDir}`));
          } else {
            const defaultStore = cotalPath("nats");
            let hasEntries = false;
            try {
              hasEntries = readdirSync(join(defaultStore, "jetstream")).length > 0;
            } catch { /* absent: no jetstream dir yet */ }
            if (!hasEntries) {
              console.error(
                c.yellow(
                  `! mesh "${repairSpace}" was recorded before the store directory was kept, so this repair opens ${defaultStore}; if the previous broker used --store-dir, stop this one with \`cotal down\` and repair with that flag (its Store Directory: line is in ${repairRoot}/.cotal/nats.log)`,
                ),
              );
            }
          }
        }
      }
    }
    if (!resumeAttempt) assertOrdinaryUpAllowed(cotalRoot(), values["store-dir"] ? resolve(values["store-dir"]) : cotalPath("nats"));
    const restoredAttempt = resumeAttempt ? pendingRestores.get(resumeAttempt) : undefined;
    if (restoredAttempt?.reentry) {
      if (!restoredAttempt.listenerProof)
        throw new Error(`restore attempt ${resumeAttempt} re-entry has no bound listener proof; preserving recovery state`);
      const ownerStatus = localProcessOwnerStatus(restoredAttempt.listenerProof.processOwner);
      if (ownerStatus === "alive") {
        await resumeProvenRestoreListener(restoredAttempt, startupLock);
        return;
      }
      if (ownerStatus === "unknown")
        throw new Error(`restore attempt ${resumeAttempt} listener ownership is ambiguous; refusing replacement`);
      if (restoredAttempt.managerCommit)
        throw new Error(`restore attempt ${resumeAttempt} is manager-committed but its bound listener is dead; preserving the commit token and retained suppression`);
      if (await isReachable(restoredAttempt.server))
        throw new Error(`restore attempt ${resumeAttempt} refuses the occupied foreign listener at ${restoredAttempt.server}`);
      replacePreparedDeadRestoreListener(restoredAttempt, startupLock);
    }
    const ordinaryAttempt = resumeAttempt ? pendingOrdinaryResumes.get(resumeAttempt) : undefined;
    if (ordinaryAttempt?.adoptProof) {
      // The recovered attempt's exact bound listener is alive: prove it over the wire and adopt it
      // instead of spawning a competitor over the same store.
      await resumeProvenOrdinaryListener(ordinaryAttempt, startupLock);
      return;
    }
    if (ordinaryAttempt?.journalState === "resume-committed")
      throw new Error(`resume attempt ${resumeAttempt} is manager-committed but has no adoptable bound listener; preserving the commit token and retained suppression`);
    const listenerReachable = repairProbe !== undefined ? repairProbe : await isReachable(server);
    if (resumeAttempt && listenerReachable)
      throw new Error(`resume attempt ${resumeAttempt} refuses the unproven occupied listener at ${server}`);
    if (listenerReachable) {
    const space = values.space ?? folderSpace();
    const root = cotalRoot();
    // A broker is already on this port. Same root means "this project is already up" unless the
    // operator explicitly asked for a second space in the same `.cotal/` root (unsupported today: pid,
    // auth, and logs are root-scoped). Different root / unrecorded broker on the implicit default port
    // gets a fresh free port instead of making the user hunt for one.
    const meshes = loadMeshes();
    // An explicit refresh names a complete identity. Selecting only by server makes the result depend
    // on registry order when that broker has records for several spaces. A bare refresh keeps its
    // existing resolution behaviour.
    const held = values.space === undefined
      ? meshes.find((m) => m.server === server)
      : meshes.find((m) => m.server === server && m.root === root && m.space === space);
    if (held && held.root === root && (held.space === space || values.space === undefined)) {
      // A refresh of the SAME already-running mesh — its mode is fixed by how the live broker was
      // started. A flag asking for a DIFFERENT mode must fail loud (silently preserving the old
      // mode would hand the operator a mesh on the wrong identity plane); a bare refresh keeps the
      // held mode.
      const requested = wantUser ? "user" : values.open ? "open" : undefined;
      if (requested && requested !== held.mode) {
        const label = { auth: "static JWT auth", open: "no auth (--open)", user: "per-user auth" }[held.mode];
        console.error(
          c.red(
            `✗ mesh "${held.space}" is already running at ${server} with ${label} - a running broker can't change auth mode; \`cotal down\` it first, then \`cotal up ${wantUser ? "--user-auth" : "--open"}\``,
          ),
        );
        process.exit(1);
      }
      // A rotation retires the system account this LIVE broker was started on, and only a broker
      // (re)started from the rewritten config carries the successor. Rotating under a running mesh
      // would leave the record and the creds a generation ahead of the broker: every $SYS client
      // denied, with `doctor auth` reporting freshly-minted creds. Refuse with the two-step recipe.
      if (values["rotate-sys"]) {
        console.error(
          c.red(
            `✗ mesh "${held.space}" is already running at ${server} - a running broker can't rotate its system account (it would keep serving the retired one); \`cotal down\` it first, then \`cotal up --rotate-sys\``,
          ),
        );
        process.exit(1);
      }
      // A running broker cannot change its transport either, and for exactly the reason it cannot
      // change its auth mode: the listener's TLS config was fixed when nats-server read its config
      // file. This branch starts nothing, so `--tls-cert`/`--tls-key` here can only be a request to
      // change something that is already decided — and answering it with `✓ mesh up` told the
      // operator they had TLS while the live broker went on serving whatever it was started with.
      //
      // Refuse rather than warn. The whole feature is that a command accepting a TLS flag either
      // encrypts or refuses to start; printing a success line over an unchanged plaintext listener
      // is the precise outcome that must be unreachable.
      if (values["tls-cert"] || values["tls-key"]) {
        console.error(
          c.red(
            `✗ mesh "${held.space}" is already running at ${server} - a running broker can't change its transport; \`cotal down\` it first, then \`cotal up --tls-cert <cert> --tls-key <key>\``,
          ),
        );
        process.exit(1);
      }
      // The store cap is fixed when nats-server reads its config, and nats-server refuses a reload
      // from its dynamic cap to an explicit one. This branch starts nothing, so a different cap can
      // only be refused; the same cap is a no-op.
      if (maxFileStore !== undefined && maxFileStore !== held.maxFileStore) {
        console.error(
          c.red(
            `✗ mesh "${held.space}" is already running at ${server} - a running broker can't change --max-file-store (it is fixed at start); \`cotal down\` it first, then \`cotal up --max-file-store ${maxFileStore}\``,
          ),
        );
        process.exit(1);
      }
      // The store directory is fixed the same way: an explicit --store-dir on a live refresh can
      // only be refused when it disagrees with what the running broker actually opened. Absent
      // `held.storeDir` (a pre-field record) has nothing to compare against, so it is not checked.
      if (values["store-dir"] !== undefined && held.storeDir !== undefined && resolve(values["store-dir"]) !== held.storeDir) {
        console.error(
          c.red(
            `✗ mesh "${held.space}" is already running at ${server} - a running broker can't change --store-dir (it is fixed at start); \`cotal down\` it first, then \`cotal up --store-dir ${resolve(values["store-dir"])}\``,
          ),
        );
        process.exit(1);
      }
      // `--max-sessions` is fixed when the manager starts. A refresh reuses a live manager as-is
      // (`ensureManager` returns immediately), then used to persist the requested ceiling anyway.
      // That printed `✓ already running` over an unchanged plane and left MeshEntry lying about it.
      // Refuse rather than warn: the flag either applies or the command fails. Matching the live
      // argv is a no-op and may proceed. An unreadable command line cannot prove a match.
      if (maxSessions !== undefined) {
        const live = managerRecordState(undefined, undefined, held.space);
        if (live.state === "alive" && !liveManagerWouldApplyMaxSessions(live.command, maxSessions)) {
          console.error(
            c.red(
              `✗ mesh "${held.space}" is already running at ${server} - a running manager can't change --max-sessions (it is fixed at start); \`cotal down\` it first, then \`cotal up --max-sessions ${maxSessions}\``,
            ),
          );
          process.exit(1);
        }
      }
      // `--no-manager` on a refresh whose manager is LIVE is the same class of refusal: this branch
      // starts nothing, so the flag cannot apply, and silently keeping the manager would answer a
      // broker-only ask with a full stack while silently stopping it would kill agents this command
      // was never asked to touch. Same shape as `--runtime`/`--max-sessions` above: refuse and name the
      // remedy. This launcher's stack has no manager-only stop, so the remedy is the whole-stack stop
      // and a broker-only start. A refresh of a mesh whose manager is NOT live simply proceeds
      // broker-only.
      if (noManager) {
        const live = managerRecordState(undefined, undefined, held.space);
        if (live.state === "alive") {
          console.error(
            c.red(
              `✗ mesh "${held.space}" is already running at ${server} with a live manager - \`cotal up --no-manager\` will not keep or stop one, and this stack has no command that stops only its manager; \`cotal down\` stops the whole stack, then \`cotal up --no-manager --space ${held.space}\` starts it broker-only`,
            ),
          );
          process.exit(1);
        }
      }
      // Live INFO must agree with the recorded/requested transport. A bare refresh that greets
      // "already running" over a plaintext listener while policy claims TLS is S5's second half —
      // the refuse left a durable lie and this path used to reprint TLS success over cleartext.
      const liveTls = await liveListenerRequiresTls(server);
      const wantTls = transport.kind === "tls-required" || held.tlsRequired === true;
      if (wantTls && liveTls === false) {
        console.error(
          c.red(
            `✗ mesh "${held.space}" at ${server} is recorded/expected TLS-required but the live listener is plaintext - refuse rather than claim it is up; \`cotal down\` then \`cotal up --tls-cert <cert> --tls-key <key>\` (or fix the broker)`,
          ),
        );
        process.exit(1);
      }
      if (!wantTls && liveTls === true) {
        console.error(
          c.red(
            `✗ mesh "${held.space}" at ${server} is serving TLS but this mesh is recorded plaintext - \`cotal down\` then re-up with matching flags`,
          ),
        );
        process.exit(1);
      }
      // #286: reconcile the presence/lease bucket TTLs, HERE, before the success line.
      //
      // This branch is the upgrade path. A mesh created before the bucket TTLs existed keeps no
      // `max_age` forever, so dead presence records never expire and the roster reports a despawned
      // agent as live — and that mesh is by definition ALREADY RUNNING, which is precisely the case
      // that returns from here without ever reaching `postStart`/`setupSpaceStreams`. Reconciling
      // only on the create path fixes the deployments that never had the bug.
      //
      // BEFORE the success print, not after: `✓ already running` is a claim about a healthy mesh,
      // and printing it over an unreconciled one is the silent-drift failure this change exists to
      // remove. A reconcile that cannot complete is a loud refusal, not a footnote under a tick.
      //
      // Read-first, so this stays a no-op in steady state: each bucket is skipped when its `max_age`
      // already matches, so a repeat `cotal up` on a current mesh issues three reads and no writes.
      // When it DOES write it says so — a bare `cotal up` now performs a config write on a running
      // mesh, and an operator should never have to infer that from silence.
      try {
        // Open meshes hold no creds and need none (a bare connection has the rights) — but they DO
        // carry the same three TTL'd buckets, so they drift identically and are reconciled too.
        let reconcileCreds: string | undefined;
        if (held.mode !== "open") {
          const spaceAuth = await getSpaceAuth(workspaceSecretStore(root), held.space);
          if (!spaceAuth) {
            console.error(c.red(`✗ mesh "${held.space}" has no trust material under ${authDir(root)} - cannot reconcile its presence/lease TTLs; restore or re-provision \`.cotal/auth\``));
            process.exit(1);
          }
          // Ephemeral, reconcile-only, discarded with the connection. Same enumerated `provisioner`
          // scope the create path mints — no principal gains authority it did not already have, since
          // a same-root caller holds the space's signing material either way.
          reconcileCreds = await mintCreds(spaceAuth, newIdentity(), "provisioner");
        }
        const v = await brokerVersion(server, held.space, reconcileCreds);
        if (belowPresenceSafeBroker(v.version) && v.presenceFileBacked)
          console.error(
            c.yellow(
              `! nats-server ${v.version} is below 2.14.5 and the presence bucket of "${held.space}" is file-backed: it can latch after a stall and close the mesh to new joins (#1356); put a nats-server 2.14.5 or newer on PATH (it wins over the bundled one)`,
            ),
          );
        for (const r of await reconcileSpaceTtls({ servers: server, space: held.space, creds: reconcileCreds }))
          console.log(c.dim(`  reconciled ${r.stream} TTL ${r.fromMs === 0 ? "none" : `${r.fromMs}ms`} -> ${r.toMs}ms`));
      } catch (e) {
        console.error(c.red(`✗ mesh "${held.space}" is running at ${server} but its presence/lease TTLs could not be reconciled: ${(e as Error).message}`));
        process.exit(1);
      }
      console.log(c.green(`✓ mesh "${held.space}" already running at ${server}`));
      // USER MODE: re-upping IS the documented recovery for a dead auth service (the provider's
      // failure copy says "restart it with `cotal up`"), so a refresh must re-ensure the service —
      // never just reprint "already running" over a dead callout. No broker config is (re)written
      // here, so healing on a bare `cotal up` is safe: the mode can't drift, only the daemon heals.
      let userAuth: UserAuthInfo | undefined;
      if (held.mode === "user") {
        const auth = await getSpaceAuth(workspaceSecretStore(root), held.space);
        if (!auth) {
          console.error(c.red(`✗ mesh "${held.space}" is user-auth but this root has no trust material under ${authDir(root)} - \`cotal down\` it, restore or re-provision \`.cotal/auth\`, then \`cotal up --user-auth\``));
          process.exit(1);
        }
        const stateDir = userAuthStateDir(root, held.space);
        let prepared: AuthPrepared;
        try {
          prepared = await resolveAuthProvider().prepareServer({
            space: held.space,
            operatorSeed: auth.operator.seed,
            account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
            store: workspaceSecretStore(root),
            dir: stateDir,
            idpUrl: values.idp,
          });
        } catch (e) {
          console.error(c.red(`✗ ${(e as Error).message}`));
          process.exit(1);
        }
        const svc = await startUserAuthService(held.space, server, { prepared, stateDir }, publicExchange);
        userAuth = svc.userAuth;
        // The refresh IS the recovery command — a heal that didn't heal must not exit 0.
        if (!svc.ok) process.exitCode = 1;
      }
      // Auth/user meshes also need their resident renewal owner. A same-root refresh is the normal
      // repair command after a stale/missing manager, so ensure the delivery daemon + manager before
      // claiming the running mesh is healthy. Open meshes have no auth creds or delivery daemon.
      // Re-ensure the control plane on a refresh. The manager is ensured for every mode that reaches
      // here (a heal after a dead/missing manager adopts `--runtime`); the delivery daemon self-gates
      // to auth mode inside `ensureControlPlane`. Open meshes normally skip this (a bare refresh has
      // nothing to heal that must be touched), but a `--runtime` request must be honored there too,
      // not silently dropped.
      if (held.mode !== "open" || values.runtime) {
        // Warn only when the manager is genuinely REUSED: a live delivery-aware (this-build) manager
        // is kept as-is by `ensureManager`, so its runtime can't change. An old hosting manager (no
        // delivery marker) is stopped and REPLACED by the ensure below carrying the requested runtime,
        // so that's not a reuse - don't claim the runtime is fixed. A dead/absent manager is (re)started
        // with it.
        if (values.runtime) {
          const live = managerRecordState(undefined, undefined, held.space);
          if (live.state === "alive" && managerHasDeliveryMarker(live.pid!, held.space))
            console.error(
              c.dim(`! manager already running for "${held.space}" - its runtime is fixed at start; \`cotal down\` then \`cotal up --runtime ${values.runtime}\` to change it`),
            );
        }
        // A repair replaces the manager, so it must carry the mesh's recorded exposure forward — a
        // bare `cotal up` here has no `--host` of its own, and dropping it silently moves the attach
        // face back to loopback while everything else keeps working.
        // `wantTls` above is this branch's transport decision — the registry record reconciled
        // against the live listener's INFO (a disagreement already exited). It is what the daemon
        // must be launched with; #836 was this call dropping it.
        const controlPlane = await startDeliveryWithBroker(held.space, server, wantTls, {
          runtime: values.runtime,
          attachHost: attachHostFor(held.space, values.host),
          maxSessions: maxSessionsFor(held.space, maxSessions),
          noManager,
        });
        if (!controlPlane) process.exitCode = 1;
        // #883: a refresh that HEALED a missing manager must say so — the summary line otherwise reads
        // identically to a refresh that found everything already up, and the operator cannot tell which
        // world they are in without a second command. Only here does a started manager mean one was
        // missing: a launch starts its manager as a matter of course (#2480).
        if (controlPlane?.started) console.log(c.green(`✓ restored in the background: manager (pid ${controlPlane.pid})`));
      }
      // A broker was already answering here — this branch starts nothing, so it must not claim the
      // record as ours (see `Provenance`), and it passes only what this invocation decided.
      // `recordOurMesh` carries everything else (`tlsRequired`, the recorded host and session
      // ceiling, the store) from the record as it stands at write time, not from `held`.
      recordOurMesh({ space: held.space, server, root, mode: held.mode, ...(userAuth ? { userAuth } : {}), ...(values.host ? { attachHost: values.host } : {}), ...(maxSessions !== undefined ? { maxSessions } : {}), ts: new Date().toISOString() }, "refresh");
      seedPersonaAfterUp(root);
      return;
    }
    const who = held ? `mesh "${held.space}" (${held.root})` : "a broker not started here";
    // Reaching here with `--rotate-sys` means something IS answering at the requested address and it
    // is not this root's recorded mesh (that case was refused above). The ordinary response is to pick
    // a free port and carry on, which for a rotation is the wrong instinct: the unidentified listener
    // may be a `nats-server -c <root>/.cotal/auth/server.conf` started by hand, holding THIS root's
    // config and JetStream store while writing neither a pidfile nor a registry row. Rotating around
    // it retires the account it is still serving and opens its store a second time. Nothing available
    // here can identify it (that is what unidentified means), so refuse instead of stepping past it.
    if (values["rotate-sys"]) {
      console.error(
        c.red(`✗ ${server} is answering and it is not this root's recorded mesh (${who})`) +
          c.dim(" - `--rotate-sys` will not start on another port around an unidentified broker: it may be serving this root's own server.conf and JetStream store. Stop whatever is listening there (`cotal down` if it was started here), then rotate."),
      );
      process.exit(1);
    }
    if (values.server === undefined && (!held || held.root !== root)) {
      const next = await serverWithFreePort(server, host);
      console.log(c.dim(`${server} is already in use by ${who}; starting "${space}" at ${next} instead`));
      server = next;
    } else {
      console.error(
        c.red(
          `✗ ${server} is already in use by ${who} - to run "${space}" use \`--server nats://${host}:<port>\` with a free port`,
        ),
      );
      process.exit(1);
    }
  }

  const restored = resumeAttempt ? pendingRestores.get(resumeAttempt) : undefined;
  const boundListener: DetachOpts["boundListener"] = restored ? {
    serverName: restored.serverName,
    serverNonce: restored.serverNonce,
    onSpawn: (pid: number, startedAt: string) => bindSpawnedRestoreListener(restored, pid, startedAt, startupLock),
    verify: async () => { await provePreparedRestoreListener(restored); },
  } : ordinaryAttempt ? {
    serverName: ordinaryAttempt.serverName,
    serverNonce: ordinaryAttempt.serverNonce,
    onSpawn: (pid: number, startedAt: string) => bindSpawnedOrdinaryResumeListener(ordinaryAttempt, pid, startedAt, startupLock),
    verify: async () => { await verifySpawnedOrdinaryListener(ordinaryAttempt); },
  } : undefined;
  if (values.detach) {
    // A `backup restore` owns its own receipt: the native launcher's progress lines stay off stdout.
    const quietRestore = restored !== undefined && restoreSinks.has(restored.attemptId);
    const { pid, source, authService, controlPlane, delivery, manager } = await startMeshDetached({
      transport,
      server,
      storeDir: values["store-dir"],
      maxFileStore,
      space: values.space,
      open: values.open,
      userAuth: wantUser ? { idpUrl: values.idp } : undefined,
      rotateSys: values["rotate-sys"],
      publicExchange,
      channels: values.channels,
      // The RAW flag, not the loopback-defaulted `host` above: `startMeshDetached` applies the same
      // default itself, and what it records must distinguish "the operator asked for this address"
      // from "nobody asked", or every mesh would persist an exposure decision it never made.
      host: values.host,
      runtime: values.runtime,
      maxSessions,
      noManager,
      resumeAttempt,
      resumeCommit: commitTokenHandoff(cotalRoot(), (restored?.managerCommit ?? ordinaryAttempt?.managerCommit) !== undefined, startupLock),
      boundListener,
      ...(quietRestore ? { quietBoot: true } : {}),
    });
    // Transport policy is committed inside startMeshDetached before delivery launch (S5+S9).
    if (!quietRestore) {
      console.log(c.dim(`Started nats-server (${source}).`));
      console.log(c.green(renderDetachedSummary({ pid, delivery, authService: wantUser && authService, manager, machineHome: canonicalRoot(cotalRoot()) === canonicalRoot(homedir()), ...(values.root ? { root: cotalRoot() } : {}) })));
    }
    if (restored && process.env.COTAL_SMOKE_FAIL_AFTER_RESTORE_LISTENER_READY === "1")
      throw new Error("smoke-injected failure after restore listener readiness");
    // A user mesh whose auth service never became ready, or a mesh whose control plane is degraded,
    // is recorded + running, but this `up` did NOT deliver what was asked — automation must see that
    // in the exit code, as it does on a refresh, not only in the line printed above.
    if (!authService || !controlPlane) process.exitCode = 1;
    await completeResumeActivation(
      resumeAttempt,
      controlPlane && authService,
      !authService ? "normal listener started but the user-auth service is unavailable" : "normal listener started but the control plane is degraded",
      server,
      startupLock,
    );
    if (restored) restoreSinks.get(restored.attemptId)?.({
      attemptId: restored.attemptId, space: restored.space, root: restored.root, server: restored.server, mode: restored.mode,
      selection: restored.selection, targetPath: restored.targetPath, runtime: restored.runtime, brokerPid: pid,
      delivery, authService, controlPlane, manager,
    });
    return;
  }

  const useAuth = !values.open;
  const space = values.space ?? folderSpace();
  ensureRootForSpace(space); // may pin the cwd as this space's root — before any cotalPath use
  refuseOpenOverUserState(Boolean(values.open), space);
  const storeDir = values["store-dir"] ? resolve(values["store-dir"]) : cotalPath("nats");
  if (values.__ordinaryResumeAttempt) {
    // Final identity re-assertion immediately before JetStream opens: the journaled canonical path
    // must still be the exact preserved inode (no symlink retarget or replacement since intent).
    const resumeJournal = readMaintenanceJournal(cotalRoot());
    if (!resumeJournal || !("ordinaryResume" in resumeJournal))
      throw new Error(`resume attempt ${values.__ordinaryResumeAttempt} lost its durable journal before the store open`);
    if (!sameStoreIdentity(readStoreIdentity(storeDir), resumeJournal.source))
      throw new Error(`resume store ${storeDir} no longer matches the preserved source identity; refusing to open JetStream over it`);
  }
  // Owner-private regardless of umask: a recursive create also makes a missing `.cotal`, which every
  // later protection check walks as an ancestor.
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  await claimSpace(space, server, cotalRoot());
  const seedFile = loadChannelsFile(values.channels);
  // Decided above the branch; the dial host is only settled here (a port collision may have moved
  // the server, and the hostname is what the certificate has to match).
  assertServesDialHost(transport, new URL(server).hostname);
  const setup = useAuth ? await authSetup(storeDir, server, space, host, wantUser ? { idpUrl: values.idp } : undefined, transport, values["rotate-sys"], maxFileStore) : undefined;
  const port = Number(new URL(server).port) || 4222;
  // Both modes go through a RENDERER, never bare CLI flags. Open mode used to start from
  // `-js -sd … -p … -a …`, which never called a renderer at all — so the required transport union
  // protected the auth path and was silent on the open one, and a cert/key pair passed to an
  // open-mode `up` would have been accepted while the listener came up in cleartext.
  const confPath = setup ? setup.confPath : writeOpenBrokerConf(storeDir, { port, host, transport, maxFileStore });
  const natsArgs = [
    "-c", confPath,
    ...(boundListener ? ["--name", boundListener.serverName] : []),
  ];
  const { bin, source } = await resolveNatsServer();

  console.log(
    c.dim(
      `Starting nats-server (JetStream, ${useAuth ? "JWT auth" : "OPEN/no-auth"}, ${source}) - store: ${storeDir}, bind: ${host}`,
    ),
  );
  console.log(c.dim("Press Ctrl-C to stop.\n"));
  const listenerStartedAt = new Date().toISOString();
  // A terminal sends Ctrl-C to the whole foreground process group. Keep the broker outside it
  // on POSIX so only this owner receives the interrupt and can finish manager-first teardown
  // before signalling the broker. Keep the child referenced and its output in this terminal.
  const child = spawn(bin, natsArgs, { stdio: "inherit", detached: process.platform !== "win32" });
  let activationFinished = !resumeAttempt;
  await recordSpawnedListener(child, listenerStartedAt, boundListener);
  releaseStartupLock();
  child.on("error", (err) => {
    console.error(c.red(`Failed to start nats-server: ${err.message}`));
    if (!resumeAttempt) process.exit(1);
  });
  // The control plane is coupled to the broker: stop the detached manager AND the delivery daemon
  // (AND the space's user-auth service) when this `up` stops (Ctrl-C), so none outlives the broker
  // it serves — a surviving manager would reconnect-loop invisibly against the dead (or the NEXT)
  // broker (the documented orphan-supervisor failure mode). All kill by pidfile, symmetric; the
  // auth service's pid is space-scoped so no other space's daemon can ever be hit.
  // The manager goes first, in `cotal down`'s order, through the stop `cotal down` runs (#1307): it
  // holds the stop reservation, asserts the exact manager can spare its seats before any signal,
  // reports the seats left behind, and escalates a wedged manager to SIGKILL. When that stop throws
  // the manager may still be serving, so NOTHING else is signalled — no delivery, no auth, no broker:
  // the refusal is printed with the reap route and the latch is released, so the stack keeps running
  // in the foreground; the operator ends it with `cotal down --with-agents` from another terminal,
  // and the broker-exit handler below already ends `up` when the broker goes.
  // stopDelivery and stopAuthService are the stops bare `cotal down` performs for those daemons
  // (reservation, SIGKILL escalation); the rest of the teardown must run even if one fails —
  // the failure is logged, never swallowed silently. Teardown is AWAITED before the broker is
  // signalled, so it never races a broker that is already going away.
  let stopping = false;
  let teardown: Promise<void> | undefined;
  const stop = () => {
    if (stopping) return; // a second Ctrl-C during teardown must not start a second teardown
    stopping = true;
    // Once the broker has exited, its handler below is already running this teardown and reads
    // `stopping` when it is done.
    if (child.exitCode !== null || child.signalCode !== null) return;
    teardown = (async () => {
      try {
        await stopManager(space);
        clearManagerArtifacts(space);
      } catch (e) {
        console.error(c.red(`! teardown: ${(e as Error).message}`));
        console.error(c.red(`the stack is still running; to take managed agents with it, run: cotal down --with-agents`));
        stopping = false;
        return;
      }
      await stopDelivery(space).catch((e: Error) => console.error(`! delivery teardown: ${e.message}`));
      await stopAuthService(space).catch((e: Error) => console.error(`! auth teardown: ${e.message}`));
      child.kill("SIGTERM");
    })();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // The broker is gone — drop it from the registry (and the `current` pointer if it was the default)
  // so a later `cotal spawn` doesn't try to join a dead mesh.
  child.on("exit", async (code, signal) => {
    if (failedListeners.has(child)) return;
    removePidPair(cotalPath("nats.pid"), String(child.pid));
    // One teardown at a time: a stop started while another is in flight is refused the reservation
    // that one holds, so wait for a Ctrl-C teardown already running instead of racing it.
    await teardown;
    await stopDelivery(space).catch((e: Error) => console.error(`! delivery teardown: ${e.message}`));
    await stopManager(space).then(() => clearManagerArtifacts(space)).catch((e: Error) => console.error(`! manager teardown: ${e.message}`));
    await stopAuthService(space).catch((e: Error) => console.error(`! auth teardown: ${e.message}`));
    // Unrecording (and the exit code below) both depend on WHY the broker is gone. `stopping` is
    // true only for the intended shutdown `stop()` drives (Ctrl-C, SIGTERM) — everything else here
    // (a crash, an OOM kill, a signal from outside `up`) leaves the record and its store in place.
    if (stopping) {
      // Only unrecord if the registry still points at THIS broker. A newer broker for the same space
      // (a concurrent `up`, or a different-port re-up that recorded after us) may have replaced our
      // record — removing by name would clobber the live winner and hide it from the registry.
      // …and only if it is still OUR kind of record. A concurrent `cotal meshes add --force` can
      // replace it with a hand-registered one carrying the same server + root; that record outlives
      // this broker by design (it is the operator's, and only they remove it), so unrecording it on
      // our exit would delete a registration this process never owned.
      const mine = findMesh(space);
      if (mine && mine.origin !== "manual" && mine.server === server && mine.root === cotalRoot()) {
        removeMesh(space);
        if (getCurrent() === space) clearCurrent();
      }
      if (activationFinished) process.exit(code ?? 0);
    } else {
      // The record is kept ON PURPOSE: it still names the store this broker opened, so a repair
      // `up` reopens that SAME store instead of falling back to the root's default, and a
      // supervising unit's restart takes the refresh path against the recorded store rather than
      // racing a second broker into existence. Foreground stdio is inherited (its own log lines
      // are already on this terminal, above), so there is no `.cotal/nats.log` to name here.
      const detail = signal ? `signal ${signal}` : `code ${code}`;
      console.error(
        c.red(
          `✗ nats-server exited unexpectedly (${detail}); the mesh "${space}" stays recorded (\`cotal meshes\` lists it offline); log: see the terminal output above; repair: \`cotal up --server ${server} --space ${space}\``,
        ),
      );
      // A foreground broker under `Restart=on-failure` must exit non-zero on a crash so the unit
      // restarts it; exiting 0 here (as an unconditional `code ?? 0` used to) looked like a clean
      // stop and left the unit sitting dead.
      if (activationFinished) process.exit(code ?? 1);
    }
  });

  await awaitSpawnedListener({ child, server, space, creds: setup?.creds, log: "the terminal output above", boundListener });
  {
    // A DAEMON THAT DIES UNDER THIS RUNNING BROKER IS RESTARTED HERE (#2469). It exits on its own once
    // it cannot reach the broker, and a starved host makes a running broker look unreachable, so it can
    // end while this broker serves on. Nothing else brings it back, and every static retirement then
    // fails on the ctl.delivery-admin rail and holds its name until an operator re-runs `cotal up`. A
    // clean exit or SIGTERM/SIGINT is a deliberate stop (`cotal down`) and stays stopped, and so
    // is the SIGKILL `down` escalates to when a starved daemon outlives its grace, also when either ends a
    // replacement this loop is still waiting on: that attempt then fails, and retrying it would undo the
    // stop. A failed attempt waits out the lease TTL, the longest a dead holder's lease blocks its
    // replacement. No daemon is alive during that wait for `down` to signal, so a stop there shows only as
    // the dead daemon's record going away. Recovery is announced only once the responder is bound.
    const meshServing = () => !stopping && child.exitCode === null && child.signalCode === null;
    let restartingDelivery = false;
    let deliveryStopped = false;
    const onDeliveryExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (code === 0 || signal === "SIGTERM" || signal === "SIGINT" || (signal !== null && deliveryStoppedByDown(space))) {
        deliveryStopped = true;
        return;
      }
      if (restartingDelivery || !meshServing()) return;
      restartingDelivery = true;
      console.error(c.yellow(`! delivery daemon exited (${signal ? `signal ${signal}` : `code ${code}`}) while nats-server is running - restarting it`));
      void (async () => {
        while (meshServing()) {
          let failure: string;
          try {
            const ensured = await ensureDelivery({ space, server, tls: transport.kind === "tls-required", onDeliveryExit });
            // An abnormal exit during this attempt was dropped above, so the record decides.
            if (deliveryUp(space)) {
              // An unbound responder was reported by ensureDelivery, and this daemon's exit re-arms the restart.
              if (ensured.responderBound) console.error(c.green(`✓ delivery daemon running again${ensured.pid !== undefined ? ` (pid ${ensured.pid})` : ""}`));
              break;
            }
            failure = "no delivery daemon is running after the attempt";
          } catch (e) {
            failure = (e as Error).message;
          }
          if (deliveryStopped) break;
          console.error(c.yellow(`! delivery restart failed, retrying in ${LEASE_TTL_MS / 1000}s: ${failure}`));
          const recorded = !deliveryStoppedByDown(space);
          await new Promise((r) => setTimeout(r, LEASE_TTL_MS));
          if (deliveryStopped || (recorded && deliveryStoppedByDown(space))) break;
        }
        restartingDelivery = false;
      })();
    };
    const { authService, controlPlane } = await serveReadyListener({
      child, server, space, storeDir, setup, seedFile, transport,
      host: values.host,
      maxSessions,
      maxFileStore,
      publicExchange,
      resumeAttempt,
      resumeCommit: commitTokenHandoff(cotalRoot(), (restored?.managerCommit ?? ordinaryAttempt?.managerCommit) !== undefined, startupLock),
      runtime: values.runtime,
      noManager,
      onDeliveryExit,
    });
    if (restored && process.env.COTAL_SMOKE_FAIL_AFTER_RESTORE_LISTENER_READY === "1")
      throw new Error("smoke-injected failure after restore listener readiness");
    await completeResumeActivation(
      resumeAttempt,
      controlPlane !== undefined && authService,
      !authService ? "normal listener started but the user-auth service is unavailable" : "normal listener started but the control plane is degraded",
      server,
      startupLock,
    );
    activationFinished = true;
  }
  await new Promise<void>(() => {});
  } finally {
    releaseStartupLock();
  }
}

function assertOrdinaryUpAllowed(root: string, storeDir?: string): void {
  const maintenance = readMaintenanceJournal(root);
  if (!maintenance) return;
  if (maintenance.state === "active") {
    if (!isManagerCommittedRestore(maintenance))
      throw new Error(`restore attempt ${maintenance.restore.attemptId} is active without durable manager commit evidence`);
    if (!maintenance.listenerProof)
      throw new Error(`restore attempt ${maintenance.restore.attemptId} is active without a bound listener proof`);
    const status = localProcessOwnerStatus(maintenance.listenerProof.processOwner);
    if (status !== "dead")
      throw new Error(`restore attempt ${maintenance.restore.attemptId} active listener ownership is ${status}; refusing ordinary startup`);
    // Relaunching after restore must serve the exact recorded active target, not whatever store the
    // caller happens to name — the journal's provenance would otherwise describe a different mesh.
    if (!storeDir)
      throw new Error(`restore attempt ${maintenance.restore.attemptId} is active; relaunch with bare \`cotal up\` over the recorded target ${maintenance.restore.target.path}`);
    if (!sameStoreIdentity(readStoreIdentity(resolve(storeDir)), maintenance.restore.target))
      throw new Error(`ordinary startup after restore must use the recorded active target store ${maintenance.restore.target.path}, not ${storeDir}`);
    return;
  }
  if (maintenance.state === "ready") throw new Error("ordinary resume must begin through the attempt-bound startup path");
  throw new Error(`cotal up is refused while maintenance state is ${maintenance.state}; follow the recorded restore recovery`);
}

function markPendingResumeDegraded(attemptId: string, reason: string, heldLock?: MaintenanceLock): void {
  const ordinary = pendingOrdinaryResumes.get(attemptId);
  if (ordinary) {
    const lock = heldLock ?? acquireMaintenanceLock(ordinary.root);
    try {
      const journal = readMaintenanceJournal(ordinary.root);
      if (journal && (journal.state === "resume-intent" || journal.state === "resume-active"))
        markOrdinaryResumeDegraded(lock, reason, [{
          action: "repair",
          description: "Preserve the store and retained resume inventory; repair forward, then retry the same-principal activation.",
          paths: [journal.source.path],
        }]);
    } finally {
      if (!heldLock) releaseMaintenanceLock(lock);
    }
    return;
  }
  const restored = pendingRestores.get(attemptId);
  if (restored) markPreparedRestoreDegraded(restored.root, restored.attemptId, reason, heldLock);
}

async function resumeControlAuth(root: string, mode: "open" | "auth" | "user"): Promise<ControlAuth> {
  if (mode === "open") return {};
  const auth = await getSoleSpaceAuth(workspaceSecretStore(root), authDir(root));
  if (!auth) throw new Error("same-principal resume requires the existing space trust material");
  const identity = newIdentity();
  // The instrument's ep caller triple (1c.2b): the admin instrument's rows are lifecycle-keyed,
  // and the triple rides back so the resume/preservation calls take askManager's ep path.
  const uid = mintLifecycleUid();
  return {
    creds: await mintCreds(auth, identity, "control-caller-admin", {
      lifecycleUid: uid,
      expiresAt: Math.floor((Date.now() + 30 * 60 * 1000) / 1000),
    }),
    epCaller: { owner: DEV_OWNER, actor: identity.id, uid },
  };
}

/** The caller for the resume's admin-gated manager asks on a user mesh. The gate reads the CURRENT
 *  ledger, so they ride the logged-in operator's manager view, the principal the preserve cut used:
 *  a static instrument carries a caller the ledger has no row for. The view selects a registered
 *  manager instance, so it is taken after the readiness wait. Each ask is its own connection and a
 *  bearer lives no longer than the IdP proof behind it, so every call after the first takes a fresh
 *  bearer from the view's source, pinned to the same principal and manager instance. */
async function userManagerAuth(space: string): Promise<() => Promise<ControlAuth>> {
  const conn = await connectUserControlOrThrow({ space });
  const view = await userViewAuth(conn, "manager-caller");
  let first: string | undefined = view.bearer;
  return async () => {
    const bearer = first ?? await view.source();
    first = undefined;
    return {
      bearer,
      sentinelCreds: view.sentinelCreds,
      tls: conn.tls,
      epCaller: { owner: view.owner, actor: view.actor, uid: view.lifecycleUid },
      managerInstanceId: view.managerInstanceId,
    };
  };
}

function restoreListenerOwner(pid: number, nonce: string, startedAt: string): ProcessOwner {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("restore listener spawn returned no pid");
  return { pid, host: hostname(), startedAt, id: `restore-listener-${nonce}` };
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolveExit(exited);
    };
    child.once("exit", onExit);
  });
}

/** Listeners {@link stopFailedListener} is stopping. Their launch reports its own error, so the
 *  foreground's broker-exit handler must not report that exit as a crash and exit first. */
const failedListeners = new WeakSet<ChildProcess>();

/**
 * Stop a listener whose launch failed before it served. A signal is not proof of exit, so SIGTERM
 * escalates to SIGKILL and `nats.pid` is removed only once the exit is observed. A listener that
 * outlives both keeps its record and fails loud with its pid. A listener whose pid publish threw
 * passes `published` false and leaves `nats.pid` as found.
 */
async function stopFailedListener(child: ChildProcess, published = true): Promise<void> {
  failedListeners.add(child);
  child.kill("SIGTERM");
  if (!await waitForChildExit(child, 5_000)) {
    child.kill("SIGKILL");
    if (!await waitForChildExit(child, 5_000))
      throw new Error(`nats-server process ${child.pid ?? "unknown"} did not exit after SIGKILL`);
  }
  if (published) removePidPair(cotalPath("nats.pid"), String(child.pid));
}

function bindSpawnedRestoreListener(prepared: PreparedRestore, pid: number, startedAt: string, heldLock?: MaintenanceLock): void {
  bindRestoreListenerOwner(prepared, restoreListenerOwner(pid, prepared.serverNonce, startedAt), heldLock);
}

function bindRestoreListenerOwner(prepared: PreparedRestore, processOwner: ProcessOwner, heldLock?: MaintenanceLock): void {
  bindPreparedRestoreListener(prepared, processOwner, heldLock);
  if (process.env.COTAL_SMOKE_EXIT_AFTER_RESTORE_LISTENER_BIND === "1") process.exit(86);
}

function sameProcessOwner(a: ProcessOwner, b: ProcessOwner): boolean {
  return a.pid === b.pid && a.host === b.host && a.startedAt === b.startedAt && a.id === b.id;
}

function sameRestoreListenerProof(a: RestoreListenerProof, b: RestoreListenerProof): boolean {
  return a.attemptId === b.attemptId && a.serverName === b.serverName &&
    a.serverNonce === b.serverNonce && sameProcessOwner(a.processOwner, b.processOwner) &&
    a.serverEndpoint === b.serverEndpoint && sameStoreIdentity(a.target, b.target);
}

function readNatsInfo(endpoint: string, timeoutMs = 2_000): Promise<Record<string, unknown>> {
  return new Promise((resolveInfo, rejectInfo) => {
    let settled = false;
    let socket: ReturnType<typeof createConnection> | undefined;
    const finish = (error?: Error, info?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      if (error) rejectInfo(error);
      else resolveInfo(info!);
    };
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      rejectInfo(new Error(`invalid restore listener endpoint ${endpoint}`));
      return;
    }
    socket = createConnection({ host: url.hostname, port: Number(url.port) || 4222 });
    socket.setTimeout(timeoutMs);
    let input = "";
    socket.on("data", (chunk: Buffer) => {
      input += chunk.toString("utf8");
      if (input.length > 64 * 1024) return finish(new Error("restore listener INFO exceeds 64 KiB"));
      const newline = input.indexOf("\r\n");
      if (newline < 0) return;
      const line = input.slice(0, newline);
      const brace = line.indexOf("{");
      if (!/^INFO\b/.test(line) || brace < 0)
        return finish(new Error("restore listener did not present a NATS INFO greeting"));
      try {
        const info = JSON.parse(line.slice(brace)) as unknown;
        if (!info || typeof info !== "object" || Array.isArray(info))
          throw new Error("INFO is not an object");
        finish(undefined, info as Record<string, unknown>);
      } catch (error) {
        finish(new Error(`restore listener presented invalid NATS INFO: ${(error as Error).message}`));
      }
    });
    socket.on("timeout", () => finish(new Error("restore listener INFO timed out")));
    socket.on("error", (error) => finish(new Error(`restore listener INFO failed: ${error.message}`)));
    socket.on("close", () => finish(new Error("restore listener closed before NATS INFO")));
  });
}

/** Prove a recovered attempt's live bound listener IS ours end-to-end before adoption: launch
 *  binding, durable journal match, local pid + exact pidfile, store identity, mesh identity, the
 *  raw NATS INFO server name, and an authenticated connect confirming name + JetStream. Each attempt
 *  kind supplies only its journal match, which yields the store identity the journal recorded. */
async function proveBoundListener(
  kind: "restore" | "resume",
  attempt: Pick<PendingOrdinaryResume, "attemptId" | "serverName" | "serverNonce" | "server" | "root" | "space" | "mode">,
  proof: RestoreListenerProof | undefined,
  journalStore: (proof: RestoreListenerProof) => StoreIdentity | undefined,
  store: { path: string; changed: string },
): Promise<RestoreListenerProof> {
  const label = `${kind} attempt ${attempt.attemptId}`;
  if (!proof) throw new Error(`${label} has no bound listener proof`);
  if (proof.attemptId !== attempt.attemptId || proof.serverName !== attempt.serverName ||
      proof.serverNonce !== attempt.serverNonce || proof.serverEndpoint !== attempt.server ||
      proof.serverName !== `${proof.attemptId}-${proof.serverNonce}` || !/^[0-9a-f]{32}$/.test(proof.serverNonce) ||
      proof.processOwner.id !== `${kind}-listener-${proof.serverNonce}`)
    throw new Error(`${label} listener proof does not match its launch record`);
  const recorded = journalStore(proof);
  if (!recorded)
    throw new Error(`${label} listener proof does not exactly match durable recovery state`);
  if (proof.processOwner.host !== hostname())
    throw new Error(`${label} listener process ownership is not live and local`);
  try {
    process.kill(proof.processOwner.pid, 0);
  } catch {
    throw new Error(`${label} listener process ownership is not live and local`);
  }
  const pidPath = join(attempt.root, ".cotal", "nats.pid");
  let exactPidFile = false;
  try {
    const stat = lstatSync(pidPath);
    exactPidFile = stat.isFile() && !stat.isSymbolicLink() &&
      readFileSync(pidPath, "utf8") === String(proof.processOwner.pid);
  } catch { /* absent or unprovable */ }
  if (!exactPidFile)
    throw new Error(`${label} listener pidfile does not match its process proof`);
  if (!sameStoreIdentity(readStoreIdentity(store.path), proof.target) || !sameStoreIdentity(recorded, proof.target))
    throw new Error(`${label} ${store.changed}`);
  const mesh = findMesh(attempt.space);
  if (mesh && (mesh.server !== attempt.server || mesh.root !== attempt.root || mesh.mode !== attempt.mode))
    throw new Error(`${label} conflicts with the recorded mesh identity`);

  const info = await readNatsInfo(proof.serverEndpoint);
  if (info.server_name !== proof.serverName)
    throw new Error(`${label} reached a foreign NATS server name/nonce`);

  const auth = await resumeControlAuth(attempt.root, attempt.mode);
  const nc = await connect({
    servers: attempt.server,
    ...standaloneConnectOpts({ ...auth, /* not yet wired to a recorded transport - see broker-policy/MeshEntry work */ tls: false }),
    maxReconnectAttempts: 0,
  });
  try {
    if (nc.info?.server_name !== proof.serverName)
      throw new Error(`${label} authenticated to a foreign NATS server name/nonce`);
    if (!nc.info.jetstream) throw new Error(`${label} listener has no JetStream`);
  } finally {
    await nc.drain().catch(() => {});
  }
  return proof;
}

function provePreparedRestoreListener(prepared: PreparedRestore): Promise<RestoreListenerProof> {
  return proveBoundListener("restore", prepared, prepared.listenerProof, (proof) => {
    const journal = readMaintenanceJournal(prepared.root);
    if (!journal || (journal.state !== "commit-intent" && journal.state !== "manager-committed" && journal.state !== "degraded" && journal.state !== "active") ||
        journal.restore.attemptId !== prepared.attemptId || !journal.listenerProof ||
        !sameRestoreListenerProof(journal.listenerProof, proof) || journal.launch.server !== proof.serverEndpoint)
      return undefined;
    return journal.restore.target;
  }, { path: prepared.targetPath, changed: "target identity changed" });
}

/** Bare `up`, `up --restore` and `backup restore` on a controller cut: at
 *  `ready`, eligibility and the resume intent; before manager commitment, each member started or
 *  adopted by the journal's own start rows, the broker's listener proof bound to its started
 *  instance, then the manager; after commitment, only the manager relaunched once its exit is
 *  receipted; then the shared same-principal activation. A re-entry continues the recorded attempt;
 *  nothing here launches the legacy pidfile stack. A degraded attempt starts nothing and holds on any
 *  member that is not live. Returns whether the caller should hold the stack's lifetime in the
 *  foreground, which it does after releasing the lock. */
async function resumeControllerStack(lock: MaintenanceLock, root: string, values: { "accept-stale-checkpoint"?: boolean; runtime?: string; server?: string; "store-dir"?: string; "max-file-store"?: string; detach?: boolean; foreground?: boolean; json?: boolean; plain?: boolean }, restoreSink?: (result: RestoreStartupResult) => void): Promise<boolean> {
  let journal = readMaintenanceJournal(root)!;
  const cut = cutController(journal.cut)!;
  const space = journal.space;
  const inventory = readMaintenanceResumeDocument(root, journal.resume).inventory;
  const agents = (inventory as { agents?: Array<{ launch?: { runtime?: unknown } }> }).agents ?? [];
  // A restore's inputs were checked and journaled by `prepareRestore`; a resume takes them from the cut.
  if (!("restore" in journal)) {
    if (values.server !== undefined && values.server !== journal.cut.launch.server) throw new CommandFailure("refused", "USAGE_INVALID", "a controller resume takes its broker address from the cut; --server is refused", { target: { root, space } });
    if (values["store-dir"] !== undefined || values["max-file-store"] !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "a controller resume takes its store and cap from the cut; --store-dir and --max-file-store are refused", { target: { root, space } });
    const runtimes = [...new Set(agents.map((agent) => agent.launch?.runtime).filter((value): value is string => typeof value === "string"))];
    if (runtimes.length > 1 || (values.runtime !== undefined && runtimes[0] !== undefined && values.runtime !== runtimes[0]))
      throw new CommandFailure("refused", "USAGE_INVALID", "--runtime must equal the preserved inventory's runtime; a controller resume does not change it", { target: { root, space } });
    if (journal.state === "ready") {
      const stops = journal.cutCompletion.controllerStops ?? [];
      assertControllerCoupling(root, cut, journal.cut.launch.server, journal.source.path);
      assertStoreIdentity(journal.source);
      assertControllerResumeEligible(space, cut, stops, cut.brokerDefinitionRevision);
      const attemptId = `resume-${randomUUID()}`;
      const staleConsent = admitAndRestoreSeatCheckpoints(root, space, journal.cut.attemptId, values, inventory);
      const serverNonce = randomUUID().replaceAll("-", "");
      beginControllerResume(lock, attemptId, {
        server: journal.cut.launch.server, storeDir: journal.source.path,
        ...(typeof journal.cut.launch.maxFileStore === "number" ? { maxFileStore: journal.cut.launch.maxFileStore } : {}),
        runtime: runtimes[0] ?? "pty", detached: !values.foreground, serverName: `${attemptId}-${serverNonce}`, serverNonce,
        ...(staleConsent.length ? { acceptedStaleCheckpoints: staleConsent.map((seat) => ({ ...seat })) as unknown as JsonValue } : {}),
      });
      journal = readMaintenanceJournal(root)!;
    }
  }
  const attempt = currentControllerAttempt(root);
  const { attemptId } = attempt;
  assertControllerCoupling(root, cut, journal.cut.launch.server, journal.source.path, { stackOperationId: attempt.stackOperationId, attemptId });
  const restoring = "restore" in journal;
  const launch = ("ordinaryResume" in journal ? journal.ordinaryResume.launch : (journal as CommitIntentRecord).launch) as { server: string; serverName: string; serverNonce: string; runtime: string; detached: boolean; maxFileStore?: number };
  try {
    if (journal.state === "resume-intent" || journal.state === "commit-intent") {
      await startControllerMembers(lock, root, space, launch.serverName);
      const brokerInfo = await readNatsInfo(launch.server);
      if (brokerInfo.server_name !== launch.serverName) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the resumed broker reports another server name than this attempt recorded; nothing further was started", { target: { root, space } });
      bindControllerBroker(lock, root, space, launch);
      await startControllerMember(lock, root, space, "manager", managerResumeAttempt(root));
    } else if (journal.state === "resume-committed" || journal.state === "manager-committed") {
      assertControllerMembersLive(root, space, "manager");
      await relaunchCommittedManager(lock, root, space);
    } else if (journal.state !== "active") {
      assertControllerMembersLive(root, space);
    }
  } catch (error) {
    settleControllerResume(root, isCommandFailure(error) && error.outcome === "refused" ? "refused" : "unknown");
    throw error;
  }
  // Read before activation: a new broker instance replaces the cut's retired record, which is
  // removed once the attempt is active.
  const broker = controllerAttemptBrokerInstance(root, space);
  const stops = (journal as MaintenanceReadyRecord).cutCompletion.controllerStops ?? [];
  const retireBroker = attempt.brokerRequired ? () => removeRetiredBrokerInstance(space, cut, stops) : undefined;
  journal = readMaintenanceJournal(root)!;
  let targetPath = journal.source.path;
  try {
    if (restoring) {
      const record = journal as CommitIntentRecord | RestoreManagerCommittedRecord | RestoreActiveRecord | RestoreDegradedRecord;
      const prepared = pendingRestores.get(attemptId) ?? rehydratePreparedRestore(root, record);
      if (record.listenerProof) prepared.listenerProof = record.listenerProof;
      pendingRestores.set(attemptId, prepared);
      targetPath = record.restore.target.path;
      if (record.state === "active") {
        pendingRestores.delete(attemptId);
        retireActiveRestoreBroker(root, attemptId, retireBroker, lock);
      } else {
        await completeResumeActivation(attemptId, true, "controller stack restored", launch.server, lock, retireBroker);
      }
    } else {
      pendingOrdinaryResumes.set(attemptId, {
        root, attemptId, space, mode: journal.mode, server: launch.server, storeDir: journal.source.path,
        ...(launch.maxFileStore !== undefined ? { maxFileStore: launch.maxFileStore } : {}),
        runtime: launch.runtime, detached: launch.detached, inventory,
        journalState: journal.state as PendingOrdinaryResume["journalState"],
        ...(journal.state === "resume-committed" ? { managerCommit: journal.managerCommit } : {}),
        serverName: launch.serverName, serverNonce: launch.serverNonce,
      });
      await completeResumeActivation(attemptId, true, "controller stack resumed", launch.server, lock, retireBroker);
    }
  } catch (error) {
    settleControllerResume(root, "unknown");
    throw error;
  }
  settleControllerResume(root, "completed", { ...(attempt.brokerRequired ? { brokerInstanceId: broker.instanceId } : {}), ...(restoring ? { storeDir: targetPath } : {}) });
  if (restoring) {
    const restored = readMaintenanceJournal(root) as RestoreActiveRecord;
    const has = (role: string) => cut.members.some((member) => member.role === role);
    const result: RestoreStartupResult = {
      attemptId, space, root, server: launch.server, mode: restored.mode, selection: restored.launch.restoreOnly === "registry" ? "registry" : "full",
      targetPath, runtime: launch.runtime, brokerPid: broker.pid, delivery: has("delivery"), authService: has("auth"), controlPlane: true, manager: true,
    };
    if (restoreSink) restoreSink(result);
    else writeResult(presentationOf(values), { command: "up", target: { root, space, server: launch.server }, result: { kind: "controller-stack-restore", root, space, server: launch.server, attemptId, targetPath, selection: result.selection, retiredBrokerRemoved: attempt.brokerRequired } }, (row) => ({ sections: [{ title: "Controller stack restored", blocks: [
      { kind: "fields", rows: [["Space", row.space], ["Root", row.root], ["Broker", row.server], ["Attempt", row.attemptId], ["Store", row.targetPath], ["Selection", row.selection]] },
      { kind: "lines", lines: ["Each recorded member was started or adopted for this attempt, and the retained agents were resumed under the same principals. The restore journal stays active until its fallback is cleaned up. This is not agent or task readiness."] },
    ] }] }));
    return values.foreground === true && !restoreSink;
  }
  writeResult(presentationOf(values), { command: "up", target: { root, space, server: launch.server }, result: { kind: "controller-stack-resume", root, space, server: launch.server, attemptId, seatResume: agents.length ? "requested" : "not-requested" } }, (row) => ({ sections: [{ title: "Controller stack resumed", blocks: [
    { kind: "fields", rows: [["Space", row.space], ["Root", row.root], ["Broker", row.server], ["Attempt", row.attemptId], ["Retained agents", row.seatResume]] },
    { kind: "lines", lines: ["Each recorded member was started or adopted from its own recorded instance, and the retained agents were resumed under the same principals. This is not agent or task readiness."] },
  ] }] }));
  return values.foreground === true;
}

/** An active controller restore whose attempt started a new broker removes the cut's retired record
 *  here; a mismatch degrades the restore with its reason and removes nothing. */
function retireActiveRestoreBroker(root: string, attemptId: string, retireBroker: (() => void) | undefined, heldLock?: MaintenanceLock): void {
  if (!retireBroker) return;
  try { retireBroker(); }
  catch (error) {
    markPreparedRestoreDegraded(root, attemptId, error instanceof Error ? error.message : String(error), heldLock);
    throw error;
  }
}

/** Hand a manager-committed attempt's commit token to the next manager as a protected file. The
 *  token is read from the journal under the maintenance lock and never travels on argv. An attempt
 *  with no manager commit has nothing to hand off. */
function commitTokenHandoff(root: string, committed: boolean, heldLock?: MaintenanceLock): { path: string; sha256: string } | undefined {
  if (!committed) return undefined;
  const lock = heldLock ?? acquireMaintenanceLock(root);
  try {
    sweepTokenHandoff(lock);
    return writeTokenHandoff(lock);
  } finally {
    if (!heldLock) releaseMaintenanceLock(lock);
  }
}

function bindSpawnedOrdinaryResumeListener(pending: PendingOrdinaryResume, pid: number, startedAt: string, heldLock?: MaintenanceLock): void {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("resume listener spawn returned no pid");
  const lock = heldLock ?? acquireMaintenanceLock(pending.root);
  try {
    const journal = readMaintenanceJournal(pending.root);
    if (!journal || !("ordinaryResume" in journal) || journal.ordinaryResume.attemptId !== pending.attemptId)
      throw new Error(`resume listener bind does not match attempt ${pending.attemptId}`);
    bindOrdinaryResumeListener(lock, {
      attemptId: pending.attemptId,
      serverName: pending.serverName,
      serverNonce: pending.serverNonce,
      processOwner: { pid, host: hostname(), startedAt, id: `resume-listener-${pending.serverNonce}` },
      serverEndpoint: pending.server,
      target: journal.source,
    });
  } finally {
    if (!heldLock) releaseMaintenanceLock(lock);
  }
}

function proveOrdinaryResumeListener(pending: PendingOrdinaryResume): Promise<RestoreListenerProof> {
  return proveBoundListener("resume", pending, pending.adoptProof, (proof) => {
    const journal = readMaintenanceJournal(pending.root);
    if (!journal || !("ordinaryResume" in journal) || journal.ordinaryResume.attemptId !== pending.attemptId ||
        !journal.listenerProof || !sameRestoreListenerProof(journal.listenerProof, proof) ||
        journal.ordinaryResume.launch.server !== proof.serverEndpoint)
      return undefined;
    return journal.source;
  }, { path: pending.storeDir, changed: "preserved source identity changed" });
}

/** Light wire check for a freshly SPAWNED ordinary-resume listener: the greeted server must carry
 *  the attempt's exact name/nonce (the full seven-point prove is for adopting a survivor). */
async function verifySpawnedOrdinaryListener(pending: PendingOrdinaryResume): Promise<void> {
  const info = await readNatsInfo(pending.server);
  if (info.server_name !== pending.serverName)
    throw new Error(`resume attempt ${pending.attemptId} spawned listener reports a foreign NATS server name`);
}

async function resumeProvenOrdinaryListener(pending: PendingOrdinaryResume, heldLock?: MaintenanceLock): Promise<void> {
  await proveOrdinaryResumeListener(pending);
  const svc = await ensureRecoveredUserAuth(pending);
  // Read the recorded exposure BEFORE re-recording: `recordOurMesh` writes the entry whole, so a
  // record built without this field would erase the operator's decision, and the adopted manager
  // below would then be launched loopback-only from an entry that no longer remembers otherwise.
  const adoptAttachHost = attachHostFor(pending.space);
  const adoptMaxSessions = maxSessionsFor(pending.space);
  recordOurMesh({
    space: pending.space,
    server: pending.server,
    root: pending.root,
    mode: pending.mode,
    // Adopted from the recorded policy: this path proves and re-adopts a listener it did not start.
    tlsRequired: adoptedTlsRequired(pending.root),
    ...(svc.userAuth ? { userAuth: svc.userAuth } : {}),
    ...(adoptAttachHost ? { attachHost: adoptAttachHost } : {}),
    ...(adoptMaxSessions !== undefined ? { maxSessions: adoptMaxSessions } : {}),
    ...(pending.maxFileStore !== undefined ? { maxFileStore: pending.maxFileStore } : {}),
    storeDir: resolve(pending.storeDir),
    ts: new Date().toISOString(),
  }, "started");
  const controlPlane = await startDeliveryWithBroker(pending.space, pending.server, adoptedTlsRequired(pending.root), {
    runtime: pending.runtime,
    attachHost: adoptAttachHost,
    maxSessions: adoptMaxSessions,
    resumeAttempt: pending.attemptId,
    resumeCommit: commitTokenHandoff(pending.root, pending.managerCommit !== undefined, heldLock),
  });
  await completeResumeActivation(
    pending.attemptId,
    controlPlane !== undefined && svc.ok,
    !svc.ok ? "adopted resume listener has no user-auth service" : "adopted resume listener has a degraded control plane",
    pending.server,
    heldLock,
  );
}

async function ensureRecoveredUserAuth(
  prepared: Pick<PreparedRestore, "mode" | "root" | "space" | "server">,
): Promise<{ ok: boolean; userAuth?: UserAuthInfo }> {
  if (prepared.mode !== "user") return { ok: true };
  const auth = await getSpaceAuth(workspaceSecretStore(prepared.root), prepared.space);
  if (!auth) throw new Error("restored user-auth listener has no retained trust material");
  const stateDir = userAuthStateDir(prepared.root, prepared.space);
  const provider = await resolveAuthProvider().prepareServer({
    space: prepared.space,
    operatorSeed: auth.operator.seed,
    account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    store: workspaceSecretStore(prepared.root),
    dir: stateDir,
  });
  return startUserAuthService(prepared.space, prepared.server, { prepared: provider, stateDir });
}

async function resumeProvenRestoreListener(prepared: PreparedRestore, heldLock?: MaintenanceLock): Promise<void> {
  await provePreparedRestoreListener(prepared);
  const svc = await ensureRecoveredUserAuth(prepared);
  // Same ordering constraint as the pending-adopt path above: capture the recorded exposure before
  // `recordOurMesh` rewrites the entry, or a restore silently demotes the mesh to loopback attach.
  const restoreAttachHost = attachHostFor(prepared.space);
  const restoreMaxSessions = maxSessionsFor(prepared.space);
  recordOurMesh({
    space: prepared.space,
    server: prepared.server,
    root: prepared.root,
    mode: prepared.mode,
    // Same as the ordinary-resume path: a restore adopts an existing listener, so the requirement
    // comes from the policy that listener was started from, never from a default.
    tlsRequired: adoptedTlsRequired(prepared.root),
    ...(svc.userAuth ? { userAuth: svc.userAuth } : {}),
    ...(restoreAttachHost ? { attachHost: restoreAttachHost } : {}),
    ...(restoreMaxSessions !== undefined ? { maxSessions: restoreMaxSessions } : {}),
    storeDir: resolve(prepared.targetPath),
    ts: new Date().toISOString(),
  }, "started");
  const controlPlane = await startDeliveryWithBroker(prepared.space, prepared.server, adoptedTlsRequired(prepared.root), {
    runtime: prepared.runtime,
    attachHost: restoreAttachHost,
    maxSessions: restoreMaxSessions,
    resumeAttempt: prepared.attemptId,
    resumeCommit: commitTokenHandoff(prepared.root, prepared.managerCommit !== undefined, heldLock),
  });
  await completeResumeActivation(
    prepared.attemptId,
    controlPlane !== undefined && svc.ok,
    !svc.ok ? "proven restore listener has no user-auth service" : "proven restore listener has a degraded control plane",
    prepared.server,
    heldLock,
  );
}

async function completeResumeActivation(
  attemptId: string | undefined,
  healthy: boolean,
  reason: string,
  server: string,
  heldLock?: MaintenanceLock,
  retireBroker?: () => void,
): Promise<void> {
  if (!attemptId) return;
  const ordinary = pendingOrdinaryResumes.get(attemptId);
  const restored = pendingRestores.get(attemptId);
  const pending = ordinary ?? restored;
  if (!pending) throw new Error(`resume activation lost attempt context ${attemptId}`);
  if (!healthy) {
    markPendingResumeDegraded(attemptId, reason, heldLock);
    throw new Error(reason);
  }
  let journal = readMaintenanceJournal(pending.root);
  if (!journal) throw new Error(`resume attempt ${attemptId} lost its durable workspace journal`);
  if (restored) {
    if (!("restore" in journal) || journal.restore.attemptId !== attemptId)
      throw new Error(`restore activation journal does not match attempt ${attemptId}`);
    if (journal.state === "active") {
      restored.cleanupStage();
      pendingRestores.delete(attemptId);
      return;
    }
  } else {
    if (!("ordinaryResume" in journal) || journal.ordinaryResume.attemptId !== attemptId)
      throw new Error(`ordinary resume journal does not match attempt ${attemptId}`);
    if (journal.state === "resume-retired") {
      const lock = heldLock ?? acquireMaintenanceLock(ordinary!.root);
      try { consumeRetiredMaintenance(lock); }
      finally { if (!heldLock) releaseMaintenanceLock(lock); }
      pendingOrdinaryResumes.delete(attemptId);
      return;
    }
  }

  let managerCommit: ManagerCommitEvidence | undefined;
  if (restored && (journal.state === "manager-committed" ||
      (journal.state === "degraded" && journal.managerCommit))) {
    managerCommit = journal.managerCommit;
    restored.managerCommit = managerCommit;
    restored.journalState = journal.state;
  } else if (ordinary && journal.state === "resume-committed") {
    managerCommit = journal.managerCommit;
    ordinary.journalState = "resume-committed";
  }

  const auth = await resumeControlAuth(pending.root, pending.mode);
  const readinessDeadline = Date.now() + 20_000;
  for (;;) {
    const ready = await askManager(pending.space, server, "ps", undefined, auth, "any", 2_000);
    // Wait only while nothing ANSWERS (the manager is still coming up). Any answer, including a
    // refusal, ends the wait: a refusal will not heal by waiting, and the resume call right after
    // this fails loud on it with its own message.
    if (!ready.unanswered) break;
    if (Date.now() >= readinessDeadline) {
      const why = ready.error ?? "no manager answered within the readiness deadline";
      markPendingResumeDegraded(attemptId, why, heldLock);
      throw new Error(why);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  let userAuth: (() => Promise<ControlAuth>) | undefined;
  // The auth for one admin-gated ask. A failed user-mode renewal degrades the journal only where a
  // refusal of that ask would.
  const askAuth = async (degrade: boolean): Promise<ControlAuth> => {
    if (pending.mode !== "user") return auth;
    try {
      userAuth ??= await userManagerAuth(pending.space);
      return await userAuth();
    } catch (e) {
      if (degrade) markPendingResumeDegraded(attemptId, e instanceof Error ? e.message : String(e), heldLock);
      throw e;
    }
  };
  const resumed = await askManager(
    pending.space,
    server,
    "resumePreserved",
    {
      attemptId,
      inventory: restored?.selection === "registry"
        ? { ...(pending.inventory as Record<string, unknown>), agents: [] }
        : pending.inventory as Record<string, unknown>,
    },
    await askAuth(true),
    "any",
    10 * 60 * 1000,
  );
  if (!resumed.ok) {
    const detail = resumed.data ? ` (${JSON.stringify(resumed.data)})` : "";
    const message = `${resumed.error ?? "retained-agent resume failed"}${detail}`;
    markPendingResumeDegraded(attemptId, message, heldLock);
    throw new Error(message);
  }
  if (restored && process.env.COTAL_SMOKE_EXIT_AFTER_RESUME_PRESERVED === "1") process.exit(88);
  if (ordinary && !managerCommit) {
    const lock = heldLock ?? acquireMaintenanceLock(ordinary.root);
    try {
      const current = readMaintenanceJournal(ordinary.root);
      if (current?.state !== "resume-active") {
        markOrdinaryResumeActive(lock, {
          operation: "resumePreserved",
          attemptId,
          state: "awaitingCommit",
          observedAt: new Date().toISOString(),
        });
      }
      ordinary.journalState = "resume-active";
    } finally {
      if (!heldLock) releaseMaintenanceLock(lock);
    }
  }
  if (!managerCommit) {
    const committed = await askManager(
      pending.space,
      server,
      "commitResume",
      { attemptId },
      await askAuth(true),
      "any",
      40_000,
    );
    if (!committed.ok) {
      const message = committed.error ?? "manager resume commit failed";
      markPendingResumeDegraded(attemptId, message, heldLock);
      throw new Error(message);
    }
    if (!isManagerCommitResult(committed.data, attemptId)) {
      const message = `manager resume commit returned invalid awaiting-finalize evidence for attempt ${attemptId}`;
      markPendingResumeDegraded(attemptId, message, heldLock);
      throw new Error(message);
    }
    managerCommit = committed.data;
    if (ordinary) {
      const lock = heldLock ?? acquireMaintenanceLock(ordinary.root);
      try {
        recordOrdinaryResumeManagerCommit(lock, managerCommit);
        ordinary.journalState = "resume-committed";
        ordinary.managerCommit = managerCommit;
      } finally {
        if (!heldLock) releaseMaintenanceLock(lock);
      }
    } else {
      recordPreparedRestoreManagerCommit(restored!, managerCommit, heldLock);
    }
    if (process.env.COTAL_SMOKE_EXIT_AFTER_RESUME_COMMIT === "1") process.exit(89);
  } else {
    const recommitted = await askManager(
      pending.space,
      server,
      "commitResume",
      { attemptId },
      await askAuth(false),
      "any",
      40_000,
    );
    // A surviving manager that already finalized legitimately answers {state:"active"} with the
    // exact durable token: accept both committed shapes idempotently, then reissue the token-bound
    // finalize (itself idempotent) below.
    const recovered = recommitted.ok ? recommitted.data as { attemptId?: unknown; state?: unknown; durableCommitToken?: unknown } : undefined;
    const exactToken = Boolean(recovered && typeof recovered === "object" &&
      recovered.attemptId === attemptId &&
      recovered.durableCommitToken === managerCommit.durableCommitToken &&
      (recovered.state === "awaitingFinalize" || recovered.state === "active"));
    if (!exactToken)
      throw new Error(`replacement manager did not recover the durable commit token for attempt ${attemptId}`);
  }

  const finalized = await askManager(
    pending.space,
    server,
    "finalizeResume",
    { attemptId, durableCommitToken: managerCommit.durableCommitToken },
    await askAuth(false),
    "any",
    40_000,
  );
  if (!finalized.ok)
    throw new Error(finalized.error ?? `manager resume finalize failed for attempt ${attemptId}`);
  if (!isManagerFinalizeResult(finalized.data, attemptId))
    throw new Error(`manager resume finalize returned invalid active evidence for attempt ${attemptId}`);
  const finalizeEvidence: ManagerFinalizeEvidence = {
    attemptId,
    state: "active",
    durableCommitToken: managerCommit.durableCommitToken,
  };
  if (process.env.COTAL_SMOKE_EXIT_AFTER_RESUME_FINALIZE === "1") process.exit(91);

  if (ordinary) {
    // A controller resume that started a new broker removes the cut's retired record before the
    // journal is retired; a mismatch leaves the committed attempt to recover forward.
    retireBroker?.();
    const lock = heldLock ?? acquireMaintenanceLock(ordinary.root);
    try {
      // The finalized manager has read or abandoned its handoff file; settle it before retirement.
      settleTokenHandoff(lock);
      retireOrdinaryResume(lock, finalizeEvidence);
      consumeRetiredMaintenance(lock);
    } finally {
      if (!heldLock) releaseMaintenanceLock(lock);
    }
    pendingOrdinaryResumes.delete(attemptId);
  } else {
    restored!.managerCommit = managerCommit;
    markPreparedRestoreActive(restored!, finalizeEvidence, heldLock);
    restored!.cleanupStage();
    pendingRestores.delete(attemptId);
    retireActiveRestoreBroker(restored!.root, attemptId, retireBroker, heldLock);
  }
}

/** Validate + assemble the auth-service daemon's public-exchange argv from `up`'s flags. The three
 *  flags travel with --user-auth (an open mesh has no exchange to publish); --exchange-public-url
 *  and --exchange-trusted-proxy modify the public listener, so they require its port. Returned as
 *  an argv ARRAY — the daemon re-exec never shell-interpolates. */
function publicExchangeArgs(
  v: { "exchange-public-port"?: string; "exchange-public-url"?: string; "exchange-trusted-proxy"?: boolean; "advertised-server"?: string; "agent-provisioning-url"?: string },
  wantUser: boolean,
): string[] {
  const port = v["exchange-public-port"];
  const url = v["exchange-public-url"];
  const proxy = Boolean(v["exchange-trusted-proxy"]);
  const advertised = v["advertised-server"];
  const provisioning = v["agent-provisioning-url"];
  if (port === undefined && url === undefined && !proxy && advertised === undefined && provisioning === undefined) return [];
  if (!wantUser)
    throw new Error("--exchange-public-port/--exchange-public-url/--exchange-trusted-proxy/--advertised-server/--agent-provisioning-url are for user-auth spaces - pair them with --user-auth");
  if (port === undefined) throw new Error("--exchange-public-url/--exchange-trusted-proxy/--advertised-server/--agent-provisioning-url require --exchange-public-port");
  return [
    "--exchange-public-port", port,
    ...(url !== undefined ? ["--exchange-public-url", url] : []),
    ...(proxy ? ["--exchange-trusted-proxy"] : []),
    ...(advertised !== undefined ? ["--advertised-server", advertised] : []),
    ...(provisioning !== undefined ? ["--agent-provisioning-url", provisioning] : []),
  ];
}

/** Bring the space's USER-AUTH service up with the broker (user mode only — `setup.prepared` is the
 *  provider's output). Loud both ways (U5): a ready service prints the login line; a service that
 *  never became ready prints the exact consequence + recourse. Returns the registry metadata either
 *  way — the mesh IS a user-auth mesh even while its service is down (connects must say "auth
 *  service down", never fall back to static semantics) — plus `ok`, so the exiting `up` surfaces
 *  (detach / manifest / refresh-heal) turn a dead identity plane into a NON-ZERO exit: automation
 *  must not read "user mesh up" from a mesh whose every user connect will be denied. */
async function startUserAuthService(
  space: string,
  server: string,
  setup?: { prepared?: AuthPrepared; stateDir?: string },
  publicExchange?: string[],
  quietBoot = false,
): Promise<{ userAuth?: UserAuthInfo; ok: boolean }> {
  if (!setup?.prepared || !setup.stateDir) return { ok: true };
  try {
    const raw = await ensureAuthService({ space, server, stateDir: setup.stateDir, prepared: setup.prepared, extraArgs: publicExchange });
    // The PUBLIC face's advertised URL (when enabled) supersedes the loopback bind in the registry's
    // convenience endpoint — the discovery bundle is GENERATED from what the daemon actually serves,
    // never hand-written. The provider reports it; nothing here reads provider state files.
    const base = typeof raw.publicUrl === "string" ? raw.publicUrl : String(raw.url);
    const endpoints = { url: base, ...(typeof raw.publicUrl === "string" ? { managerAuthorityUrl: `${base.replace(/\/$/, "")}/manager-service-authority` } : {}) };
    const info = assertUserAuthInfo({ ...setup.prepared.publicAuth, endpoints });
    if (!quietBoot) console.log(c.green("✓ user-auth service up") + c.dim(` - sign in with: cotal login --idp ${info.idp.url}`));
    return { userAuth: info, ok: true };
  } catch (e) {
    console.error(c.red(`✗ user-auth service did not come up (${(e as Error).message}) - user connects to "${space}" will fail until a re-\`cotal up\` succeeds`));
    return { userAuth: assertUserAuthInfo(setup.prepared.publicAuth), ok: false };
  }
}

/** Every fresh-boot input a controller team boot freezes before its first effect. It holds no
 *  credential, trust material or launch spec; those are produced only after this plan exists. */
export interface FreshTeamBootPlan {
  root: string;
  space: string;
  server: string;
  /** The declared bind host, or undefined when the manifest left it unset (loopback default). */
  host: string | undefined;
  mode: "open" | "auth" | "user";
  idp: string | undefined;
  runtime: string;
  manifestPath: string;
  prepared: PreparedManifest;
  transport: BrokerTransport;
  maxSessions: number | undefined;
}

/** The fresh boot's read-only preparation, shared by the controller team boot. It runs the same
 *  manifest load, override, mode agreement, ownership, bind, runtime, reachability and connector
 *  refusals as the retained `upManifest` fresh path, in the same order, and writes nothing. */
export async function prepareFreshTeamBoot(file: string, opts: { space: string; transport: BrokerTransport; server?: string; host?: string; runtime?: string; open?: boolean; userAuth?: boolean; idp?: string; maxSessions?: number }): Promise<FreshTeamBootPlan> {
  const flags: UpManifestFlags = { ...opts, dryRun: false, freshTeamBoot: true };
  let prepared: PreparedManifest;
  try { prepared = loadManifest(resolve(file)); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the fresh boot manifest changed or could not be resolved before startup; no broker was started", { target: { path: resolve(file), space: opts.space } }); }
  if (opts.space !== prepared.manifest.space)
    throw new CommandFailure("refused", "CONFLICT", "the fresh boot manifest no longer names the selected space; no broker was started", { target: { selectedSpace: opts.space, declaredSpace: prepared.manifest.space } });
  const declared = prepared.manifest.broker?.auth;
  if (opts.open && declared === "user") throw new CommandFailure("refused", "CONFLICT", "--open contradicts this manifest's user-auth mode; no trust or broker was changed", { target: { space: opts.space } });
  if (opts.userAuth && declared !== "user") throw new CommandFailure("refused", "CONFLICT", "--user-auth contradicts this manifest's declared auth mode; no trust or broker was changed", { target: { space: opts.space } });
  if (opts.idp && declared !== "user") throw new CommandFailure("refused", "CONFLICT", "--idp needs this manifest's user-auth mode; no trust or broker was changed", { target: { space: opts.space } });
  const idpProblem = opts.idp === undefined ? undefined : idpUrlProblem(opts.idp, "--idp");
  if (idpProblem) throw new CommandFailure("refused", "SCHEMA_INVALID", idpProblem, { target: { space: opts.space } });
  const serverProblems = opts.server === undefined ? [] : serverUrlProblems(opts.server, "--server");
  if (serverProblems.length) throw new CommandFailure("refused", "SCHEMA_INVALID", serverProblems.join("; "), { target: { space: opts.space } });
  const eff = applyUpOverrides(prepared, flags);
  const m = eff.manifest;
  const host = m.broker?.host ?? "127.0.0.1";
  const server = m.broker?.host ? reconcileHostAndServer(m.broker.host, m.broker?.servers, "broker.host", "broker.servers") : (m.broker?.servers ?? DEFAULT_SERVER);
  const open = m.broker?.auth === false;
  const mode = open ? "open" as const : m.broker?.auth === "user" ? "user" as const : "auth" as const;
  const runtime = m.runtime ?? "pty";
  if (open && (m.defaults?.deliveryClass === "durable" || m.channels.some((channel) => channel.deliveryClass === "durable")))
    throw new CommandFailure("refused", "UNSUPPORTED", "this open manifest explicitly requests durable channel delivery, but the open broker has no delivery daemon; no channel metadata or broker was written", { target: { space: m.space }, remedy: "use static/user authentication for durable delivery, or declare live delivery for an open mesh" });
  const other = loadMeshes().filter((row) => row.space !== m.space && row.server === server);
  if (other.length) throw new CommandFailure("refused", "CONFLICT", "another local registration names this exact broker address; fresh team boot did not create a listener over its recorded target", { target: { space: m.space, server: brokerAddressForDisplay(server) ?? "not displayable", otherSpaces: other.map((row) => row.space) } });
  assertFreshTeamBootOwnership(cotalRoot(), m.space, mode);
  await assertFreshTeamBindAvailable(server, host, m.space);
  try { await preflightRuntime(runtime); }
  catch (error) { throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the requested runtime did not pass preflight; no fresh boot intent or broker was started", { target: { space: m.space, runtime }, remedy: error instanceof Error ? error.message : "inspect the selected runtime provider" }); }
  if (await isReachable(server)) throw new CommandFailure("refused", "CONFLICT", "the selected address already has a broker; fresh boot did not adopt it or start a competing listener", { target: { space: m.space, server: brokerAddressForDisplay(server) ?? "not displayable" } });
  const conn = await preflightConnectors(prepared);
  if (conn) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "connector preflight failed before the fresh boot intent; no native effect was requested", { target: { space: m.space }, remedy: conn });
  return { root: canonicalRoot(cotalRoot()), space: m.space, server, host: m.broker?.host, mode, idp: m.broker?.idp, runtime, manifestPath: resolve(file), prepared: eff, transport: assertServesDialHost(opts.transport, new URL(server).hostname), maxSessions: opts.maxSessions };
}

/** A team boot that resumes one exact stopped controller stack whose manager was never attempted.
 *  The same manifest load, agreement, durable-on-open, runtime, reachability and connector refusals
 *  as {@link prepareFreshTeamBoot}, without the fresh zero-instance ownership gate: that gate is
 *  replaced by the stopped-stack eligibility the caller binds under its lock. The manifest may not
 *  move the recorded broker: its server must equal the recorded one, and a declared bind host must
 *  equal the recorded host. Writes nothing. */
export async function prepareResumeTeamBoot(file: string, opts: { space: string; transport: BrokerTransport; recorded: { server: string; mode: "open" | "auth" | "user"; host?: string } }): Promise<FreshTeamBootPlan> {
  let prepared: PreparedManifest;
  try { prepared = loadManifest(resolve(file)); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the team manifest changed or could not be resolved before startup; nothing was resumed", { target: { path: resolve(file), space: opts.space } }); }
  if (opts.space !== prepared.manifest.space)
    throw new CommandFailure("refused", "CONFLICT", "the team manifest no longer names the selected space; nothing was resumed", { target: { selectedSpace: opts.space, declaredSpace: prepared.manifest.space } });
  const eff = applyUpOverrides(prepared, { transport: opts.transport, dryRun: false, freshTeamBoot: true });
  const m = eff.manifest;
  const server = m.broker?.host ? reconcileHostAndServer(m.broker.host, m.broker?.servers, "broker.host", "broker.servers") : (m.broker?.servers ?? DEFAULT_SERVER);
  const open = m.broker?.auth === false;
  const mode = open ? "open" as const : m.broker?.auth === "user" ? "user" as const : "auth" as const;
  const runtime = m.runtime ?? "pty";
  if (server !== opts.recorded.server || mode !== opts.recorded.mode || (m.broker?.host !== undefined && m.broker.host !== opts.recorded.host))
    throw new CommandFailure("refused", "CONFLICT", "the manifest's broker address, bind host or auth mode differs from the recorded stopped stack; nothing was resumed", { target: { space: m.space, recorded: opts.recorded, declared: { server: brokerAddressForDisplay(server) ?? "not displayable", host: m.broker?.host ?? null, mode } } });
  if (open && (m.defaults?.deliveryClass === "durable" || m.channels.some((channel) => channel.deliveryClass === "durable")))
    throw new CommandFailure("refused", "UNSUPPORTED", "this open manifest explicitly requests durable channel delivery, but the open broker has no delivery daemon; nothing was resumed", { target: { space: m.space } });
  const other = loadMeshes().filter((row) => row.space !== m.space && row.server === server);
  if (other.length) throw new CommandFailure("refused", "CONFLICT", "another local registration names this exact broker address; the stopped stack was not resumed over it", { target: { space: m.space, otherSpaces: other.map((row) => row.space) } });
  try { await preflightRuntime(runtime); }
  catch (error) { throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the requested runtime did not pass preflight; nothing was resumed", { target: { space: m.space, runtime }, remedy: error instanceof Error ? error.message : "inspect the selected runtime provider" }); }
  if (await isReachable(server)) throw new CommandFailure("refused", "CONFLICT", "the recorded broker address already answers; the stopped stack was not resumed over it", { target: { space: m.space, server: brokerAddressForDisplay(server) ?? "not displayable" } });
  const conn = await preflightConnectors(prepared);
  if (conn) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "connector preflight failed; nothing was resumed", { target: { space: m.space }, remedy: conn });
  return { root: canonicalRoot(cotalRoot()), space: m.space, server, host: opts.recorded.host, mode, idp: m.broker?.idp, runtime, manifestPath: resolve(file), prepared: eff, transport: assertServesDialHost(opts.transport, new URL(server).hostname), maxSessions: undefined };
}

/** The recorded broker transport of a prepared root, decided without persisting anything: a team
 *  boot names no TLS flags, so it inherits the root's recorded policy exactly as a bare `up` does. */
export function recordedBrokerTransport(root: string): BrokerTransport {
  return resolveTransport({}, undefined, root, { persist: false, quiet: true });
}

/** Recheck, under the fresh boot's own lock, the ownership and bind refusals that a concurrent
 *  writer could have invalidated after {@link prepareFreshTeamBoot}. */
export async function recheckFreshTeamBoot(plan: FreshTeamBootPlan, own?: { deploymentId: string }): Promise<void> {
  assertFreshTeamBootOwnership(plan.root, plan.space, plan.mode, own ? { deploymentId: own.deploymentId, server: plan.server, manifestPath: plan.manifestPath } : undefined);
  await assertFreshTeamBindAvailable(plan.server, plan.host ?? "127.0.0.1", plan.space);
}

/** The native callbacks a controller stack start uses, shared by `cotal up` and a controller team
 *  boot so both prepare, seed and record through the same native path. */
export function controllerStackNative(): StackUpNative {
  return {
    prepareBroker: async (opts) => {
      const prepared = await prepareBrokerStart({ transport: opts.transport, server: opts.server, space: opts.space, ...(opts.open ? { open: true } : {}), ...(opts.userAuth ? { userAuth: opts.userAuth } : {}), ...(opts.host ? { host: opts.host } : {}), ...(opts.storeDir ? { storeDir: opts.storeDir } : {}), ...(opts.existingStore ? { existingStore: opts.existingStore } : {}), ...(opts.maxFileStore !== undefined ? { maxFileStore: opts.maxFileStore } : {}), ...(opts.seed !== undefined ? { seed: opts.seed as ChannelRegistryFile } : opts.channels ? { channels: opts.channels } : {}), quietBoot: true });
      return { root: prepared.root, server: prepared.server, space: prepared.space, storeDir: prepared.storeDir, transport: prepared.transport, ...(prepared.setup ? { setup: { creds: prepared.setup.creds, wsPort: prepared.setup.wsPort } } : {}), ...(prepared.setup?.prepared && prepared.setup.stateDir ? { user: { prepared: prepared.setup.prepared, stateDir: prepared.setup.stateDir } } : {}), confPath: prepared.confPath, bin: prepared.bin, seedFile: prepared.seedFile };
    },
    initializeStreams: (server, space, setup, seedFile) => postStart(server, space, setup, seedFile as ChannelRegistryFile | undefined),
    recordMesh: (entry) => recordOurMesh({ ...entry, ts: new Date().toISOString() }, "started", true),
    commitTransport: (root, chosen) => commitTransportPolicy(root, chosen, true),
  };
}

/** `cotal up -f cotal.yaml` — bring up a FRESH mesh from a manifest (broker + channels + booted
 *  agents). `up -f` is a broker-CREATION command: `broker.servers` is the bind address for the NEW
 *  local broker, never a connect target. A broker already reachable there (local OR remote) means
 *  fresh boot refusal; an unbindable/remote address makes the broker fail to start (no silent
 *  local fallback). It owns the whole space, so `cotal down` tears it down without an additive
 *  ownership ledger. */
async function upManifest(file: string, opts: UpManifestFlags): Promise<void> {
  let prepared: PreparedManifest;
  try {
    prepared = loadManifest(resolve(file));
  } catch (e) {
    if (opts.freshTeamBoot) throw new CommandFailure("refused", "SCHEMA_INVALID", "the fresh boot manifest changed or could not be resolved before startup; no broker was started", { target: { path: resolve(file), space: opts.space } });
    failManifest(e);
  }
  if (opts.freshTeamBoot && opts.space !== prepared.manifest.space)
    throw new CommandFailure("refused", "CONFLICT", "the fresh boot manifest no longer names the selected space; no broker was started", { target: { selectedSpace: opts.space, declaredSpace: prepared.manifest.space } });
  refuseManifestSpaceMismatch(prepared, opts.space);
  // The auth-mode sources (flags vs manifest) must AGREE — any mismatch names both sources and the
  // exact correction in one sentence (a no-fallback identity decision, never a bare enum error).
  const declared = prepared.manifest.broker?.auth;
  const declaredStr = declared === undefined ? '"static" (the unset default)' : JSON.stringify(declared);
  if (opts.open && declared === "user") {
    if (opts.freshTeamBoot) throw new CommandFailure("refused", "CONFLICT", "--open contradicts this manifest's user-auth mode; no trust or broker was changed", { target: { space: prepared.manifest.space } });
    console.error(c.red('✗ --open contradicts this manifest\'s broker.auth: "user" - a user-auth space cannot run unauthenticated. Drop --open, or change the manifest.'));
    process.exit(1);
  }
  if (opts.userAuth && declared !== "user") {
    if (opts.freshTeamBoot) throw new CommandFailure("refused", "CONFLICT", "--user-auth contradicts this manifest's declared auth mode; no trust or broker was changed", { target: { space: prepared.manifest.space } });
    console.error(c.red(`✗ --user-auth requires manifest broker.auth: "user" (this manifest's broker.auth is ${declaredStr}). Either set broker.auth: "user" in the manifest, or drop --user-auth.`));
    process.exit(1);
  }
  if (opts.idp && declared !== "user") {
    if (opts.freshTeamBoot) throw new CommandFailure("refused", "CONFLICT", "--idp needs this manifest's user-auth mode; no trust or broker was changed", { target: { space: prepared.manifest.space } });
    console.error(c.red(`✗ --idp is for user-auth spaces (this manifest's broker.auth is ${declaredStr}) - set broker.auth: "user" in the manifest, or drop --idp.`));
    process.exit(1);
  }
  const idpProblem = opts.idp === undefined ? undefined : idpUrlProblem(opts.idp, "--idp");
  if (idpProblem) {
    if (opts.freshTeamBoot) throw new CommandFailure("refused", "SCHEMA_INVALID", idpProblem, { target: { space: prepared.manifest.space } });
    console.error(c.red(`✗ ${idpProblem}`));
    process.exit(1);
  }
  const serverProblems = opts.server === undefined ? [] : serverUrlProblems(opts.server, "--server");
  if (serverProblems.length) {
    if (opts.freshTeamBoot) throw new CommandFailure("refused", "SCHEMA_INVALID", serverProblems.join("; "), { target: { space: prepared.manifest.space } });
    for (const problem of serverProblems) console.error(c.red(`✗ ${problem}`));
    process.exit(1);
  }
  // Apply CLI overrides to one effective manifest (flag > manifest > default) so render + seed +
  // broker + launch all agree on the same values.
  const eff = applyUpOverrides(prepared, opts);
  const m = eff.manifest;
  const host = m.broker?.host ?? "127.0.0.1";
  // Same bind-vs-probe reconciliation as the flag path: a manifest that sets `broker.host` without
  // an explicit `broker.servers` would otherwise bind one address and be probed at another.
  const server = m.broker?.host ? reconcileHostAndServer(m.broker.host, m.broker?.servers, "broker.host", "broker.servers") : (m.broker?.servers ?? DEFAULT_SERVER);
  const open = m.broker?.auth === false; // default is auth
  const userAuth = m.broker?.auth === "user" ? { idpUrl: m.broker.idp } : undefined;
  const runtime = m.runtime ?? "pty";
  if (open && (m.defaults?.deliveryClass === "durable" || m.channels.some((channel) => channel.deliveryClass === "durable")))
    throw new CommandFailure("refused", "UNSUPPORTED", "this open manifest explicitly requests durable channel delivery, but the open broker has no delivery daemon; no channel metadata or broker was written", { target: { space: m.space, defaultDurable: m.defaults?.deliveryClass === "durable", channels: m.channels.filter((channel) => channel.deliveryClass === "durable").map((channel) => channel.name) }, remedy: "use static/user authentication for durable delivery, or declare live delivery for an open mesh" });
  if (opts.freshTeamBoot) {
    const other = loadMeshes().filter((row) => row.space !== m.space && row.server === server);
    if (other.length) throw new CommandFailure("refused", "CONFLICT", "another local registration names this exact broker address; fresh team boot did not create a listener over its recorded target", { target: { space: m.space, server: brokerAddressForDisplay(server) ?? "not displayable", otherSpaces: other.map((row) => row.space) }, remedy: "inspect both registrations and their native brokers; exact-address conflicts block creation, while no conflict does not prove exclusivity" });
  }
  if (opts.freshTeamBoot) {
    assertFreshTeamBootOwnership(cotalRoot(), m.space, open ? "open" : userAuth ? "user" : "auth");
    await assertFreshTeamBindAvailable(server, host, m.space);
  }
  // A manifest's agents are booted BY the manager `up -f` starts with the mesh, so `--no-manager`
  // against a manifest declaring agents asks for a boot that cannot deliver its own plan. Refused
  // before the dry-run print and before anything boots.
  if (opts.noManager && eff.agents.length)
    throw new Error(`--no-manager cannot launch this manifest: it declares ${eff.agents.length} agent(s), and a manifest's agents are booted by its manager (which --no-manager omits). Drop --no-manager, or use a broker-only manifest with no agents.`);
  const effectiveNoManager = Boolean(opts.noManager);
  // The open-mesh refusal must be RE-STATED here, not only against the CLI `--open` flag: on this
  // path openness comes from the MANIFEST (`broker.auth: false`), which the flag-level guard cannot
  // see. Without it, `cotal up -f open.yaml --rotate-sys` boots an open broker, exits 0 and rotates
  // nothing: a rotation ask answered with silent success, the exact failure class this change
  // exists to remove. Before the dry-run print and before anything boots.
  if (opts.rotateSys && open)
    throw new Error("--rotate-sys is for auth meshes: this manifest sets broker.auth: false (open), so there is no system account or $SYS credentials to rotate");

  if (opts.dryRun) {
    // Dial-host SAN must refuse here too (S6). The real route runs assertServesDialHost after
    // the plan is computed; dry-run used to return before that check and green-lit a launch
    // the applying command refuses. Validate against the effective server; still no writes.
    // Announce only AFTER the dial-host check so a wrong-SAN dry-run does not print TLS: serving.
    assertServesDialHost(opts.transport, new URL(server).hostname);
    // Connector preflight on the dry-run path too (#315): the real route refuses a manifest at
    // preflightConnectors before anything boots; a dry run that plans a launch the applying
    // command refuses is the same green-lit-a-refusal failure class.
    const dryConn = await preflightConnectors(prepared);
    if (dryConn) {
      console.error(c.red(`✗ connector preflight failed: ${dryConn}`));
      process.exit(1);
    }
    if (opts.transport.kind === "tls-required") announceTransport(opts.transport);
    console.log(renderUpPlan(eff, server));
    // The omission is part of the plan (#1417): a dry run that lists a manager the real boot
    // will not start is the exact "green-lit a launch the applying command refuses" failure.
    if (effectiveNoManager)
      console.log(c.dim("  no manager will start on this host (--no-manager): broker, channels and, in auth mode, the delivery daemon come up, and no agents launch from here"));
    return;
  }

  // Preflight an extension runtime before starting the broker. The detached manager re-execs this
  // CLI and resolves the same installed package when `supervise --runtime <name>` starts.
  try { await preflightRuntime(runtime); }
  catch (error) {
    throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `the requested runtime did not pass preflight; ${opts.freshTeamBoot ? "no fresh boot intent or broker was started" : "no broker was started"}`, { target: { space: m.space, runtime }, remedy: error instanceof Error ? error.message : "inspect the selected runtime provider" });
  }

  // up -f never adopts a running broker. The old spawn -f route is no longer a manifest deploy.
  if (await isReachable(server)) {
    if (opts.freshTeamBoot) throw new CommandFailure("refused", "CONFLICT", "the selected address already has a broker; fresh boot did not adopt it or start a competing listener", { target: { space: m.space, server: brokerAddressForDisplay(server) ?? "not displayable" }, remedy: "inspect the existing broker and selected local records, or use another prepared address" });
    console.error(c.red(`✗ ${brokerAddressForDisplay(server) ?? "selected address"} already has a broker - a fresh boot will not adopt it. Stop the owned stack or select another address; team deploy supports only all-new channel cards, not agent apply.`));
    process.exit(1);
  }
  // Connectors + their required binaries must exist before any mutation (no fallback).
  const conn = await preflightConnectors(prepared);
  if (conn) {
    if (opts.freshTeamBoot) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "connector preflight failed before the fresh boot intent; no native effect was requested", { target: { space: m.space }, remedy: conn });
    console.error(c.red(`✗ connector preflight failed: ${conn}`));
    process.exit(1);
  }
  if (opts.freshTeamBoot) {
    assertFreshTeamBootOwnership(cotalRoot(), m.space, open ? "open" : userAuth ? "user" : "auth");
    await assertFreshTeamBindAvailable(server, host, m.space);
  }

  const deploymentId = genRunId();
  if (opts.freshTeamBoot) {
    try { writeFreshTeamAttempt(cotalRoot(), { schemaVersion: 1, kind: "fresh-team-attempt", deploymentId, space: m.space, root: cotalRoot(), server, authMode: open ? "open" : userAuth ? "user" : "auth", manifestPath: resolve(file), createdAt: new Date().toISOString() }); }
    catch { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "fresh boot intent creation or its durability did not confirm; no trust preparation, launch spec or listener was requested", { target: { space: m.space, deploymentId, root: cotalRoot(), intentPath: join(cotalRoot(), ".cotal", `team-boot-attempt-${deploymentId}.json`) }, remedy: "inspect the exact intent path before deciding whether any further boot can be attempted" }); }
  }

  // USER-AUTH manifest: the agents run under the LOGGED-IN operator's owner, and the launch spec
  // (consumed by the manager at boot) must carry it — so resolve it NOW. On a fresh mesh the
  // derivation material doesn't exist yet; ensure it just-in-time (authSetup + prepareServer are
  // idempotent ensure-* — the same contract the refresh-heal path already rides). Not logged in /
  // no provider = the exact recovery sentence, before anything boots.
  let owner: string | undefined;
  if (userAuth) {
    try {
      mkdirSync(cotalPath("nats"), { recursive: true, mode: 0o700 });
      // NO `rotateSys` here on purpose: this is an owner-derivation pre-resolve that runs BEFORE the
      // real boot, and the boot below carries the flag. Rotating in both would burn two generations
      // per `up -f --rotate-sys` and retire the account the first pass just minted creds against.
      const setup = await authSetup(cotalPath("nats"), server, m.space, host, userAuth, assertServesDialHost(opts.transport, new URL(server).hostname), false, undefined, opts.freshTeamBoot);
      owner = await resolveAuthProvider().ownerForLogin({ store: workspaceSecretStore(cotalRoot()), dir: setup.stateDir!, space: m.space });
    } catch (e) {
      if (opts.freshTeamBoot) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the fresh user-auth owner preparation did not confirm; trust or provider state may have changed, but no launch spec or listener was requested", { target: { space: m.space, deploymentId, root: cotalRoot() }, remedy: "inspect the retained boot intent, trust state and login before deciding another action; do not repeat an uncertain preparation" });
      console.error(c.red(`✗ ${(e as Error).message}`));
      process.exit(1);
    }
  }
  // The resolved launch spec is written FIRST so the ONE control-plane manager that comes up with
  // the broker (inside startMeshDetached) carries it. Exactly one manager serves a space (the
  // singleton lease): a second `supervise` started here for the launch would race the plain one for
  // the lease — the loser refuses, so either the agents never boot or the incumbent is orphaned
  // behind an overwritten pid file. The manager materializes each transient persona and mints creds
  // from the resolved policy — never re-reading a file for authority.
  if (opts.freshTeamBoot) {
    assertFreshTeamBootOwnership(cotalRoot(), m.space, open ? "open" : userAuth ? "user" : "auth", { deploymentId, server, manifestPath: resolve(file) });
    try { await assertFreshTeamBindAvailable(server, host, m.space); }
    catch { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the fresh boot's bind address was not confirmed after owner preparation; no launch spec or listener was requested, but its retained intent and any prepared trust were not discarded", { target: { space: m.space, deploymentId, server: brokerAddressForDisplay(server) ?? "not displayable" }, remedy: "inspect the exact retained intent, trust state and address before deciding another boot; this bind probe does not reserve the listener" }); }
  }
  let specPath: string;
  try { specPath = writeLaunchSpec(cotalRoot(), buildLaunchSpec(eff, deploymentId, owner)); }
  catch (error) {
    if (opts.freshTeamBoot) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the fresh boot intent was recorded, but launch-spec creation did not confirm its outcome; no broker launch was attempted and the intent remains for inspection", { target: { space: m.space, deploymentId, root: cotalRoot() }, remedy: "inspect the original intent and launch-spec path before another boot; no effect was retried" });
    throw error;
  }
  // Ordinary up can reconcile a leftover manager. Fresh team boot must not signal one: its
  // stricter prewrite gate required no manager record at all, and a later contender wins
  // neither stop authority nor permission to replace it.
  if (!opts.freshTeamBoot) {
    await stopManager(m.space);
    clearManagerArtifacts(m.space);
  }
  let pid: number;
  let controlPlane = false;
  let authService = true;
  let deliveryResponderBound: boolean | null = null;
  try {
    // `m.broker?.host`, not the defaulted `host`: same reason as the flag path — only a host the
    // manifest actually declared is an exposure decision worth persisting.
    ({ pid, controlPlane, authService, deliveryResponderBound } = await startMeshDetached({ transport: opts.transport, server, space: m.space, open, userAuth, rotateSys: opts.rotateSys, host: m.broker?.host, seed: manifestToChannels(eff), runtime, launch: specPath, maxSessions: opts.maxSessions, noManager: effectiveNoManager, quietBoot: opts.freshTeamBoot }));
  } catch (e) {
    if (opts.freshTeamBoot) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the fresh broker startup did not confirm completion after its launch spec was written; the listener or control plane may have changed state and the boot was not retried", { target: { space: m.space, deploymentId, launchSpec: specPath }, changed: [{ kind: "launch-spec-written", path: specPath }], remedy: "inspect this exact run and the recorded local listener, manager and auth state before another boot" });
    console.error(c.red(`✗ ${(e as Error).message}`));
    process.exit(1);
  }
  // Transport committed inside startMeshDetached before delivery (S5+S9).
  let summaryRecorded = false;
  try {
    writeFreshTeamSummary(cotalRoot(), {
      schemaVersion: 1, kind: "fresh-team-summary", deploymentId, space: m.space,
      root: cotalRoot(), server, authMode: open ? "open" : userAuth ? "user" : "auth", brokerPid: pid, manifestPath: resolve(file),
      requestedAgents: eff.agents.map((agent) => agent.name),
      declaredChannels: m.channels.map((channel) => channel.name),
      recordedAt: new Date().toISOString(), managerRequested: !effectiveNoManager,
      controlPlaneReturned: controlPlane, authServiceReturned: authService, deliveryResponderBound,
      agentReadiness: "not-checked",
    });
    summaryRecorded = true;
  } catch {
    console.error(c.yellow(`! the native fresh boot returned but its local team summary could not be recorded (run ${deploymentId}); do not repeat the boot just to recreate the summary`));
  }
  if (opts.freshTeamBoot) {
    if (!authService || !controlPlane || !summaryRecorded || (!open && deliveryResponderBound !== true))
      throw new CommandFailure("partial", "OPERATION_PARTIAL", "the fresh broker started, but its control plane, auth service, delivery responder or local deployment summary did not confirm readiness; the same boot was not retried", { target: { space: m.space, deploymentId, brokerPid: pid, launchSpec: specPath }, changed: [{ kind: "broker-started", pid, server: brokerAddressForDisplay(server) ?? "not displayable" }, { kind: "launch-spec-written", path: specPath }, ...(summaryRecorded ? [{ kind: "fresh-summary-recorded", deploymentId }] : [])], remedy: "inspect this exact run, the local broker and manager, and any retained summary before deciding another action" });
    const inheritedAccess = eff.agents.flatMap((agent) => {
      const access = agent.inherited;
      return access.capabilities.length || access.subscribe.length || access.allowSubscribe.length || access.allowPublish.length
        ? [{ agent: agent.name, persona: agent.persona ?? null, capabilities: access.capabilities, subscribe: access.subscribe, allowSubscribe: access.allowSubscribe, allowPublish: access.allowPublish }]
        : [];
    });
    let currentSelection: string | null = null;
    let selectionChecked = false;
    try { currentSelection = getCurrent() ?? null; selectionChecked = true; }
    catch { /* The returned broker receipt remains usable without a current-default read. */ }
    const result = { kind: "fresh-team-boot" as const, space: m.space, root: cotalRoot(), deploymentId, server: brokerAddressForDisplay(server) ?? "not displayable", brokerPid: pid, manifestPath: resolve(file), runtime, currentSelection, selectionChecked,
      mode: open ? "open" : userAuth ? "user-auth" : "static-auth", controlPlaneReturned: controlPlane, authServiceReturned: authService, deliveryResponderBound, summaryRecorded,
      requestedAgents: eff.agents.map((agent) => ({ name: agent.name, application: agent.agentType, role: agent.role ?? null })),
      declaredChannels: m.channels.map((channel) => ({ name: channel.name, deliveryClass: channel.deliveryClass ?? null, replay: channel.replay ?? null, replayWindow: channel.replayWindow ?? null })), inheritedAccess, agentReadiness: "not-checked" as const };
    writeResult(opts.presentation ?? "rich", { command: "team boot", target: { space: m.space, root: cotalRoot(), deploymentId }, result, completeness: "partial", warnings: [...eff.warnings.map((warning) => ({ code: "MANIFEST_WARNING", target: { agent: warning.agent }, message: warning.message })), ...(!selectionChecked ? [{ code: "CURRENT_SELECTION_UNAVAILABLE", target: { space: m.space }, message: "The current default space could not be read after boot; no default was inferred." }] : [])] }, (data): Report => ({ sections: [
      { title: "Fresh team broker returned", blocks: [{ kind: "fields", rows: [["Space", data.space], ["Deployment", data.deploymentId], ["Root", data.root], ["Broker", data.server], ["Broker PID", String(data.brokerPid)], ["Manifest", data.manifestPath], ["Auth mode", data.mode], ["Runtime request", data.runtime], ["Current default", data.selectionChecked ? data.currentSelection ?? "none selected" : "not checked"], ["Control-plane ensure", "returned"], ["Delivery responder", data.deliveryResponderBound === null ? "not required" : "bound when boot returned"], ["Membership material", "not checked by this receipt"], ["Auth service", data.mode === "user-auth" ? "returned at boot" : "not required"], ["Launch summary", "recorded"], ["Agent readiness", "not checked"]] }, { kind: "lines", lines: ["The manager was requested as part of boot; this receipt does not establish agent joins, current broker health or whole-stack stop authority."] }] },
      { title: "Requested topology", blocks: [data.requestedAgents.length ? { kind: "table", columns: [{ key: "name", label: "Agent" }, { key: "application", label: "Application" }, { key: "role", label: "Role" }], rows: data.requestedAgents.slice(0, 100).map((agent) => ({ ...agent, role: agent.role ?? "none" })) } : { kind: "lines", lines: ["No agents requested."] }, data.declaredChannels.length ? { kind: "table", columns: [{ key: "name", label: "Channel" }, { key: "delivery", label: "Declared delivery" }, { key: "replay", label: "Declared replay" }, { key: "window", label: "Declared window" }], rows: data.declaredChannels.slice(0, 100).map((channel) => ({ name: `#${channel.name}`, delivery: channel.deliveryClass ?? "not declared", replay: channel.replay === null ? "not declared" : channel.replay ? "on" : "off", window: channel.replayWindow ?? "not declared" })) } : { kind: "lines", lines: ["No channels declared."] }, ...((data.requestedAgents.length > 100 || data.declaredChannels.length > 100) ? [{ kind: "lines" as const, lines: ["Showing at most 100 declared agents and channels; the saved summary retains all names."] }] : [])] },
      ...(data.inheritedAccess.length ? [{ title: "Persona-inherited access", blocks: [{ kind: "table" as const, columns: [{ key: "agent", label: "Agent" }, { key: "persona", label: "Persona" }, { key: "scope", label: "Outside manifest channels" }], rows: data.inheritedAccess.slice(0, 100).map((row) => ({ agent: row.agent, persona: row.persona ?? "none", scope: [row.capabilities.length ? `capabilities ${row.capabilities.join(",")}` : "", row.subscribe.length ? `subscribe ${row.subscribe.join(",")}` : "", row.allowSubscribe.length ? `read ${row.allowSubscribe.join(",")}` : "", row.allowPublish.length ? `post ${row.allowPublish.join(",")}` : ""].filter(Boolean).join(" · ") })) }, { kind: "lines" as const, lines: [...(data.inheritedAccess.length > 100 ? ["Additional inherited scopes are not shown in this terminal view."] : []), "These scopes came from referenced personas and are not limited to channels declared by this manifest."] }] }] : []),
      { title: "Next", blocks: [{ kind: "commands", items: [{ command: `cotal team show ${data.deploymentId}`, description: "Read this local launch summary" }, { command: `cotal watch --space ${data.space}`, description: "Observe the selected mesh" }, { command: `cotal down --space ${data.space} --dry-run`, description: "Inspect local stop records without stopping the stack" }] }] },
    ] }));
    return;
  }
  console.log(c.green(`✓ mesh "${m.space}" up at ${server}`) + c.dim(` (broker pid ${pid})`));
  console.log(c.dim(`  seeded ${m.channels.length} channel(s): ${m.channels.map((ch) => "#" + ch.name).join(", ")}`));
  if (summaryRecorded) console.log(c.dim(`  fresh deployment ${deploymentId} recorded; cotal team show ${deploymentId} reads its launch summary, not live ownership`));
  // Never claim a launch the control plane can't deliver: the manager carries the launch spec, so a
  // degraded control plane (announced above) means the agents are NOT coming up.
  if (effectiveNoManager) {
    // Truthful summary for the broker-only boot (#1417): nothing was omitted by accident, and the
    // agents this manifest declares (none — a declaring manifest is refused above) launch elsewhere.
    console.log(c.dim(`  broker-only (--no-manager): no manager started on this host - run \`cotal supervise --space ${m.space} --server ${server}\` from a manager host to manage agents`));
  } else if (controlPlane) {
    // U6: on a user mesh the agents run under the OPERATOR's identity — say whose they are.
    console.log(c.green(`✓ launching ${eff.agents.length} agent(s)`) + c.dim(` via manager (${runtime})${owner ? ` as you (owner ${owner})` : ""} - see ${managerLogDisplayPath(m.space)}`));
  } else {
    console.error(c.red(`✗ ${eff.agents.length} agent(s) NOT launched - the control plane did not come up (see above)`));
  }

  // Loud summary: any persona-inherited access an `include` manifest dragged in, plus warnings.
  const inherited = renderInherited(eff);
  if (inherited) console.log("\n" + inherited);
  if (eff.warnings.length) console.log("\n" + renderWarnings(eff.warnings));
  const downRoute = opts.root ? `from ${oneLine(cotalRoot())}, run \`cotal down\`` : "`cotal down`";
  console.log(c.dim(`\nWatch: \`cotal watch --space ${m.space}\` (terminal)   ·   Dashboard: configure the explicit web service preset separately   ·   Tear down: ${downRoute}`));
  // A declared-user-auth manifest whose auth service never became ready, or a degraded control
  // plane: the mesh is up + recorded, but this launch did not deliver what it declared — exit
  // non-zero so CI/wrappers don't read success (the consequence line printed at the failure above).
  if (!authService || !controlPlane || !summaryRecorded) process.exitCode = 1;
}

/** CLI overrides for `up -f` — each wins over the manifest's own value (flag > manifest > default).
 *  `userAuth` is a consistency ASSERTION against the manifest, not an override, and `idp` overrides
 *  only on a user-auth manifest: the manifest declares the auth mode; a disagreeing flag is a hard
 *  error, never a silent re-mode. */
interface UpManifestFlags {
  root?: string;
  freshTeamBoot?: boolean;
  presentation?: "rich" | "json" | "plain";
  /** The listener's transport, decided above the `--file` branch. NON-OPTIONAL: this path is one of
   *  the three that used to drop `--tls-cert`/`--tls-key` at the call boundary and serve plaintext. */
  transport: BrokerTransport;
  dryRun: boolean;
  server?: string;
  host?: string;
  space?: string;
  runtime?: string;
  open?: boolean;
  userAuth?: boolean;
  idp?: string;
  /** `--rotate-sys` on the manifest path: the same class-3 renewal, carried to the ONE boot that
   *  renders the broker config (`startMeshDetached`), never to the owner-derivation pre-resolve. */
  rotateSys?: boolean;
  /** Operator-set live-session ceiling, recorded and handed to the manager started with the mesh. */
  maxSessions?: number;
  /** #1417 broker-only boot: the broker (+ channels, + delivery daemon in auth mode) comes up and
   *  NO manager starts on this host. The manifest's agents are booted BY its manager, so a manifest
   *  declaring agents under `--no-manager` is a contradiction refused before anything boots. */
  noManager?: boolean;
}

/** Return a copy of the prepared manifest with CLI overrides applied to broker/space/runtime, so the
 *  whole launch (render, seed, broker, manager, launch spec) runs against one effective manifest. */
function applyUpOverrides(prepared: PreparedManifest, o: UpManifestFlags): PreparedManifest {
  const m = prepared.manifest;
  const broker = { ...m.broker };
  if (o.server) broker.servers = o.server;
  if (o.host) broker.host = o.host;
  if (o.open) broker.auth = false;
  if (o.idp) broker.idp = o.idp;
  return {
    ...prepared,
    manifest: {
      ...m,
      broker: Object.keys(broker).length ? broker : undefined,
      runtime: (o.runtime as typeof m.runtime) ?? m.runtime,
    },
  };
}

/** Start the CONTROL PLANE alongside the broker: old-manager preflight → delivery daemon (auth
 *  mode only) → detached manager. `up` is the launching command — since `setup` became
 *  configure-only (stage 2b), the whole local stack comes up HERE, so `spawn --detach` /
 *  cotal_spawn find a manager without any setup side effect. Coupled to the broker by the
 *  daemon's watchdog + the `up`/`down` teardown. `mgr` rides through to the manager start — the
 *  `up -f` path hands THE manager its runtime + resolved launch spec here (one manager per space,
 *  so the launch can never be a second supervise). Returns the control plane it ensured, or
 *  `undefined` when it is degraded, so a caller whose output claims a manager (the `up -f` launching
 *  line) can tell the truth. */
async function startDeliveryWithBroker(
  space: string,
  server: string,
  /**
   * Whether this listener requires TLS, decided by the CALLER.
   *
   * NON-OPTIONAL, for exactly the reason {@link DetachOpts.transport} is. This used to be an
   * optional `transport` that the callee fell back on `readBrokerPolicy(cotalRoot())` for whenever
   * it was absent — and the refresh path (#836) never passed it. That path decides the same fact
   * from the mesh-registry entry AND the live `INFO`, refuses on any disagreement, and then handed
   * the decision to nobody: a root whose registry records `tlsRequired` while holding no
   * `broker-policy.json` (registered with `cotal meshes add --tls`, or a mesh that predates the
   * policy file) relaunched the delivery daemon FLAGLESS against a TLS broker. Nothing looked
   * wrong, because the daemon still upgrades on the server's unauthenticated INFO — and it holds a
   * STANDING credential and reconnects unattended, so that exposure repeats with nobody watching.
   *
   * A second durable record consulted in the callee is how the caller's copy went silently unused.
   * One decision, and it arrives as an argument.
   */
  tlsRequired: boolean,
  mgr?: {
    runtime?: string;
    launch?: string;
    attachHost?: string;
    resumeAttempt?: string;
    resumeCommit?: { path: string; sha256: string };
    /** P2 item 6: broker ws listener port for the console session client. */
    wsPort?: number;
    maxSessions?: number;
    /** #1417 broker-only mode: ensure the delivery daemon and not the manager. */
    noManager?: boolean;
    /** #2469: the foreground owner's restart hook for a daemon this launch starts. */
    onDeliveryExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  },
): Promise<Awaited<ReturnType<typeof ensureControlPlane>> | undefined> {
  try {
    const plane = await ensureControlPlane({ space, server, tls: tlsRequired, ...(mgr ?? {}) });
    // #1576: `up` either BINDS the responder or SAYS SO HERE. The delivery daemon is a hard
    // dependency of spawn, retirement and join, and this function used to return `true` for a boot
    // that started a daemon whose responder never bound — so `cotal up` printed its success banner
    // over a control plane that could not perform any of the three. The reporter's fleet ran 22
    // hours in that state. This is not a failure of `up` (live messaging is unaffected and the
    // responder may still bind), so it does not throw; it states the condition and its consequence.
    if (plane.responderBound === false)
      console.error(
        c.yellow(`! delivery responder did not bind before this boot finished - ${RESPONDER_UNBOUND_CONSEQUENCE}`) +
          c.dim(`\n  The daemon process is running and the wait is open-ended; boot durable joins reconcile by themselves once it binds (agents do NOT need respawning).\n  Watch it with \`${displayCmd()} status --components\`.`),
      );
    return plane;
  } catch (e) {
    // Non-fatal (live messaging is unaffected) — but never SILENT: without the manager,
    // `spawn --detach` / cotal_spawn have no responder, and the operator must hear it here,
    // not as an unexplained "no manager reachable" later.
    console.error(c.dim(`! control plane degraded: ${(e as Error).message} - durable delivery/manager may be down; start one with: cotal supervise`));
    return undefined;
  }
}

/**
 * Publish a spawned listener's pid, and bind a maintenance-bound one to its attempt, before anything
 * waits on it. A launch that dies before its listener serves then leaves `nats.pid` for `cotal down`
 * and a journal naming the exact process for recovery to adopt or retire. A publish or bind that
 * throws stops the listener. Both launch modes call it right after the spawn.
 */
async function recordSpawnedListener(child: ChildProcess, startedAt: string, bound?: DetachOpts["boundListener"]): Promise<void> {
  if (!child.pid) throw new Error("nats-server spawned with no pid");
  try {
    writePidPair(cotalPath("nats.pid"), child.pid); // #969/#1238: publish the pair by rename, never torn
  } catch (error) {
    // The entry at `nats.pid` may be the one that refused the publish (a directory there fails the
    // rename), so it is left as found: unrecording would read it and throw over this error.
    await stopFailedListener(child, false);
    throw error;
  }
  if (!bound) return;
  if (process.env.COTAL_SMOKE_EXIT_AFTER_RESTORE_LISTENER_SPAWN === "1") process.exit(87);
  try {
    bound.onSpawn(child.pid, startedAt);
  } catch (error) {
    await stopFailedListener(child);
    throw error;
  }
}

/**
 * Everything between spawning a listener and serving it: readiness, the broker version read and a
 * bound listener's identity check. Foreground `up` and {@link startMeshDetached} both call it, so a
 * guard added here reaches both launch modes (#2924).
 *
 * A listener that never answers or whose version read throws is stopped and its `nats.pid` removed
 * before `up` fails. Nothing has recorded the mesh yet, so a listener left running would hold the
 * port with no registry entry. A bound listener that fails its identity check is kept: its
 * maintenance journal is already bound to it.
 */
async function awaitSpawnedListener(l: {
  child: ChildProcess;
  server: string;
  space: string;
  creds?: string;
  /** Where the listener's output goes, named when it never answers. */
  log: string;
  boundListener?: DetachOpts["boundListener"];
}): Promise<void> {
  const { child, server, space } = l;
  let facts: BrokerFacts;
  try {
    if (!(await waitReady(server, l.creds))) throw new Error(`nats-server did not become reachable at ${server} - see ${l.log}`);
    facts = await brokerVersion(server, space, l.creds);
  } catch (e) {
    await stopFailedListener(child);
    throw e;
  }
  if (belowPresenceSafeBroker(facts.version) && facts.presenceFileBacked)
    console.error(
      c.yellow(
        `! nats-server ${facts.version} is below 2.14.5 and the presence bucket of "${space}" is file-backed: it can latch after a stall and close the mesh to new joins (#1356); put a nats-server 2.14.5 or newer on PATH (it wins over the bundled one)`,
      ),
    );
  if (l.boundListener) await l.boundListener.verify();
}

/**
 * Everything a launch runs once its listener answers: the space setup, the user-auth service, the
 * mesh record, the transport commit and the control plane. Foreground `up` and
 * {@link startMeshDetached} both call it, so the two launch modes cannot drift apart (#2496).
 *
 * A fresh boot whose setup throws stops the listener and removes `nats.pid` before rethrowing the
 * original error. Nothing has recorded the mesh yet, so a listener left running would hold the port
 * with no registry entry for `cotal down` to reach. A channel seed with an unparseable value fails
 * here. A resume keeps its listener: its maintenance journal is already bound to it.
 */
async function serveReadyListener(l: {
  child: ChildProcess;
  server: string;
  space: string;
  storeDir: string;
  setup?: Awaited<ReturnType<typeof authSetup>>;
  seedFile?: ChannelRegistryFile;
  transport: BrokerTransport;
  /** The raw `--host` flag, so the record can tell an operator's address from the loopback default. */
  host?: string;
  maxSessions?: number;
  maxFileStore?: number;
  publicExchange?: string[];
  resumeAttempt?: string;
  resumeCommit?: { path: string; sha256: string };
  runtime?: string;
  launch?: string;
  noManager?: boolean;
  quietBoot?: boolean;
  onDeliveryExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}): Promise<{ authService: boolean; controlPlane: Awaited<ReturnType<typeof ensureControlPlane>> | undefined }> {
  const { child, server, space, setup, transport } = l;
  if (l.resumeAttempt) await recreateMemoryBuckets(server, space, setup);
  else {
    try {
      await postStart(server, space, setup, l.seedFile);
    } catch (e) {
      await stopFailedListener(child);
      throw e;
    }
  }
  // USER MODE: the auth service comes up FIRST among the daemons — until its callout answers,
  // every user-mode connect to this broker is denied, so `up` must not report a usable user mesh
  // (nor let agents race it) on a half-started auth plane.
  const svc = await startUserAuthService(space, server, setup, l.publicExchange, l.quietBoot);
  // Record BEFORE the control plane comes up: the manager's fail-closed mode detection requires
  // an authoritative registry entry (marker-without-registry is a refused start, not a guess),
  // so the record must exist by the time it boots. A manager/delivery failure after this leaves
  // a recorded-but-degraded mesh — the documented, healable posture.
  // Resolve exposure BEFORE recording. A RESUME of an already-recorded mesh (`down
  // --preserve-state` then a bare `up`) carries the operator's `--host` only in the registry, and
  // the record below is written whole, so reading it afterwards would find the field this very call
  // had just erased.
  const attachHost = attachHostFor(space, l.host);
  const maxSessions = maxSessionsFor(space, l.maxSessions);
  recordOurMesh({
    space, server, root: cotalRoot(),
    mode: setup?.prepared ? "user" : setup ? "auth" : "open",
    // Written ALWAYS, as a boolean, unlike `attachHost` below. Absence and `false` resolve
    // identically for clients, so an omitted field would be indistinguishable from a deliberate
    // plaintext mesh — and this is the one field whose whole purpose is that the answer was
    // stated rather than defaulted.
    tlsRequired: transport.kind === "tls-required",
    ...(svc.userAuth ? { userAuth: svc.userAuth } : {}),
    // Only a real decision is persisted — an explicit `--host` now, or one carried forward from a
    // previous launch. The bare case stays absent rather than recording the loopback default as
    // though the operator had chosen it.
    ...(attachHost ? { attachHost } : {}),
    ...(maxSessions !== undefined ? { maxSessions } : {}),
    ...(l.maxFileStore !== undefined ? { maxFileStore: l.maxFileStore } : {}),
    storeDir: l.storeDir,
    ts: new Date().toISOString(),
  }, "started", l.quietBoot);
  // Commit the policy only for a listener that is up and recorded (S5), and before the control
  // plane (S9). startDeliveryWithBroker is HANDED the transport decision, so it does not depend on
  // the file at all.
  commitTransportPolicy(cotalRoot(), transport, l.quietBoot);
  // The delivery daemon self-gates on `.cotal/auth`, so an open mesh has none. Class-2 credential
  // renewal is NOT wired here: the MANAGER is the renewal owner (it is resident in every mesh mode,
  // where a foreground `up` process is not).
  const controlPlane = await startDeliveryWithBroker(space, server, transport.kind === "tls-required", {
    onDeliveryExit: l.onDeliveryExit,
    runtime: l.runtime,
    launch: l.launch,
    // The address the broker was bound to. This is what lets `cotal attach` reach this manager
    // from another machine; without it the attach face stays loopback-only, so exposing terminals
    // is never a side effect of anything but the operator binding the mesh somewhere reachable.
    attachHost,
    maxSessions,
    noManager: l.noManager,
    resumeAttempt: l.resumeAttempt,
    resumeCommit: l.resumeCommit,
    wsPort: setup?.wsPort, // P2 item 6: the console session client's broker ws port
  });
  seedPersonaAfterUp(cotalRoot(), l.quietBoot);
  return { authService: svc.ok, controlPlane };
}

export interface DetachOpts {
  /**
   * The listener's transport, resolved and validated by the CALLER.
   *
   * NON-OPTIONAL. This function used to re-derive it here from `opts`, which never carried
   * `--tls-cert`/`--tls-key` — so `cotal up --detach --tls-cert …` validated the pair, dropped it at
   * this boundary, fell through to the recorded policy (absent on a first enable), and served
   * PLAINTEXT while printing `✓ mesh up`. Re-deriving a decision in the callee is what let the
   * caller's copy be silently unused; the fix is that there is one decision and it arrives as an
   * argument.
   */
  transport: BrokerTransport;
  server?: string;
  storeDir?: string;
  /** A store that must already exist with this identity. Preparation rechecks it instead of
   *  creating the directory, and refuses a missing, replaced or relinked store. */
  existingStore?: ExistingStorePin;
  /** JetStream file storage cap in bytes (`--max-file-store`), rendered and recorded by this boot. */
  maxFileStore?: number;
  space?: string;
  open?: boolean;
  /** USER MODE: enable per-user auth (presence = on; `idpUrl` pins the IdP on first enable). */
  userAuth?: { idpUrl?: string };
  /** Rotate the space's system account before rendering the broker config, re-minting the two $SYS
   *  creds against the successor. Only this boot (and the foreground one) may set it: rotation is
   *  complete only when the broker it starts is the one carrying the rewritten config. */
  rotateSys?: boolean;
  channels?: string;
  host?: string;
  /** Channel-registry seed in memory (the `cotal up -f` manifest path), used instead of reading a
   *  `--channels` file. Takes precedence over {@link channels}. */
  seed?: ChannelRegistryFile;
  /** Live boot lines, tailed from the server's log file (safe for a detached child). */
  onLine?: (line: string) => void;
  /** PUBLIC-exchange daemon argv (`--exchange-public-port` et al), threaded verbatim to the
   *  auth-service daemon when THIS boot starts it. */
  publicExchange?: string[];
  /** Manifest launch (`cotal up -f`): the ONE control-plane manager started alongside the broker
   *  carries this runtime + resolved launch-spec path — never a second supervise (singleton lease). */
  runtime?: string;
  launch?: string;
  resumeAttempt?: string;
  resumeCommit?: { path: string; sha256: string };
  maxSessions?: number;
  /** #1417 broker-only boot (`--no-manager`): no manager starts with this broker. An `up -f` under
   *  the flag boots the broker + channels and launches NO agents from this host — a manifest's
   *  agents are booted by its manager, so a launch spec under `--no-manager` would promise a boot
   *  nothing can deliver. Refused at the flag level; carried here so every path is explicit. */
  noManager?: boolean;
  /** Fresh-team human report owns stdout; omit helper progress notes, retain stderr failures. */
  quietBoot?: boolean;
  /** Maintenance-bound listener (restore target or ordinary-resume source): named spawn, durable
   *  ownership bind immediately after, wire verification after readiness. */
  boundListener?: {
    serverName: string;
    serverNonce: string;
    onSpawn(pid: number, startedAt: string): void;
    verify(): Promise<void>;
  };
}

/** Prepare the existing broker's local trust, configuration and launch inputs without starting a
 *  listener, auth service, delivery daemon or manager. This is an explicit mutating phase, not a
 *  dry-run or service-adapter planning hook. Its returned setup includes private authority material
 *  for the coordinating caller only; it must not be logged or serialized into a public receipt. */
export async function prepareBrokerStart(opts: DetachOpts) {
  const server = opts.server ?? DEFAULT_SERVER;
  const useAuth = !opts.open;
  // Belt on the one boot that both renders the broker config and can be reached by any caller: an
  // open boot skips `authSetup` entirely, so a `rotateSys` arriving here would be dropped in silence
  // rather than refused. Callers guard this too; this is the seam that cannot be bypassed.
  if (opts.rotateSys && !useAuth)
    throw new Error("startMeshDetached: --rotate-sys is for auth meshes; an open mesh has no system account or $SYS credentials to rotate");
  const space = opts.space ?? folderSpace();
  ensureRootForSpace(space); // may pin the cwd as this space's root — before any cotalPath use
  refuseOpenOverUserState(Boolean(opts.open), space);
  const root = cotalRoot();
  const storeDir = opts.storeDir ? resolve(opts.storeDir) : cotalPath("nats");
  if (opts.existingStore) {
    if (opts.existingStore.named !== storeDir) throw new Error("prepareBrokerStart: the pinned existing store is not the store being prepared");
    recheckExistingStore(opts.existingStore, { space, storeDir });
  } else mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  await claimSpace(space, server, root);
  const seedFile = opts.seed ?? loadChannelsFile(opts.channels);
  const host = opts.host ?? "127.0.0.1";
  // The transport arrives decided. The dial-host SAN is re-checked here because THIS is where the
  // effective server is finally known — a manifest may name a different host than the flags did, and
  // a certificate that is valid for one is not thereby valid for the other.
  const transport = assertServesDialHost(opts.transport, new URL(server).hostname);
  const setup = useAuth ? await authSetup(storeDir, server, space, host, opts.userAuth, transport, opts.rotateSys, opts.maxFileStore, opts.quietBoot) : undefined;
  const port = Number(new URL(server).port) || 4222;
  // Same rule as the foreground path: every route to a listener names its transport (see
  // `writeOpenBrokerConf`). Detach must not be the mode where the fence quietly does not apply.
  const confPath = setup ? setup.confPath : writeOpenBrokerConf(storeDir, { port, host, transport, maxFileStore: opts.maxFileStore });
  // Trust preparation awaits; the pinned store is checked again before its config is handed back.
  if (opts.existingStore) recheckExistingStore(opts.existingStore, { space, storeDir });
  const args = [
    "-c", confPath,
    ...(opts.boundListener ? ["--name", opts.boundListener.serverName] : []),
  ];
  const { bin, source } = await resolveNatsServer();
  return { root, server, space, useAuth, storeDir, seedFile, host, transport, setup, confPath, args, bin, source };
}

/**
 * Open the detached broker's log with {@link openPrivateAppend}: created `0600` whatever the umask,
 * never through a symlink, and an earlier log this user owns set to `0600`. A symlink, a log another
 * user owns or a name that is not a regular file is refused and left unchanged.
 */
export function openBrokerLog(path: string): number {
  try {
    return openPrivateAppend(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    throw new CommandFailure("refused", "PERMISSION_DENIED", `no broker was started: ${(error as Error).message}`,
      { target: { path }, remedy: `remove ${path} or replace it with a regular file you own, then run cotal up again` });
  }
}

/**
 * Start a background nats-server (JetStream), wait until it's reachable, pre-create the
 * space's streams, and leave it running detached (pid in `.cotal/nats.pid`). Used by
 * `up --detach`. When `onLine` is given, boot output is tailed from the
 * log file and forwarded — the child writes to the file (not a pipe), so it survives the
 * parent exiting.
 */
export async function startMeshDetached(
  // The `= {}` default is gone with the optional transport: an options object that can be omitted
  // entirely cannot carry a mandatory decision.
  opts: DetachOpts,
): Promise<{ server: string; pid: number; source: string; controlPlane: boolean; authService: boolean; deliveryResponderBound: boolean | null; delivery: boolean; manager: boolean }> {
  const { server, space, useAuth, storeDir, seedFile, transport, setup, args, bin, source } = await prepareBrokerStart(opts);
  const logPath = cotalPath("nats.log");
  const fd = openBrokerLog(logPath);
  const startOffset = fstatSync(fd).size;
  const listenerStartedAt = new Date().toISOString();
  const child = spawn(bin, args, { detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  await recordSpawnedListener(child, listenerStartedAt, opts.boundListener);
  child.unref();

  let tailing = Boolean(opts.onLine);
  if (opts.onLine) tailLines(logPath, startOffset, opts.onLine, () => !tailing);
  try {
    await awaitSpawnedListener({ child, server, space, creds: setup?.creds, log: logPath, boundListener: opts.boundListener });
  } finally {
    tailing = false;
  }
  const { authService, controlPlane } = await serveReadyListener({
    child, server, space, storeDir, setup, seedFile, transport,
    host: opts.host,
    maxSessions: opts.maxSessions,
    maxFileStore: opts.maxFileStore,
    publicExchange: opts.publicExchange,
    resumeAttempt: opts.resumeAttempt,
    resumeCommit: opts.resumeCommit,
    runtime: opts.runtime,
    launch: opts.launch,
    noManager: opts.noManager,
    quietBoot: opts.quietBoot,
  });
  return {
    server,
    pid: child.pid ?? 0,
    source,
    controlPlane: controlPlane !== undefined,
    authService,
    deliveryResponderBound: useAuth ? controlPlane?.responderBound === true : null,
    delivery: useAuth && deliveryUp(space),
    manager: managerUp(space),
  };
}

/** THE FLIP, open-boot edition: `--open` must never boot a credless broker over a root whose
 *  space has user-auth state on disk — that would serve the space's existing JetStream store to
 *  anyone and re-record the mesh "open" over its user entry. The same fail-closed rule authSetup
 *  enforces for static re-ups, applied to the one boot path that skips authSetup entirely. */
function refuseOpenOverUserState(open: boolean, space: string): void {
  if (!open) return;
  if (!hasUserAuthState(cotalRoot(), space)) return;
  const stateDir = userAuthStateDir(cotalRoot(), space);
  throw new Error(`space "${space}" has user auth enabled (state under ${stateDir}) - \`--open\` would serve its streams without auth. Start it with \`cotal up --user-auth\`, or remove that directory deliberately to disable user auth (existing logins/grants die with it)`);
}

/** Pin cwd as its own mesh root when the nearest ancestor root already belongs to a DIFFERENT
 *  space — mode-independent.
 *
 *  Auth path: a root's `.cotal/auth` is space-bound, so an explicit `--space` naming another space
 *  cannot share that trust material. Open path: the same ancestor still owns policy, store, pid
 *  and MeshEntry; reusing it for a second space collides those (S4 open arm — child `--open --tls-*`
 *  wrote the parent's broker-policy and nats.pid while a second broker shared the JetStream store).
 *
 *  A mismatch only exists when the resolved space differs from what the ancestor already hosts.
 *  When the root was merely inherited (cwd has no `.cotal`), honor the new-space intent by making
 *  cwd its own root. Only a folder that itself holds the other space's material refuses.
 *  (When multi-space-per-root lands, that refusal becomes provision-the-new-space instead.)
 *
 *  The question this asks is "does this root hold the space being booted", NOT "what is THE space of
 *  this root". A root holding several tenants has no sole space, and asking for one there threw
 *  before the boot could reach the config render - so a `cotal up --space alpha` against a root that
 *  legitimately holds alpha and beta refused on ambiguity that its own `--space` had already
 *  resolved. The tenant list answers the real question without picking. */
function ensureRootForSpace(space: string): void {
  const root = cotalRoot();
  const cwd = process.cwd();
  // A prepared space starts only in the root `cotal space create` gave it. Checked before the mkdir
  // below, so a refused start leaves nothing behind.
  const prepared = findPreparedSpace(space);
  if (prepared && canonicalRoot(prepared.root) !== canonicalRoot(root))
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `space "${space}" is prepared in ${prepared.root}`, {
      target: { space, root: prepared.root },
      remedy: `start it with \`cotal up\` there, or \`cotal space forget ${space}\` to start it here`,
    });
  // What spaces does this root already host? Prefer auth material; fall back to a live MeshEntry
  // whose root is this directory (open meshes have no auth dir).
  const hosted = listSpaceAccounts(authDir(root));
  if (hosted.includes(space)) return;
  const existing = hosted.length
    ? hosted
    : [loadMeshes().find((m) => m.root === root || realpathSafe(m.root) === realpathSafe(root))?.space ?? preparedSpaceAt(root)?.space].filter((s): s is string => !!s);
  if (existing.length === 0 || existing.includes(space)) return;
  const names = existing.map((s) => `"${s}"`).join(", ");
  if (root !== cwd) {
    mkdirSync(join(cwd, ".cotal"), { recursive: true, mode: 0o700 });
    console.log(c.dim(`nearest mesh root ${root} hosts ${names} - making this folder its own root for "${space}"`));
    return;
  }
  throw new CommandFailure("refused", "CONFLICT", `this folder is the root of ${names} (${root}/.cotal), so it can't also run "${space}"`, {
    target: { space, root, hosted: existing },
    remedy: `${existing.length === 1 ? `run ${names} with \`cotal up --space ${existing[0]}\`` : "run one of those with `cotal up --space <name>`"}, or start "${space}" from a different folder (it becomes that mesh's own root)`,
  });
}

/** The space a `cotal up` that names none runs in this folder. The root's sole account names it
 *  first, as {@link resolveSpace} does. An open mesh has no account, and its first start replaces
 *  the prepared record with a registration, so the space this root's stack journal or its locally
 *  started registration names comes next. Without it a second `up` in the same folder resolved the
 *  default space and refused its own mesh. Several names there are refused, never picked. Then the
 *  space prepared here, then the default.
 *
 *  Only `up` asks this. `resolveSpace` also decides whether identity cleanup may attribute a root to
 *  a space (`reset-space-plan.ts`) and, through `resolveRuntimeSpace`, which space a legacy `down`
 *  removes credentials for; those keep their own answer. */
function folderSpace(): string {
  const root = cotalRoot();
  if (soleSpaceOf(authDir(root)) === undefined) {
    const named = [...new Set([readStackJournal(root)?.journal.space, ...localMeshesForRoot(root).map((m) => m.space)])].filter((s): s is string => s !== undefined);
    if (named.length > 1)
      throw new CommandFailure("refused", "CONFLICT", `this folder's stack and registrations name ${named.length} spaces (${named.map((s) => `"${s}"`).join(", ")}), so up cannot pick one`, {
        target: { root, spaces: named },
        remedy: "name the space to run with `--space`",
      });
    if (named.length === 1) return named[0];
  }
  return resolveSpace(process.cwd());
}

function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** The remedy for a hand-registered (`origin === "manual"`) space `claimSpace` refuses to touch.
 *  Branches on whether the REGISTERED server is loopback, the one authority for that being
 *  `isLoopbackHost` (`@cotal-ai/workspace`) — never a second opinion here.
 *
 *  Non-loopback: the mesh runs on another machine and this one does not take over its control
 *  plane by deleting the registry route (that route is what attach, spawn-from-anywhere, and
 *  every read verb hang off) or by forking the identity under a different `--space`. The actual
 *  next step is running that control plane FROM here, against the broker the record already
 *  names: `cotal supervise` (plus `cotal deliver` for the daemon). Dropping the record
 *  (`meshes rm`) is a separate decision for a genuinely stale record, out of scope here.
 *
 *  Loopback: unchanged — a loopback registration this machine cannot reach the "real" mesh behind
 *  (or is stale) keeps the original two-way remedy, byte for byte.
 *
 *  A server string `new URL` rejects is a record shape this function never validated before
 *  (nothing here parsed it), so it keeps the loopback wording rather than growing a parser. */
function manualClaimRemedy(space: string, server: string): string {
  let loopback = true;
  try {
    loopback = isLoopbackHost(new URL(server).hostname);
  } catch {
    loopback = true;
  }
  if (!loopback)
    return `\`cotal supervise --space ${space} --server ${server}\` to run its control plane from here (and \`cotal deliver --space ${space} --server ${server}\` for the daemon)`;
  return `\`cotal meshes rm ${space}\` to drop that record first, or start this one under a different \`--space\``;
}

/** Where a prior holder's absolute root physically resolves, or undefined when it is proven gone: it
 *  does not resolve (ENOENT, ENOTDIR) or resolves to something other than a directory. Any other
 *  failure, such as EACCES, EPERM, EIO or ELOOP, proves nothing about the root or its journal, so the
 *  name is kept and the refusal says why. No lexical spelling stands in for the physical path: under
 *  an unreadable ancestor, `<root>/link/..` resolves lexically to `<root>` while it names another. */
function priorRootPath(space: string, root: string): string | undefined {
  let real: string;
  let kind: Stats;
  try {
    real = realpathSync.native(root);
    kind = statSync(real);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw new CommandFailure("refused", code === "EACCES" || code === "EPERM" ? "PERMISSION_DENIED" : "TARGET_UNAVAILABLE", `space "${space}" is registered to ${root}, which could not be resolved (${code ?? String(e)}) - \`cotal up\` did not take the name`, { target: { space, root }, remedy: `restore access to ${root} and run this again, or start this stack under a different \`--space\`` });
  }
  return kind.isDirectory() ? real : undefined;
}

/** A space name maps to one mesh in the registry (the key `--space`/`use`/`down` act on). Before
 *  starting a broker, refuse to reuse a space already claimed by a DIFFERENT live mesh — a stale/dead
 *  holder is reclaimed, and said so when it was another root's, unless that root still holds a
 *  maintenance journal. Re-`up`ping the same mesh (same server + root) is a refresh (port-reachable
 *  path). NOTE: this is a best-effort sequential guard — two `cotal up --space X` racing from
 *  different roots within the same instant can both pass the check before either records; that
 *  concurrent case is out of scope (a single-operator CLI action), not synchronized with a lock. */
export async function claimSpace(space: string, server: string, root: string): Promise<void> {
  const existing = findMesh(space);
  if (!existing) return;
  // A relative recorded root names no directory without a guess against the cwd, so it is never
  // taken as this root, compared with it or reclaimed. Its record stays until it is removed by hand.
  const relative = !isAbsolute(existing.root);
  if (!relative && existing.server === server && existing.root === root) return;
  // Every refusal below is made before the registry changes, so it is typed as refused with its own
  // remedy, and the controller and legacy routes both show the reason and exit 2.
  const target = { space, root: existing.root, server: existing.server };
  // An OPERATOR-REGISTERED holder is decided FIRST, before liveness, because liveness changes
  // nothing about it and the two outcomes would otherwise print the wrong remedy. It is never
  // reclaimed: unreachable is not proof the mesh is gone (the record describes a broker on another
  // machine), the reclaim runs BEFORE this launch starts anything, and `cotal down` — what the
  // liveness branch below would advise — cannot stop a mesh this machine does not run.
  if (existing.origin === "manual" || existing.origin === "catalog")
    throw new CommandFailure("refused", "CONFLICT", `space "${space}" is registered to a mesh at ${existing.server} (${existing.root}) - it is ${existing.origin === "catalog" ? "owned by a signed-in space catalog" : "registered by hand"}, so \`cotal up\` neither takes it over nor reclaims the name`, { target, remedy: existing.origin === "catalog" ? "use a different `--space`, or remove access at the IdP and run `cotal sync`" : manualClaimRemedy(space, existing.server) });
  if (relative)
    throw new CommandFailure("refused", "CONFLICT", `space "${space}" is registered to ${existing.root}, which is not an absolute path - \`cotal up\` did not take the name`, { target, remedy: `drop that record with \`cotal meshes rm ${space}\`, or start this stack under a different \`--space\`` });
  if (await isReachable(existing.server))
    throw new CommandFailure("refused", "CONFLICT", `space "${space}" is already in use by a mesh at ${existing.server} (${existing.root})`, { target, remedy: "pick a different `--space`, or `cotal down` it first" });
  // The recorded root is this root only where it physically resolves, so it is resolved before any
  // comparison, and one that cannot be resolved refuses. A dead holder at another root keeps its name
  // while that root holds a preserved cut or a restore: taking it would cut that root's recovery off
  // from its space. A journal that cannot be read keeps it too. A root proven gone or not a directory
  // has no journal to read; a readable root without one is reclaimed.
  const prior = priorRootPath(space, existing.root);
  const otherRoot = prior !== canonicalRoot(root);
  if (otherRoot && prior !== undefined) {
    let held: string | undefined;
    try { held = readMaintenanceJournal(existing.root)?.state; }
    catch { held = "unreadable"; }
    if (held)
      throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `space "${space}" is registered to ${existing.root}, whose maintenance journal holds a preserved cut or a restore (state ${held}) - \`cotal up\` did not take the name`, { target, remedy: `finish that attempt from ${existing.root}, or start this stack under a different \`--space\`` });
  }
  removeMesh(space); // the prior holder's broker is gone — reclaim the name
  if (otherRoot) console.error(`• space "${space}" was registered to ${existing.root}, whose broker at ${existing.server} is not running - this up takes the name over`);
}

/**
 * The manager attach/console BIND host for a launch into `space`.
 *
 * Exposure is an operator DECISION, made at `up --host` and recorded on the mesh entry. Every later
 * launch for the same mesh — a same-root repair, adopting a preserved or restored listener, a
 * manifest deploy — has no `--host` of its own to consult, so it reads the decision back. Without
 * this a replacement manager falls to loopback and remote `cotal attach` dies at the first repair,
 * silently: the broker and every agent stay up, only the terminal face moves.
 *
 * An explicit host on THIS invocation always wins, so an operator can widen or narrow exposure by
 * saying so. Absent both, undefined — the manager's own loopback default, unchanged.
 */
export function attachHostFor(space: string, explicit?: string): string | undefined {
  return explicit ?? findMesh(space)?.attachHost;
}

/**
 * The manager live-session ceiling for a launch into `space`.
 *
 * Like {@link attachHostFor}, this is an operator DECISION (`--max-sessions`), not something later
 * commands can reconstruct. Every later manager launch — same-root repair, resume, `spawn -f` —
 * has no flag of its own unless the operator typed one, so it reads the decision back. Without
 * this a replacement manager silently falls to 64 and the next console pane past that is refused.
 *
 * An explicit value on THIS invocation always wins. Absent both, undefined — the plane's own
 * default of 64, unchanged, and nothing is recorded as though chosen.
 */
export function maxSessionsFor(space: string, explicit?: number): number | undefined {
  return explicit ?? findMesh(space)?.maxSessions;
}

/** The store cap a preserved launch recorded: absent, or a positive integer byte count. Anything
 *  else is a damaged journal, refused rather than rendered as the dynamic default. */
function journaledMaxFileStore(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`the preserved launch records an invalid maxFileStore (${JSON.stringify(value)}); refusing to guess the broker's store cap`);
  return value;
}

/**
 * Did THIS launch bring the broker up, or is it re-recording one that was already there?
 *
 * The distinction is provenance, and it has to come from the call site because it cannot be
 * observed here: `started` covers the paths that spawned the broker or proved a listener this
 * attempt owns, and stamps `origin: "up"` — a record this machine can always write back, so the
 * liveness sweep and `cotal down` may drop it. `refresh` is the "a broker is already on this port"
 * branch, which concludes the mesh is up from reachability alone and starts nothing; stamping `up`
 * there would silently convert a hand-registered record into one the next sweep may delete, so it
 * keeps whatever origin the record already had.
 */
type Provenance = "started" | "refresh";

/** {@link recordOurMesh} under a name that says it is a test seam: the origin rule it enforces is
 *  asserted directly by the registry smoke, since reaching each branch through a full `up` would
 *  need a live broker per case. */
export const recordOurMeshForTest = (m: MeshEntry, provenance: Provenance): void => recordOurMesh(m, provenance);

/** Record this mesh in the registry, and set it as the `current` default when there's no usable one
 *  — i.e. the first mesh, OR when `current` dangles at a space that's no longer in the registry (a
 *  ghost pointer is not a default). Never silently redirect a `current` that still resolves to a live
 *  mesh; just say another is the default and how to switch. */
function recordOurMesh(m: MeshEntry, provenance: Provenance, quietBoot = false): void {
  const cur = getCurrent();
  const usableCurrent = cur && (findMesh(cur) || findPreparedSpace(cur)) ? cur : undefined; // compute before recording m
  const prior = findMesh(m.space);
  const origin = provenance === "refresh" && (prior?.origin === "manual" || prior?.origin === "catalog") ? prior.origin : "up";
  // A REFRESH starts nothing: it concluded the mesh is up from reachability alone, so `m` holds only
  // what THIS launch decided, and every other field is the record as it stands now. That covers the
  // operator's past decisions (origin, overlay consent, TLS requirement) and anything another writer
  // committed while the refresh ensured the control plane; rebuilding from the refresh's earlier
  // read reverted those and still exited 0. A `started` takeover may replace the record outright
  // (that launch really is the mesh now).
  if (provenance === "refresh" && !prior)
    throw new Error(`mesh "${m.space}" was removed from the registry while \`cotal up\` refreshed it - not re-recording it from an earlier read`);
  recordMesh(provenance === "refresh" ? { ...prior, ...m, origin } : { ...m, origin });
  removePreparedSpace(m.space); // started: the registration is its record now
  if (!usableCurrent) {
    setCurrent(m.space);
    return;
  }
  if (usableCurrent !== m.space && !quietBoot)
    console.log(c.dim(`"${m.space}" up; current is still "${usableCurrent}" - \`cotal use ${m.space}\` to switch`));
}

/** Write the default persona into the root this `up` started or refreshed when it has none, and
 *  say so. The mesh is already up, so a write that fails is reported and the start stands. */
function seedPersonaAfterUp(root: string, quiet = false): void {
  let written: { what: string; path: string } | undefined;
  try {
    written = seedDefaultPersona(root);
  } catch (e) {
    console.error(c.yellow(`! the default persona was not written in ${root}: ${(e as Error).message}`));
    return;
  }
  if (written && !quiet) console.log(c.dim(`  wrote ${written.what}: ${written.path}`));
}

/** Poll a growing log file and forward newly-appended lines until `stopped()` is true. */
function tailLines(path: string, from: number, onLine: (l: string) => void, stopped: () => boolean): void {
  let offset = from;
  const tick = () => {
    if (stopped()) return;
    try {
      const size = statSync(path).size;
      if (size > offset) {
        const fd = openSync(path, "r");
        const buf = Buffer.alloc(size - offset);
        readSync(fd, buf, 0, buf.length, offset);
        closeSync(fd);
        offset = size;
        for (const line of buf.toString("utf8").split("\n")) if (line.trim()) onLine(line);
      }
    } catch {
      // file may not exist yet on the first ticks — keep polling
    }
    setTimeout(tick, 150);
  };
  setTimeout(tick, 150);
}

async function waitReady(server: string, creds?: string): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (await isReachable(server, creds ? { creds } : undefined)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// SPEC §13.12: reads the connected broker's version, and refuses loud below the 2.12 floor
// before any provisioning touches it (the same gate `requireBrokerFloor` enforces on every other
// control-surface connection).
type BrokerFacts = { version: string; presenceFileBacked: boolean };

/** The broker's version, and whether `space`'s presence stream exists file-backed. Cotal creates
 *  it in memory (#1356), so only a bucket an older cotal created is file-backed; an absent one
 *  will be created in memory by `setupSpaceStreams`. */
async function brokerVersion(server: string, space: string, creds?: string): Promise<BrokerFacts> {
  const nc = await connect({ servers: server, ...standaloneConnectOpts({ creds, tls: false }) });
  try {
    requireBrokerFloor(nc);
    const version = nc.info?.version ?? "";
    let presenceFileBacked = false;
    try {
      const info = await (await jetstreamManager(nc)).streams.info(`KV_${presenceBucket(space)}`);
      presenceFileBacked = info.config.storage === StorageType.File;
    } catch (e) {
      const err = e as { message?: string; api_error?: { err_code?: number } };
      if (err.api_error?.err_code !== 10059 && !/stream not found/i.test(err.message ?? "")) throw e;
    }
    return { version, presenceFileBacked };
  } finally {
    await nc.drain();
  }
}

// #1356: the presence bucket's file-backed latch is fixed in nats-server 2.14.5. Below that,
// `cotal up` warns when the space's presence bucket is file-backed (never refuses: 2.14.0 meets the
// SPEC §13.12 floor and is the bundled broker). A memory-backed bucket has no file store to latch.
function belowPresenceSafeBroker(version: string): boolean {
  const p = parseServerVersion(version);
  if (!p) return false;
  if (p.major !== 2) return p.major < 2;
  if (p.minor !== 14) return p.minor < 14;
  return p.patch < 5;
}

/** Wildcard binds mean "every interface", so they are NOT an address a client can be told to dial:
 *  the probe/registry URL stays whatever it already is (loopback by default), which the wildcard
 *  bind necessarily covers. */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

/** Establish that a bind-host value IS a host, BEFORE anything brackets it, and return the
 *  bracketed literal a URL can hold (#1697).
 *
 *  `--host` is the bind address; its sibling `--server` takes a URL, the registry stores and prints
 *  URLs, and every message in this area shows one — so an operator plausibly types the URL here
 *  (the manifest's `broker.host` carries the same ambiguity against `broker.servers`). Unrejected,
 *  the IPv6 bracketing wrapped it into `nats://[nats://127.0.0.1:4222]:4222`, which is not a URL at
 *  all. Nothing checked the derived string: the first code to look at it compared it with the
 *  space's registry record, failed for a reason unrelated to what was typed, and showed the
 *  operator the "registered by hand" refusal whose remedy de-registers a live mesh. Refused by name
 *  here instead — pointing at the URL-carrying sibling — and a value that still cannot serve as a
 *  URL host (a `host:port` spelling, say) is refused rather than reaching that comparison as a
 *  silently wrong server string. Never rewritten: a value this flag cannot use is an error, not a
 *  URL to derive from. */
function assertBindableHost(host: string, source: string, urlSource: string): { literal: string; hostname: string } {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    console.error(
      c.red(
        `✗ ${source} ${host} looks like a URL - it takes a bind host only (an IP or hostname, no scheme); pass the broker URL with ${urlSource} instead`,
      ),
    );
    process.exit(1);
  }
  const literal = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  try {
    // ONE parse, both consumers served from it: `literal` builds the derived URL (a URL host needs
    // the brackets), `hostname` compares against the explicit server's (the URL API strips them).
    return { literal, hostname: new URL(`nats://${literal}:1`).hostname };
  } catch {
    console.error(
      c.red(
        `✗ ${source} ${host} is not a valid bind host - an IP or hostname only, with no port; the port comes from ${urlSource} (or its default), never from the bind host`,
      ),
    );
    process.exit(1);
  }
}

/**
 * Reconcile the bind address (`--host`, manifest `broker.host`) with the broker URL the readiness
 * probe, the mesh registry, and every later client use.
 *
 * They must name the same address. Left independent, `--host <non-loopback>` bound correctly and was
 * then probed at the loopback default: the probe found nothing, timed out, and the caller SIGTERM'd
 * a broker that had started perfectly, so `--host` alone could never succeed. With no explicit URL,
 * derive one from the host (keeping the implicit URL's port); with both, refuse a contradicting pair rather
 * than starting a broker that nothing can reach.
 */
function reconcileHostAndServer(host: string, explicitServer: string | undefined, source = "--host", urlSource = "--server", implicitServer = DEFAULT_SERVER): string {
  const url = new URL(explicitServer ?? implicitServer);
  if (WILDCARD_HOSTS.has(host)) return explicitServer ?? implicitServer;
  const { literal, hostname } = assertBindableHost(host, source, urlSource);
  if (!explicitServer) return `nats://${literal}:${url.port || "4222"}`;
  // NO parse on this path: `assertBindableHost` just parsed the identical literal above, so the
  // mismatch check compares two parsed hostnames and can only ever print its diagnostic and exit 1
  // — the "never throw a raw Invalid URL" requirement (#1697) holds by construction, not by a
  // second guard that no input could reach.
  if (url.hostname !== hostname) {
    console.error(
      c.red(
        `✗ ${source} ${host} and ${urlSource} ${explicitServer} name different addresses - the broker would bind ${host} but be probed at ${url.hostname}. Pass one, or make them agree.`,
      ),
    );
    process.exit(1);
  }
  return explicitServer;
}

/** Bind the manifest's exact listener address before any team-boot write. Releasing this
 *  socket is not a reservation: the real broker still owns the final bind verdict. */
async function assertFreshTeamBindAvailable(server: string, host: string, space: string): Promise<void> {
  const url = new URL(server), port = Number(url.port || "4222");
  const displayServer = brokerAddressForDisplay(server) ?? "not displayable";
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new CommandFailure("refused", "USAGE_INVALID", "the fresh team broker needs a concrete TCP port before it can check its bind address", { target: { space } });
  await new Promise<void>((resolve, reject) => {
    const socket = createServer(), controller = new AbortController();
    socket.unref();
    let settled = false;
    const finish = (error?: CommandFailure) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => {
      controller.abort();
      finish(new CommandFailure("refused", "TARGET_UNAVAILABLE", "the local broker bind inspection did not complete within its deadline; no absence or startup eligibility was inferred", { target: { space, server: displayServer } }));
    }, 1500);
    socket.once("error", () => finish(new CommandFailure("refused", "TARGET_UNAVAILABLE", "the selected broker address cannot be bound as a new local listener; no existing or remote broker was adopted", { target: { space, server: displayServer }, remedy: "inspect this local bind address and any process already listening there" })));
    try {
      socket.listen({ port, host, signal: controller.signal }, () => {
        if (settled) return;
        socket.close((error) => finish(error ? new CommandFailure("failed", "OPERATION_FAILED", "the temporary bind inspection did not confirm closure; no broker was started", { target: { space, server: displayServer } }) : undefined));
      });
    } catch {
      controller.abort();
      finish(new CommandFailure("refused", "TARGET_UNAVAILABLE", "the selected broker bind address was rejected before startup; no other listener was chosen", { target: { space, server: displayServer } }));
    }
  });
}

async function serverWithFreePort(server: string, host: string): Promise<string> {
  const url = new URL(server);
  url.port = String(await freePort(host));
  return url.toString();
}

function freePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : undefined;
      srv.close((err) => {
        if (err) reject(err);
        else if (port) resolve(port);
        else reject(new Error("could not allocate a free port"));
      });
    });
  });
}

/** One-time space infrastructure once the server accepts connections: pre-create the space's
 *  streams + KV buckets, and seed the channel registry. Done for BOTH modes — auth needs it
 *  (agents are denied STREAM.CREATE), and open needs it too so anything that touches a stream
 *  before an endpoint has joined (e.g. `cotal spawn`'s DM-inbox provisioning, `cotal_purge`,
 *  `history clear`) finds the streams instead of failing with StreamNotFound. Open connects
 *  without creds (no authenticator). */
async function postStart(
  server: string,
  space: string,
  setup?: { creds: string },
  seedFile?: ChannelRegistryFile,
): Promise<void> {
  await setupSpaceStreams({ servers: server, space, creds: setup?.creds });
  if (seedFile) {
    await seedChannelRegistry({ servers: server, space, creds: setup?.creds, file: seedFile });
  }
  // SPEC §4: `defaults.deliveryClass` MUST be written at space creation so the effective default is
  // discoverable on the wire, never inferred from the `?? "durable"` resolution fallback. Auth mode
  // (`setup` present ⇒ the delivery daemon is up) is local/self-hosted ⇒ `durable`; open mode has no
  // daemon and is live-only ⇒ `live`. Runs after the seed so an explicit `channels.json` default wins.
  await ensureDefaultDeliveryClass({
    servers: server,
    space,
    creds: setup?.creds,
    deliveryClass: setup ? "durable" : "live",
  });
}

/** A resume or restore skips `postStart` because the preserved store already holds every canonical
 *  stream. A memory-backed bucket is the exception: the broker stop that preserved the store emptied
 *  it, stream and all (#1356 made presence memory-backed). Recreate those, and only those, from the
 *  same `ttlBuckets` list `setupSpaceStreams` creates them from, before any daemon opens them. */
async function recreateMemoryBuckets(server: string, space: string, setup?: { creds: string }): Promise<void> {
  const nc = await connect({ servers: server, ...standaloneConnectOpts({ creds: setup?.creds, tls: false }) });
  try {
    requireBrokerFloor(nc);
    const kvm = new Kvm(nc);
    for (const [bucket, ttl, storage] of ttlBuckets(space))
      if (storage === StorageType.Memory) await kvm.create(bucket, { ttl, storage });
  } finally {
    await nc.drain();
  }
}

/** Load the declarative channels-config file to seed the registry. An explicit `--channels`
 *  path that's missing is a hard error; the default `.cotal/channels.json` is optional (absent
 *  ⇒ nothing to seed). */
function loadChannelsFile(explicit?: string): ChannelRegistryFile | undefined {
  const path = explicit ? resolve(explicit) : cotalPath("channels.json");
  if (!existsSync(path)) {
    if (explicit) {
      throw new Error(`channels file not found: ${path}`);
    }
    return undefined;
  }
  return JSON.parse(readFileSync(path, "utf8")) as ChannelRegistryFile;
}

/**
 * Turn the `--tls-cert`/`--tls-key` pair into a validated {@link BrokerTransport}, or `plaintext`
 * when neither was given.
 *
 * REFUSES BEFORE LAUNCH, never after. Everything it rejects would otherwise become a running broker
 * in some wrong state, and the two failure modes are not symmetrical: a broker that will not start
 * is an operator reading an error, while a broker that starts wrong is an operator believing they
 * have TLS. So the validation is deliberately ours and deliberately early.
 *
 * `validateTlsMaterial` does the substantive checks — readability, private-key mode, PEM pair
 * match, validity window, dial-host SAN — because nats-server's are not sufficient. Missing,
 * unreadable and mismatched pairs do stop it before it opens a listener, but an EXPIRED certificate
 * does not: it reports the config valid, starts, logs "Server is ready" and "TLS required", and
 * only the client then fails. An expired cert must never yield "mesh up".
 *
 * @param dialHost the hostname clients will verify against, which is NOT the bind host — a broker
 *                 may bind `0.0.0.0` while clients dial `broker.example`.
 */
function resolveTransport(
  values: { "tls-cert"?: string; "tls-key"?: string },
  dialHost: string | undefined,
  root: string,
  /** `persist` defaults false (commit-after-apply). `quiet` suppresses serving/inheriting lines
   *  until the caller announces after a successful apply. */
  opts: { persist?: boolean; quiet?: boolean } = {},
): BrokerTransport {
  const certFile = values["tls-cert"], keyFile = values["tls-key"];
  const quiet = opts.quiet === true;

  // NO FLAGS: inherit the RECORDED decision rather than defaulting to plaintext. This is the half
  // that makes a bare `cotal up` after a `cotal down` keep serving TLS. Without it the decision
  // lives only in the argv of whichever invocation first made it, and the most ordinary operator
  // gesture there is - stop the mesh, start it again - silently downgrades a broker that was
  // deliberately put on TLS. `readBrokerPolicy` refuses rather than degrading if the recorded
  // material has gone missing, so a moved cert fails loud here instead of coming up in cleartext.
  if (!certFile && !keyFile) {
    let recorded;
    try {
      recorded = readBrokerPolicy(root);
    } catch (e) {
      console.error(c.red(`✗ ${e instanceof Error ? e.message : String(e)}`));
      process.exit(1);
    }
    if (recorded?.transport.kind === "tls-required") {
      if (!quiet) console.log(c.dim("TLS: inheriting the recorded broker policy (no --tls-cert/--tls-key given)"));
      return validateRecorded(recorded.transport, dialHost, { quiet });
    }
    return { kind: "plaintext" };
  }

  // Half a pair is a mistake, never a configuration. Refusing names the missing half rather than
  // failing later inside nats-server with a message about a file the operator did not mention.
  if (!certFile || !keyFile) {
    console.error(c.red(`✗ --tls-cert and --tls-key must be given together (missing ${certFile ? "--tls-key" : "--tls-cert"})`));
    process.exit(1);
  }

  const transport: BrokerTransport = { kind: "tls-required", certFile: resolve(certFile), keyFile: resolve(keyFile) };
  const validated = validateRecorded(transport, dialHost, { quiet });
  // RECORD only when the caller has already applied the transport (started a matching listener).
  // Eager write here is S5: a refuse path cannot unwrite, and the next bare up inherits fiction.
  if (opts.persist === true) writeBrokerPolicy(root, { version: 1, transport: validated });
  return validated;
}

/** Persist a transport after its listener starts; a structured boot leaves stdout to its receipt. */
function commitTransportPolicy(root: string, transport: BrokerTransport, quietBoot = false): void {
  if (transport.kind !== "tls-required") return;
  writeBrokerPolicy(root, { version: 1, transport });
  if (!quietBoot) announceTransport(transport);
}

function announceTransport(transport: BrokerTransport): void {
  if (transport.kind !== "tls-required") return;
  try {
    const material = validateTlsMaterial(transport, {});
    console.log(c.dim(`TLS: serving ${material.subject}, valid until ${material.notAfter.toISOString()}`));
  } catch {
    // Already validated at decide-time; announce is best-effort display.
  }
}

/** Read the live INFO greeting and report whether the listener requires TLS.
 *  `undefined` means no usable INFO (timeout / closed) — caller treats as unknown. */
async function liveListenerRequiresTls(server: string, timeoutMs = 2000): Promise<boolean | undefined> {
  let host: string;
  let port: number;
  try {
    const u = new URL(server);
    host = u.hostname || "127.0.0.1";
    port = Number(u.port) || 4222;
  } catch {
    return undefined;
  }
  return await new Promise((res) => {
    const sock = createConnection({ host, port });
    let buf = "";
    const done = (v: boolean | undefined) => {
      try { sock.destroy(); } catch { /* */ }
      res(v);
    };
    sock.setTimeout(timeoutMs, () => done(undefined));
    sock.on("error", () => done(undefined));
    sock.on("close", () => done(undefined));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\r\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      try {
        const info = JSON.parse(line.replace(/^INFO\s+/, "")) as { tls_required?: boolean };
        done(info.tls_required === true);
      } catch {
        done(undefined);
      }
    });
  });
}

/**
 * Re-assert that `transport` is valid for the host clients will actually dial, and exit loudly if
 * not. A no-op for plaintext.
 *
 * This exists because the transport is decided ONCE, early, before the route is known, so that no
 * route can be reached without one — but the effective dial host is decided LATE and differs per
 * route: a manifest may set `broker.host`, and a certificate valid for the flag-derived host is not
 * thereby valid for that one. Deciding early and checking late is the only ordering that satisfies
 * both, so the check is deliberately separate from the decision rather than folded into it.
 *
 * Quiet on success: `resolveTransport` already printed what is being served, and a second identical
 * line reads like a second broker.
 */
function assertServesDialHost(transport: BrokerTransport, dialHost: string | undefined): BrokerTransport {
  if (transport.kind !== "tls-required" || dialHost === undefined) return transport;
  try {
    validateTlsMaterial(transport, { dialHost });
  } catch (e) {
    console.error(c.red(`✗ ${e instanceof Error ? e.message : String(e)}`));
    process.exit(1);
  }
  return transport;
}

/**
 * The client-side TLS requirement to persist for a listener THIS PROCESS DID NOT START — the
 * restore and ordinary-resume paths, which adopt a broker that is already listening.
 *
 * They have no `transport` in scope because they never decided one, so the honest source is the
 * recorded policy: the listener they are adopting was started from it. Reading it here is what stops
 * a resume from writing a registry entry that says "plaintext" over a broker serving TLS — clients
 * resolved from that entry would then connect without requiring it, which is the downgrade this
 * feature exists to prevent, arriving by way of a recovery path rather than a launch.
 *
 * Fails loud on an unusable policy for the same reason `resolveTransport` does: a resume that cannot
 * tell what it is adopting must not guess.
 */
function adoptedTlsRequired(root: string): boolean {
  try {
    return readBrokerPolicy(root)?.transport.kind === "tls-required";
  } catch (e) {
    console.error(c.red(`✗ ${e instanceof Error ? e.message : String(e)}`));
    process.exit(1);
  }
}

/** Validate a TLS pair and exit loudly on anything wrong. Shared by the flag path and the
 *  recorded-policy path so a cert that rots on disk is caught on the NEXT `up`, not only on the
 *  one that first configured it. */
function validateRecorded(
  transport: BrokerTransport,
  dialHost: string | undefined,
  opts: { quiet?: boolean } = {},
): BrokerTransport {
  try {
    const material = validateTlsMaterial(transport as Extract<BrokerTransport, { kind: "tls-required" }>, dialHost !== undefined ? { dialHost } : {});
    if (!opts.quiet) console.log(c.dim(`TLS: serving ${material.subject}, valid until ${material.notAfter.toISOString()}`));
  } catch (e) {
    // Surface the CERTIFICATE cause. A TLS failure reported as a generic startup error invites the
    // wrong remedy - operators go looking at ports and firewalls when the answer is the cert.
    console.error(c.red(`✗ ${e instanceof Error ? e.message : String(e)}`));
    process.exit(1);
  }
  return transport;
}

/**
 * Render and write the config for an OPEN (no-auth) broker, returning its path.
 *
 * The `authSetup` sibling for the no-auth mode. Open mode previously launched nats-server from
 * bare CLI flags and so never passed through any renderer — meaning the REQUIRED transport union
 * on the config renderers covered the auth path only, and a `--tls-cert`/`--tls-key` pair given to
 * an open-mode `up` would have been accepted while the broker came up in cleartext. Routing open
 * mode through a renderer is what makes the union total: there is now no route to a listener that
 * does not state its transport.
 */
function writeOpenBrokerConf(storeDir: string, opts: { port: number; host: string; transport: BrokerTransport; maxFileStore?: number }): string {
  const confPath = cotalPath("server-open.conf");
  writeSecretFile(
    confPath,
    openServerConfig({ port: opts.port, host: opts.host, storeDir, maxFileStore: opts.maxFileStore, transport: opts.transport }),
  );
  return confPath;
}

/** Ensure the space's trust material exists, render a server config, and mint a privileged
 *  setup creds (used to pre-create streams once the server is up). The account signing key
 *  in `.cotal/auth` is what `cotal mint` and the manager later use to issue per-agent creds.
 *
 *  USER MODE (`user` set): additionally run the registered auth provider's `prepareServer` over the
 *  SPACE-SCOPED state dir (`.cotal/auth/<space>/` — the multi-space-ready layout; nothing user-auth
 *  lives flat) and preload its extra account(s) into the broker config. The inverse is fail-closed:
 *  a space whose user-auth state exists MUST keep being started with --user-auth — regenerating the
 *  config without the callout account would silently break every sentinel connect.
 *
 *  `rotateSys` (`cotal up --rotate-sys`) is the class-3 renewal for an EXISTING space: rotate the
 *  system account, re-mint `membership-observer.creds` + `connection-evictor.creds` against the
 *  successor, and render the config from the ROTATED record so the broker this `up` starts is the one
 *  that trusts them. It belongs here because this is the single site that both owns the trust record
 *  and renders `server.conf`; anywhere else would publish creds the live broker cannot honor. */
async function authSetup(
  storeDir: string,
  server: string,
  space: string,
  host: string = "127.0.0.1",
  user: { idpUrl?: string } | undefined,
  // NON-OPTIONAL, and it used to default to `{ kind: "plaintext" }`. That default was the hole: the
  // manifest path called this with five arguments and silently got a cleartext listener while the
  // operator's `--tls-cert` sat validated and unused. A default here cannot be right, because the
  // safe value and the common value are different values — every caller knows its transport, and
  // the one that does not is the one that must not compile.
  transport: BrokerTransport,
  rotateSys = false,
  maxFileStore?: number,
  quietBoot = false,
): Promise<{ confPath: string; creds: string; wsPort: number; prepared?: AuthPrepared; stateDir?: string }> {
  const dir = authDir(cotalRoot()); // the broker config (server.conf) still lands under the FS auth dir
  const store = workspaceSecretStore(cotalRoot());
  let auth: SpaceAuth | undefined = await getSpaceAuth(store, space);
  if (!auth) {
    auth = await createSpaceAuth(space);
    await putSpaceAuth(store, auth); // strips the $SYS seed at rest, but leaves the in-memory `auth` intact …
    await provisionMembershipCreds(auth, cotalRoot(), space); // … so the observer can still be minted here (fresh-space only)
    // A fresh space's $SYS material was just minted from the seed that only exists in this branch, so
    // the ASK is already satisfied, so say so rather than rotating a one-second-old account, and never
    // report a rotation that did not happen.
    if (rotateSys) console.log(c.dim("• --rotate-sys: this space is new, so its $SYS creds were just minted - nothing to rotate"));
  } else if (rotateSys) {
    // Third and last of the stopped-broker checks, at the one point every rotation path converges on.
    // The other two live in `up`'s reachable-listener branch: this root's recorded mesh at the
    // requested address, and any UNIDENTIFIED listener there (which refuses rather than free-porting
    // around a broker that may be serving this root's own server.conf and store). This one reads the
    // root's ownership records for a broker at an address nobody probed. It reports what those
    // records say, not what the process table says (see its own comment for the residual), and fails
    // CLOSED, so an ambiguous record refuses exactly like a live one.
    await assertRootBrokerStopped(cotalRoot());
    // Fails loud: a caller that swallowed this would boot the broker on the RETIRED system account
    // while `doctor auth` reported the rotation as done.
    const rot = await rotateSystemCreds(cotalRoot(), space);
    auth = rot.auth; // the config below MUST be rendered from the successor, never the pre-rotation copy
    console.log(
      c.green(`✓ rotated the system account for "${space}"`) +
        c.dim(` (generation ${rot.gen}) - re-minted ${SYSTEM_CREDS_FILES.join(" + ")}${rot.expiresAt ? `, valid to ${new Date(rot.expiresAt * 1000).toISOString().slice(0, 10)}` : ""}`),
    );
    // Say exactly what is true. The retirement is CONFIG-LOAD-BOUND: an old cred dies against any
    // broker that loads the successor config, which is every broker started from this root from here
    // on, but a stale nats-server still holding the pre-rotation config in memory would keep
    // honoring it, so "now dead" without that qualifier oversells the guarantee.
    console.log(c.dim("  the data account, every agent cred and the JetStream store are untouched. The OLD $SYS creds are refused by any broker that loads this config; a stale broker still running the previous config would still honor them, so stop those first."));
    // A full backup binds to the trust chain it was taken against: `rootChainCommitment` hashes the
    // operator JWT and the system account, both of which just changed, so `cotal up --restore`
    // refuses every full artifact taken before this moment. That is correct (it is a different trust
    // root), but it is only obvious to someone who has read the fingerprint code, and rotation is
    // now a routine 30-day act rather than a once-per-space event. Say it at the moment it becomes
    // true, not in a doc the operator reads after the restore has already failed.
    console.log(c.dim("  NOTE: full backups taken before this rotation can no longer be restored (they are bound to the retired trust chain) - take a fresh `cotal backup` once the mesh is up."));
  }
  // The DATA half of the membership bundle, on EVERY path — see healMembershipDataCreds.
  await healMembershipDataCreds(auth, cotalRoot(), space, quietBoot);
  // The $SYS creds must be signed by the system account THIS boot is about to put in `server.conf`.
  // A rotation that committed the trust record and then died leaves them stale, unexpired, and
  // broker-dead and, crash-before-either-write, stale in a way that no comparison between the two
  // FILES can see (they agree with each other; they just disagree with the record). This is the one
  // place holding both, on the one path that renders the config, so it is where the split is caught.
  //
  // REFUSE, do not warn. A warning is what the `--detach` path turns into an unread log line under a
  // green "✓ running in the background", which is the false success this whole change exists to
  // remove. And what stays broken is not only the display feed: live connection EVICTION rides the
  // same pair, so booting here would silently downgrade revocation to deny-new for the life of the
  // mesh. The repo's posture is to throw rather than degrade, and the recovery is one command that
  // this message names.
  const stale = staleSystemCreds(cotalRoot(), auth.sys.pub, space);
  if (stale.length)
    throw new Error(
      `${stale.map((x) => `${x.file} (signed by ${x.iss ? `${x.iss.slice(0, 12)}…` : "an unreadable issuer"})`).join(", ")} ` +
        `${stale.length === 1 ? "is" : "are"} not signed by this space's system account (${auth.sys.pub.slice(0, 12)}…) - ` +
        "an interrupted rotation left the $SYS creds behind the trust record, so the broker would deny them and live eviction + the membership feed would stay down. " +
        "Re-run the rotation to land a complete generation: `cotal up --rotate-sys`",
    );
  const stateDir = userAuthStateDir(cotalRoot(), space); // the provider's space-scoped state dir
  if (!user && hasUserAuthState(cotalRoot(), space)) {
    throw new Error(`space "${space}" has user auth enabled (state under ${stateDir}) - start it with \`cotal up --user-auth\`, or remove that directory deliberately to disable user auth (existing logins/grants die with it)`);
  }
  let prepared: AuthPrepared | undefined;
  if (user) {
    // Registry composition: the provider came from the composition root (bin/cotal.ts imports
    // @cotal-ai/auth); this package never imports it. No provider ⇒ resolveAuthProvider throws the
    // exact fix. The narrow input is a capability boundary: operator seed (signs the provider's
    // account once) + the data account's pub/signingSeed (projected for the service's minting duty).
    try {
      prepared = await resolveAuthProvider().prepareServer({
        space,
        operatorSeed: auth.operator.seed,
        account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
        store: workspaceSecretStore(cotalRoot()),
        dir: stateDir,
        idpUrl: user.idpUrl,
      });
    } catch (e) {
      throw e instanceof Error ? e : new Error(String(e));
    }
  }
  const port = Number(new URL(server).port) || 4222;
  // P2 item 6: allocate the broker's loopback WebSocket listener port — the console page becomes a
  // mesh §13.6 session client over it (a NEW same-host attack surface, localhost-bound, no TLS). The
  // manager's establisher builds its wsUrl from this; threaded to `supervise --ws-port`.
  const wsPort = await freePort(host);
  const confPath = resolve(dir, "server.conf");
  // EVERY tenant of this root, not just the one being booted: `resolver_preload` is a whole-broker
  // map, so a config rendered from one space evicts the rest silently. `auth` leads the list because
  // this function's copy can be fresher than the disk (a space created above, or one whose trust
  // record `--rotate-sys` just replaced). Refuses on an unreadable record rather than dropping it.
  const spaces = preloadSpaceAccounts(dir, auth);
  const enabled = userAuthSpacesOnDisk(dir);
  for (const enabledSpace of enabled) {
    if (!spaces.some((s) => s.space === enabledSpace))
      throw new Error(`space "${enabledSpace}" has user auth enabled but no data account record - refusing to render an incomplete broker resolver`);
  }
  const extraAccounts: Array<{ pub: string; jwt: string }> = [];
  for (const enabledSpace of enabled) {
    const accounts = enabledSpace === space && prepared
      ? prepared.extraAccounts
      : await resolveAuthProvider().preloadAccounts({ store, space: enabledSpace });
    extraAccounts.push(...accounts);
  }
  // Owner-private regardless of umask, as `writeOpenBrokerConf` writes the open configuration: the
  // broker preset refuses a configuration that other local users can write.
  writeSecretFile(confPath, serverConfig(auth, spaces, { transport, port, storeDir, maxFileStore, host, wsPort, wsHost: host, extraAccounts }));
  // Ephemeral setup cred: used only to probe reachability, pre-create the space streams/buckets
  // (setupSpaceStreams) and seed the channel registry (seedChannelRegistry) — all within the
  // enumerated `provisioner` scope. No broad `manager` residual for the up path.
  const creds = await mintCreds(auth, newIdentity(), "provisioner");
  return { confPath, creds, wsPort, ...(prepared ? { prepared, stateDir } : {}) };
}

/**
 * Refuse the rotation if this root's own bookkeeping still shows a broker running. This is a
 * BEST-EFFORT check over Cotal-managed ownership records, NOT a proof that no process is serving this
 * root, and the difference matters: a survivor keeps honoring the retired account from memory, and a
 * second broker on the successor opens that survivor's JetStream store underneath it.
 *
 * Two records, because either alone has a blind spot. The PID FILE catches a broker this root started
 * whose registry row was lost. The REGISTRY sweep catches one recorded for this root at some OTHER
 * address, which no probe of the requested URL would reach. Both fail CLOSED: an unreadable or
 * malformed pid file refuses exactly like a live one, since "cannot tell" and "still running" have
 * the same consequence.
 *
 * WHAT IT CANNOT SEE: both records are mutable, and neither is written by a broker started outside
 * `cotal up`. Delete both while the process lives, or run
 * `nats-server -c <root>/.cotal/auth/server.conf` by hand, and this returns success having probed
 * nothing. The requested address is covered separately (an unidentified listener there refuses the
 * rotation rather than moving to a free port), which leaves a hand-started broker on a DIFFERENT port
 * as the honest residual. Closing that needs something a survivor holds and cannot delete, an
 * exclusive store lock, which does not exist today; until it does, do not run `nats-server` against
 * this root's config outside `cotal up`.
 *
 * Not a general `up` guard: an ordinary boot adopting or replacing a listener is a supported flow with
 * its own claim machinery. This is specifically the precondition for retiring an authority.
 */
async function assertRootBrokerStopped(root: string): Promise<void> {
  const pidPath = join(root, ".cotal", "nats.pid");
  if (existsSync(pidPath)) {
    let raw: string;
    try {
      raw = readFileSync(pidPath, "utf8").trim();
    } catch (e) {
      throw new Error(`--rotate-sys: ${pidPath} exists but cannot be read (${(e as Error).message}) - refusing to rotate while a broker for this root may still be running; \`cotal down\` first`);
    }
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0)
      throw new Error(`--rotate-sys: ${pidPath} does not hold a pid (${JSON.stringify(raw)}) - refusing to rotate while a broker for this root may still be running; \`cotal down\` first`);
    let live: boolean;
    try {
      process.kill(pid, 0); // signal 0 is a liveness probe, it signals nothing
      live = true;
    } catch (e) {
      // EPERM means the process EXISTS and is not ours to signal, i.e. alive for this purpose.
      live = (e as NodeJS.ErrnoException).code === "EPERM";
    }
    if (live)
      throw new Error(`--rotate-sys: this root's broker is still running (pid ${pid}) - it would keep serving the retired system account, and a second broker would share its JetStream store. Stop it first: \`cotal down\``);
  }
  // A broker recorded for this root at ANY address, still answering. The rotate refusal earlier in
  // `up` only sees the URL this invocation asked for; this sees the ones it did not.
  for (const m of meshesForRoot(root)) {
    if (await isReachable(m.server))
      throw new Error(`--rotate-sys: mesh "${m.space}" for this root is still reachable at ${m.server} - stop it first (\`cotal down\`), then rotate`);
  }
}

/** Provision the DATA-account half of the membership bundle, on EVERY `up` rather than only a fresh
 *  space. Idempotent: it writes only what is absent and is silent when both are present.
 *
 *  WHY THIS IS SEPARATE FROM {@link provisionMembershipCreds}. That function mints the whole bundle
 *  in the fresh-space branch because the `$SYS` signing seed exists only there and is never
 *  persisted — true of `membership-observer.creds` and `connection-evictor.creds`, and the reason
 *  they can only be re-minted by a system-account rotation. It is NOT true of the other two.
 *  `membership-rw.creds` is signed by the DATA account, whose signing seed IS persisted, and
 *  `membership.json` is just that account's public id. Neither needs the `$SYS` window, so binding
 *  them to it left every space provisioned before the feature permanently without the feed.
 *
 *  That gap was not theoretical. A space with a complete `$SYS` pair, missing only the rw cred,
 *  reported `the membership bundle is incomplete here (missing membership-rw.creds)` on every
 *  delivery-daemon start and served a traffic-only graph, and the documented remedy did not work:
 *  `--rotate-sys` re-mints the `$SYS` pair and never calls the provisioner, so it wrote neither the
 *  rw cred nor the account id. `mintMembershipObserverCreds` even names that rotation as the fix in
 *  its own error text — advice that could not succeed. Healing here fixes both spellings at once:
 *  the ordinary `up` repairs the data half with no rotation at all, and a rotation now repairs it
 *  too, because this runs after both branches converge. */
async function healMembershipDataCreds(auth: SpaceAuth, root: string, space: string, quietBoot = false): Promise<void> {
  try {
    const store = workspaceSecretStore(root);
    // THE RESOLVERS, not the bare kinds (P7 §2 rule 1). Both reads below are absent-means-MINT, which
    // is precisely why the location must be resolved through the choke point: a canonical read on a
    // root whose material is still flat answers "absent" and mints a SECOND live cred beside the one
    // the running daemons hold. `up` is a workstation composition by construction, so the resolver
    // gets the FS arm and moves the material on this first touch.
    const composition = { injected: false as const, root };
    const rwKey = membershipRwCredsKey(space, composition);
    const wrote: string[] = [];
    if ((await store.get(rwKey)) === undefined) {
      await store.put(rwKey, await mintCreds(auth, newIdentity(), "membership-rw"));
      wrote.push(MEMBERSHIP_RW_CREDS_KIND); // the KIND is what an operator reads, never the segmented key
    }
    const configPath = membershipConfigPath(root, space);
    if (!existsSync(configPath)) {
      mkSecretDir(dirname(configPath)); // harden the per-space dir before the file lands, as the fresh path does
      writeSecretFile(configPath, JSON.stringify({ accountId: auth.account.pub }));
      wrote.push(MEMBERSHIP_CONFIG_KIND);
    }
    if (wrote.length && !quietBoot)
      console.log(c.dim(`• membership: provisioned ${wrote.join(" + ")} - the data-account half needs no system-account rotation`));
  } catch (e) {
    // Best-effort, exactly like the fresh-space provisioner: a failure here leaves the graph on
    // traffic-only and leaves delivery untouched. It must never keep the mesh from starting.
    console.error(c.dim(`• broker-sourced membership not repaired: ${(e as Error).message}`));
  }
}

/** Mint the two scoped creds the delivery daemon's membership feed loads (broker-sourced graph
 *  membership), at the FRESH `cotal up` while the in-memory `$SYS` signing seed still exists:
 *   - `membership-observer.creds` — SYSTEM-account CONNZ reader (the only window it can be minted: the
 *     `$SYS` seed is never persisted).
 *   - `membership-rw.creds` — DATA-account members-read + feed-write.
 *   - `membership.json` — the DATA account id (the CONNZ/event subjects pin it; non-secret, but kept
 *     0600 alongside the creds).
 *  All 0600. Best-effort: a failure logs and leaves the feed disabled (the graph degrades to traffic-
 *  only, delivery is untouched). Runs only on a FRESH space (the `if (!auth)` branch); a normal down/up
 *  keeps `.cotal/auth` + these creds and reuses them. A space provisioned before this feature has no
 *  in-memory `$SYS` seed, so it gains membership only when its auth is regenerated (a fresh `.cotal/auth`)
 *  — a documented migration property, not a silent no-op.
 *  Coupling: `cotal clean all` deletes this identity-derived set (removeLocalState in clean.ts) —
 *  a cred added here must be added to that removal list too. `membership-rw.creds` is a MIGRATED kind:
 *  its write/read/delete all go through the {@link SecretStore} seam (here, the feed reader, and clean),
 *  so the renewal owner can re-sign it into a hosted store. The observer / evictor / config stay on the
 *  raw FS (static $SYS creds + non-secret config, not renewable kinds). */
async function provisionMembershipCreds(auth: SpaceAuth, root: string, space: string): Promise<void> {
  try {
    const observer = await mintMembershipObserverCreds(auth, newIdentity());
    const rw = await mintCreds(auth, newIdentity(), "membership-rw");
    // D5 slice 4: the KICK-only connection-evictor cred — same mint-only-at-fresh-`up` window as
    // the observer ($SYS seed in memory here). The delivery daemon pairs it with the observer to
    // close a revoked/removed principal's live connections. A space without it degrades to
    // deny-new-only (durable reauth) — surfaced loudly by the removal path, never silent.
    const evictor = await mintConnectionEvictorCreds(auth, newIdentity());
    // All four land through the per-kind resolvers (P7 §2 rule 1), and all four through the store's
    // `put`, which is the same `mkSecretDir` + atomic write the raw `writeSecretFile` did — the
    // difference being that it hardens the PER-SPACE dir the material now lives in rather than
    // `.cotal/` itself. This is the fresh-space branch, so nothing is there to migrate; it calls the
    // resolvers anyway because a kind with two write paths is a kind that grows two layouts.
    const composition = { injected: false as const, root };
    const store = workspaceSecretStore(root);
    await store.put(membershipObserverCredsKey(space, composition), observer);
    await store.put(membershipRwCredsKey(space, composition), rw);
    await store.put(connectionEvictorCredsKey(space, composition), evictor);
    const configPath = membershipConfigPath(root, space);
    mkSecretDir(dirname(configPath));
    writeSecretFile(configPath, JSON.stringify({ accountId: auth.account.pub }));
  } catch (e) {
    console.error(c.dim(`• broker-sourced membership not provisioned: ${(e as Error).message}`));
  }
}
