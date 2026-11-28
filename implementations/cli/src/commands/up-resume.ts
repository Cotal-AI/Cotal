import { drainAndClose, dialerFor, DEFAULT_SERVER, mintCreds, mintLifecycleUid, DEV_OWNER, newIdentity, standaloneConnectOpts } from "@cotal-ai/core";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { hostname } from "node:os";
import { readFileSync, existsSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CommandFailure,
  isCommandFailure,
  authDir,
  getSoleSpaceAuth,
  getSpaceAuth,
  listSpaceAccounts,
  canonicalRoot,
  findMesh,
  presentationOf,
  writeResult,
  userAuthStateDir,
  workspaceSecretStore,
  type UserAuthInfo,
  acquireMaintenanceLock,
  assertStoreIdentity,
  bindOrdinaryResumeListener,
  consumeRetiredMaintenance,
  markOrdinaryResumeActive,
  markOrdinaryResumeDegraded,
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
  connectUserControlOrThrow,
  userViewAuth,
  recordOperationWarning,
  restoreLeftOut,
  NATS_PIDFILE,
  type ControlAuth,
} from "@cotal-ai/workspace";
import { resolveAuthProvider } from "../lib/auth-proc.js";
import { c } from "../ui.js";
import { admitAndRestoreSeatCheckpoints } from "../lib/seat-resume.js";
import { displayCmd } from "../lib/self-exec.js";
import {
  assertControllerCoupling,
  assertControllerMembersLive,
  assertControllerResumeEligible,
  beginControllerResume,
  bindControllerBroker,
  controllerAttemptBrokerInstance,
  currentControllerAttempt,
  managerResumeAttempt,
  relaunchCommittedManager,
  settleControllerResume,
  startControllerMember,
  startControllerMembers,
} from "../lib/controller-resume.js";
import { removeRetiredBrokerInstance } from "../lib/controller-restore.js";
import { STACK_DEFINITION } from "../lib/stack-journal.js";
import { serviceDefinitionStore } from "../lib/service-definitions.js";
import { MissingFlags } from "../lib/missing-flags.js";
import {
  bindPreparedRestoreListener,
  isManagerCommitResult,
  isManagerFinalizeResult,
  isManagerCommittedRestore,
  markPreparedRestoreActive,
  markPreparedRestoreDegraded,
  recordPreparedRestoreManagerCommit,
  rehydratePreparedRestore,
  journaledRestoredStreams,
  leftOutNotes,
  restoreComposition,
  restoreHistory,
  restoreNextStep,
  type PreparedRestore,
} from "../lib/restore.js";
import { freshStackServer } from "../lib/up-broker-address.js";
import { askManager } from "@cotal-ai/workspace/control";
import { cliControl } from "../lib/control.js";
import { pendingRestores, type PendingOrdinaryResume, pendingOrdinaryResumes } from "./up-pending.js";
import { adoptedTlsRequired } from "./up-transport.js";
import { reconcileHostAndServer } from "./up-host.js";
import { recreateAdoptedMemoryBuckets } from "./up-stores.js";
import { startUserAuthService, startDeliveryWithBroker, attachHostFor, maxSessionsFor, serveFor, recordOurMesh } from "./up-detach.js";
import type { RestoreStartupResult } from "./up.js";

/** The human receipt for a completed `up --restore`. `backup restore` prints its own receipt. */
export function printRestoreReceipt(restored: PreparedRestore, invokedRoot?: string): void {
  console.log(c.green(`✓ restored the backup ${restored.selection === "registry" ? "registry" : "in full"} as restore attempt ${restored.attemptId}`));
  const composition = restoreComposition(restored.space, restored.restoredStreams, restored.mode);
  console.log(c.dim(`restored: ${composition.restoredWords}; recreated empty: ${composition.emptyWords}`));
  if (composition.note) console.log(c.yellow(composition.note));
  const cleanupRoot = invokedRoot && invokedRoot !== canonicalRoot(restored.root) ? restored.root : undefined;
  const cmd = displayCmd();
  const { onlyCopy, emptyNote } = restoreHistory(restored.root, restored.attemptId);
  if (emptyNote) console.log(c.dim(emptyNote));
  for (const line of leftOutNotes(restored.attemptId, restored.selection, onlyCopy, cleanupRoot, cmd)) console.log(c.yellow(line));
  const journal = readMaintenanceJournal(restored.root);
  if (journal && "restore" in journal && journal.restore.attemptId === restored.attemptId)
    console.log(c.dim(`next: ${restoreNextStep(journal.state, restored.attemptId, journal, { cleanupRoot, cmd })}`));
}

/** The address of a prepared stack that neither a journal nor a registration records, as after a
 *  damaged journal was removed once `down` had dropped the registration. Its saved broker definition
 *  names it. With none, a root that holds this space's trust or a store from an earlier start refuses
 *  rather than start at another address; only a fresh prepared root chooses an available address. */
export async function unrecordedStackServer(root: string, space: string, host: string | undefined): Promise<string> {
  const launch = serviceDefinitionStore(space).read(STACK_DEFINITION.broker)?.record.value.launch;
  const saved = launch?.type === "adapter" && typeof launch.options.server === "string" ? launch.options.server : undefined;
  if (saved !== undefined) {
    recordOperationWarning({ code: "STACK_ADDRESS_RECOVERED", target: { root, space, server: saved }, message: `no stack journal or registration records this stack's address, so it starts at ${saved}, the address its saved broker definition names` });
    return host ? reconcileHostAndServer(host, undefined, "--host", "--server", saved) : saved;
  }
  if (listSpaceAccounts(authDir(root)).includes(space) || existsSync(join(root, ".cotal", "nats")))
    throw new MissingFlags(`no stack journal, registration or saved broker definition records the address "${space}" ran at in ${root}, which holds its earlier trust or store; nothing was started`, "repeat the same startup command, adding `--server <url>` with the address it ran at", { root, space });
  return freshStackServer(host ? reconcileHostAndServer(host, undefined) : DEFAULT_SERVER, host);
}

/** A start over the broker a committed restore left running here. `up -f` boots a fresh mesh, so its
 *  way out also retires the restore with `retire`. */
export function restoredBrokerRuns(root: string, attempt: string, pid: number, manifest?: string, retire?: string): CommandFailure {
  return new CommandFailure("refused", "CONFLICT", `the broker that restore attempt ${attempt} started still runs here (pid ${pid}), and a new start does not run beside it; nothing was started`, {
    target: { root, attempt, pid },
    remedy: manifest !== undefined ? `stop the restored stack with \`cotal down\`, retire the restore with ${retire}, then run \`cotal up -f ${manifest}\` again` : "stop the restored stack with `cotal down`, then run `cotal up` again",
  });
}

/** The cleanup that retires an active restore. If its previous store holds data the restore left
 *  out, cleanup deletes that store only with `--discard-history`. */
function retireRestore(attempt: string, leftOut: string | undefined): string {
  return leftOut
    ? `\`cotal backup cleanup-fallback ${attempt}\` only if you choose to discard the ${leftOut} held only in the previous store (deletion requires --discard-history)`
    : `\`cotal backup cleanup-fallback ${attempt} --yes\``;
}

/** `manifest` is the `up -f` file, which boots a fresh mesh and so needs the restore retired first. */
export function assertOrdinaryUpAllowed(root: string, storeDir?: string, manifest?: string): string | undefined {
  const maintenance = readMaintenanceJournal(root);
  if (!maintenance) return storeDir;
  if (maintenance.state === "active") {
    const attempt = maintenance.restore.attemptId, retire = retireRestore(attempt, maintenance.restore.previousSource ? restoreLeftOut(maintenance) : undefined);
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
    const target = maintenance.restore.target;
    const selected = storeDir ?? target.path;
    const requested = resolve(selected);
    // A restart serves the journal's exact target, whether or not the caller names a store.
    if (!sameStoreIdentity(readStoreIdentity(requested), target))
      throw new Error(`ordinary startup after restore must use the recorded active target store ${target.path}, not ${requested}`);
    return selected;
  }
  // A preserved cut resumes only through bare `up`, which journals the resume attempt. Nothing has
  // started here, so this is a refusal.
  if (maintenance.state === "ready")
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "this root holds a stack preserved by `cotal down --preserve-state`, which only bare `cotal up` resumes; nothing was started", { target: { root, space: maintenance.space }, remedy: `resume it with bare \`cotal up\` in ${root}` });
  throw new Error(`cotal up is refused while maintenance state is ${maintenance.state}; follow the recorded restore recovery`);
}

export function markPendingResumeDegraded(attemptId: string, reason: string, heldLock?: MaintenanceLock): void {
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

export function bindSpawnedRestoreListener(prepared: PreparedRestore, pid: number, startedAt: string, heldLock?: MaintenanceLock): void {
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

export function provePreparedRestoreListener(prepared: PreparedRestore): Promise<ListenerProof> {
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
export async function resumeControllerStack(lock: MaintenanceLock, root: string, values: { "accept-stale-checkpoint"?: boolean; runtime?: string; server?: string; "store-dir"?: string; "max-file-store"?: string; "auth-timeout"?: string; "max-payload"?: string; "account-resolver"?: string; detach?: boolean; foreground?: boolean; json?: boolean; plain?: boolean }, restoreSink?: (result: RestoreStartupResult) => void): Promise<boolean> {
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
    const { onlyCopy, emptyNote } = restoreHistory(root, attemptId);
    if (restoreSink) restoreSink(result);
    else writeResult(presentationOf(values), { command: "up", target: { root, space, server: launch.server }, result: { kind: "controller-stack-restore", root, space, server: launch.server, attemptId, targetPath, selection: result.selection, restored: composition.restored, recreatedEmpty: composition.recreatedEmpty, retiredBrokerRemoved: attempt.brokerRequired } }, (row) => ({ sections: [{ title: "Controller stack restored", blocks: [
      { kind: "fields", rows: [["Space", row.space], ["Root", row.root], ["Broker", row.server], ["Attempt", row.attemptId], ["Store", row.targetPath], ["Selection", row.selection], ["Restored", composition.restoredWords], ["Recreated empty", composition.emptyWords]] },
      { kind: "lines", lines: ["Each recorded member was started or adopted for this attempt, and the retained agents were resumed under the same principals. The restore journal stays active until its fallback is cleaned up. This is not agent or task readiness.", ...(composition.note ? [composition.note] : []), ...(emptyNote ? [emptyNote] : []), ...leftOutNotes(attemptId, result.selection, onlyCopy)] },
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
export function commitTokenHandoff(root: string, committed: boolean, heldLock?: MaintenanceLock): { path: string; sha256: string } | undefined {
  if (!committed) return undefined;
  const lock = heldLock ?? acquireMaintenanceLock(root);
  try {
    sweepTokenHandoff(lock);
    return writeTokenHandoff(lock);
  } finally {
    if (!heldLock) releaseMaintenanceLock(lock);
  }
}

export function bindSpawnedOrdinaryResumeListener(pending: PendingOrdinaryResume, pid: number, startedAt: string, heldLock?: MaintenanceLock): void {
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

export function proveOrdinaryResumeListener(pending: PendingOrdinaryResume): Promise<ListenerProof> {
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
export async function verifySpawnedOrdinaryListener(pending: PendingOrdinaryResume): Promise<void> {
  const label = `resume attempt ${pending.attemptId}`;
  const info = await readNatsInfo(label, pending.server);
  if (info.server_name !== pending.serverName)
    throw new Error(`${label} spawned listener reports a foreign NATS server name`);
}

/** Adopts a listener its resume or restore attempt has proved over the wire: records the mesh,
 *  starts delivery and completes the attempt. `storeDir` is the store that listener runs on, and
 *  `listener` names it in a degraded reason. */
export async function adoptProvenListener(
  attempt: PendingOrdinaryResume | PreparedRestore,
  storeDir: string,
  listener: string,
  heldLock?: MaintenanceLock,
  channels?: string,
): Promise<void> {
  await recreateAdoptedMemoryBuckets(attempt.root, attempt.space, attempt.server, attempt.mode, channels);
  const svc = await ensureRecoveredUserAuth(attempt);
  // Read the recorded exposure BEFORE re-recording: `recordOurMesh` writes the entry whole, so a
  // record built without this field would erase the operator's decision, and the adopted manager
  // below would then be launched loopback-only from an entry that no longer remembers otherwise.
  const attachHost = attachHostFor(attempt.space);
  const maxSessions = maxSessionsFor(attempt.space);
  const serve = serveFor(attempt.space);
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
    ...(serve ? { serve } : {}),
    ...(attempt.maxFileStore !== undefined ? { maxFileStore: attempt.maxFileStore } : {}),
    storeDir: resolve(storeDir),
    ts: new Date().toISOString(),
  }, "started");
  const controlPlane = await startDeliveryWithBroker(attempt.space, attempt.server, tlsRequired, {
    runtime: attempt.runtime,
    attachHost,
    maxSessions,
    ...(serve ? { serve } : {}),
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

export async function completeResumeActivation(
  attemptId: string | undefined,
  healthy: boolean,
  reason: string,
  server: string,
  heldLock?: MaintenanceLock,
  retireBroker?: () => void,
  waitForRestoreStop?: () => Promise<void> | undefined,
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
    await waitForRestoreStop?.();
    const ready = await askManager(cliControl, pending.space, server, "ps", undefined, auth, "any", 2_000);
    // Wait only while nothing ANSWERS (the manager is still coming up). Any answer, including a
    // refusal, ends the wait: a refusal will not heal by waiting, and the resume call right after
    // this fails loud on it with its own message.
    if (!ready.unanswered) break;
    if (Date.now() >= readinessDeadline) {
      await waitForRestoreStop?.();
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
      if (!degrade) throw e;
      await waitForRestoreStop?.();
      markPendingResumeDegraded(attemptId, e instanceof Error ? e.message : String(e), heldLock);
      throw e;
    }
  };
  await waitForRestoreStop?.();
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
  await waitForRestoreStop?.();
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
    await waitForRestoreStop?.();
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
