import { noManagerCredentialWarning } from "../lib/daemon-credential-warning.js";
import { drainAndClose } from "@cotal-ai/core";
import { openBrokerLog, prepareForegroundBrokerLog } from "../lib/broker-log.js";
import { spawnBroker } from "../lib/broker-spawn.js";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { homedir, hostname } from "node:os";
import {
  mkdirSync,
  readFileSync,
  existsSync,
  lstatSync,
  realpathSync,
  readdirSync,
  rmdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  isReachable,
  dialerFor,
  DEFAULT_SERVER,
  CONTRACT_ARTIFACT_MAX_BYTES,
  MANAGER_START_PAYLOAD_FLOOR,
  type BrokerTransport,
  mintCreds,
  mintLifecycleUid,
  DEV_OWNER,
  newIdentity,
  reconcileSpaceMemoryBuckets,
  standaloneConnectOpts,
  LEASE_TTL_MS,
  type AuthPrepared,
  type SpaceAuth,
  type ChannelRegistryFile,
  type ParsedArgs,
  type FlagSpec,
  type CompletionResult,
} from "@cotal-ai/core";
import {
  assertManagerName,
  processStopped,
  readManagerName,
  readManagerSeatCap, DEFAULT_SEAT_CAP,
  recordManagerName,
  parseSeatCapFlag,
  seatCapText,
  CommandFailure,
  codeSpan,
  commandFailureReport,
  failureEnvelope,
  writeEnvelope,
  isCommandFailure,
  protectedLocalDirectory,
  jsonFlag,
  plainFlag,
  renderReport,
  assertSingleSpaceBroker,
  authDir,
  brokerAddressForDisplay,
  getSoleSpaceAuth,
  getSpaceAuth,
  listSpaceAccounts,
  brokerAddressKey,
  canonicalRoot,
  clearCurrent,
  findMesh,
  legacyStackOtherHome,
  stackHomeRemedy,
  getCurrent,
  loadMeshes,
  localMeshesForRoot,
  keepsRegistration,
  oneLine,
  presentationOf,
  writeResult,
  type Report,
  parsePositiveIntegerFlag,
  retainedLegacyBroker,
  removeMesh,
  userAuthStateDir,
  workspaceSecretStore,
  type UserAuthInfo,
  acquireMaintenanceLock,
  assertStoreIdentity,
  assessMaintenanceClaim,
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
  type ListenerProof,
  type StoreIdentity,
  readBrokerPolicy,
  removePidPair,
  verifyIdentityPin,
  processesNaming,
  connectUserControlOrThrow,
  userViewAuth,
  recordOperationSpace,
  recordOperationWarning,
  restoreLeftOut,
  NATS_PIDFILE,
  exitCode,
  terminalWidth,
  type ControlAuth,
} from "@cotal-ai/workspace";
import { FlagValueRefusal } from "../lib/flag-value-refusal.js";
import { resolveAuthProvider, stopAuthService } from "../lib/auth-proc.js";
import { c, hang, stderrLine } from "../ui.js";
import { admitAndRestoreSeatCheckpoints } from "../lib/seat-resume.js";
import { NATS_DEFAULT_MAX_PAYLOAD, natsServerLabel, resolveNatsServer, unreadVersion } from "../lib/nats-bin.js";
import { cotalPath, cotalRoot } from "../lib/paths.js";
import { channelsReads, readChannelsFile } from "../lib/channel-seed.js";
import { controllerManifestRemedy, detachedNext, renderDetachedSummary } from "../lib/up-report.js";
import { seedBeforeLaunch, seedMoveNote } from "../seed/launch.js";
import { seedDir } from "../seed/paths.js";
import { seedStoreMoved } from "../seed/reconcile.js";
import { upSystemdSupervisionWarning } from "../lib/systemd-supervision.js";
import { deliveryStoppedByDown, deliveryUp, ensureDelivery, stopDelivery } from "../lib/delivery-proc.js";
import { displayCmd } from "../lib/self-exec.js";
import { shellWord } from "../lib/endpoint-errors.js";
import { clearManagerArtifacts, liveManagerWouldApplyMaxSessions, managerHasDeliveryMarker, managerLogDisplayPath, managerRecordState, stopManager } from "../lib/manager-proc.js";
import { ManifestError, formatIssue, loadManifest, type PreparedManifest } from "../lib/manifest/index.js";
import { UnusableFile } from "../lib/unusable-file.js";
import { buildLaunchSpec, genRunId, manifestToChannels, preflightConnectors, writeLaunchSpec } from "../lib/manifest/apply.js";
import { writeFreshTeamAttempt, writeFreshTeamSummary } from "../lib/team-fresh.js";
import { renderUpPlan, renderInherited, renderWarnings } from "../lib/manifest/render.js";
import { idpUrlProblem, serverUrlProblems } from "../lib/manifest/resolve.js";
import { failManifest, refuseManifestSpaceMismatch } from "./topology.js";
import { checkNewUpSpace, preparedUpRoot } from "./up-target.js";
import { cleanedManifestStart, interruptedStartBroker } from "../lib/legacy-start.js";
import {
  canonicalServer,
  controllerStackApplies,
  requestedStackMode, refuseForegroundStackHolder,
  stackUp,
  stackUpForegroundNotice,
  stackUpInterrupted,
  type StackUpNative,
} from "./stack-up.js";
import { exitInterrupted, handOverStartupNotice, noticeOnInterrupt, releaseStartupNotice } from "../lib/interrupt-notice.js";
import { claimForegroundHold, foregroundHolder, foregroundStackEnd, releaseForegroundHold } from "../lib/foreground-hold.js";
import { settleInterruptedLaunches } from "../lib/service-process.js";
import { assertUserStackTransport, preflightUserStack } from "./stack-user-auth.js";
import { stackDown } from "./stack-down.js";
import {
  assertControllerCoupling, assertControllerMembersLive, assertControllerResumeEligible, beginControllerResume, bindControllerBroker, controllerAttemptBrokerInstance,
  currentControllerAttempt, managerResumeAttempt, relaunchCommittedManager, settleControllerResume, startControllerMember, startControllerMembers,
} from "../lib/controller-resume.js";
import { removeRetiredBrokerInstance } from "../lib/controller-restore.js";
import { acquireStackOperationLock, admittedStackRestore, readStackJournal, STACK_DEFINITION, STACK_ROLES } from "../lib/stack-journal.js";
import { observeServiceProcess, serviceInstances } from "../lib/service-instances.js";
import { serviceDefinitionStore } from "../lib/service-definitions.js";
import { MissingFlags } from "../lib/missing-flags.js";
import { warnForeignStoreEntries } from "../lib/store-dir.js";
import { extensionNames, preflightRuntime } from "../ext-loader.js";
import { completingFlagValue } from "../lib/completion.js";
import { metadataPositionals } from "../lib/command-path.js";
import {
  bindPreparedRestoreListener,
  isManagerCommitResult,
  isManagerFinalizeResult,
  isManagerCommittedRestore,
  markPreparedRestoreActive,
  markPreparedRestoreDegraded,
  heldRestoreAttempt,
  heldClaim,
  movedFolderRefusal,
  prepareRestore,
  restoreArtifactPath,
  restoreLaunch,
  preservedSourceState,
  recordPreparedRestoreManagerCommit,
  rehydratePreparedRestore,
  journaledMaxFileStore,
  journaledRestoredStreams,
  leftOutNotes,
  rearmUnboundRestore,
  replacePreparedDeadRestoreListener,
  restoreComposition,
  restoreInterruptNotice,
  restoreNextStep,
  restoreOnlyCopy,
  type PreparedRestore,
  type RestoreFlags,
} from "../lib/restore.js";
import { attemptProcessesGone } from "../lib/isolated-broker.js";
import { assertEndpointUnreachable } from "../lib/endpoint-cut.js";
import { freshStackServer, retryStackAddress, serverWithFreePort } from "../lib/up-broker-address.js";
import { askManager } from "@cotal-ai/workspace/control";
import { cliControl } from "../lib/control.js";
import { pendingRestores, type PendingOrdinaryResume, pendingOrdinaryResumes } from "./up-pending.js";
import {
  parseMaxFileStore,
  parseAuthTimeout,
  parseMaxPayload,
  assertManagerPayload,
  parseAccountResolver,
  authTimeoutArgs,
  loadChannelsFile,
  refuseRunningElsewhere,
  refuseRecordsElsewhere,
  resolveTransport,
  assertTlsIntentServed,
  assertTlsAddressServed,
  commitTransportPolicy,
  tlsAddress,
  announceTransport,
  liveListenerRequiresTls,
  assertServesDialHost,
  adoptedTlsRequired,
  refuseUnnamedLastStore,
  reopenLastStore,
  refuseMissingNamedStore,
  checkStartStore,
} from "./up-transport.js";
import { reconcileHostAndServer, assertFreshTeamBindAvailable } from "./up-host.js";
import {
  registeredAddressHolder,
  refuseRegisteredAddress,
  membershipConversionRefusal,
  fileMembershipStore,
  postStart,
  recreateAdoptedMemoryBuckets,
  recreateDeletedStreams,
} from "./up-stores.js";
import { brokerVersion, writeOpenBrokerConf, authSetup, provisionWebCreds } from "./up-broker-auth.js";
import {
  validateUpArguments,
  bindListRefusal,
  freshFolderRoot,
  folderNamedSpace,
  recordsNameNoSpace,
  inheritedMachineHomeRoot,
  assertFreshTeamBootOwnership,
  publicExchangeArgs,
  serviceEndpointsArgs,
  folderSpace,
  assertSelectionNotMoved,
} from "./up-args.js";
import {
  failedListeners,
  startUserAuthService,
  startDeliveryWithBroker,
  reportDegradedControlPlane,
  recordSpawnedListener,
  awaitSpawnedListener,
  listenerExitRemedy,
  serveReadyListener,
  type DetachOpts,
  prepareBrokerStart,
  startMeshDetached,
  assertBrokerAddressFree,
  refuseStartOverUserState,
  ensureRootForSpace,
  unnamedDefault,
  claimSpace,
  attachHostFor,
  maxSessionsFor,
  recordOurMesh,
  seedPersonaAfterUp,
  belowPresenceSafeBroker,
} from "./up-detach.js";
export { type DetachOpts, prepareBrokerStart, startMeshDetached, claimSpace, attachHostFor, maxSessionsFor, recordOurMeshForTest } from "./up-detach.js";

export { validateUpArguments } from "./up-args.js";

/** What a guarded restore returned, for `backup restore` to report as its own receipt. `up --restore`
 *  never sets a sink and prints its own startup receipt. Delivered only after the native activation wrote
 *  the active journal; every earlier failure still throws through the same restore guards. */
export interface RestoreStartupResult {
  attemptId: string;
  space: string;
  root: string;
  server: string;
  mode: PreparedRestore["mode"];
  selection: PreparedRestore["selection"];
  restoredStreams: readonly string[];
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
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the guarded restore returned without its activation result; the journal records its state and no step was repeated", { target: { root, ...(held ? { attemptId: held.attemptId, journalState: held.journalState } : {}) }, remedy: held?.remedy ?? "this root's maintenance journal names no restore attempt; check it with `cotal status`" });
  }
  return returned;
}

/** `cotal up` flags — colocated with the command (like `spawnFlags`) so its completion can read them. */
export const upFlags: FlagSpec[] = [
  { name: "server", type: "string", value: "<url>", description: "listen URL; a stack's first up records it and later ups keep it" },
  { name: "host", type: "string", value: "<host>", description: "bind host override (an IP/hostname, not a URL; the URL is --server)" },
  { name: "space", type: "string", value: "<s>", description: "space name (default: the folder's)" },
  { name: "root", type: "string", value: "<dir>", description: "start the project in this folder instead of the current one; it must already have its own .cotal" },
  { name: "store-dir", type: "string", value: "<dir>", description: "JetStream store directory" },
  { name: "max-file-store", type: "string", value: "<bytes>", description: "JetStream file storage cap in bytes (default: nats-server's dynamic cap). Fixed at broker start and recorded for the next `up`; a legacy root also keeps it across `down --preserve-state`" },
  { name: "log-file", type: "string", value: "<path>", description: "nats-server log file path; recorded and reused by later starts" },
  { name: "logfile-size-limit", type: "string", value: "<bytes>", description: "nats-server log rotation threshold in bytes; requires --log-file, a saved controller log path, or broker.logFile in a manifest" },
  { name: "logfile-max-num", type: "string", value: "<count>", description: "maximum total broker log files retained; requires --log-file, a saved controller log path, or broker.logFile in a manifest" },
  { name: "auth-timeout", type: "string", value: "<seconds>", description: "user-auth only: how long the broker waits for the auth callout, 1 to 60 seconds (default: nats-server's 2); the auth service answers inside it. Fixed at broker start and recorded for the next `up`" },
  { name: "max-payload", type: "string", value: "<bytes>", description: `broker-wide message size limit in bytes (default: nats-server's ${NATS_DEFAULT_MAX_PAYLOAD}). A manager-backed start needs at least 263168, and service endpoint caller grants need at least 2098176. Fixed at broker start and recorded for the next \`up\`` },
  { name: "account-resolver", type: "string", value: "<memory|full>", description: "how the broker resolves space accounts: memory (default) knows only the accounts its configuration lists, so adding one means a reload; full also keeps pushed account claims in .cotal/account-jwts, so a host can add and retire accounts on the running broker without a reload. Fixed at broker start and recorded for the next `up`" },
  { name: "channels", type: "string", value: "<path>", description: "channel-registry seed file (JSON; default .cotal/channels.json); not used with -f" },
  { name: "tls-cert", type: "string", value: "<file>", description: "serve the broker over TLS with this certificate (requires --tls-key)" },
  { name: "tls-key", type: "string", value: "<file>", description: "the private key for --tls-cert" },
  { name: "restore", type: "string", value: "<dir>", description: "restore an offline backup before exposing the normal listener" },
  { name: "restore-only", type: "string", value: "<registry>", description: "restore only the registry component" },
  { name: "accept-missing-source", type: "boolean", description: "explicit disaster consent when the inode-bound preserved source is absent" },
  { name: "accept-stale-checkpoint", type: "boolean", description: "explicit consent to resume a seat checkpoint captured outside its recorded recency horizon" },
  { name: "open", type: "boolean", description: "unauthenticated dev mesh (no JWT/ACLs)" },
  { name: "user-auth", type: "boolean", description: "per-USER auth: login + bearer through the space's auth service" },
  { name: "idp", type: "string", value: "<url>", description: "with --user-auth: the IdP auth base URL to pin (first enable)" },
  { name: "exchange-public-port", type: "string", value: "<n>", description: "legacy user-auth startup only: public loopback port (0 to 65535) for an HTTPS reverse proxy" },
  { name: "exchange-public-url", type: "string", value: "<https://…>", description: "legacy user-auth startup only, with --exchange-public-port: advertise the reverse proxy's HTTPS URL" },
  { name: "exchange-trusted-proxy", type: "boolean", description: "legacy user-auth startup only, with --exchange-public-port: attribute peers by the last X-Forwarded-For hop (default: socket address)" },
  { name: "advertised-server", type: "string", value: "<url>", description: "legacy user-auth startup only, with --exchange-public-port: broker address to advertise (default: --server)" },
  { name: "service-endpoints", type: "boolean", description: "with --user-auth: the auth service also hosts service endpoints (the registration door and the owner-decision host route)" },
  { name: "agent-provisioning-url", type: "string", value: "<https://…>", description: "legacy user-auth startup only, with --exchange-public-port: agent-provisioning endpoint to advertise" },
  { name: "rotate-sys", type: "boolean", description: "renew the expired/expiring $SYS creds by rotating the system account (agents, data and creds survive; needs a stopped mesh)" },
  { name: "recreate-membership-store", type: "boolean", description: "replace a stopped space's legacy File-backed derived membership feed with the current Memory-backed store" },
  { name: "recreate-issued-stores", type: "string", value: "<backup-dir>", description: "back up this space's issued-authority stores created before 0.111.0 into a new <backup-dir>, delete them and create them again (needs a stopped stack and every other issuer of the space stopped)" },
  { name: "detach", type: "boolean", short: "d", description: "run in the background (the default; stop with `cotal down`)" },
  { name: "foreground", type: "boolean", description: "keep a non-manifest native stack in this terminal; -f currently refuses" },
  { name: "runtime", type: "string", value: "<name>", description: "agent runtime for the mesh manager (default pty; extension runtimes are explicit-only, see `cotal runtimes`); with -f overrides the manifest's runtime" },
  { name: "max-sessions", type: "string", value: "<n>", description: "live-session ceiling for the mesh manager (default 64; one session per console pane, so size for agents × panes). Recorded and reused by later manager launches" },
  { name: "manager-name", type: "string", value: "<name>", description: "name this root's manager for who --all, the manager choice and --on; kept for later starts" },
  { name: "seat-cap", type: "string", value: "<n|unlimited>", description: "live seats this root's manager admits per owner (default unlimited); kept for later starts" },
  { name: "no-manager", type: "boolean", description: "broker-only boot: start the broker and, in auth mode, the delivery daemon, and no local manager (refuses on a mesh whose manager is live)" },
  { name: "file", type: "string", short: "f", value: "<cotal.yaml>", description: "launch a whole mesh from a manifest" },
  { name: "dry-run", type: "boolean", description: "with -f: print the plan, mutate nothing" },
  { ...jsonFlag, description: "one structured receipt on stdout (controller-owned stack only, without --foreground)" },
  { ...plainFlag, description: "plain line-oriented receipt (controller-owned stack only, without --foreground)" },
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
  if (flag && ["root", "restore", "recreate-issued-stores", "file", "channels", "tls-cert", "tls-key", "store-dir"].includes(flag.name)) return { items: [], directive: "default" };
  if (flag) return { items: [], directive: "nofiles" };
  const items = upFlags.map((f) => ({ value: `--${f.name}`, description: f.description }));
  return { items, directive: items.length ? "nofiles" : "default" };
}

export { preparedUpRoot } from "./up-target.js";

/** The guarded whole-stack stop a foreground signal runs, acknowledged by that signal's exit code. A
 *  failed or unknown stop is reported with its retained members; nothing is force-killed. */
function stopForegroundStack(root: string, signal: "SIGINT" | "SIGTERM"): Promise<void> {
  return stackDown(root, { yes: true }).catch((error) => {
    process.stderr.write(`${renderReport(commandFailureReport(isCommandFailure(error) ? error : new CommandFailure("unknown", "OPERATION_UNKNOWN", "the foreground stack stop did not confirm its outcome; its members were retained")), "rich", process.stderr)}\n`);
  }).finally(() => { process.exitCode = signal === "SIGINT" ? 130 : 143; });
}

/** A hangup, such as a closed terminal, is not a stop. The stack keeps running and the notice names
 *  the command that stops it. Release this process's hold before the immediate exit, which does not
 *  unwind the surrounding finally, so a later foreground `up` can take the running stack over. */
function hangupForegroundStack(root: string): never {
  process.stderr.write(`The terminal closed. This stack in ${root} is still running; \`cotal down\` stops it.\n`);
  process.exitCode = 129;
  releaseForegroundHold(root);
  process.exit(129);
}

/** Foreground controller stack: the terminal holds the stack's lifetime until SIGINT or SIGTERM,
 *  which runs the same guarded whole-stack stop as bare `down`. A hangup leaves the stack running and
 *  exits 129, naming `cotal down`. `start`, when given, is the startup this terminal already holds: a
 *  signal during it lets the start settle, then a stop signal runs that stop and a hangup leaves what
 *  the start left. A failed start still runs the stop, and its failure is thrown once the stop returns.
 *  The hold exits 0 after a completed external stop or preserve, 5 after a broker crash, 129 after
 *  a hangup, 130 or 143 after a stop signal, whatever the start receipt set. */
export async function holdForegroundStack(root: string, start?: () => Promise<void>, releaseRestoreNotice?: () => void): Promise<void> {
  claimForegroundHold(root);
  try { await holdStack(root, start, releaseRestoreNotice); }
  finally { releaseForegroundHold(root); }
}

async function holdStack(root: string, start?: () => Promise<void>, releaseRestoreNotice?: () => void): Promise<void> {
  // The start's listeners go only once the hold's own are installed. Node runs a listener for a
  // signal when the loop next polls, and drops the signal if its last listener was removed first,
  // so a signal that lands in the start's last synchronous step would be lost in between.
  let releaseStart = (): void => {};
  if (start) {
    let requested: "SIGINT" | "SIGTERM" | "SIGHUP" | undefined;
    const request = (signal: "SIGINT" | "SIGTERM" | "SIGHUP") => {
      if (requested) return;
      requested = signal;
      process.stderr.write(signal === "SIGHUP"
        ? "The terminal closed; the start settles, then the stack is left running\n"
        : "Stop requested; the whole-stack stop runs once the start settles\n");
    };
    const interrupt = () => request("SIGINT"), terminate = () => request("SIGTERM"), hangup = () => request("SIGHUP");
    process.on("SIGINT", interrupt); process.on("SIGTERM", terminate); process.on("SIGHUP", hangup);
    handOverStartupNotice();
    let failure: { error: unknown } | undefined;
    try { await start(); } catch (error) { failure = { error }; }
    releaseStart = () => { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); process.off("SIGHUP", hangup); };
    if (requested || failure) releaseStart();
    if (requested === "SIGHUP") hangupForegroundStack(root);
    if (requested) await stopForegroundStack(root, requested);
    if (failure) throw failure.error;
    if (requested) return;
  }
  return new Promise<void>((resolveHold) => {
    // The poll keeps Node alive and observes the recorded broker and external stack operations.
    const held = (() => { try { return readStackJournal(root)?.journal.operation.id; } catch { return undefined; } })();
    let stopping = false;
    const lifetime = setInterval(() => {
      if (stopping) return;
      const code = foregroundStackEnd(root, held);
      if (code === undefined) return;
      stopping = true;
      process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); process.off("SIGHUP", hangup);
      clearInterval(lifetime);
      process.exitCode = code;
      resolveHold();
    }, 1000);
    const stop = (signal: "SIGINT" | "SIGTERM") => {
      if (stopping) return;
      stopping = true;
      process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); process.off("SIGHUP", hangup);
      clearInterval(lifetime);
      void stopForegroundStack(root, signal).finally(resolveHold);
    };
    const interrupt = () => stop("SIGINT");
    const terminate = () => stop("SIGTERM");
    const hangup = () => { if (!stopping) hangupForegroundStack(root); };
    process.on("SIGINT", interrupt); process.on("SIGTERM", terminate); process.on("SIGHUP", hangup);
    releaseStart();
    handOverStartupNotice();
    releaseRestoreNotice?.();
  });
}

/** The registered `up` command. When a background run is the main process of a systemd unit, it
 *  names that unit and the `--foreground` remedy once startup returns: controller stack, retained
 *  launcher, refresh and restore alike. It never changes the run's mode. Internal callers of
 *  {@link up} print nothing. */
export async function upCommand(args: ParsedArgs): Promise<void> {
  try {
    await up(args);
    // A run that started no process, such as one that found its stack running, still reconciles.
    await seedBeforeLaunch();
  } catch (error) {
    throw seedMovedFailure(error);
  }
  const warning = upSystemdSupervisionWarning(args.values);
  if (warning) console.error(c.yellow(warning));
}

/** A failure after this run moved the connector seed store says so, instead of claiming that nothing
 *  was written: an older cotal refuses the store from then on. */
function seedMovedFailure(error: unknown): unknown {
  const moved = seedStoreMoved();
  if (!moved || !(error instanceof Error)) return error;
  const note = seedMoveNote();
  if (note === undefined) return error;
  const message = `${error.message.replace(/; nothing was (?:started or )?written$/, "")}; ${note}`;
  if (!isCommandFailure(error)) {
    error.message = message;
    return error;
  }
  const changed = { kind: "seed-store", path: seedDir(), ...(moved.from === undefined ? {} : { from: moved.from }), to: moved.to };
  return new CommandFailure(error.outcome, error.code, message, { remedy: error.remedy, native: error.native, target: error.target, changed: [...(error.changed ?? []), changed], cause: error.cause, selfContained: error.selfContained, remedyIsCommand: error.remedyIsCommand });
}

/** `inheritedLock` is the root maintenance lock a recovery re-entry hands down (see the re-entry
 *  below). Ownership transfers with it: this call releases it at its own release point. */
export async function up(args: ParsedArgs, inheritedLock?: MaintenanceLock, freshTeamBoot = false, restoreSink?: (result: RestoreStartupResult) => void): Promise<void> {
  // One `up`, its re-entries included, reads each channels file once (see `channelsReads`).
  if (!channelsReads.getStore()) return channelsReads.run(new Map(), () => up(args, inheritedLock, freshTeamBoot, restoreSink));
  // A --server is recorded and compared in one spelling, the scheme in lower case with no bare
  // trailing slash. A manifest boot checks its own override against broker.servers.
  if (typeof args.values.server === "string" && !args.values.file) args = { ...args, values: { ...args.values, server: canonicalServer(args.values.server) } };
  // A re-entry owns its inherited lock even if mode validation refuses before runUp adopts it.
  let adopted = false;
  try {
    validateUpArguments(args);
    const root = args.values.root === undefined ? undefined : preparedUpRoot(String(args.values.root));
    const fresh = args.values.root === undefined ? freshFolderRoot(args.values) : undefined;
    checkNewUpSpace(args.values.space, root ?? fresh);
    // Validate a seed before writing stack records only on the route that uses it.
    if (typeof args.values.channels === "string" && args.values.file) recordOperationWarning({ code: "MANIFEST_CHANNEL_SEED_IGNORED", target: null, message: "--channels is not used with -f. Set channels and defaults in the manifest." }, { echo: args.values.json !== true });
    else if (typeof args.values.channels === "string") readChannelsFile(resolve(args.values.channels));
    const folderNamed = folderNamedSpace(args.values);
    if (folderNamed) args = { ...args, values: { ...args.values, space: folderNamed, __folderNamed: true } };
    // A fresh folder under the machine home gets its own `.cotal` before anything resolves the root, so
    // every later step uses this folder. A run that stops before writing there removes it again.
    if (fresh) {
      mkdirSync(join(fresh, ".cotal"), { mode: 0o700 });
      for (const line of hang("", `made ${join(fresh, ".cotal")} for this folder's records; the machine's home .cotal was not used`, terminalWidth(process.stderr), c.dim)) console.error(line);
    }
    const previousCwd = process.cwd();
    // Path flags still mean paths relative to the invoking directory, not the selected root.
    // The recursive restore/resume re-entries inherit absolute paths and the same absolute root.
    const paths = root ? Object.fromEntries(["file", "restore", "channels", "tls-cert", "tls-key", "store-dir", "log-file"].filter((key) => typeof args.values[key] === "string" && args.values[key] !== "").map((key) => [key, resolve(String(args.values[key]))])) : {};
    // The receipt's Next must run from the folder up was invoked in, which a re-entry inherits.
    const invokedRoot = root && args.values.__invokedRoot === undefined ? { __invokedRoot: canonicalRoot(cotalRoot()) } : {};
    const invocation: ParsedArgs = { ...args, values: { ...args.values, ...paths, ...(root ? { root } : {}), ...invokedRoot, detach: args.values.foreground !== true } };
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
    try { return await runUp(invocation, previousCwd, inheritedLock, () => { adopted = true; }, freshTeamBoot, restoreSink); }
    catch (error) {
      if (fresh) removeEmptyRecords(join(fresh, ".cotal"));
      throw error;
    }
    finally { if (root) process.chdir(previousCwd); }
  } finally {
    if (inheritedLock && !adopted) releaseMaintenanceLock(inheritedLock);
  }
}

/** Remove the `.cotal` a failed `up` made for a fresh folder when the run wrote nothing in it. One
 *  that holds anything stays, as the run's records. */
function removeEmptyRecords(path: string): void {
  try { rmdirSync(path); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOTEMPTY" && code !== "EEXIST") console.error(c.yellow(`! ${path} was left in place (${code ?? "an error"})`));
  }
}

const NO_MANAGER_DURING_RECOVERY = "--no-manager is refused while this root has a maintenance attempt to recover - a resume needs a manager to commit the preserved inventory; recover it (`cotal up` alone) or roll it back first";

function retainedStartupPresentationRefusal(root: string): CommandFailure {
  return new CommandFailure("refused", "UNSUPPORTED", "this startup uses the retained native launcher, which has no structured or plain receipt; nothing was started", { target: { root }, remedy: "use a fresh prepared root with static auth, --open, or plain-loopback --user-auth for the controller-owned stack, or omit --json/--plain" });
}

async function runUp(args: ParsedArgs, invokedFrom: string, inheritedLock?: MaintenanceLock, onAdopt?: () => void, freshTeamBoot = false, restoreSink?: (result: RestoreStartupResult) => void): Promise<void> {
  const values = args.values as {
    server?: string; "store-dir"?: string; "max-file-store"?: string; "log-file"?: string; "logfile-size-limit"?: string; "logfile-max-num"?: string; "auth-timeout"?: string; "max-payload"?: string; "account-resolver"?: string; space?: string; root?: string; open?: boolean; "user-auth"?: boolean; "service-endpoints"?: boolean; idp?: string;
    "exchange-public-port"?: string; "exchange-public-url"?: string; "exchange-trusted-proxy"?: boolean; "advertised-server"?: string; "agent-provisioning-url"?: string;
    channels?: string; detach?: boolean; foreground?: boolean; host?: string; runtime?: string; file?: string; "dry-run"?: boolean;
    restore?: string; "restore-only"?: string; "accept-missing-source"?: boolean; "rotate-sys"?: boolean; "recreate-membership-store"?: boolean; "recreate-issued-stores"?: string;
    "accept-stale-checkpoint"?: boolean;
    "tls-cert"?: string; "tls-key"?: string;
    "max-sessions"?: string;
    "manager-name"?: string;
    "seat-cap"?: string;
    "no-manager"?: boolean;
    json?: boolean; plain?: boolean;
    __restoreAttempt?: string;
    __ordinaryResumeAttempt?: string;
    __invokedRoot?: string;
    __folderNamed?: boolean;
  };
  if (freshTeamBoot && (!values.file || values.restore || values.__restoreAttempt || values.__ordinaryResumeAttempt || values["rotate-sys"] || values["no-manager"])) throw new CommandFailure("refused", "USAGE_INVALID", "fresh team boot accepts one manifest and its selected lifetime, not a restore, rotation or manager-free override");
  if (values["manager-name"] !== undefined && (values.restore || values.file || values["no-manager"])) throw new CommandFailure("refused", "USAGE_INVALID", "--manager-name names the manager a plain `cotal up` starts; it cannot be combined with --restore, --file or --no-manager");
  if (values["seat-cap"] !== undefined && (values.restore || values.file || values["no-manager"])) throw new CommandFailure("refused", "USAGE_INVALID", "--seat-cap caps the manager a plain `cotal up` starts; it cannot be combined with --restore, --file or --no-manager");
  // `space create` and `down` refuse a root other local accounts can write, so `up` refuses it too,
  // before anything is written: a stack started there could not be stopped from it.
  protectedLocalDirectory(canonicalRoot(cotalRoot()), "the project root");
  if (values.restore !== undefined) {
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
    const root = cotalRoot();
    assertSingleSpaceBroker(authDir(root), "cotal up --restore");
    const flags = values as RestoreFlags;
    const journal = readMaintenanceJournal(root);
    const nextArgs = (launch: ReturnType<typeof restoreLaunch>["launch"], attemptId?: string): ParsedArgs => {
      const defaultStore = join(launch.root, ".cotal", "nats");
      const atDefault = launch.targetPath === defaultStore || (() => { try { return realpathSync(defaultStore) === launch.targetPath; } catch { return false; } })();
      return { ...args, values: {
        ...values,
        ...(values["store-dir"] === undefined && !atDefault ? { "store-dir": launch.targetPath } : {}),
        restore: undefined,
        "restore-only": undefined,
        "accept-missing-source": undefined,
        __restoreAttempt: attemptId,
        space: values.space ?? launch.space,
        server: launch.server, host: launch.host,
        runtime: launch.runtime,
        "max-file-store": launch.maxFileStore === undefined ? undefined : String(launch.maxFileStore),
        open: launch.mode === "open",
        "user-auth": launch.mode === "user",
      } };
    };
    const validateLaunch = async (launch: ReturnType<typeof restoreLaunch>["launch"], controller: boolean) => {
      if (controller) return;
      const next = nextArgs(launch);
      validateUpArguments(next);
      const wantUser = launch.mode === "user";
      publicExchangeArgs(values, wantUser);
      serviceEndpointsArgs(values, wantUser);
      if (values.json || values.plain) throw retainedStartupPresentationRefusal(root);
      const transport = resolveTransport(values, undefined, root, { persist: false, quiet: true });
      assertTlsIntentServed(launch.server, transport, "--server");
      assertTlsAddressServed(launch.server, transport, root);
      assertServesDialHost(transport, new URL(launch.server).hostname);
      loadChannelsFile();
      if (wantUser && values.idp !== undefined) await preflightUserStack(root, launch.space, values.idp);
      try { await preflightRuntime(launch.runtime); }
      catch (error) { throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the requested runtime did not pass preflight; nothing was restored", { target: { root, space: launch.space, runtime: launch.runtime }, remedy: error instanceof Error ? error.message : "inspect the selected runtime provider" }); }
    };
    // Validate the synthesized re-entry before preparation, then recheck the launch read under the
    // restore lock before staging, in case the preserved cut changed in the meantime.
    if (journal?.state === "ready" && !cutController(journal.cut)) {
      restoreArtifactPath(root, flags.restore, journal.source.path);
      await validateLaunch(restoreLaunch(root, flags, journal).launch, false);
    }
    // `up` keeps the startup interrupt notice (`keepsStartupNotice`); a restore reports its own.
    await releaseStartupNotice();
    // A `backup restore` owns stdout for its receipt, so its seat admission lines go to stderr.
    const prepared = await prepareRestore(root, flags, validateLaunch, restoreSink ? (line) => console.error(line) : undefined);
    pendingRestores.set(prepared.attemptId, prepared);
    try {
      const committed = readMaintenanceJournal(prepared.root);
      if (committed && cutController(committed.cut)) {
        // A controller restore continues through its recorded members. A member
        // that cannot start holds the attempt at commit intent for bare `cotal up` to continue; it is
        // not marked degraded, because a degraded attempt starts nothing.
        const lock = acquireMaintenanceLock(prepared.root);
        let foreground: boolean;
        try { foreground = await resumeControllerStack(lock, prepared.root, values, restoreSink); }
        finally { releaseMaintenanceLock(lock); }
        if (foreground) await holdForegroundStack(prepared.root, undefined, prepared.releaseInterruptNotice);
        return;
      }
      if (restoreSink) restoreSinks.set(prepared.attemptId, restoreSink);
      try {
        await up(nextArgs(prepared, prepared.attemptId));
      } catch (error) {
        // The re-entry has already released its startup lock, so this helper takes its own.
        markPreparedRestoreDegraded(prepared.root, prepared.attemptId, (error as Error).message);
        throw error;
      }
    } finally {
      prepared.releaseInterruptNotice?.();
      pendingRestores.delete(prepared.attemptId);
      restoreSinks.delete(prepared.attemptId);
    }
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
    if (values["recreate-issued-stores"] !== undefined && readMaintenanceJournal(root))
      throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "--recreate-issued-stores needs a fresh broker start, and this root has a maintenance attempt to recover; nothing was started", { target: { root }, remedy: "finish or roll back that attempt first (`cotal up` alone recovers it)" });
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
    if (values.space === undefined && unnamedDefault(root, stackSpace)) assertSelectionNotMoved(root, stackSpace);
    recordOperationSpace(stackSpace);
    if (!readMaintenanceJournal(root)) {
      const controller = controllerStackApplies(root, stackSpace, values);
      const recordedStack = readStackJournal(root);
      if ((recordedStack?.journal.mode ?? requestedStackMode(values)) === "user" && (!recordedStack || values.idp !== undefined)) {
        const server = values.server ?? recordedStack?.journal.server ?? localMeshesForRoot(root).find((m) => m.space === stackSpace)?.server ?? (values.host ? reconcileHostAndServer(values.host, undefined) : DEFAULT_SERVER);
        const transport = resolveTransport(values, undefined, root, { persist: false, quiet: true });
        if (controller) assertUserStackTransport(server, transport.kind === "tls-required");
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
    // A concurrent whole-stack operation is a known refusal that names its pid, as for `down`.
    const lock = acquireStackOperationLock(root);
    let pending: PendingOrdinaryResume | undefined;
    let recoveredRestore: PreparedRestore | undefined;
    // Set only at the moment the lock is passed to a re-entry, which then owns releasing it. Any
    // other exit from this block — including a throw after `pending` was built — still releases.
    let handedOff = false;
    try {
      const journal = readMaintenanceJournal(root);
      // A recorded maintenance attempt is recovered on its own terms, with no startup notice.
      if (journal) await releaseStartupNotice();
      if (journal?.state === "restore-ready") {
        // Ordinary up NEVER rolls back an in-progress restore: a live attempt's target may still be
        // written by its isolated broker. Refuse with the exact recovery recourse instead.
        const attempt = journal.restore.attemptId;
        const assessment = assessRestoreClaim(journal, { unrecordedOwnersDead: attemptProcessesGone(root) });
        if (assessment !== "stale") throw heldClaim(root, attempt, journal.claim, "cotal up", assessment);
        throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `cotal up is refused: restore attempt ${attempt} stopped before it committed and still holds the store; nothing was changed`, { target: { root, attemptId: attempt }, remedy: `roll it back with \`cotal backup recover ${attempt} --yes\`, then run \`cotal up\`; or run the restore again` });
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
        // The restore committed and its broker runs, so there is nothing to hand off or adopt.
        if (status === "alive") throw restoredBrokerRuns(root, journal.restore.attemptId, journal.listenerProof.processOwner.pid);
      } else if (journal?.state === "ready") {
        const source = preservedSourceState(root, journal.source);
        if (source.state === "moved") throw movedFolderRefusal(root, journal.space, journal.source.path, source, "run `cotal up`");
        if (source.state === "missing")
          throw new CommandFailure("refused", "TARGET_NOT_FOUND", `the preserved store recorded at ${journal.source.path} is missing, so up cannot resume it; nothing was started`, { target: { root, space: journal.space, recordedStore: journal.source.path }, remedy: "if this folder was moved, move it back so that path exists again; if the store is lost, restore a backup here with `cotal backup restore <dir> --accept-missing-source`" });
        const resume = readMaintenanceResumeDocument(root, journal.resume);
        const attemptId = `resume-${randomUUID()}`;
        const launch = resume.launch as { server?: unknown; storeDir?: unknown; maxFileStore?: unknown };
        const agents = (resume.inventory as { agents?: Array<{ launch?: { runtime?: unknown } }> }).agents ?? [];
        const runtimes = [...new Set(agents.map((agent) => agent.launch?.runtime).filter((value): value is string => typeof value === "string"))];
        if (runtimes.length > 1) throw new Error(`resume inventory requires multiple runtimes: ${runtimes.join(", ")}`);
        const resumeServer = typeof launch.server === "string" ? launch.server : DEFAULT_SERVER;
        // A resume starts what `down --preserve-state` recorded. Another value is a new start, which
        // follows a normal `down` of the resumed mesh.
        const preservedOnly = (flag: string, given: string | number, what: string, preserved: string) => new CommandFailure("refused", "CONFLICT", `${flag} ${given} is not the ${what} that down --preserve-state recorded here (${preserved}), and a resume starts what it recorded; nothing was started`, {
          target: { root, space: journal.space, flag, given: String(given), preserved },
          remedy: `resume with \`cotal up\` without ${flag}; to use ${given}, stop the resumed mesh with \`cotal down\`, then run \`cotal up ${flag} ${given}\``,
        });
        if (values.server !== undefined && values.server !== resumeServer) throw preservedOnly("--server", values.server, "broker address", resumeServer);
        const givenStore = values["store-dir"];
        if (givenStore !== undefined && resolve(givenStore) !== journal.source.path) {
          let same = false;
          try { same = sameStoreIdentity(readStoreIdentity(resolve(givenStore)), journal.source); } catch { same = false; }
          if (!same) throw preservedOnly("--store-dir", givenStore, "store", journal.source.path);
        }
        const requestedStore = givenStore ?? (typeof launch.storeDir === "string" ? launch.storeDir : journal.source.path);
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
        const requestedMaxFileStore = parseMaxFileStore(values["max-file-store"]);
        if (requestedMaxFileStore !== undefined && requestedMaxFileStore !== resumeMaxFileStore)
          throw preservedOnly("--max-file-store", requestedMaxFileStore, "file store cap", resumeMaxFileStore === undefined ? "no cap" : String(resumeMaxFileStore));
        // The resumed broker renders this root's recorded auth callout timeout again.
        const recordedPolicy = readBrokerPolicy(root);
        const recordedTimeout = recordedPolicy?.authTimeout;
        const requestedTimeout = parseAuthTimeout(values["auth-timeout"]);
        if (requestedTimeout !== undefined && requestedTimeout !== recordedTimeout)
          throw preservedOnly("--auth-timeout", requestedTimeout, "auth callout timeout", recordedTimeout === undefined ? "none" : String(recordedTimeout));
        // So is the payload limit: a resume renders the recorded one.
        const recordedPayload = recordedPolicy?.maxPayload;
        const requestedPayload = parseMaxPayload(values["max-payload"]);
        if (requestedPayload !== undefined && requestedPayload !== recordedPayload)
          throw preservedOnly("--max-payload", requestedPayload, "payload limit", recordedPayload === undefined ? "none" : String(recordedPayload));
        // And the account resolver.
        const recordedResolver = recordedPolicy?.accountResolver ?? "memory";
        const requestedResolver = parseAccountResolver(values["account-resolver"]);
        if (requestedResolver !== undefined && requestedResolver !== recordedResolver)
          throw preservedOnly("--account-resolver", requestedResolver, "account resolver", recordedResolver);
        if (values.runtime && runtimes[0] && values.runtime !== runtimes[0])
          throw preservedOnly("--runtime", values.runtime, "agent runtime", runtimes[0]);
        const resumeRuntime = values.runtime ?? runtimes[0] ?? "pty";
        // The resumed broker binds this address, so another listener there would leave the resume
        // degraded. It is refused here, before anything is journalled or started, as backup create does.
        await assertEndpointUnreachable(resumeServer).catch((error: Error) => {
          throw new CommandFailure("refused", "CONFLICT", `${error.message}; the resumed broker needs that address, so nothing was started`, { target: { root, space: journal.space, server: resumeServer }, remedy: `stop the process that listens on ${resumeServer}, then run \`cotal up\` again` });
        });
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
        const requestedMaxFileStore = parseMaxFileStore(values["max-file-store"]);
        if (requestedMaxFileStore !== undefined && requestedMaxFileStore !== recoveredMaxFileStore)
          throw new Error(`--max-file-store ${requestedMaxFileStore} is not the preserved launch cap (${recoveredMaxFileStore ?? "unset"}); resume attempt ${attemptId} re-renders exactly the preserved cap - omit --max-file-store`);
        const requestedTimeout = parseAuthTimeout(values["auth-timeout"]);
        if (requestedTimeout !== undefined && requestedTimeout !== readBrokerPolicy(root)?.authTimeout)
          throw new Error(`--auth-timeout ${requestedTimeout} is not this root's recorded auth callout timeout; resume attempt ${attemptId} re-renders the recorded one - omit --auth-timeout`);
        const requestedPayload = parseMaxPayload(values["max-payload"]);
        if (requestedPayload !== undefined && requestedPayload !== readBrokerPolicy(root)?.maxPayload)
          throw new Error(`--max-payload ${requestedPayload} is not this root's recorded payload limit; resume attempt ${attemptId} re-renders the recorded one - omit --max-payload`);
        const requestedResolver = parseAccountResolver(values["account-resolver"]);
        if (requestedResolver !== undefined && requestedResolver !== (readBrokerPolicy(root)?.accountResolver ?? "memory"))
          throw new Error(`--account-resolver ${requestedResolver} is not this root's recorded account resolver; resume attempt ${attemptId} re-renders the recorded one - omit --account-resolver`);
        // Recovery re-asserts the source identity rather than trusting the journaled spelling.
        assertStoreIdentity(journal.source);
        // The bound listener decides re-entry: a live exact listener is ADOPTED, a provably dead
        // one is durably retired before a fresh spawn, ambiguity refuses, and a manager-committed
        // resume never replaces the listener its durable token is bound to.
        let adoptProof: ListenerProof | undefined;
        const recoveredProof = journal.listenerProof;
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
      } else if (journal?.state === "claimed") {
        // An interrupted backup create holds the cut. Refuse with its holder or its release.
        const attempt = journal.claim.attemptId;
        const assessment = assessMaintenanceClaim(journal.claim, { unrecordedOwnersDead: attemptProcessesGone(root) });
        if (assessment !== "stale") throw heldClaim(root, attempt, journal.claim, "cotal up", assessment);
        throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `cotal up is refused: backup attempt ${attempt} stopped before it finished and still holds this root; nothing was changed`, { target: { root, attemptId: attempt }, remedy: `release it with \`cotal backup recover ${attempt} --yes\`, then run \`cotal up\`` });
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
  const publicExchange = [...publicExchangeArgs(values, wantUser), ...serviceEndpointsArgs(values, wantUser)];
  const maxSessions = parsePositiveIntegerFlag("--max-sessions", values["max-sessions"]);
  const maxFileStore = parseMaxFileStore(values["max-file-store"]);
  const logFile = values["log-file"] === undefined ? undefined : resolve(values["log-file"]);
  const logfileSizeLimit = parsePositiveIntegerFlag("--logfile-size-limit", values["logfile-size-limit"]);
  const logfileMaxNum = parsePositiveIntegerFlag("--logfile-max-num", values["logfile-max-num"]);
  const authTimeout = parseAuthTimeout(values["auth-timeout"]);
  const maxPayload = parseMaxPayload(values["max-payload"]);
  const accountResolver = parseAccountResolver(values["account-resolver"]);
  // The manifest path renders its broker from the manifest, which has no store fields, so the flag
  // would be accepted and never rendered. Refuse it rather than drop it.
  if (maxFileStore !== undefined && values.file)
    throw new FlagValueRefusal("--max-file-store cannot be combined with --file/-f: a manifest launch does not render a store cap, so nothing was started", "drop --max-file-store, or start the mesh without -f");
  // An open mesh has no operator, no system account, and no $SYS creds, so there is nothing to
  // rotate; the request is a misunderstanding to name, never a silent no-op that reports success.
  if (values["rotate-sys"] && values.open) {
    throw new FlagValueRefusal("--rotate-sys is for auth meshes: an open mesh (--open) has no system account or $SYS credentials to rotate, so nothing was started", "drop --rotate-sys, or drop --open to rotate an auth mesh's system account");
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
      // Only a manifest error is deferred: the -f path reports it from the same load. The pin's refusal
      // is not one of those errors, and the path that finds a broker already answering the manifest's
      // address never reaches the later pin in startMeshDetached, so the catch used to discard it.
      let prepared: ReturnType<typeof loadManifest> | undefined;
      try {
        prepared = loadManifest(resolve(values.file), logFile);
      } catch {
        // Manifest errors are reported by the -f path with the same load; do not double-print.
      }
      // A --space that names another space is refused by the -f path below, before anything is written.
      if (prepared && (values.space === undefined || values.space === prepared.manifest.space)) ensureRootForSpace(prepared.manifest.space);
    } else {
      ensureRootForSpace(spaceForRoot);
    }
  }
  // `--manager-name` is recorded for this root, where the manager reads it at each start. A running
  // manager keeps the name it started with, so a different name while one runs is refused.
  if (values["manager-name"] !== undefined) {
    const name = assertManagerName(values["manager-name"]);
    const named = { root: cotalRoot(), space: values.space ?? folderSpace() };
    if (readManagerName(named) !== name) {
      if (managerRecordState(named.space, named.root).state === "alive")
        throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `a manager already runs for space ${named.space}, and it keeps the name it started with`, { target: { root: named.root, space: named.space }, remedy: `stop it with \`cotal down\`, then run ${codeSpan(`cotal up --manager-name ${shellWord(name)}`)}` });
      if (!values["dry-run"]) recordManagerName(named, name);
    }
  }
  // The manager records this cap once it serves. A running manager keeps the cap it started with.
  const managerSeatCap = parseSeatCapFlag("--seat-cap", values["seat-cap"]);
  if (managerSeatCap !== undefined) {
    const capped = { root: cotalRoot(), space: values.space ?? folderSpace() };
    if ((readManagerSeatCap(capped) ?? DEFAULT_SEAT_CAP) !== managerSeatCap && managerRecordState(capped.space, capped.root).state === "alive")
      throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `a manager already runs for space ${capped.space}, and it keeps the seat cap it started with`, { target: { root: capped.root, space: capped.space }, remedy: `stop it with \`cotal down\`, then run \`cotal up --seat-cap ${seatCapText(managerSeatCap)}\`` });
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
  const ownerHome = legacyStackOtherHome(meshRoot);
  if (ownerHome !== undefined) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "this folder's running stack belongs to another Cotal home; nothing was started", { target: { root: meshRoot, home: ownerHome }, remedy: stackHomeRemedy(ownerHome) });
  // A bare start seeds the root's default channels file, so one it would refuse is named here,
  // before anything starts; an explicit --channels file was checked with the other flags.
  if (!values.file && !values.restore && values.channels === undefined) loadChannelsFile();
  const transport = resolveTransport(values, undefined, meshRoot, {
    persist: false,
    quiet: true,
  });
  // The manifest route checks its own effective address, which `--server` only overrides.
  if (!values.file && values.server !== undefined) assertTlsIntentServed(values.server, transport, "--server");
  // AND THE OTHER DIRECTION. `assertTlsIntentServed` refuses a `tls://` address this start would
  // serve in cleartext; this refuses a `nats://` one it would serve over TLS. `up -f` has carried
  // the same check since it gained one, and so has a `--server nats://` passed with `--tls-cert`
  // (see `validateUpArguments`), but a root whose RECORDED policy serves TLS reached neither: it
  // started a TLS broker, registered it under the `nats://` address nothing can dial, and printed
  // `TLS: serving <subject> at nats://…` over it.
  if (!values.file && values.server !== undefined) assertTlsAddressServed(values.server, transport, meshRoot);

  // CONTROLLER-OWNED STACK. A root whose stack the service controller owns, or a fresh prepared
  // static-auth, open or user-auth root with nothing legacy retained, starts as exact controller members instead
  // of the pidfile launcher. The decision is made once here; neither route falls back to the other.
  if (!values.file && controllerStackApplies(meshRoot, values.space ?? folderSpace(), values)) {
    const stackSpace = values.space ?? folderSpace();
    recordOperationSpace(stackSpace);
    const stackMode = requestedStackMode(values);
    const presentation = presentationOf(values);
    // A foreground up holds a stack only one terminal holds. Over a stack that already runs without
    // one, it takes that stack's lifetime over and says so before it blocks.
    const holder = values.foreground ? foregroundHolder(meshRoot) : undefined;
    if (holder !== undefined)
      refuseForegroundStackHolder(meshRoot, stackSpace, holder);
    const takeover = values.foreground === true && STACK_ROLES.some((role) => serviceInstances(stackSpace, STACK_DEFINITION[role]).some((row) => observeServiceProcess(row.record.value) === "running"));
    // A signal ends a detached start where it is, after it records a launch it had not yet pinned to
    // its child, and the notice names what it left running. It is installed before the lock, so no
    // moment of the start exits without it.
    const release = values.foreground ? undefined : noticeOnInterrupt(() => {
      settleInterruptedLaunches();
      const failure = stackUpInterrupted(meshRoot, stackSpace, values["no-manager"] === true);
      if (presentation === "json") writeEnvelope(failureEnvelope("up", failure));
      return `${failure.message} ${failure.remedy}`;
    });
    try {
      const stackLock = acquireStackOperationLock(meshRoot, values.foreground ? "foreground up" : undefined);
      const native = controllerStackNative();
      // A foreground terminal holds the start as well, so a signal during it stops what it started.
      const start = async () => {
        try {
          const stackServer = values.server ?? readStackJournal(meshRoot)?.journal.server ?? localMeshesForRoot(meshRoot).find((m) => m.space === stackSpace)?.server ?? await unrecordedStackServer(meshRoot, stackSpace, values.host);
          if (values.foreground && presentation !== "json") stackUpForegroundNotice(presentation, stackSpace, takeover);
          await stackUp({ maintenanceLock: stackLock, root: meshRoot, space: stackSpace, server: stackServer, transport, runtime: values.runtime ?? "pty", noManager, managerSeatCap, ...(stackMode ? { mode: stackMode } : {}), ...(values.idp ? { idp: values.idp } : {}), ...(values.host ? { host: values.host } : {}), ...(values["store-dir"] ? { storeDir: values["store-dir"] } : {}), ...(values["rotate-sys"] ? { rotateSys: true } : {}), ...(values["recreate-membership-store"] ? { recreateMembershipStore: true } : {}), ...(values["recreate-issued-stores"] !== undefined ? { recreateIssuedStores: resolve(values["recreate-issued-stores"]) } : {}), ...(maxFileStore !== undefined ? { maxFileStore } : {}), ...(logFile !== undefined ? { logFile } : {}), ...(logfileSizeLimit !== undefined ? { logfileSizeLimit } : {}), ...(logfileMaxNum !== undefined ? { logfileMaxNum } : {}), ...(authTimeout !== undefined ? { authTimeout } : {}), ...(maxPayload !== undefined ? { maxPayload } : {}), ...(accountResolver !== undefined ? { accountResolver } : {}), ...(maxSessions !== undefined ? { maxSessions } : {}), ...(values.channels ? { channels: values.channels } : {}), ...(values.__invokedRoot ? { invokedRoot: values.__invokedRoot } : {}), foreground: values.foreground === true, presentation,
            retryAtAnotherAddress: (host) => retryStackAddress(args.raw, invokedFrom, stackServer, host),
          }, native);
        } finally { releaseMaintenanceLock(stackLock); }
      };
      if (values.foreground) await holdForegroundStack(meshRoot, start);
      else await start();
    } finally { release?.(); }
    return;
  }
  // A manifest or retained-launcher start reports no interrupt notice of its own.
  await releaseStartupNotice();
  if (authTimeout !== undefined && !wantUser)
    throw new CommandFailure("refused", "USAGE_INVALID", "--auth-timeout sets the auth callout's timeout, which only a user-auth space has; pair it with --user-auth, and nothing was started", { remedy: "add --user-auth, or drop --auth-timeout" });
  // A named space this machine runs from another folder is refused before anything is written here,
  // and in every presentation, since the launcher below has no structured receipt.
  if (!values.file && values.space !== undefined) await refuseRunningElsewhere(values.space, meshRoot);
  // A bare one in a folder holding the records of a space registered for another folder does not take
  // that name over, as `down` there does not stop it.
  if (!values.file && values.space === undefined) await refuseRecordsElsewhere(meshRoot);
  if (!values.file && (values.json || values.plain)) throw retainedStartupPresentationRefusal(meshRoot);
  // `up -f cotal.yaml` is a distinct path: bring up a FRESH mesh described by a manifest (broker +
  // channels + booted agents). It owns the whole space; the additive team deploy route is separate.
  // CLI flags override the manifest (flag > manifest > default) so the same file runs at a different
  // port / runtime / auth without editing it. Its space is its target: `--space` may only repeat it.
  if (values.file) {
    const path = resolve(values.file);
    // Structured and plain manifest refusals report file errors before checking startup support.
    if (values.json || values.plain) {
      try { loadManifest(path, logFile); } catch (e) { throw manifestFileRefusal(e, path); }
    }
    // A manifest start takes the legacy launcher, which never runs beside a controller stack, running
    // or stopped, so a dry run refuses as the start would.
    const controller = freshTeamBoot ? undefined : readStackJournal(meshRoot);
    if (controller) throw new CommandFailure("refused", "CONFLICT", `this root holds the controller stack of space ${controller.journal.space}, and up -f does not start a manifest beside it; nothing was started`, {
      target: { root: meshRoot, space: controller.journal.space },
      remedy: controllerManifestRemedy(meshRoot, controller.journal.space, path),
    });
    if (values.json || values.plain) throw new CommandFailure("refused", "UNSUPPORTED", "up -f starts its manifest on the retained native launcher, which has no structured or plain receipt; nothing was started", { target: { root: meshRoot, path }, remedy: `omit ${values.json ? "--json" : "--plain"}` });
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
        storeDir: values["store-dir"],
        logFile,
        logfileSizeLimit,
        logfileMaxNum,
      });
      if (previewRoot) console.log(c.yellow("! this preview used the invoking folder, not the inherited home store; before applying, prepare it with `cotal space create <space> --root .`"));
      return;
    }
    const lock = acquireStackOperationLock(cotalRoot());
    try {
      if (freshTeamBoot) {
        if (!values.space) throw new CommandFailure("refused", "USAGE_INVALID", "fresh team boot needs the manifest's exact selected space");
        assertFreshTeamBootOwnership(cotalRoot(), values.space);
      }
      assertOrdinaryUpAllowed(cotalRoot(), undefined, values.file);
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
        storeDir: values["store-dir"],
        logFile,
        logfileSizeLimit,
        logfileMaxNum,
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
  let startupLock: MaintenanceLock | undefined = inheritedLock ?? acquireStackOperationLock(cotalRoot(), values.detach ? undefined : "foreground up");
  onAdopt?.(); // from here the release below owns it, inherited or not
  const releaseStartupLock = () => {
    if (!startupLock) return;
    releaseMaintenanceLock(startupLock);
    startupLock = undefined;
  };
  try {
    // A suspended pinned broker still holds this root's store, even at a different requested port.
    const brokerPin = verifyIdentityPin(cotalPath(NATS_PIDFILE));
    if (brokerPin.kind === "match" && processStopped(brokerPin.record.pid))
      throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `the stack's broker, pid ${brokerPin.record.pid}, is suspended and cannot answer; no broker was launched`, { target: { root: cotalRoot(), pid: brokerPin.record.pid }, remedy: `resume it with ${codeSpan(`kill -CONT ${brokerPin.record.pid}`)} and run ${codeSpan(`${displayCmd()} up`)} again` });
    // Gated on the ATTEMPT, not on holding the lock. The lock is now always held, and this refuses
    // whenever a journal exists — which is precisely the state a resume re-entry is in, so gating
    // it on the lock would refuse the very resume the lock is here to protect.
    // Without --server the default URL only seeds a first boot. A first boot that found it taken ran
    // on a free port, which this root's record keeps; a re-run must start from that URL, or every
    // lookup below misses its own mesh and the space claim refuses it (#3889).
    const recordedSpace = values.space ?? folderSpace();
    const registration = localMeshesForRoot(cotalRoot()).find((m) => m.space === recordedSpace);
    // A stopped legacy root's own files decide its start: its `down` dropped the registration that
    // kept its address, or kept one for a space named after its folder, which only holds the name.
    // With no address flag, it starts again at the address its last start rendered, and in open
    // mode when that start was open and no mode is asked for. After `clean all` only a fresh team
    // summary remains, and a start that would differ from it refuses, naming its manifest.
    const keptStopped = registration !== undefined && !resumeAttempt && values.server === undefined && keepsRegistration(registration) && !(await isReachable(registration.server));
    const registeredServer = keptStopped ? undefined : registration?.server;
    const implicit = !resumeAttempt && registeredServer === undefined && values.server === undefined && values.host === undefined && !values["user-auth"];
    // THE ADDRESS AND THE MODE ARE TWO DECISIONS, and only the address belongs to `--server` and
    // `--host`. Reading both off `implicit` meant that naming the address dropped the mode: an open
    // root restarted at the address it already ran on came back in static auth, with a delivery
    // daemon and no line saying so, and the broker that had served its agents unauthenticated now
    // refused them. The address still follows the flags; the recorded mode is inherited whenever
    // this start names no mode of its own.
    const recorded = resumeAttempt ? undefined : retainedLegacyBroker(cotalRoot());
    // A flag still wins: `--open` over a root that last ran with auth starts it open, as it always
    // has, and `--user-auth` asks for the mode the user-auth state decides. Only silence inherits.
    if (recorded?.open && values["user-auth"] !== true) values.open = true;
    const retained = implicit ? recorded : undefined;
    // An address up chooses for a TLS broker names TLS, as an explicit one must.
    const serving = (url: string) => transport.kind === "tls-required" ? tlsAddress(url) : url;
    // Printed below, once this up is known to start the stack: a refresh of the running one says nothing.
    let stoppedStart: string | undefined;
    if (retained) {
      stoppedStart = `starting this folder's stopped stack as it last ran: ${serving(retained.server)}${values.open ? ", open" : ""}`;
    } else if (recorded?.open) {
      stoppedStart = "starting this folder's stopped stack in the mode it last ran: open";
    } else if (implicit) {
      const cleaned = cleanedManifestStart(cotalRoot(), recordedSpace, values.open === true);
      if (cleaned) throw new CommandFailure("refused", "CONFLICT", `this folder was deployed from a manifest as "${cleaned.space}" at ${cleaned.server} in ${cleaned.mode === "open" ? "open" : "static auth"} mode, and its identity and broker configuration were removed, so a bare up would not start it as it was deployed; nothing was started`, { target: { root: cotalRoot(), space: cleaned.space, server: cleaned.server }, remedy: `deploy it again with ${codeSpan(cleaned.command)}` });
    }
    // A registered address stays as recorded, so a running stack is still found by it.
    const implicitServer = registeredServer ?? serving(retained?.server ?? DEFAULT_SERVER);
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
    let repairing = false;
    if (!resumeAttempt) {
      const repairSpace = values.space ?? folderSpace();
      const repairRoot = cotalRoot();
      const heldForRepair = loadMeshes().find(
        (m) => m.origin !== "manual" && m.origin !== "catalog" && m.server === server && m.root === repairRoot && m.space === repairSpace,
      );
      if (heldForRepair) {
        repairProbe = await isReachable(server);
        repairing = !repairProbe;
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
            for (const line of hang("", `reopening the recorded store ${heldForRepair.storeDir}`, terminalWidth(process.stdout), c.dim)) console.log(line);
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
    // A start interrupted after it published its broker's pid and before it registered the space left
    // that broker running on this root's store. No broker starts beside it, at its address or at
    // another one, and it is not reported as a broker started elsewhere (#7123).
    const interrupted = resumeAttempt ? undefined : interruptedStartBroker(cotalRoot());
    if (interrupted)
      throw new CommandFailure("refused", "CONFLICT", `the broker this folder started for "${interrupted.space}" still runs at ${interrupted.server} (pid ${interrupted.pid}), and no space is registered for it because the start that launched it did not finish; nothing was started`, { target: { root: cotalRoot(), space: interrupted.space, server: interrupted.server, pid: interrupted.pid }, remedy: "stop it with `cotal down`, then run `cotal up` again" });
    const restoredAttempt = resumeAttempt ? pendingRestores.get(resumeAttempt) : undefined;
    if (restoredAttempt?.reentry) {
      if (!restoredAttempt.listenerProof)
        throw new Error(`restore attempt ${resumeAttempt} re-entry has no bound listener proof; preserving recovery state`);
      const ownerStatus = localProcessOwnerStatus(restoredAttempt.listenerProof.processOwner);
      if (ownerStatus === "alive") {
        await provePreparedRestoreListener(restoredAttempt);
        await adoptProvenListener(restoredAttempt, restoredAttempt.targetPath, "proven restore listener", startupLock);
        return;
      }
      if (ownerStatus === "unknown")
        throw new Error(`restore attempt ${resumeAttempt} listener ownership is ambiguous; refusing replacement`);
      if (restoredAttempt.managerCommit)
        throw new Error(`restore attempt ${resumeAttempt} is manager-committed but its bound listener is dead; preserving the commit token and retained suppression`);
      if (await isReachable(restoredAttempt.server))
        throw new Error(`restore attempt ${resumeAttempt} refuses the occupied foreign listener at ${restoredAttempt.server}`);
      replacePreparedDeadRestoreListener(restoredAttempt, startupLock);
    } else if (restoredAttempt) {
      // No listener is bound to this attempt. A listener that an interrupted run spawned and never
      // bound may still be opening the restored store, and a second one would open it beside it, so
      // every process that names the attempt must be gone. Then the attempt starts its listener,
      // from commit intent (#7127).
      const naming = processesNaming(restoredAttempt.attemptId);
      if (naming.kind === "unreadable")
        throw new Error(`restore attempt ${resumeAttempt} re-entry has no bound listener proof, and this host cannot show that no listener it started still runs (${naming.why}); preserving recovery state`);
      if (naming.pids.length)
        throw new Error(`restore attempt ${resumeAttempt} re-entry has no bound listener proof, and process ${naming.pids.join(", ")} started for it still runs; stop it, then run \`${displayCmd()} up\` again; preserving recovery state`);
      if (await isReachable(restoredAttempt.server))
        throw new Error(`restore attempt ${resumeAttempt} refuses the occupied foreign listener at ${restoredAttempt.server}`);
      rearmUnboundRestore(restoredAttempt, startupLock);
    }
    const ordinaryAttempt = resumeAttempt ? pendingOrdinaryResumes.get(resumeAttempt) : undefined;
    if (ordinaryAttempt?.adoptProof) {
      // The recovered attempt's exact bound listener is alive: prove it over the wire and adopt it
      // instead of spawning a competitor over the same store.
      await proveOrdinaryResumeListener(ordinaryAttempt);
      await adoptProvenListener(ordinaryAttempt, ordinaryAttempt.storeDir, "adopted resume listener", startupLock);
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
      if (values["recreate-issued-stores"] !== undefined)
        throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `mesh "${held.space}" is already running at ${server}, and its issued-authority stores are recreated only on a fresh broker start, before any issuer runs; nothing was changed`, { target: { space: held.space }, remedy: "stop the stack first, then run `cotal up --recreate-issued-stores <backup-dir>` again" });
      if (values["recreate-membership-store"])
        throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `mesh "${held.space}" is already running at ${server}, and membership storage conversion deletes the derived feed before recreating it; nothing was changed`, { target: { space: held.space }, remedy: "stop the stack first, then run `cotal up --recreate-membership-store` again" });
      // `--foreground` asks this terminal to hold the stack's lifetime, but this branch starts
      // nothing here: it used to print `✓ already running`, restart a missing manager detached and
      // exit 0. A service unit relying on `--foreground` read that exit as the stack ending, stopped
      // it, and restarted into the same branch. Refuse and name the remedy.
      if (values.foreground) {
        console.error(
          c.red(
            `✗ mesh "${held.space}" is already running at ${server} - \`cotal up --foreground\` starts nothing here, so it can't keep it in this terminal; \`cotal down\` it first, then \`cotal up --foreground\``,
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
      // So is the auth callout timeout: the running broker keeps the one it was started with, which
      // its broker policy records.
      const runningPolicy = readBrokerPolicy(root);
      const runningTimeout = runningPolicy?.authTimeout;
      if (authTimeout !== undefined && authTimeout !== runningTimeout) {
        console.error(
          c.red(
            `✗ mesh "${held.space}" is already running at ${server} - a running broker can't change --auth-timeout (it is fixed at start); \`cotal down\` it first, then \`cotal up --user-auth --auth-timeout ${authTimeout}\``,
          ),
        );
        process.exit(1);
      }
      // And so is the payload limit, which the same record carries.
      if (maxPayload !== undefined && maxPayload !== (runningPolicy?.maxPayload ?? NATS_DEFAULT_MAX_PAYLOAD)) {
        console.error(
          c.red(
            `✗ mesh "${held.space}" is already running at ${server} - a running broker can't change --max-payload (it is fixed at start); \`cotal down\` it first, then \`cotal up${noManager ? " --no-manager" : ""} --max-payload ${maxPayload}\``,
          ),
        );
        process.exit(1);
      }
      // nats-server switches account resolvers only at start, and refuses a reload that changes one.
      if (accountResolver !== undefined && accountResolver !== (runningPolicy?.accountResolver ?? "memory")) {
        console.error(
          c.red(
            `✗ mesh "${held.space}" is already running at ${server} - a running broker can't change --account-resolver (nats-server switches resolvers only at start); \`cotal down\` it first, then \`cotal up --account-resolver ${accountResolver}\``,
          ),
        );
        process.exit(1);
      }
      // A bare refresh adds the manager this broker was started without. The manager publishes its
      // contract on the limit the broker already serves, so a recorded one below the floor is refused
      // before that launch rather than dying on the publish.
      const refreshPayload = maxPayload ?? runningPolicy?.maxPayload;
      if (!noManager && refreshPayload !== undefined && refreshPayload < MANAGER_START_PAYLOAD_FLOOR) {
        console.error(
          c.red(
            `✗ --max-payload ${refreshPayload} is below ${MANAGER_START_PAYLOAD_FLOOR} bytes, the least the space's manager starts on: it publishes its contract artifacts, one message each, and the largest is bounded at ${CONTRACT_ARTIFACT_MAX_BYTES} bytes with ${MANAGER_START_PAYLOAD_FLOOR - CONTRACT_ARTIFACT_MAX_BYTES} more for the publish; nothing was started`,
          ),
        );
        console.error(`  From the stack's project root, run \`cotal down --yes\`, then \`cotal up --max-payload ${NATS_DEFAULT_MAX_PAYLOAD}\`, or keep it broker-only with \`cotal up --no-manager\`.`);
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
        const live = managerRecordState(held.space);
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
        const live = managerRecordState(held.space);
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
        let spaceAuth: SpaceAuth | undefined;
        if (held.mode !== "open") {
          spaceAuth = await getSpaceAuth(workspaceSecretStore(root), held.space);
          if (!spaceAuth) {
            stderrLine("✗ ", `mesh "${held.space}" has no trust material under ${authDir(root)} - cannot reconcile its Memory buckets and lease TTLs; restore or re-provision \`.cotal/auth\``, c.red);
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
        if (await fileMembershipStore(server, held.space, reconcileCreds)) throw membershipConversionRefusal(held.space);
        for (const r of await reconcileSpaceMemoryBuckets({ servers: server, space: held.space, creds: reconcileCreds }))
          console.log(c.dim(r.recreated
            ? `  re-created ${r.stream}: it is Memory-backed and was lost when the broker restarted`
            : `  reconciled ${r.stream} TTL ${r.fromMs === 0 ? "none" : `${r.fromMs}ms`} -> ${r.toMs}ms`));
        // The dashboard cred is minted on a refresh too: a space that predates it may never boot again.
        if (held.mode === "auth" && spaceAuth) await provisionWebCreds(spaceAuth, root, held.space);
      } catch (e) {
        stderrLine("✗ ", `mesh "${held.space}" is running at ${server} but its Memory buckets and lease TTLs could not be reconciled: ${(e as Error).message}`, c.red);
        process.exit(1);
      }
      // A refresh is a receipt like any other start: it names its mesh before it says anything
      // about it, and ends with the steps to take. It used to print this one green line alone, so
      // `up` in a running project's subfolder answered without saying which mesh it reached or what
      // to do next, while the launch beside it printed both.
      console.log(`${renderReport({ space: held.space, sections: [] }, "rich", process.stdout)}\n`);
      console.log(c.green(`✓ mesh "${held.space}" already running at ${server}`));
      // USER MODE: re-upping IS the documented recovery for a dead auth service (the provider's
      // failure copy says "restart it with `cotal up`"), so a refresh must re-ensure the service —
      // never just reprint "already running" over a dead callout. No broker config is (re)written
      // here, so healing on a bare `cotal up` is safe: the mode can't drift, only the daemon heals.
      let userAuth: UserAuthInfo | undefined;
      let startAuth: (() => Promise<void>) | undefined;
      if (held.mode === "user") {
        const auth = await getSpaceAuth(workspaceSecretStore(root), held.space);
        if (!auth) {
          stderrLine("✗ ", `mesh "${held.space}" is user-auth but this root has no trust material under ${authDir(root)} - \`cotal down\` it, restore or re-provision \`.cotal/auth\`, then \`cotal up --user-auth\``, c.red);
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
          stderrLine("✗ ", `${(e as Error).message}`, c.red);
          process.exit(1);
        }
        startAuth = async () => {
          const svc = await startUserAuthService(held.space, server, { prepared, stateDir }, [...publicExchange, ...authTimeoutArgs(runningTimeout)]);
          userAuth = svc.userAuth;
          // The refresh IS the recovery command — a heal that didn't heal must not exit 0.
          if (!svc.ok) process.exitCode = 1;
        };
      }
      // Re-ensure the control plane on a refresh, in every mode, under the decision the first boot
      // follows: the mesh owes a manager unless `--no-manager` was asked for, and a delivery daemon
      // unless the recorded mode is open. A same-root refresh is the normal repair
      // command after a stale or missing manager, so a heal adopts `--runtime` and a degraded answer
      // fails the refresh. An open refresh used to skip this unless it carried `--runtime`, so a bare
      // one exited 0 over a manager record that the same refresh with `--runtime` reported degraded
      // (#3892).
      //
      // Warn only when the manager is genuinely REUSED: a live delivery-aware (this-build) manager
      // is kept as-is by `ensureManager`, so its runtime can't change. An old hosting manager (no
      // delivery marker) is stopped and REPLACED by the ensure below carrying the requested runtime,
      // so that's not a reuse - don't claim the runtime is fixed. A dead/absent manager is (re)started
      // with it.
      if (values.runtime) {
        const live = managerRecordState(held.space);
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
        open: held.mode === "open",
        runtime: values.runtime,
        attachHost: attachHostFor(held.space, values.host),
        maxSessions: maxSessionsFor(held.space, maxSessions),
        managerSeatCap,
        noManager,
      }, startAuth);
      if (!controlPlane) process.exitCode = 1;
      // #883: a refresh that HEALED a missing manager must say so — the summary line otherwise reads
      // identically to a refresh that found everything already up, and the operator cannot tell which
      // world they are in without a second command. Only here does a started manager mean one was
      // missing: a launch starts its manager as a matter of course (#2480).
      if (controlPlane?.started) console.log(c.green(`✓ restored in the background: manager (pid ${controlPlane.pid})`));
      // A broker was already answering here — this branch starts nothing, so it must not claim the
      // record as ours (see `Provenance`), and it passes only what this invocation decided.
      // `recordOurMesh` carries everything else (`tlsRequired`, the recorded host and session
      // ceiling, the store) from the record as it stands at write time, not from `held`.
      recordOurMesh({ space: held.space, server, root, mode: held.mode, ...(userAuth ? { userAuth } : {}), ...(values.host ? { attachHost: values.host } : {}), ...(maxSessions !== undefined ? { maxSessions } : {}), ts: new Date().toISOString() }, "refresh");
      if (noManager && held.mode !== "open") recordOperationWarning(await noManagerCredentialWarning(root, held.space));
      seedPersonaAfterUp(root);
      // The same Next a launch ends with: this mesh runs, so the steps are the ones that use and
      // stop it. A manager the refresh found or healed is what makes `spawn` one of them.
      const managerRecord = managerRecordState(held.space);
      console.log(`\n${renderReport({ sections: [{ title: "Next", blocks: detachedNext({ manager: managerRecord.state === "alive", controlPlane: controlPlane !== undefined, machineHome: canonicalRoot(root) === canonicalRoot(homedir()), ...(values.root ? { root } : {}), ...(managerRecord.state === "unattributable" ? { unattributableManager: managerRecord.path, noManager } : {}) }, held.space) }] }, "rich", process.stdout)}`);
      return;
    }
    // The address explains the collision even when this invocation cannot refresh that space.
    // The registration does not prove that the process answering the probe belongs to it.
    const address = brokerAddressKey(server);
    const registered = address === undefined ? undefined : meshes.find((m) =>
      m.origin !== "manual" && m.origin !== "catalog" && brokerAddressKey(m.server) === address);
    const registeredAt = registered && `address registered to mesh "${registered.space}" (${registered.root})`;
    const occupant = "a broker not started here";
    const occupied = registeredAt ? `already in use (${registeredAt})` : `already in use by ${occupant}`;
    // Reaching here with `--rotate-sys` means something IS answering at the requested address and it
    // is not this root's recorded mesh (that case was refused above). The ordinary response is to pick
    // a free port and carry on, which for a rotation is the wrong instinct: the unidentified listener
    // may be a `nats-server -c <root>/.cotal/auth/server.conf` started by hand, holding THIS root's
    // config and JetStream store while writing neither a pidfile nor a registry row. Rotating around
    // it retires the account it is still serving and opens its store a second time. Nothing available
    // here can identify it (that is what unidentified means), so refuse instead of stepping past it.
    if (values["rotate-sys"]) {
      console.error(
        c.red(`✗ ${server} is answering and it is not this root's recorded mesh (${registeredAt ?? occupant})`) +
          c.dim(" - `--rotate-sys` will not start on another port around an unidentified broker: it may be serving this root's own server.conf and JetStream store. Stop whatever is listening there (`cotal down` if it was started here), then rotate."),
      );
      process.exit(1);
    }
    if (values.server === undefined && (!held || held.root !== root)) {
      const next = await serverWithFreePort(server, host);
      console.log(c.dim(`${server} is ${occupied}; starting "${space}" at ${next} instead`));
      server = next;
    } else {
      console.error(
        c.red(
          `✗ ${server} is ${occupied} - to run "${space}" use \`--server nats://${host}:<port>\` with a free port`,
        ),
      );
      process.exit(1);
    }
  }
  const openMaxPayload = values.open ? maxPayload ?? readBrokerPolicy(cotalRoot())?.maxPayload : undefined;
  if (!noManager) assertManagerPayload(openMaxPayload);
  if (stoppedStart) console.log(c.dim(stoppedStart));

  if (!resumeAttempt) {
    const space = values.space ?? folderSpace();
    // A stopped reservation has no listener to trigger the port selection above. Only a first
    // implicit start can move: a prior store, launch record or manifest summary can outlive its address.
    if (!listenerReachable && values.server === undefined && !values["rotate-sys"] && registeredAddressHolder(server, space)
      && recordsNameNoSpace(cotalRoot()) && !["nats", "stack-home.json", "team-summaries"].some((entry) => existsSync(cotalPath(entry)))) {
      server = await freshStackServer(server, host);
    }
    refuseRegisteredAddress(server, space, `start this one at another address with \`cotal up --server nats://${host}:<port>\``);
  }
  await assertBrokerAddressFree(server, `${displayCmd()} up${values.host === undefined ? "" : ` --host ${shellWord(host)}`}`, host);
  // A repair keeps its own store rules above, and a resume or restore names its store.
  if (!resumeAttempt && !repairing) {
    if (values["store-dir"] === undefined) values["store-dir"] = reopenLastStore(cotalPath("nats"));
    else refuseMissingNamedStore(resolve(values["store-dir"]));
    checkStartStore(values["store-dir"], values.space ?? folderSpace());
  }
  const restored = resumeAttempt ? pendingRestores.get(resumeAttempt) : undefined;
  const quietRestore = restored !== undefined && restoreSinks.has(restored.attemptId);
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
    // The receipt names its space before the launch prints anything, as every report does. A start that
    // refuses the space reports that on stderr under its own `Mesh:` heading, so those checks run
    // first; the launch below repeats them and finds them settled.
    const receiptSpace = values.space ?? folderSpace();
    const unnamed = values.space === undefined && unnamedDefault(cotalRoot(), receiptSpace);
    refuseStartOverUserState(Boolean(values.open), wantUser, receiptSpace);
    await claimSpace(receiptSpace, server, cotalRoot());
    if (!quietRestore) console.log(`${renderReport({ space: receiptSpace, sections: [] }, "rich", process.stdout)}\n`);
    const { pid, executable, authService, controlPlane: planeReturned, delivery, deliveryLost, manager } = await startMeshDetached({
      transport,
      server,
      storeDir: values["store-dir"],
      maxFileStore,
      logFile,
      logfileSizeLimit,
      logfileMaxNum,
      authTimeout,
      maxPayload: openMaxPayload ?? maxPayload,
      accountResolver,
      space: values.space,
      open: values.open,
      userAuth: wantUser ? { idpUrl: values.idp } : undefined,
      rotateSys: values["rotate-sys"],
      ...(values["recreate-issued-stores"] !== undefined ? { recreateIssuedStores: resolve(values["recreate-issued-stores"]) } : {}),
      ...(values["recreate-membership-store"] ? { recreateMembershipStore: true } : {}),
      publicExchange,
      channels: values.channels,
      // The RAW flag, not the loopback-defaulted `host` above: `startMeshDetached` applies the same
      // default itself, and what it records must distinguish "the operator asked for this address"
      // from "nobody asked", or every mesh would persist an exposure decision it never made.
      host: values.host,
      runtime: values.runtime,
      maxSessions,
      managerSeatCap,
      noManager,
      resumeAttempt,
      resumeCommit: commitTokenHandoff(cotalRoot(), (restored?.managerCommit ?? ordinaryAttempt?.managerCommit) !== undefined, startupLock),
      boundListener,
      ...(quietRestore ? { quietBoot: true } : {}),
    });
    // Transport policy is committed inside startMeshDetached before delivery launch (S5+S9).
    // A delivery daemon this boot started and lost degrades the control plane, as one that never came up does.
    if (deliveryLost !== undefined) reportDegradedControlPlane(deliveryLost);
    const controlPlane = planeReturned && deliveryLost === undefined;
    const detached = { pid, delivery, authService: wantUser && authService, manager, machineHome: canonicalRoot(cotalRoot()) === canonicalRoot(homedir()), ...(values.root ? { root: cotalRoot() } : {}) };
    if (!quietRestore) {
      for (const line of hang("", `Started ${executable}.`, terminalWidth(process.stdout), c.dim)) console.log(line);
      // The summary's continuation lines start under its text, past the `✓`.
      const [mark, ...summary] = renderDetachedSummary(detached).split(" ");
      for (const line of hang(`${mark} `, summary.join(" "), terminalWidth(process.stdout))) console.log(c.green(line));
      if (unnamed) console.log(c.dim(`  This folder names no space, so up started the default space "${receiptSpace}"; pass --space <name> to start another`));
      if (values.__folderNamed) for (const line of hang("  ", `This new project's space is named after its folder, "${receiptSpace}"; pass --space <name> to start another`, terminalWidth(process.stdout))) console.log(c.dim(line));
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
    if (restored && !quietRestore) printRestoreReceipt(restored, values.__invokedRoot);
    if (!quietRestore) {
      const managerRecord = managerRecordState(receiptSpace);
      console.log(`\n${renderReport({ sections: [{ title: "Next", blocks: detachedNext({ ...detached, controlPlane, ...(managerRecord.state === "unattributable" ? { unattributableManager: managerRecord.path, noManager } : {}) }, receiptSpace) }] }, "rich", process.stdout)}`);
    }
    if (restored) restoreSinks.get(restored.attemptId)?.({
      attemptId: restored.attemptId, space: restored.space, root: restored.root, server: restored.server, mode: restored.mode,
      selection: restored.selection, restoredStreams: restored.restoredStreams, targetPath: restored.targetPath, runtime: restored.runtime, brokerPid: pid,
      delivery, authService, controlPlane, manager,
    });
    return;
  }

  const useAuth = !values.open;
  const space = values.space ?? folderSpace();
  ensureRootForSpace(space); // may pin the cwd as this space's root — before any cotalPath use
  refuseStartOverUserState(Boolean(values.open), wantUser, space);
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
  if (values["store-dir"]) warnForeignStoreEntries(storeDir);
  prepareForegroundBrokerLog(logFile);
  // Owner-private regardless of umask: a recursive create also makes a missing `.cotal`, which every
  // later protection check walks as an ancestor.
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  await claimSpace(space, server, cotalRoot());
  const seedFile = loadChannelsFile(values.channels);
  // Decided above the branch; the dial host is only settled here (a port collision may have moved
  // the server, and the hostname is what the certificate has to match).
  assertServesDialHost(transport, new URL(server).hostname);
  const brokerSetup = useAuth ? await authSetup(storeDir, server, space, host, wantUser ? { idpUrl: values.idp } : undefined, transport, values["rotate-sys"], maxFileStore, false, { authTimeout, maxPayload, accountResolver, manager: values["no-manager"] !== true, logFile, logfileSizeLimit, logfileMaxNum }) : undefined;
  const brokerMaxPayload = brokerSetup?.maxPayload ?? openMaxPayload;
  const port = Number(new URL(server).port) || 4222;
  // Both modes go through a RENDERER, never bare CLI flags. Open mode used to start from
  // `-js -sd … -p … -a …`, which never called a renderer at all — so the required transport union
  // protected the auth path and was silent on the open one, and a cert/key pair passed to an
  // open-mode `up` would have been accepted while the listener came up in cleartext.
  const renderingBinary = brokerSetup?.brokerBinary ?? await resolveNatsServer();
  if (!renderingBinary.version) throw unreadVersion(renderingBinary);
  const confPath = brokerSetup ? brokerSetup.confPath : writeOpenBrokerConf(storeDir, space, { brokerVersion: renderingBinary.version, port, host, transport, maxFileStore, maxPayload: brokerMaxPayload, logFile, logfileSizeLimit, logfileMaxNum });
  const natsArgs = [
    "-c", confPath,
    ...(boundListener ? ["--name", boundListener.serverName] : []),
  ];
  const natsServer = renderingBinary;
  const bin = natsServer.path;
  const brokerOutput = logFile ?? "the terminal output above";
  await seedBeforeLaunch();
  const setup = brokerSetup && { ...brokerSetup, creds: await brokerSetup.mintProvisioner() };

  const starting = `Starting ${natsServerLabel(natsServer)} (JetStream, ${useAuth ? "JWT auth" : "OPEN/no-auth"}) - store: ${storeDir}, bind: ${host}`;
  for (const line of hang("", starting, terminalWidth(process.stdout), c.dim)) console.log(line);
  console.log(c.dim("Press Ctrl-C to stop.\n"));
  const listenerStartedAt = new Date().toISOString();
  // A terminal sends Ctrl-C to the whole foreground process group. Keep the broker outside it
  // on POSIX so only this owner receives the interrupt and can finish manager-first teardown
  // before signalling the broker. Keep the child referenced and its output in this terminal.
  // The configuration names a store inside the root relative to it, so the broker runs from the root.
  const child = spawnBroker(bin, natsArgs, { cwd: cotalRoot(), stdio: "inherit", detached: process.platform !== "win32" });
  let listenerReady = false;
  let activationFinished = !resumeAttempt;
  await recordSpawnedListener(child, listenerStartedAt, boundListener);
  child.on("error", (err) => {
    console.error(c.red(`Failed to start nats-server: ${err.message}`));
    if (!resumeAttempt) process.exit(1);
  });
  // Stop the detached manager, delivery daemon and space's user-auth service before their broker,
  // so none outlives it. The auth service's process record is space-scoped.
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
  // The operator's signal sets the command's exit status, not the broker's SIGTERM.
  let stopSignal: "SIGINT" | "SIGTERM" | undefined;
  let stoppedListener = false;
  let teardown: Promise<void> | undefined;
  const stop = (signal: "SIGINT" | "SIGTERM") => {
    if (stopping) return; // a second Ctrl-C during teardown must not start a second teardown
    stopping = true;
    stopSignal = signal;
    // Once the broker has exited, its handler below is already running this teardown and reads
    // `stopping` when it is done.
    if (child.exitCode !== null || child.signalCode !== null) return;
    teardown = (async () => {
      try {
        await stopManager(space);
        clearManagerArtifacts(space);
      } catch (e) {
        console.error(c.red(`! teardown: ${(e as Error).message}`));
        console.error(c.red(`the stack is still running; to take managed agents with it, run: \`cotal down --with-agents\``));
        stopping = false;
        return;
      }
      await stopDelivery(space).catch((e: Error) => console.error(`! delivery teardown: ${e.message}`));
      await stopAuthService(space).catch((e: Error) => console.error(`! auth teardown: ${e.message}`));
      stoppedListener = child.kill("SIGTERM");
    })();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  restored?.releaseInterruptNotice?.();
  // On exit, drop only this stop's registration and matching `current` pointer, unless folder-named.
  child.on("exit", async (code, signal) => {
    if (failedListeners.has(child)) return;
    removePidPair(cotalPath(NATS_PIDFILE), String(child.pid));
    // One teardown at a time: a stop started while another is in flight is refused the reservation
    // that one holds, so wait for a Ctrl-C teardown already running instead of racing it.
    await teardown;
    await stopDelivery(space).catch((e: Error) => console.error(`! delivery teardown: ${e.message}`));
    await stopManager(space).then(() => clearManagerArtifacts(space)).catch((e: Error) => console.error(`! manager teardown: ${e.message}`));
    await stopAuthService(space).catch((e: Error) => console.error(`! auth teardown: ${e.message}`));
    // Only the shutdown that `stop()` drives (Ctrl-C, SIGTERM) can unrecord here.
    // External `down` owns its own registry cleanup.
    if (stopping) {
      // Only unrecord if the registry still points at THIS broker. A newer broker for the same space
      // (a concurrent `up`, or a different-port re-up that recorded after us) may have replaced our
      // record — removing by name would clobber the live winner and hide it from the registry.
      // …and only if it is still OUR kind of record. A concurrent `cotal meshes add --force` can
      // replace it with a hand-registered one carrying the same server + root; that record outlives
      // this broker by design (it is the operator's, and only they remove it), so unrecording it on
      // our exit would delete a registration this process never owned.
      const mine = findMesh(space);
      if (mine && mine.origin !== "manual" && mine.server === server && mine.root === cotalRoot() && !keepsRegistration(mine)) {
        removeMesh(space);
        if (getCurrent() === space) clearCurrent();
      }
      if (activationFinished) process.exit(stopSignal === "SIGTERM" ? 143 : 130);
    } else if (code === 0) {
      // Before readiness, the startup check reports that the listener never answered.
      // After readiness, do not race external `down` with a claim about its registry cleanup.
      if (listenerReady && activationFinished) process.exit(0);
    } else {
      // The record is kept ON PURPOSE: it still names the store this broker opened, so a repair
      // `up` reopens that SAME store instead of falling back to the root's default, and a
      // supervising unit's restart takes the refresh path against the recorded store rather than
      // racing a second broker into existence. NATS logs to this terminal unless a native log was
      // requested, so there is no `.cotal/nats.log` to name here.
      const detail = signal ? `signal ${signal}` : `code ${code}`;
      const repair = `log: see ${brokerOutput}; repair: ${codeSpan(`cotal up --server ${shellWord(server)} --space ${shellWord(space)}`)}`;
      // Retention is read from the registry, not assumed: a broker that exits before it first
      // answers was never recorded, and running the same `up` again only repeats that exit, so its
      // step is the one a detached start gives. A registry that cannot be read is not claimed
      // either way, and the read cannot throw past this handler, which still has to exit.
      let outcome: string;
      try {
        const mine = findMesh(space);
        outcome = mine && mine.server === server && mine.root === cotalRoot()
          ? `; the mesh "${space}" stays recorded (\`cotal meshes\` lists it offline); ${repair}`
          : ` before the mesh "${space}" was recorded; next: ${listenerExitRemedy(natsServer, brokerOutput)}`;
      } catch {
        outcome = `; whether the mesh "${space}" stays recorded could not be read; ${repair}`;
      }
      stderrLine("✗ ", `nats-server exited unexpectedly (${detail})${outcome}`, c.red);
      // A foreground broker under `Restart=on-failure` must exit non-zero on a crash so the unit
      // restarts it; exiting 0 here (as an unconditional `code ?? 0` used to) looked like a clean
      // stop and left the unit sitting dead. An abnormal exit is a failed run, 5, not the broker's
      // own code, which the exit table would read as a usage error (1) or a refusal (2).
      if (activationFinished) process.exit(exitCode("failed", "OPERATION_FAILED"));
    }
  });

  await awaitSpawnedListener({ child, executable: natsServer, server, space, creds: setup?.creds, tls: transport.kind === "tls-required", log: brokerOutput, boundListener }).catch((error: unknown) => {
    if (!restored || !stoppedListener || !stopSignal || (child.exitCode === null && child.signalCode === null)) throw error;
    releaseStartupLock();
    exitInterrupted(stopSignal, restoreInterruptNotice(restored.root, restored.attemptId));
  });
  listenerReady = true;
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
      child, server, space, storeDir, setup, seedFile, transport, maxPayload: brokerMaxPayload,
      ...(values["recreate-issued-stores"] !== undefined ? { recreateIssuedStores: resolve(values["recreate-issued-stores"]) } : {}),
      ...(values["recreate-membership-store"] ? { recreateMembershipStore: true } : {}),
      host: values.host,
      maxSessions,
      managerSeatCap,
      maxFileStore,
      publicExchange,
      resumeAttempt,
      resumeCommit: commitTokenHandoff(cotalRoot(), (restored?.managerCommit ?? ordinaryAttempt?.managerCommit) !== undefined, startupLock),
      runtime: values.runtime,
      noManager,
      onDeliveryExit,
      isStopping: () => stopping,
    });
    if (noManager && setup && controlPlane) recordOperationWarning(await noManagerCredentialWarning(cotalRoot(), space));
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
    if (restored && !quietRestore) printRestoreReceipt(restored, values.__invokedRoot);
  }
  releaseStartupLock();
  await new Promise<void>(() => {});
  } finally {
    releaseStartupLock();
  }
}

/** The human receipt for a completed `up --restore`. `backup restore` prints its own receipt. */
function printRestoreReceipt(restored: PreparedRestore, invokedRoot?: string): void {
  console.log(c.green(`✓ restored the backup ${restored.selection === "registry" ? "registry" : "in full"} as restore attempt ${restored.attemptId}`));
  const composition = restoreComposition(restored.space, restored.restoredStreams, restored.mode);
  console.log(c.dim(`restored: ${composition.restoredWords}; recreated empty: ${composition.emptyWords}`));
  if (composition.note) console.log(c.yellow(composition.note));
  const cleanupRoot = invokedRoot && invokedRoot !== canonicalRoot(restored.root) ? restored.root : undefined;
  const cmd = displayCmd();
  for (const line of leftOutNotes(restored.attemptId, restored.selection, restoreOnlyCopy(restored.root, restored.attemptId), cleanupRoot, cmd)) console.log(c.yellow(line));
  const journal = readMaintenanceJournal(restored.root);
  if (journal && "restore" in journal && journal.restore.attemptId === restored.attemptId)
    console.log(c.dim(`next: ${restoreNextStep(journal.state, restored.attemptId, restoreLeftOut(journal), cleanupRoot, cmd)}`));
}

/** The address of a prepared stack that neither a journal nor a registration records, as after a
 *  damaged journal was removed once `down` had dropped the registration. Its saved broker definition
 *  names it. With none, a root that holds this space's trust or a store from an earlier start refuses
 *  rather than start at another address; only a fresh prepared root chooses an available address. */
async function unrecordedStackServer(root: string, space: string, host: string | undefined): Promise<string> {
  const launch = serviceDefinitionStore(space).read(STACK_DEFINITION.broker)?.record.value.launch;
  const saved = launch?.type === "adapter" && typeof launch.options.server === "string" ? launch.options.server : undefined;
  if (saved !== undefined) {
    recordOperationWarning({ code: "STACK_ADDRESS_RECOVERED", target: { root, space, server: saved }, message: `no stack journal or registration records this stack's address, so it starts at ${saved}, the address its saved broker definition names` });
    return host ? reconcileHostAndServer(host, undefined, "--host", "--server", saved) : saved;
  }
  if (listSpaceAccounts(authDir(root)).includes(space) || existsSync(join(root, ".cotal", "nats")))
    throw new MissingFlags(`no stack journal, registration or saved broker definition records the address "${space}" ran at in ${root}, which holds its earlier trust or store; nothing was started`, "run `cotal up --server <url>` with the address it ran at", { root, space });
  return freshStackServer(host ? reconcileHostAndServer(host, undefined) : DEFAULT_SERVER, host);
}

/** A start over the broker a committed restore left running here. `up -f` boots a fresh mesh, so its
 *  way out also retires the restore with `retire`. */
function restoredBrokerRuns(root: string, attempt: string, pid: number, manifest?: string, retire?: string): CommandFailure {
  return new CommandFailure("refused", "CONFLICT", `the broker that restore attempt ${attempt} started still runs here (pid ${pid}), and a new start does not run beside it; nothing was started`, {
    target: { root, attempt, pid },
    remedy: manifest !== undefined ? `stop the restored stack with \`cotal down\`, retire the restore with ${retire}, then run \`cotal up -f ${manifest}\` again` : "stop the restored stack with `cotal down`, then run `cotal up` again",
  });
}

/** The cleanup that retires an active restore. One that left something out keeps its only copy in the
 *  previous store, so its cleanup deletes that store only with `--discard-history`. */
function retireRestore(attempt: string, leftOut: string | undefined): string {
  return leftOut
    ? `\`cotal backup cleanup-fallback ${attempt} --yes --discard-history\`, which deletes the previous store and the ${leftOut} only it holds`
    : `\`cotal backup cleanup-fallback ${attempt} --yes\``;
}

/** `manifest` is the `up -f` file, which boots a fresh mesh and so needs the restore retired first. */
function assertOrdinaryUpAllowed(root: string, storeDir?: string, manifest?: string): void {
  const maintenance = readMaintenanceJournal(root);
  if (!maintenance) return;
  if (maintenance.state === "active") {
    const attempt = maintenance.restore.attemptId, retire = retireRestore(attempt, restoreLeftOut(maintenance));
    if (!isManagerCommittedRestore(maintenance))
      throw new Error(`restore attempt ${attempt} is active without durable manager commit evidence`);
    if (!maintenance.listenerProof)
      throw new Error(`restore attempt ${attempt} is active without a bound listener proof`);
    const status = localProcessOwnerStatus(maintenance.listenerProof.processOwner);
    if (status === "alive") throw restoredBrokerRuns(root, attempt, maintenance.listenerProof.processOwner.pid, manifest, retire);
    if (status !== "dead")
      throw new Error(`restore attempt ${attempt} active listener ownership is ${status}; refusing ordinary startup`);
    // `up -f` boots a fresh mesh, so the restore it would start over is retired first.
    if (manifest !== undefined)
      throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `restore attempt ${attempt} is still active here, and \`cotal up -f\` boots a fresh mesh, which does not start over a restore that is not retired; nothing was started`, {
        target: { root, attempt },
        remedy: `retire the restore with ${retire}, then run \`cotal up -f ${manifest}\` again; bare \`cotal up\` starts the restored stack instead`,
      });
    // Relaunching after restore must serve the exact recorded active target, not whatever store the
    // caller happens to name — the journal's provenance would otherwise describe a different mesh.
    if (!storeDir)
      throw new Error(`restore attempt ${attempt} is active; relaunch with bare \`cotal up\` over the recorded target ${maintenance.restore.target.path}`);
    if (!sameStoreIdentity(readStoreIdentity(resolve(storeDir)), maintenance.restore.target))
      throw new Error(`ordinary startup after restore must use the recorded active target store ${maintenance.restore.target.path}, not ${storeDir}`);
    return;
  }
  // A preserved cut resumes only through bare `up`, which journals the resume attempt. Nothing has
  // started here, so this is a refusal.
  if (maintenance.state === "ready")
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "this root holds a stack preserved by `cotal down --preserve-state`, which only bare `cotal up` resumes; nothing was started", { target: { root, space: maintenance.space }, remedy: `resume it with bare \`cotal up\` in ${root}` });
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

function sameListenerProof(a: ListenerProof, b: ListenerProof): boolean {
  return a.attemptId === b.attemptId && a.serverName === b.serverName &&
    a.serverNonce === b.serverNonce && sameProcessOwner(a.processOwner, b.processOwner) &&
    a.serverEndpoint === b.serverEndpoint && sameStoreIdentity(a.target, b.target);
}

function readNatsInfo(label: string, endpoint: string, timeoutMs = 2_000): Promise<Record<string, unknown>> {
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
      rejectInfo(new Error(`${label} has an invalid listener endpoint ${endpoint}`));
      return;
    }
    socket = createConnection({ host: url.hostname, port: Number(url.port) || 4222 });
    socket.setTimeout(timeoutMs);
    let input = "";
    socket.on("data", (chunk: Buffer) => {
      input += chunk.toString("utf8");
      if (input.length > 64 * 1024) return finish(new Error(`${label} listener INFO exceeds 64 KiB`));
      const newline = input.indexOf("\r\n");
      if (newline < 0) return;
      const line = input.slice(0, newline);
      const brace = line.indexOf("{");
      if (!/^INFO\b/.test(line) || brace < 0)
        return finish(new Error(`${label} listener did not present a NATS INFO greeting`));
      try {
        const info = JSON.parse(line.slice(brace)) as unknown;
        if (!info || typeof info !== "object" || Array.isArray(info))
          throw new Error("INFO is not an object");
        finish(undefined, info as Record<string, unknown>);
      } catch (error) {
        finish(new Error(`${label} listener presented invalid NATS INFO: ${(error as Error).message}`));
      }
    });
    socket.on("timeout", () => finish(new Error(`${label} listener INFO timed out`)));
    socket.on("error", (error) => finish(new Error(`${label} listener INFO failed: ${error.message}`)));
    socket.on("close", () => finish(new Error(`${label} listener closed before NATS INFO`)));
  });
}

/** Prove a recovered attempt's live bound listener IS ours end-to-end before adoption: launch
 *  binding, durable journal match, local pid + exact pidfile, store identity, mesh identity, the
 *  raw NATS INFO server name, and an authenticated connect confirming name + JetStream. Each attempt
 *  kind supplies only its journal match, which yields the store identity the journal recorded. */
async function proveBoundListener(
  kind: "restore" | "resume",
  attempt: Pick<PendingOrdinaryResume, "attemptId" | "serverName" | "serverNonce" | "server" | "root" | "space" | "mode">,
  proof: ListenerProof | undefined,
  journalStore: (proof: ListenerProof) => StoreIdentity | undefined,
  store: { path: string; changed: string },
): Promise<ListenerProof> {
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
  const pidPath = join(attempt.root, ".cotal", NATS_PIDFILE);
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

  const info = await readNatsInfo(label, proof.serverEndpoint);
  if (info.server_name !== proof.serverName)
    throw new Error(`${label} reached a foreign NATS server name/nonce`);

  const auth = await resumeControlAuth(attempt.root, attempt.mode);
  const nc = await dialerFor(attempt.server)({
    servers: attempt.server,
    ...standaloneConnectOpts({ ...auth, /* not yet wired to a recorded transport - see broker-policy/MeshEntry work */ tls: false }),
    maxReconnectAttempts: 0,
  });
  try {
    if (nc.info?.server_name !== proof.serverName)
      throw new Error(`${label} authenticated to a foreign NATS server name/nonce`);
    if (!nc.info.jetstream) throw new Error(`${label} listener has no JetStream`);
  } finally {
    await drainAndClose(nc).catch(() => {});
  }
  return proof;
}

function provePreparedRestoreListener(prepared: PreparedRestore): Promise<ListenerProof> {
  return proveBoundListener("restore", prepared, prepared.listenerProof, (proof) => {
    const journal = readMaintenanceJournal(prepared.root);
    if (!journal || (journal.state !== "commit-intent" && journal.state !== "manager-committed" && journal.state !== "degraded" && journal.state !== "active") ||
        journal.restore.attemptId !== prepared.attemptId || !journal.listenerProof ||
        !sameListenerProof(journal.listenerProof, proof) || journal.launch.server !== proof.serverEndpoint)
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
async function resumeControllerStack(lock: MaintenanceLock, root: string, values: { "accept-stale-checkpoint"?: boolean; runtime?: string; server?: string; "store-dir"?: string; "max-file-store"?: string; "auth-timeout"?: string; "max-payload"?: string; "account-resolver"?: string; detach?: boolean; foreground?: boolean; json?: boolean; plain?: boolean }, restoreSink?: (result: RestoreStartupResult) => void): Promise<boolean> {
  let journal = readMaintenanceJournal(root)!;
  const cut = cutController(journal.cut)!;
  const space = journal.space;
  const inventory = readMaintenanceResumeDocument(root, journal.resume).inventory;
  const agents = (inventory as { agents?: Array<{ launch?: { runtime?: unknown } }> }).agents ?? [];
  // A restore's inputs were checked and journaled by `prepareRestore`; a resume takes them from the cut.
  if (!("restore" in journal)) {
    if (values.server !== undefined && values.server !== journal.cut.launch.server) throw new CommandFailure("refused", "USAGE_INVALID", "a controller resume takes its broker address from the cut; --server is refused", { target: { root, space } });
    if (values["store-dir"] !== undefined || values["max-file-store"] !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "a controller resume takes its store and cap from the cut; --store-dir and --max-file-store are refused", { target: { root, space } });
    if (values["auth-timeout"] !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "a controller resume renders this root's recorded auth callout timeout; --auth-timeout is refused", { target: { root, space }, remedy: "run `cotal up` without --auth-timeout" });
    if (values["max-payload"] !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "a controller resume renders this root's recorded payload limit; --max-payload is refused", { target: { root, space }, remedy: "run `cotal up` without --max-payload" });
    if (values["account-resolver"] !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "a controller resume renders this root's recorded account resolver; --account-resolver is refused", { target: { root, space }, remedy: "run `cotal up` without --account-resolver" });
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
      const brokerInfo = await readNatsInfo(`${restoring ? "restore" : "resume"} attempt ${attemptId}`, launch.server);
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
      restoredStreams: journaledRestoredStreams(restored.launch, space, restored.mode),
      targetPath, runtime: launch.runtime, brokerPid: broker.pid, delivery: has("delivery"), authService: has("auth"), controlPlane: true, manager: true,
    };
    const composition = restoreComposition(space, result.restoredStreams, result.mode);
    if (restoreSink) restoreSink(result);
    else writeResult(presentationOf(values), { command: "up", target: { root, space, server: launch.server }, result: { kind: "controller-stack-restore", root, space, server: launch.server, attemptId, targetPath, selection: result.selection, restored: composition.restored, recreatedEmpty: composition.recreatedEmpty, retiredBrokerRemoved: attempt.brokerRequired } }, (row) => ({ sections: [{ title: "Controller stack restored", blocks: [
      { kind: "fields", rows: [["Space", row.space], ["Root", row.root], ["Broker", row.server], ["Attempt", row.attemptId], ["Store", row.targetPath], ["Selection", row.selection], ["Restored", composition.restoredWords], ["Recreated empty", composition.emptyWords]] },
      { kind: "lines", lines: ["Each recorded member was started or adopted for this attempt, and the retained agents were resumed under the same principals. The restore journal stays active until its fallback is cleaned up. This is not agent or task readiness.", ...(composition.note ? [composition.note] : []), ...leftOutNotes(attemptId, result.selection, restoreOnlyCopy(root, attemptId))] },
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

function proveOrdinaryResumeListener(pending: PendingOrdinaryResume): Promise<ListenerProof> {
  return proveBoundListener("resume", pending, pending.adoptProof, (proof) => {
    const journal = readMaintenanceJournal(pending.root);
    if (!journal || !("ordinaryResume" in journal) || journal.ordinaryResume.attemptId !== pending.attemptId ||
        !journal.listenerProof || !sameListenerProof(journal.listenerProof, proof) ||
        journal.ordinaryResume.launch.server !== proof.serverEndpoint)
      return undefined;
    return journal.source;
  }, { path: pending.storeDir, changed: "preserved source identity changed" });
}

/** Light wire check for a freshly SPAWNED ordinary-resume listener: the greeted server must carry
 *  the attempt's exact name/nonce (the full seven-point prove is for adopting a survivor). */
async function verifySpawnedOrdinaryListener(pending: PendingOrdinaryResume): Promise<void> {
  const label = `resume attempt ${pending.attemptId}`;
  const info = await readNatsInfo(label, pending.server);
  if (info.server_name !== pending.serverName)
    throw new Error(`${label} spawned listener reports a foreign NATS server name`);
}

/** Adopts a listener its resume or restore attempt has proved over the wire: records the mesh,
 *  starts delivery and completes the attempt. `storeDir` is the store that listener runs on, and
 *  `listener` names it in a degraded reason. */
async function adoptProvenListener(
  attempt: PendingOrdinaryResume | PreparedRestore,
  storeDir: string,
  listener: string,
  heldLock?: MaintenanceLock,
): Promise<void> {
  await recreateAdoptedMemoryBuckets(attempt.root, attempt.space, attempt.server, attempt.mode);
  const svc = await ensureRecoveredUserAuth(attempt);
  // Read the recorded exposure BEFORE re-recording: `recordOurMesh` writes the entry whole, so a
  // record built without this field would erase the operator's decision, and the adopted manager
  // below would then be launched loopback-only from an entry that no longer remembers otherwise.
  const attachHost = attachHostFor(attempt.space);
  const maxSessions = maxSessionsFor(attempt.space);
  // Adopted from the recorded policy: an adopted listener was started from it, never from a default.
  const tlsRequired = adoptedTlsRequired(attempt.root);
  recordOurMesh({
    space: attempt.space,
    server: attempt.server,
    root: attempt.root,
    mode: attempt.mode,
    tlsRequired,
    ...(svc.userAuth ? { userAuth: svc.userAuth } : {}),
    ...(attachHost ? { attachHost } : {}),
    ...(maxSessions !== undefined ? { maxSessions } : {}),
    ...(attempt.maxFileStore !== undefined ? { maxFileStore: attempt.maxFileStore } : {}),
    storeDir: resolve(storeDir),
    ts: new Date().toISOString(),
  }, "started");
  const controlPlane = await startDeliveryWithBroker(attempt.space, attempt.server, tlsRequired, {
    runtime: attempt.runtime,
    attachHost,
    maxSessions,
    resumeAttempt: attempt.attemptId,
    resumeCommit: commitTokenHandoff(attempt.root, attempt.managerCommit !== undefined, heldLock),
  });
  await completeResumeActivation(
    attempt.attemptId,
    controlPlane !== undefined && svc.ok,
    !svc.ok ? `${listener} has no user-auth service` : `${listener} has a degraded control plane`,
    attempt.server,
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
    const ready = await askManager(cliControl, pending.space, server, "ps", undefined, auth, "any", 2_000);
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
    cliControl,
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
      cliControl,
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
      cliControl,
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
    cliControl,
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
  logFile: string | undefined;
  logfileSizeLimit: number | undefined;
  logfileMaxNum: number | undefined;
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
  const list = bindListRefusal("team boot", file, opts.space, opts.server, prepared.manifest.broker?.servers);
  if (list) throw list;
  const { prepared: eff, hostSource, serverSource } = applyUpOverrides(prepared, flags);
  const m = eff.manifest;
  const host = m.broker?.host ?? "127.0.0.1";
  const server = m.broker?.host ? reconcileHostAndServer(m.broker.host, m.broker?.servers, hostSource, serverSource) : (m.broker?.servers ?? DEFAULT_SERVER);
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
  return { root: canonicalRoot(cotalRoot()), space: m.space, server, host: m.broker?.host, mode, idp: m.broker?.idp, runtime, manifestPath: resolve(file), prepared: eff, transport: assertServesDialHost(opts.transport, new URL(server).hostname), maxSessions: opts.maxSessions, logFile: m.broker?.logFile, logfileSizeLimit: m.broker?.logfileSizeLimit, logfileMaxNum: m.broker?.logfileMaxNum };
}

/** A stack's auth mode in words, and the manifest's `broker.auth` value that declares it. */
const RESUME_MODE = { open: { words: "open", field: "false" }, auth: { words: "static auth", field: "static" }, user: { words: "user auth", field: "user" } } as const;

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
  const { prepared: eff, hostSource, serverSource } = applyUpOverrides(prepared, { transport: opts.transport, dryRun: false, freshTeamBoot: true });
  const m = eff.manifest;
  const server = m.broker?.host ? reconcileHostAndServer(m.broker.host, m.broker?.servers, hostSource, serverSource) : (m.broker?.servers ?? DEFAULT_SERVER);
  const open = m.broker?.auth === false;
  const mode = open ? "open" as const : m.broker?.auth === "user" ? "user" as const : "auth" as const;
  const runtime = m.runtime ?? "pty";
  // Each setting the manifest moves, with both values and the manifest change that keeps the recorded one.
  const shown = (address: string) => brokerAddressForDisplay(address) ?? "not displayable";
  const moved = [
    ...(server !== opts.recorded.server ? [{ name: "broker address", recorded: shown(opts.recorded.server), declared: shown(server), keep: `set \`broker.servers\` to ${shown(opts.recorded.server)}` }] : []),
    ...(m.broker?.host !== undefined && m.broker.host !== opts.recorded.host ? [{ name: "bind host", recorded: opts.recorded.host ?? "none", declared: m.broker.host, keep: opts.recorded.host ? `set \`broker.host\` to ${opts.recorded.host}` : "remove `broker.host`" }] : []),
    ...(mode !== opts.recorded.mode ? [{ name: "auth mode", recorded: RESUME_MODE[opts.recorded.mode].words, declared: RESUME_MODE[mode].words, keep: `set \`broker.auth\` to \`${RESUME_MODE[opts.recorded.mode].field}\`` }] : []),
  ];
  if (moved.length) {
    const named = moved.map((row) => `${row.name} (recorded ${row.recorded}, declared ${row.declared})`);
    throw new CommandFailure("refused", "CONFLICT", `the manifest differs from the recorded stopped stack in its ${named.length > 1 ? `${named.slice(0, -1).join(", ")} and ${named.at(-1)}` : named[0]}; nothing was resumed`, {
      target: { space: m.space, recorded: { ...opts.recorded, server: shown(opts.recorded.server) }, declared: { server: shown(server), host: m.broker?.host ?? null, mode } },
      remedy: `${moved.map((row) => row.keep).join(" and ")} in the manifest to resume this stack, or boot the manifest as a new space in another folder prepared with \`cotal space create <space>\``,
    });
  }
  if (open && (m.defaults?.deliveryClass === "durable" || m.channels.some((channel) => channel.deliveryClass === "durable")))
    throw new CommandFailure("refused", "UNSUPPORTED", "this open manifest explicitly requests durable channel delivery, but the open broker has no delivery daemon; nothing was resumed", { target: { space: m.space } });
  const other = loadMeshes().filter((row) => row.space !== m.space && row.server === server);
  if (other.length) throw new CommandFailure("refused", "CONFLICT", "another local registration names this exact broker address; the stopped stack was not resumed over it", { target: { space: m.space, otherSpaces: other.map((row) => row.space) } });
  try { await preflightRuntime(runtime); }
  catch (error) { throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the requested runtime did not pass preflight; nothing was resumed", { target: { space: m.space, runtime }, remedy: error instanceof Error ? error.message : "inspect the selected runtime provider" }); }
  if (await isReachable(server)) throw new CommandFailure("refused", "CONFLICT", "the recorded broker address already answers; the stopped stack was not resumed over it", { target: { space: m.space, server: brokerAddressForDisplay(server) ?? "not displayable" } });
  const conn = await preflightConnectors(prepared);
  if (conn) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "connector preflight failed; nothing was resumed", { target: { space: m.space }, remedy: conn });
  return { root: canonicalRoot(cotalRoot()), space: m.space, server, host: opts.recorded.host, mode, idp: m.broker?.idp, runtime, manifestPath: resolve(file), prepared: eff, transport: assertServesDialHost(opts.transport, new URL(server).hostname), maxSessions: undefined, logFile: m.broker?.logFile, logfileSizeLimit: m.broker?.logfileSizeLimit, logfileMaxNum: m.broker?.logfileMaxNum };
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
      const prepared = await prepareBrokerStart({ transport: opts.transport, server: opts.server, space: opts.space, ...(opts.open ? { open: true } : {}), ...(opts.userAuth ? { userAuth: opts.userAuth } : {}), ...(opts.host ? { host: opts.host } : {}), ...(opts.wsPort !== undefined ? { wsPort: opts.wsPort } : {}), ...(opts.storeDir ? { storeDir: opts.storeDir } : {}), ...(opts.existingStore ? { existingStore: opts.existingStore } : {}), ...(opts.maxFileStore !== undefined ? { maxFileStore: opts.maxFileStore } : {}), ...(opts.logFile !== undefined ? { logFile: opts.logFile } : {}), ...(opts.logfileSizeLimit !== undefined ? { logfileSizeLimit: opts.logfileSizeLimit } : {}), ...(opts.logfileMaxNum !== undefined ? { logfileMaxNum: opts.logfileMaxNum } : {}), ...(opts.authTimeout !== undefined ? { authTimeout: opts.authTimeout } : {}), ...(opts.maxPayload !== undefined ? { maxPayload: opts.maxPayload } : {}), ...(opts.accountResolver !== undefined ? { accountResolver: opts.accountResolver } : {}), ...(opts.noManager ? { noManager: true } : {}), ...(opts.seed !== undefined ? { seed: opts.seed as ChannelRegistryFile } : opts.channels ? { channels: opts.channels } : {}), quietBoot: true });
      return { root: prepared.root, server: prepared.server, space: prepared.space, storeDir: prepared.storeDir, transport: prepared.transport, ...(prepared.setup ? { setup: { mintProvisioner: prepared.setup.mintProvisioner, wsPort: prepared.setup.wsPort, moveWebsocketPort: prepared.setup.moveWebsocketPort } } : {}), ...(prepared.setup?.prepared && prepared.setup.stateDir ? { user: { prepared: prepared.setup.prepared, stateDir: prepared.setup.stateDir } } : {}), confPath: prepared.confPath, bin: prepared.bin, source: prepared.source, version: prepared.version, seedFile: prepared.seedFile, ...(prepared.setup?.authTimeout !== undefined ? { authTimeout: prepared.setup.authTimeout } : {}), ...(prepared.maxPayload !== undefined ? { maxPayload: prepared.maxPayload } : {}), ...(prepared.setup?.accountResolver !== undefined ? { accountResolver: prepared.setup.accountResolver } : {}) };
    },
    initializeStreams: async (server, space, setup, seedFile, recreateIssuedStores, recreateMembershipStore) => postStart(server, space, setup && { creds: await setup.mintProvisioner() }, seedFile as ChannelRegistryFile | undefined, recreateIssuedStores, recreateMembershipStore, true),
    recreateDeletedStreams: ({ seed, ...opts }) => recreateDeletedStreams({ ...opts, ...(seed !== undefined ? { seed: seed as ChannelRegistryFile } : {}) }),
    recordMesh: (entry) => recordOurMesh({ ...entry, ts: new Date().toISOString() }, "started", true),
    commitTransport: (root, chosen, limits) => commitTransportPolicy(root, chosen, true, undefined, limits),
  };
}

/** The structured refusal for a manifest `up -f` cannot use: the located problems of one that does
 *  not validate, or the read failure of one that cannot be read. Both exit 1, as the text path does. */
function manifestFileRefusal(e: unknown, path: string): CommandFailure {
  if (e instanceof ManifestError) {
    // One line per problem: a parse error's code frame stays out of the sentence.
    const issues = e.issues.map((issue) => ({ ...issue, message: issue.message.split("\n")[0]!.replace(/(at line \d+, column \d+):$/, "$1") }));
    return new CommandFailure("refused", "SCHEMA_INVALID", `the manifest does not validate, so nothing was started: ${issues.map((issue) => formatIssue(e.file, issue)).join("; ")}`, { target: { path, issues }, remedy: "fix each named problem and run the command again" });
  }
  // A refusal that already names the problem, such as a directory given as the manifest, keeps its
  // own sentence and remedy, as the text path prints them.
  if (e instanceof CommandFailure) return e;
  const code = (e as NodeJS.ErrnoException)?.code;
  return new UnusableFile(code === "ENOENT" ? `manifest file not found: ${path}` : `the manifest ${path} could not be read (${code ?? (e as Error).message})`, { file: path });
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
    prepared = loadManifest(resolve(file), opts.logFile);
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
    stderrLine("✗ ", `--user-auth requires manifest broker.auth: "user" (this manifest's broker.auth is ${declaredStr}). Either set broker.auth: "user" in the manifest, or drop --user-auth.`, c.red);
    process.exit(1);
  }
  if (opts.idp && declared !== "user") {
    if (opts.freshTeamBoot) throw new CommandFailure("refused", "CONFLICT", "--idp needs this manifest's user-auth mode; no trust or broker was changed", { target: { space: prepared.manifest.space } });
    stderrLine("✗ ", `--idp is for user-auth spaces (this manifest's broker.auth is ${declaredStr}) - set broker.auth: "user" in the manifest, or drop --idp.`, c.red);
    process.exit(1);
  }
  const idpProblem = opts.idp === undefined ? undefined : idpUrlProblem(opts.idp, "--idp");
  if (idpProblem) {
    if (opts.freshTeamBoot) throw new CommandFailure("refused", "SCHEMA_INVALID", idpProblem, { target: { space: prepared.manifest.space } });
    stderrLine("✗ ", `${idpProblem}`, c.red);
    process.exit(1);
  }
  const serverProblems = opts.server === undefined ? [] : serverUrlProblems(opts.server, "--server");
  if (serverProblems.length) {
    if (opts.freshTeamBoot) throw new CommandFailure("refused", "SCHEMA_INVALID", serverProblems.join("; "), { target: { space: prepared.manifest.space } });
    for (const problem of serverProblems) stderrLine("✗ ", `${problem}`, c.red);
    process.exit(1);
  }
  // Each entry of a list is checked above; the start still needs one address, before any parse of it.
  const list = bindListRefusal(opts.freshTeamBoot ? "team boot" : "up -f", file, prepared.manifest.space, opts.server, prepared.manifest.broker?.servers);
  if (list) throw list;
  // Apply CLI overrides to one effective manifest (flag > manifest > default) so render + seed +
  // broker + launch all agree on the same values.
  const { prepared: eff, hostSource, serverSource } = applyUpOverrides(prepared, opts);
  const m = eff.manifest;
  if (m.broker?.logFile === undefined && (opts.logfileSizeLimit !== undefined || opts.logfileMaxNum !== undefined))
    throw new CommandFailure("refused", "USAGE_INVALID", "--logfile-size-limit and --logfile-max-num require --log-file or broker.logFile in the manifest", { remedy: "pass --log-file <path>, set broker.logFile in the manifest, or omit the rotation flags" });
  const host = m.broker?.host ?? "127.0.0.1";
  // Same bind-vs-probe reconciliation as the flag path: a manifest that sets `broker.host` without
  // an explicit `broker.servers` would otherwise bind one address and be probed at another.
  const server = m.broker?.host ? reconcileHostAndServer(m.broker.host, m.broker?.servers, hostSource, serverSource) : (m.broker?.servers ?? DEFAULT_SERVER);
  assertTlsIntentServed(server, opts.transport, opts.server !== undefined ? "--server" : "the manifest's broker.servers");
  // A --tls-cert broker serves TLS only, so its address says tls://, as a bare up requires of --server.
  if (opts.transport.kind === "tls-required" && server.split(",").some((url) => /^nats:\/\//i.test(url.trim())))
    throw new CommandFailure("refused", "USAGE_INVALID", `--tls-cert serves the broker over TLS, so ${opts.server !== undefined ? "--server" : "the manifest's broker.servers"} must be a tls:// address; nothing was started or written`, {
      target: { space: m.space, server: brokerAddressForDisplay(server) ?? "not displayable" },
      remedy: opts.server !== undefined ? `pass --server ${tlsAddress(server)}` : `set broker.servers to ${tlsAddress(server)} in ${file}`,
    });
  const open = m.broker?.auth === false; // default is auth
  const userAuth = m.broker?.auth === "user" ? { idpUrl: m.broker.idp } : undefined;
  const runtime = m.runtime ?? "pty";
  if (open && (m.defaults?.deliveryClass === "durable" || m.channels.some((channel) => channel.deliveryClass === "durable")))
    throw new CommandFailure("refused", "UNSUPPORTED", "this open manifest explicitly requests durable channel delivery, but the open broker has no delivery daemon; no channel metadata or broker was written", { target: { space: m.space, defaultDurable: m.defaults?.deliveryClass === "durable", channels: m.channels.filter((channel) => channel.deliveryClass === "durable").map((channel) => channel.name) }, remedy: "use static/user authentication for durable delivery, or declare live delivery for an open mesh" });
  // The address this manifest names is held by the same rule as a `--server` on the flag path: a
  // stopped space keeps its registered address, and a second stack started there answers for both
  // registrations. A fresh team boot has its own refusal below, so this is the ordinary `up -f`.
  if (!opts.freshTeamBoot)
    refuseRegisteredAddress(server, m.space, opts.dryRun
      ? "choose another address for --server and repeat the same --dry-run"
      : opts.server !== undefined ? "choose another address for --server and repeat the original command" : `point broker.servers in ${file} at another address`);
  if (opts.freshTeamBoot) {
    const other = loadMeshes().filter((row) => row.space !== m.space && row.server === server);
    if (other.length) throw new CommandFailure("refused", "CONFLICT", "another local registration names this exact broker address; fresh team boot did not create a listener over its recorded target", { target: { space: m.space, server: brokerAddressForDisplay(server) ?? "not displayable", otherSpaces: other.map((row) => row.space) }, remedy: "inspect both registrations and their native brokers; exact-address conflicts block creation, while no conflict does not prove exclusivity" });
  }
  if (opts.freshTeamBoot) {
    assertFreshTeamBootOwnership(cotalRoot(), m.space, open ? "open" : userAuth ? "user" : "auth");
    await assertFreshTeamBindAvailable(server, host, m.space);
  }
  // A manifest needs its manager to boot declared agents.
  if (opts.noManager && eff.agents.length)
    throw new FlagValueRefusal(`--no-manager cannot launch this manifest: it declares ${eff.agents.length} agent(s), and a manifest's agents are booted by its manager (which --no-manager omits)`, "drop --no-manager, or use a broker-only manifest with no agents");
  const effectiveNoManager = Boolean(opts.noManager);
  // The open-mesh refusal must be RE-STATED here, not only against the CLI `--open` flag: on this
  // path openness comes from the MANIFEST (`broker.auth: false`), which the flag-level guard cannot
  // see. Without it, `cotal up -f open.yaml --rotate-sys` boots an open broker, exits 0 and rotates
  // nothing: a rotation ask answered with silent success, the exact failure class this change
  // exists to remove. Before the dry-run print and before anything boots.
  if (opts.rotateSys && open)
    throw new FlagValueRefusal("--rotate-sys is for auth meshes: this manifest sets broker.auth: false (open), so there is no system account or $SYS credentials to rotate, and nothing was started", "drop --rotate-sys for this open manifest");
  // Before the dry-run print and before connector preflight or any write, as the refusals above.
  if (!opts.storeDir) refuseUnnamedLastStore(cotalPath("nats"));
  else refuseMissingNamedStore(resolve(opts.storeDir));
  if (userAuth) await preflightUserStack(cotalRoot(), m.space, userAuth.idpUrl);
  checkStartStore(opts.storeDir, m.space);

  // Preview and apply only probe a runtime when starting a manager.
  try { if (!effectiveNoManager) await preflightRuntime(runtime); }
  catch (error) {
    throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `the requested runtime did not pass preflight; ${opts.freshTeamBoot ? "no fresh boot intent or broker was started" : "no broker was started"}`, { target: { space: m.space, runtime }, remedy: error instanceof Error ? error.message : "inspect the selected runtime provider" });
  }

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
      stderrLine("✗ ", `connector preflight failed: ${dryConn}`, c.red);
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

  // up -f never adopts a running broker. The old spawn -f route is no longer a manifest deploy.
  if (await isReachable(server)) {
    if (opts.freshTeamBoot) throw new CommandFailure("refused", "CONFLICT", "the selected address already has a broker; fresh boot did not adopt it or start a competing listener", { target: { space: m.space, server: brokerAddressForDisplay(server) ?? "not displayable" }, remedy: "inspect the existing broker and selected local records, or use another prepared address" });
    // This folder's own mesh for the manifest's space is named as running, as a bare `up` names it,
    // with the routes that change it instead of the advice for a foreign broker.
    if (loadMeshes().some((row) => row.server === server && row.root === cotalRoot() && row.space === m.space)) {
      stderrLine("✗ ", `mesh "${m.space}" is already running at ${brokerAddressForDisplay(server) ?? "its address"} from this folder - \`up -f\` boots a fresh mesh and does not apply a manifest to a running one; stop it with \`cotal down\`, then retry your original command`, c.red);
      process.exit(1);
    }
    stderrLine("✗ ", `${brokerAddressForDisplay(server) ?? "selected address"} already has a broker - a fresh boot will not adopt it. Stop the owned stack or select another address; team deploy supports only all-new channel cards, not agent apply.`, c.red);
    process.exit(1);
  }
  await assertBrokerAddressFree(server, `${displayCmd()} up -f ${shellWord(file)}`, host);
  // Connectors + their required binaries must exist before any mutation (no fallback).
  const conn = await preflightConnectors(prepared);
  if (conn) {
    if (opts.freshTeamBoot) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "connector preflight failed before the fresh boot intent; no native effect was requested", { target: { space: m.space }, remedy: conn });
    stderrLine("✗ ", `connector preflight failed: ${conn}`, c.red);
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
      stderrLine("✗ ", `${(e as Error).message}`, c.red);
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
    ({ pid, controlPlane, authService, deliveryResponderBound } = await startMeshDetached({ transport: opts.transport, server, space: m.space, open, userAuth, rotateSys: opts.rotateSys, host: m.broker?.host, logFile: m.broker?.logFile, logfileSizeLimit: m.broker?.logfileSizeLimit, logfileMaxNum: m.broker?.logfileMaxNum, seed: manifestToChannels(eff), runtime, launch: specPath, maxSessions: opts.maxSessions, noManager: effectiveNoManager, quietBoot: opts.freshTeamBoot, ...(opts.storeDir ? { storeDir: opts.storeDir } : {}) }));
  } catch (e) {
    if (opts.freshTeamBoot) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the fresh broker startup did not confirm completion after its launch spec was written; the listener or control plane may have changed state and the boot was not retried", { target: { space: m.space, deploymentId, launchSpec: specPath }, changed: [{ kind: "launch-spec-written", path: specPath }], remedy: "inspect this exact run and the recorded local listener, manager and auth state before another boot" });
    // A classified failure, such as a certificate this client refuses, keeps its code and next step.
    if (isCommandFailure(e)) throw e;
    stderrLine("✗ ", `${(e as Error).message}`, c.red);
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
  if (summaryRecorded) console.log(c.dim(`  fresh deployment ${deploymentId} recorded; \`cotal team show ${deploymentId}\` reads its launch summary, not live ownership`));
  // Never claim a launch the control plane can't deliver: the manager carries the launch spec, so a
  // degraded control plane (announced above) means the agents are NOT coming up.
  if (effectiveNoManager) {
    // Truthful summary for the broker-only boot (#1417): nothing was omitted by accident, and the
    // agents this manifest declares (none — a declaring manifest is refused above) launch elsewhere.
    console.log(c.dim(`  broker-only (--no-manager): no manager started on this host - run \`cotal supervise --space ${m.space} --server ${server}\` from a manager host to manage agents`));
  } else if (controlPlane) {
    // U6: on a user mesh the agents run under the OPERATOR's identity — say whose they are.
    // The manager launches them after this command returns, so nothing here knows whether one joined:
    // no success mark, and name where the outcome shows.
    console.log(`  launch pending: the manager (${runtime}) starts ${eff.agents.length} agent(s)${owner ? ` as you (owner ${owner})` : ""} after this returns; up -f does not wait for them to join`);
    console.log(c.dim(`  who joined: \`cotal ps --space ${m.space}\`   ·   a failed launch and its reason: ${managerLogDisplayPath(m.space)}`));
  } else {
    stderrLine("✗ ", `${eff.agents.length} agent(s) NOT launched - the control plane did not come up (see above)`, c.red);
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
  /** `--store-dir`: the JetStream store this boot opens instead of `.cotal/nats`. */
  storeDir?: string;
  logFile?: string;
  logfileSizeLimit?: number;
  logfileMaxNum?: number;
}

/** Return a copy of the prepared manifest with CLI overrides applied to broker/space/runtime, so the
 *  whole launch (render, seed, broker, manager, launch spec) runs against one effective manifest.
 *  A flag names itself. A value that came from the file keeps that file's key, and a value neither
 *  supplied is named by the flag that would supply it. */
function applyUpOverrides(prepared: PreparedManifest, o: UpManifestFlags): { prepared: PreparedManifest; hostSource: string; serverSource: string } {
  const m = prepared.manifest;
  const broker = { ...m.broker };
  if (o.server) broker.servers = o.server;
  if (o.host) broker.host = o.host;
  if (o.open) broker.auth = false;
  if (o.idp) broker.idp = o.idp;
  if (o.logFile !== undefined) broker.logFile = o.logFile;
  if (o.logfileSizeLimit !== undefined) broker.logfileSizeLimit = o.logfileSizeLimit;
  if (o.logfileMaxNum !== undefined) broker.logfileMaxNum = o.logfileMaxNum;
  return {
    prepared: {
      ...prepared,
      manifest: {
        ...m,
        broker: Object.keys(broker).length ? broker : undefined,
        runtime: (o.runtime as typeof m.runtime) ?? m.runtime,
      },
    },
    hostSource: !o.host && m.broker?.host !== undefined ? "broker.host" : "--host",
    serverSource: !o.server && m.broker?.servers !== undefined ? "broker.servers" : "--server",
  };
}

export { openBrokerLog };
