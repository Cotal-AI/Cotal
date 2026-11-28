import { noManagerCredentialWarning } from "../lib/daemon-credential-warning.js";
import { openBrokerLog, prepareForegroundBrokerLog } from "../lib/broker-log.js";
import { spawnBroker } from "../lib/broker-spawn.js";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  mkdirSync,
  existsSync,
  lstatSync,
  realpathSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  isReachable,
  DEFAULT_SERVER,
  CONTRACT_ARTIFACT_MAX_BYTES,
  MANAGER_START_PAYLOAD_FLOOR,
  mintCreds,
  newIdentity,
  reconcileSpaceMemoryBuckets,
  reconcileArtifactIndexStores,
  LEASE_TTL_MS,
  type AuthPrepared,
  type SpaceAuth,
  type ParsedArgs,
  type FlagSpec,
  type CompletionResult,
} from "@cotal-ai/core";
import {
  assertManagerName,
  processStopped,
  readManagerName,
  readManagerSeatCap, DEFAULT_SEAT_CAP,
  parseSeatCapFlag,
  seatCapText,
  CommandFailure,
  codeSpan,
  failureEnvelope,
  writeEnvelope,
  isCommandFailure,
  protectedLocalDirectory,
  jsonFlag,
  plainFlag,
  renderReport,
  assertSingleSpaceBroker,
  authDir,
  getSpaceAuth,
  brokerAddressKey,
  canonicalRoot,
  legacyStackOtherHome,
  stackHomeRemedy,
  loadMeshes,
  localMeshesForRoot,
  keepsRegistration,
  presentationOf,
  parsePositiveIntegerFlag,
  retainedLegacyBroker,
  userAuthStateDir,
  workspaceSecretStore,
  type UserAuthInfo,
  acquireMaintenanceLock,
  assertStoreIdentity,
  assessMaintenanceClaim,
  assessRestoreClaim,
  beginOrdinaryResume,
  consumeRetiredMaintenance,
  markOrdinaryResumeDegraded,
  replaceDeadOrdinaryResumeListener,
  localProcessOwnerStatus,
  readMaintenanceJournal,
  readMaintenanceResumeDocument,
  readStoreIdentity,
  releaseMaintenanceLock,
  sameStoreIdentity,
  type MaintenanceLock,
  cutController,
  type ListenerProof,
  readBrokerPolicy,
  verifyIdentityPin,
  processesNaming,
  recordOperationSpace,
  recordOperationWarning,
  NATS_PIDFILE,
  terminalWidth,
} from "@cotal-ai/workspace";
import { FlagValueRefusal } from "../lib/flag-value-refusal.js";
import { resolveAuthProvider } from "../lib/auth-proc.js";
import { c, hang, stderrLine } from "../ui.js";
import { admitAndRestoreSeatCheckpoints } from "../lib/seat-resume.js";
import { NATS_DEFAULT_MAX_PAYLOAD, natsServerLabel, resolveNatsServer, unreadVersion } from "../lib/nats-bin.js";
import { cotalPath, cotalRoot } from "../lib/paths.js";
import { channelsReads, loadChannelsFile, readChannelsFile, readDefaultChannelsFile } from "../lib/channel-seed.js";
import { controllerManifestRemedy, detachedNext, renderDetachedSummary } from "../lib/up-report.js";
import { seedBeforeLaunch, seedMoveNote } from "../seed/launch.js";
import { seedDir } from "../seed/paths.js";
import { seedStoreMoved } from "../seed/reconcile.js";
import { upSystemdSupervisionWarning } from "../lib/systemd-supervision.js";
import { deliveryStoppedByDown, deliveryUp, ensureDelivery } from "../lib/delivery-proc.js";
import { displayCmd } from "../lib/self-exec.js";
import { shellWord } from "../lib/endpoint-errors.js";
import { liveManagerWouldApplyMaxSessions, managerHasDeliveryMarker, managerRecordState } from "../lib/manager-proc.js";
import { loadManifest } from "../lib/manifest/index.js";
import { checkNewUpSpace, preparedUpRoot, restoreUpCwd } from "./up-target.js";
import { cleanedManifestStart, interruptedStartBroker } from "../lib/legacy-start.js";
import { canonicalServer } from "../lib/broker-service.js";
import {
  controllerStackApplies,
  requestedStackMode, refuseForegroundStackHolder,
  stackUp,
  stackUpInterrupted,
} from "./stack-up.js";
import { handOverStartupNotice, noticeOnInterrupt, releaseStartupNotice } from "../lib/interrupt-notice.js";
import { claimForegroundHold, foregroundHolder, foregroundStackEnd, foregroundStopLauncher, hangupForegroundStack, releaseForegroundHold } from "../lib/foreground-hold.js";
import { settleInterruptedLaunches } from "../lib/service-process.js";
import { assertUserStackTransport, preflightUserStack } from "./stack-user-auth.js";
import { stopForegroundStack } from "./stack-down.js";
import { acquireStackOperationLock, admittedStackRestore, readStackJournal, type StackJournal } from "../lib/stack-journal.js";
import { warnForeignStoreEntries } from "../lib/store-dir.js";
import { extensionNames, preflightRuntime } from "../ext-loader.js";
import { completingFlagValue } from "../lib/completion.js";
import { metadataPositionals } from "../lib/command-path.js";
import {
  isManagerCommittedRestore,
  markPreparedRestoreDegraded,
  heldRestoreAttempt,
  heldClaim,
  movedFolderRefusal,
  prepareRestore,
  restoreArtifactPath,
  restoreLaunch,
  preservedSourceState,
  rehydratePreparedRestore,
  journaledMaxFileStore,
  rearmUnboundRestore,
  replacePreparedDeadRestoreListener,
  type PreparedRestore,
  type RestoreFlags,
} from "../lib/restore.js";
import { freezeSmokeRestoreListener, spawnMarkedListener, unreadableUnboundRestoreRefusal } from "../lib/restore-listener-spawn.js";
import { attemptProcessesGone } from "../lib/isolated-broker.js";
import { assertEndpointUnreachable } from "../lib/endpoint-cut.js";
import { freshStackServer, legacyUpRetry, retryStackAddress, serverWithFreePort } from "../lib/up-broker-address.js";
import { pendingRestores, type PendingOrdinaryResume, pendingOrdinaryResumes } from "./up-pending.js";
import {
  parseMaxFileStore,
  parseAuthTimeout,
  parseMaxPayload,
  assertManagerPayload,
  parseAccountResolver,
  authTimeoutArgs,
  refuseRunningElsewhere,
  refuseRecordsElsewhere,
  resolveTransport,
  assertTlsIntentServed,
  assertTlsAddressServed,
  tlsAddress,
  liveListenerRequiresTls,
  assertServesDialHost,
  reopenLastStore,
  refuseMissingNamedStore,
  checkStartStore,
} from "./up-transport.js";
import { reconcileHostAndServer } from "./up-host.js";
import {
  registeredAddressHolder,
  refuseRegisteredAddress,
  membershipConversionRefusal,
  fileMembershipStore,
} from "./up-stores.js";
import { brokerVersion, writeOpenBrokerConf, authSetup, provisionWebCreds } from "./up-broker-auth.js";
import {
  validateUpArguments,
  freshFolderRoot,
  folderNamedSpace,
  recordsNameNoSpace,
  inheritedMachineHomeRoot,
  assertFreshTeamBootOwnership,
  publicExchangeArgs,
  serviceEndpointsArgs,
  folderSpace,
  assertSelectionNotMoved,
  parseUpServe,
} from "./up-args.js";
import {
  startUserAuthService,
  startDeliveryWithBroker,
  reportDegradedControlPlane,
  recordSpawnedListener,
  awaitSpawnedListener,
  serveReadyListener,
  type DetachOpts,
  startMeshDetached,
  assertBrokerAddressFree,
  refuseStartOverUserState,
  ensureRootForSpace,
  unnamedDefault,
  claimSpace,
  attachHostFor,
  maxSessionsFor,
  serveFor,
  recordOurMesh,
  seedPersonaAfterUp,
  belowPresenceSafeBroker,
} from "./up-detach.js";
import { holdForegroundListener } from "./up-foreground-listener.js";
import { createUpControlDirectory, removeEmptyRecords, withUpProjectTrust } from "./up-project-trust.js";
import { controllerStackNative, manifestFileRefusal, upManifest } from "./up-manifest.js";
import {
  printRestoreReceipt,
  unrecordedStackServer,
  restoredBrokerRuns,
  assertOrdinaryUpAllowed,
  markPendingResumeDegraded,
  bindSpawnedRestoreListener,
  provePreparedRestoreListener,
  resumeControllerStack,
  commitTokenHandoff,
  bindSpawnedOrdinaryResumeListener,
  proveOrdinaryResumeListener,
  verifySpawnedOrdinaryListener,
  adoptProvenListener,
  completeResumeActivation,
} from "./up-resume.js";

export { type FreshTeamBootPlan, prepareFreshTeamBoot, prepareResumeTeamBoot, recordedBrokerTransport, recheckFreshTeamBoot, controllerStackNative } from "./up-manifest.js";

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
  { name: "serve", type: "string", value: "<endpoints>", description: "auth mode: the delivery daemon also serves these endpoints (comma-separated, for example artifacts); each is registered and bound before up reports success, and kept for later starts" },
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

/** Foreground controller stack: the terminal holds the stack's lifetime until SIGINT or SIGTERM,
 *  which runs the same guarded whole-stack stop as bare `down`. A hangup leaves the stack running and
 *  exits 129, naming `cotal down`. `start`, when given, is the startup this terminal already holds: a
 *  signal during it lets the start settle, then a stop signal runs that stop and a hangup leaves what
 *  the start left. A failed start still runs the stop, and its failure is thrown once the stop returns.
 *  The hold exits 0 after a completed external stop or preserve, 5 after a broker crash, 129 after
 *  a hangup, 130 or 143 after a stop signal, whatever the start receipt set. */
export async function holdForegroundStack(root: string, space: string, start?: () => Promise<void | StackJournal>, releaseRestoreNotice?: () => void): Promise<void> {
  claimForegroundHold(root);
  try { await holdStack(root, space, start, releaseRestoreNotice); }
  finally { releaseForegroundHold(root); }
}

async function holdStack(root: string, space: string, start?: () => Promise<void | StackJournal>, releaseRestoreNotice?: () => void): Promise<void> {
  const outsideCmd = foregroundStopLauncher(root);
  // The start's listeners go only once the hold's own are installed. Node runs a listener for a
  // signal when the loop next polls, and drops the signal if its last listener was removed first,
  // so a signal that lands in the start's last synchronous step would be lost in between.
  let held: StackJournal | void = undefined, releaseStart = (): void => {};
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
    try { held = await start(); } catch (error) { failure = { error }; }
    releaseStart = () => { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); process.off("SIGHUP", hangup); };
    if (requested || failure) releaseStart();
    if (requested === "SIGHUP") hangupForegroundStack(root, space, outsideCmd);
    if (requested) await stopForegroundStack(root, requested, true, held?.space);
    if (failure) throw failure.error;
    if (requested) return;
  }
  return new Promise<void>((resolveHold) => {
    const observed = held ?? (() => { try { return readStackJournal(root)?.journal; } catch { return undefined; } })();
    let stopping = false;
    const checkLifetime = () => {
      if (stopping) return;
      const code = foregroundStackEnd(root, observed);
      if (code === undefined) return;
      stopping = true;
      process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); process.off("SIGHUP", hangup);
      clearInterval(lifetime);
      process.exitCode = code;
      resolveHold();
    }, lifetime = setInterval(checkLifetime, 1000);
    const stop = (signal: "SIGINT" | "SIGTERM") => {
      if (stopping) return;
      stopping = true;
      process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); process.off("SIGHUP", hangup);
      clearInterval(lifetime);
      void stopForegroundStack(root, signal, false, observed?.space).finally(resolveHold);
    };
    const interrupt = () => stop("SIGINT");
    const terminate = () => stop("SIGTERM");
    const hangup = () => { checkLifetime(); if (!stopping) hangupForegroundStack(root, space, outsideCmd); };
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
  if (!channelsReads.getStore()) return withUpProjectTrust(() => channelsReads.run(new Map(), () => up(args, inheritedLock, freshTeamBoot, restoreSink)));
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
      createUpControlDirectory(fresh);
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
        restoreUpCwd(previousCwd);
        throw new CommandFailure("refused", "CONFLICT", "the selected --root changed before startup; no inherited workspace was used", { target: { root } });
      }
    }
    try { return await runUp(invocation, previousCwd, inheritedLock, () => { adopted = true; }, freshTeamBoot, restoreSink); }
    catch (error) {
      if (fresh) removeEmptyRecords(join(fresh, ".cotal"));
      throw error;
    }
    finally { if (root) restoreUpCwd(previousCwd); }
  } finally {
    if (inheritedLock && !adopted) releaseMaintenanceLock(inheritedLock);
  }
}

const NO_MANAGER_DURING_RECOVERY = "--no-manager is refused while this root has a maintenance attempt to recover - a resume needs a manager to commit the preserved inventory; recover it (`cotal up` alone) or roll it back first";

function unfinishedPreservedStop(root: string, space: string): CommandFailure {
  return new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the preserved stop committed but has not finished; nothing was started", {
    target: { root, space, state: "cut-committed" },
    remedy: `from ${codeSpan(shellWord(root))}, finish the stop with \`cotal down --preserve-state\`, then resume with \`cotal up\``,
  });
}

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
    serve?: string;
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
      validateUpArguments(next, true);
      const wantUser = launch.mode === "user";
      publicExchangeArgs(values, wantUser);
      serviceEndpointsArgs(values, wantUser);
      if (values.json || values.plain) throw retainedStartupPresentationRefusal(root);
      const transport = resolveTransport(values, undefined, root, { persist: false, quiet: true });
      assertTlsIntentServed(launch.server, transport, "--server");
      assertTlsAddressServed(launch.server, transport, root);
      assertServesDialHost(transport, new URL(launch.server).hostname);
      readDefaultChannelsFile(root);
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
        if (foreground) await holdForegroundStack(prepared.root, prepared.space, undefined, prepared.releaseInterruptNotice);
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
    const brokerOnlyJournal = values["no-manager"] ? readMaintenanceJournal(root) : undefined;
    if (brokerOnlyJournal && !admittedStackRestore(root)) {
      if (brokerOnlyJournal.state === "cut-committed" && !cutController(brokerOnlyJournal.cut)) throw unfinishedPreservedStop(root, brokerOnlyJournal.space);
      throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", NO_MANAGER_DURING_RECOVERY, { target: { root } });
    }
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
          if (values["no-manager"]) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", NO_MANAGER_DURING_RECOVERY, { target: { root } });
          const foreground = await resumeControllerStack(lock, root, values);
          // Released here, once, so the foreground hold below does not keep the maintenance lock.
          handedOff = true;
          releaseMaintenanceLock(lock);
          if (foreground) await holdForegroundStack(root, journal.space);
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
        if (journal.state === "cut-committed" && !controllerCut) throw unfinishedPreservedStop(root, journal.space);
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
  const serve = parseUpServe(values);
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
      ensureRootForSpace(spaceForRoot, values.root !== undefined || values.json === true || values.plain === true);
    }
  }
  // A running manager keeps the name it started with.
  const managerName = values["manager-name"] === undefined ? undefined : assertManagerName(values["manager-name"]);
  if (managerName !== undefined) {
    const named = { root: cotalRoot(), space: values.space ?? folderSpace() };
    if (readManagerName(named) !== managerName && managerRecordState(named.space, named.root).state === "alive")
      throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `a manager already runs for space ${named.space}, and it keeps the name it started with`, { target: { root: named.root, space: named.space }, remedy: `run ${codeSpan(`${values.json ? "cotal" : displayCmd()} down`)} from ${codeSpan(shellWord(named.root))}, then retry the original startup command unchanged from its original folder` });
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
  if (!values.file && !values.restore && values.channels === undefined) readDefaultChannelsFile(meshRoot);
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
    const holder = values.foreground ? foregroundHolder(meshRoot) : undefined;
    if (holder !== undefined)
      refuseForegroundStackHolder(meshRoot, stackSpace, holder, noManager, maxPayload, maxFileStore, maxSessions);
    // A signal ends a detached start where it is, after it records a launch it had not yet pinned to
    // its child, and the notice names what it left running. It is installed before the lock, so no
    // moment of the start exits without it.
    const release = values.foreground ? undefined : noticeOnInterrupt(() => {
      settleInterruptedLaunches();
      const failure = stackUpInterrupted(meshRoot, stackSpace, noManager, values.__invokedRoot);
      if (presentation === "json") writeEnvelope(failureEnvelope("up", failure));
      return `${failure.message} ${failure.remedy}`;
    });
    try {
      const stackLock = acquireStackOperationLock(meshRoot, values.foreground ? "foreground up" : "up");
      const native = controllerStackNative();
      const prepare = async () => {
        try {
          const stackServer = values.server ?? readStackJournal(meshRoot)?.journal.server ?? localMeshesForRoot(meshRoot).find((m) => m.space === stackSpace)?.server ?? await unrecordedStackServer(meshRoot, stackSpace, values.host);
          return await stackUp({ maintenanceLock: stackLock, root: meshRoot, space: stackSpace, server: stackServer, transport, runtime: values.runtime ?? "pty", noManager, managerSeatCap, ...(stackMode ? { mode: stackMode } : {}), ...(values.idp ? { idp: values.idp } : {}), ...(values.host ? { host: values.host } : {}), ...(values["store-dir"] ? { storeDir: values["store-dir"] } : {}), ...(values["rotate-sys"] ? { rotateSys: true } : {}), ...(values["recreate-membership-store"] ? { recreateMembershipStore: true } : {}), ...(values["recreate-issued-stores"] !== undefined ? { recreateIssuedStores: resolve(values["recreate-issued-stores"]) } : {}), ...(maxFileStore !== undefined ? { maxFileStore } : {}), ...(logFile !== undefined ? { logFile } : {}), ...(logfileSizeLimit !== undefined ? { logfileSizeLimit } : {}), ...(logfileMaxNum !== undefined ? { logfileMaxNum } : {}), ...(authTimeout !== undefined ? { authTimeout } : {}), ...(maxPayload !== undefined ? { maxPayload } : {}), ...(accountResolver !== undefined ? { accountResolver } : {}), ...(maxSessions !== undefined ? { maxSessions } : {}), ...(serve ? { serve } : {}), ...(values.channels ? { channels: values.channels } : {}), ...(values.__invokedRoot ? { invokedRoot: values.__invokedRoot } : {}), foreground: values.foreground === true, presentation,
            managerName, retryAtAnotherAddress: (host) => retryStackAddress(args.raw, invokedFrom, stackServer, host),
          }, native);
        } finally { releaseMaintenanceLock(stackLock); }
      };
      const start = async () => { const { journal, writeReceipt } = await prepare(); writeReceipt(); return journal; };
      if (values.foreground) await holdForegroundStack(meshRoot, stackSpace, start);
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
      try { loadManifest(path, logFile, "preview"); } catch (e) { throw manifestFileRefusal(e, path); }
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
  // listener binds (detached and foreground, restore and ordinary), the unbound restore spawn mark,
  // the dead-listener replacement,
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
    if (!resumeAttempt) values["store-dir"] = assertOrdinaryUpAllowed(cotalRoot(), values["store-dir"]);
    // A start interrupted after it published its broker's pid and before it registered the space left
    // that broker running on this root's store. No broker starts beside it, at its address or at
    // another one, and it is not reported as a broker started elsewhere (#7123).
    const interrupted = resumeAttempt ? undefined : interruptedStartBroker(cotalRoot());
    if (interrupted)
      throw new CommandFailure("refused", "CONFLICT", `the broker this folder started for "${interrupted.space}" still runs at ${interrupted.server} (pid ${interrupted.pid}), and no space is registered for it because the start that launched it did not finish; nothing was started`, { target: { root: cotalRoot(), space: interrupted.space, server: interrupted.server, pid: interrupted.pid }, remedy: "stop it with `cotal down`, then repeat your startup command with the same options from this folder" });
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
      // No listener is bound. An interrupted spawn may still be opening the restored store, so a
      // process naming the attempt must be gone. When command lines cannot be read, the attempt's
      // spawn mark and the published pid's creation-time pin decide. A recorded spawn with no
      // published pid refuses. A pin that does not match is a reused pid and does not block.
      const naming = process.env.COTAL_SMOKE_UNREADABLE_PROCESSES === "1"
        ? { kind: "unreadable" as const, why: "process command lines were not read" }
        : processesNaming(restoredAttempt.attemptId);
      if (naming.kind === "unreadable") {
        const refusal = unreadableUnboundRestoreRefusal(restoredAttempt.root, restoredAttempt.attemptId, restoredAttempt.serverName, naming.why);
        if (refusal) throw new Error(refusal);
      }
      if (naming.kind === "pids" && naming.pids.length)
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
      await adoptProvenListener(ordinaryAttempt, ordinaryAttempt.storeDir, "adopted resume listener", startupLock, values.channels);
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
      const stopAdvice = () => held.origin === "up"
        ? `from ${shellWord(held.root)}, inspect the stack with ${codeSpan(`${displayCmd()} down --dry-run`)} and stop it with ${codeSpan(`${displayCmd()} down --yes`)}`
        : "stop the broker with the launcher that started it";
      if (requested && requested !== held.mode) {
        const label = { auth: "static JWT auth", open: "no auth (--open)", user: "per-user auth" }[held.mode];
        throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `mesh "${held.space}" is already running at ${server} with ${label}; a running broker can't change auth mode`, {
          target: { root, space: held.space }, remedy: `${stopAdvice()}; then retry the original startup command unchanged from its original folder`,
        });
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
        throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `mesh "${held.space}" is already running and this request starts nothing, so it can't keep it in this terminal`, {
          target: { root, space: held.space }, remedy: `${stopAdvice()}; then retry the original foreground command unchanged from its original folder`,
        });
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
        if (await fileMembershipStore(server, held.space, reconcileCreds)) throw membershipConversionRefusal(held.space, "stop this stack with `cotal down --yes`, then retry the original start with `--recreate-membership-store`");
        for (const r of await reconcileSpaceMemoryBuckets({ servers: server, space: held.space, creds: reconcileCreds }))
          console.log(c.dim(r.recreated
            ? `  re-created ${r.stream}: it is Memory-backed and was lost when the broker restarted`
            : `  reconciled ${r.stream} TTL ${r.fromMs === 0 ? "none" : `${r.fromMs}ms`} -> ${r.toMs}ms`));
        for (const stream of await reconcileArtifactIndexStores({ servers: server, space: held.space, creds: reconcileCreds }))
          console.log(c.dim(`  created ${stream}: the space predates the artifact index stores`));
        // The dashboard cred is minted on a refresh too: a space that predates it may never boot again.
        if (held.mode === "auth" && spaceAuth) await provisionWebCreds(spaceAuth, root, held.space);
      } catch (e) {
        if (isCommandFailure(e) && e.code === "LIFECYCLE_BLOCKED") throw e;
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
        ...(serveFor(held.space, serve) ? { serve: serveFor(held.space, serve) } : {}),
        managerName,
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
      recordOurMesh({ space: held.space, server, root, mode: held.mode, ...(userAuth ? { userAuth } : {}), ...(values.host ? { attachHost: values.host } : {}), ...(maxSessions !== undefined ? { maxSessions } : {}), ...(serve ? { serve } : {}), ts: new Date().toISOString() }, "refresh");
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
  await assertBrokerAddressFree(server, legacyUpRetry(args.raw), host, values.foreground === true && !resumeAttempt);
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
  const seedFile = loadChannelsFile(cotalRoot(), values.channels, !resumeAttempt && values.open === true);
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
      seed: !resumeAttempt || values.channels ? seedFile : undefined,
      // The RAW flag, not the loopback-defaulted `host` above: `startMeshDetached` applies the same
      // default itself, and what it records must distinguish "the operator asked for this address"
      // from "nobody asked", or every mesh would persist an exposure decision it never made.
      host: values.host,
      runtime: values.runtime,
      maxSessions,
      ...(serve ? { serve } : {}),
      managerName,
      managerSeatCap,
      noManager,
      resumeAttempt,
      resumeCommit: commitTokenHandoff(cotalRoot(), (restored?.managerCommit ?? ordinaryAttempt?.managerCommit) !== undefined, startupLock),
      boundListener,
      heldLock: startupLock,
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
  // Keep the POSIX broker out of the terminal's process group for manager-first teardown on Ctrl-C.
  const child = spawnMarkedListener(cotalRoot(), restored, () =>
    spawnBroker(bin, natsArgs, { cwd: cotalRoot(), stdio: "inherit", detached: process.platform !== "win32", windowsHide: false }), startupLock);
  freezeSmokeRestoreListener(child);
  await recordSpawnedListener(child, listenerStartedAt, boundListener, startupLock);
  const foreground = holdForegroundListener({ child, server, space, executable: natsServer, log: brokerOutput, resuming: resumeAttempt !== undefined, restored, releaseStartupLock });
  try {
    await awaitSpawnedListener({ child, executable: natsServer, server, space, creds: setup?.creds, tls: transport.kind === "tls-required", log: brokerOutput, boundListener, heldLock: startupLock });
    foreground.listenerReady();
    await foreground.waitForRestoreStop();
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
    const meshServing = () => !foreground.isStopping() && child.exitCode === null && child.signalCode === null;
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
    const { authService, controlPlane } = await foreground.publishControlPlane(() => serveReadyListener({
      child, server, space, storeDir, setup, seedFile: !resumeAttempt || values.channels ? seedFile : undefined, transport, maxPayload: brokerMaxPayload,
      ...(values["recreate-issued-stores"] !== undefined ? { recreateIssuedStores: resolve(values["recreate-issued-stores"]) } : {}),
      ...(values["recreate-membership-store"] ? { recreateMembershipStore: true } : {}),
      host: values.host,
      maxSessions,
      ...(serve ? { serve } : {}),
      managerName,
      managerSeatCap,
      maxFileStore,
      publicExchange,
      resumeAttempt,
      resumeCommit: commitTokenHandoff(cotalRoot(), (restored?.managerCommit ?? ordinaryAttempt?.managerCommit) !== undefined, startupLock),
      runtime: values.runtime,
      noManager,
      onDeliveryExit,
      isStopping: foreground.isStopping,
      heldLock: startupLock,
    }));
    await foreground.waitForRestoreStop();
    if (noManager && setup && controlPlane) recordOperationWarning(await noManagerCredentialWarning(cotalRoot(), space));
    if (restored && process.env.COTAL_SMOKE_FAIL_AFTER_RESTORE_LISTENER_READY === "1")
      throw new Error("smoke-injected failure after restore listener readiness");
    await completeResumeActivation(
      resumeAttempt,
      controlPlane !== undefined && authService,
      !authService ? "normal listener started but the user-auth service is unavailable" : "normal listener started but the control plane is degraded",
      server,
      startupLock, undefined, foreground.waitForRestoreStop,
    );
    foreground.activationFinished();
    if (restored && !quietRestore) printRestoreReceipt(restored, values.__invokedRoot);
  } catch (error) {
    await foreground.waitForRestoreStop();
    throw error;
  }
  releaseStartupLock();
  await new Promise<void>(() => {});
  } finally {
    releaseStartupLock();
  }
}

export { openBrokerLog };
