import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { hostname } from "node:os";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  openSync,
  statSync,
  readSync,
  closeSync,
  lstatSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  isReachable,
  DEFAULT_SERVER,
  CONTROL_ADMIN,
  createSpaceAuth,
  serverConfig,
  mintCreds,
  mintConnectionEvictorCreds,
  mintMembershipObserverCreds,
  newIdentity,
  setupSpaceStreams,
  standaloneConnectOpts,
  seedChannelRegistry,
  ensureDefaultDeliveryClass,
  mkSecretDir,
  writeSecretFile,
  type AuthPrepared,
  type SpaceAuth,
  type ChannelRegistryFile,
  type ParsedArgs,
  type FlagSpec,
  type CompletionResult,
} from "@cotal-ai/core";
import { connect } from "@nats-io/transport-node";
import {
  assertSingleSpaceBroker,
  assertUserAuthInfo,
  authDir,
  getSoleSpaceAuth,
  getSpaceAuth,
  hasUserAuthState,
  loadSoleSpaceAuth,
  putSpaceAuth,
  clearCurrent,
  findMesh,
  getCurrent,
  loadMeshes,
  MEMBERSHIP_RW_CREDS_KEY,
  recordMesh,
  removeMesh,
  setCurrent,
  userAuthStateDir,
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
  readStoreIdentity,
  recordOrdinaryResumeManagerCommit,
  releaseMaintenanceLock,
  retireOrdinaryResume,
  sameStoreIdentity,
  type JsonValue,
  type ManagerCommitEvidence,
  type ManagerFinalizeEvidence,
  type ProcessOwner,
  type RestoreListenerProof,
} from "@cotal-ai/workspace";
import { ensureAuthService, resolveAuthProvider, stopAuthService } from "../lib/auth-proc.js";
import { resolveSpace } from "../lib/status.js";
import { c } from "../ui.js";
import { resolveNatsServer } from "../lib/nats-bin.js";
import { cotalPath, cotalRoot } from "../lib/paths.js";
import { renderDetachedSummary } from "../lib/up-report.js";
import { deliveryUp, ensureControlPlane, stopDelivery } from "../lib/delivery-proc.js";
import { managerHasDeliveryMarker, managerUp, stopManager } from "../lib/manager-proc.js";
import { loadManifest, type PreparedManifest } from "../lib/manifest/index.js";
import { buildLaunchSpec, genRunId, manifestToChannels, preflightConnectors, writeLaunchSpec } from "../lib/manifest/apply.js";
import { renderUpPlan, renderInherited, renderWarnings } from "../lib/manifest/render.js";
import { failManifest } from "./topology.js";
import { extensionNames, preflightRuntime } from "../ext-loader.js";
import { completingFlagValue } from "../lib/completion.js";
import { askManager, type ControlAuth } from "../lib/control.js";
import {
  bindPreparedRestoreListener,
  isManagerCommitResult,
  isManagerFinalizeResult,
  isManagerCommittedRestore,
  markPreparedRestoreActive,
  markPreparedRestoreDegraded,
  prepareRestore,
  recordPreparedRestoreManagerCommit,
  rehydratePreparedRestore,
  replacePreparedDeadRestoreListener,
  type PreparedRestore,
  type RestoreFlags,
} from "../lib/restore.js";

const pendingRestores = new Map<string, PreparedRestore>();
interface PendingOrdinaryResume {
  root: string;
  attemptId: string;
  space: string;
  mode: "open" | "auth" | "user";
  server: string;
  storeDir: string;
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
  { name: "host", type: "string", value: "<host>", description: "bind host override" },
  { name: "space", type: "string", value: "<s>", description: "space name (default: the folder's)" },
  { name: "store-dir", type: "string", value: "<dir>", description: "JetStream store directory" },
  { name: "channels", type: "string", value: "<path>", description: "channel-registry seed file (JSON; default .cotal/channels.json)" },
  { name: "restore", type: "string", value: "<dir>", description: "restore an offline backup before exposing the normal listener" },
  { name: "restore-only", type: "string", value: "<registry>", description: "restore only the registry component" },
  { name: "accept-missing-source", type: "boolean", description: "explicit disaster consent when the inode-bound preserved source is absent" },
  { name: "open", type: "boolean", description: "unauthenticated dev mesh (no JWT/ACLs)" },
  { name: "user-auth", type: "boolean", description: "per-USER auth: login + bearer through the space's auth service" },
  { name: "idp", type: "string", value: "<url>", description: "with --user-auth: the IdP auth base URL to pin (first enable)" },
  { name: "detach", type: "boolean", description: "run in the background (stop with `cotal down`)" },
  { name: "runtime", type: "string", value: "<name>", description: "agent runtime for the mesh manager (default pty; extension runtimes are explicit-only, see `cotal runtimes`); with -f overrides the manifest's runtime" },
  { name: "file", type: "string", short: "f", value: "<cotal.yaml>", description: "launch a whole mesh from a manifest" },
  { name: "dry-run", type: "boolean", description: "with -f: print the plan, mutate nothing" },
];

/** Completion for `cotal up` — `--runtime <TAB>` offers `pty` + installed runtime providers (the same
 *  offline source `spawn` uses; a <TAB> never imports or probes). Run `cotal runtimes` to also see the
 *  official ones that aren't installed yet. Any other position falls back to the command's flags, the
 *  same set the dispatcher offers for a command with no hook — the hook only ADDS runtime values. */
export function upComplete(argv: string[]): CompletionResult {
  const flag = completingFlagValue(argv, upFlags);
  if (flag?.name === "runtime")
    return { items: ["pty", ...extensionNames("runtime")].filter((v, i, a) => a.indexOf(v) === i).map((value) => ({ value })), directive: "nofiles" };
  if (flag?.name === "restore-only")
    return { items: [{ value: "registry" }], directive: "nofiles" };
  if (flag?.name === "restore") return { items: [], directive: "default" };
  const items = upFlags.map((f) => ({ value: `--${f.name}`, description: f.description }));
  return { items, directive: items.length ? "nofiles" : "default" };
}

export async function up(args: ParsedArgs): Promise<void> {
  const values = args.values as {
    server?: string; "store-dir"?: string; space?: string; open?: boolean; "user-auth"?: boolean; idp?: string;
    channels?: string; detach?: boolean; host?: string; runtime?: string; file?: string; "dry-run"?: boolean;
    restore?: string; "restore-only"?: string; "accept-missing-source"?: boolean;
    __restoreAttempt?: string;
    __ordinaryResumeAttempt?: string;
  };
  if (values.restore) {
    if (values.file || values.channels)
      throw new Error("--restore cannot be combined with --file/-f or --channels");
    // A restore rewrites the shared store and the trust root under it, from an artifact that names
    // one space (see `cotal backup`) - it cannot leave the root's other tenants standing.
    assertSingleSpaceBroker(authDir(cotalRoot()), "cotal up --restore");
    const prepared = await prepareRestore(cotalRoot(), values as RestoreFlags);
    pendingRestores.set(prepared.attemptId, prepared);
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
      markPreparedRestoreDegraded(prepared.root, prepared.attemptId, (error as Error).message);
      throw error;
    }
    return;
  }
  if (values["restore-only"] || values["accept-missing-source"])
    throw new Error("--restore-only and --accept-missing-source require --restore <dir>");
  if (!values.__restoreAttempt && !values.__ordinaryResumeAttempt && !values.file) {
    const root = cotalRoot();
    const lock = acquireMaintenanceLock(root);
    let pending: PendingOrdinaryResume | undefined;
    let recoveredRestore: PreparedRestore | undefined;
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
      if (journal && (journal.state === "commit-intent" || journal.state === "manager-committed" || journal.state === "degraded")) {
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
        const launch = resume.launch as { server?: unknown; storeDir?: unknown };
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
        if (values.runtime && runtimes[0] && values.runtime !== runtimes[0])
          throw new Error(`--runtime ${values.runtime} contradicts the preserved agent runtime ${runtimes[0]}; omit it to resume the same principals`);
        const resumeRuntime = values.runtime ?? runtimes[0] ?? "pty";
        const serverNonce = randomUUID().replaceAll("-", "");
        const serverName = `${attemptId}-${serverNonce}`;
        beginOrdinaryResume(lock, {
          attemptId,
          launch: {
            server: resumeServer,
            storeDir: resumeStore,
            runtime: resumeRuntime,
            detached: Boolean(values.detach),
            serverName,
            serverNonce,
          },
        });
        pending = {
          root,
          attemptId,
          space: journal.space,
          mode: journal.mode,
          server: resumeServer,
          storeDir: resumeStore,
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
          server?: unknown; storeDir?: unknown; runtime?: unknown; detached?: unknown;
          serverName?: unknown; serverNonce?: unknown;
        };
        const attemptId = journal.ordinaryResume.attemptId;
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
    } finally {
      releaseMaintenanceLock(lock);
    }
    if (recoveredRestore) {
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
            open: recoveredRestore.mode === "open",
            "user-auth": recoveredRestore.mode === "user",
          },
        });
      } catch (error) {
        markPendingResumeDegraded(recoveredRestore.attemptId, error instanceof Error ? error.message : String(error));
        throw error;
      }
      return;
    }
    if (pending) {
      try {
        await up({
          ...args,
          values: {
            ...values,
            __ordinaryResumeAttempt: pending.attemptId,
            space: pending.space,
            server: pending.server,
            "store-dir": pending.storeDir,
            runtime: pending.runtime,
            detach: pending.detached,
            open: pending.mode === "open",
            "user-auth": pending.mode === "user",
          },
        });
      } catch (error) {
        markPendingResumeDegraded(pending.attemptId, error instanceof Error ? error.message : String(error));
        throw error;
      }
      return;
    }
  }
  const wantUser = Boolean(values["user-auth"]);
  // The auth-mode flags contradict each other loudly, never silently (a user-auth space quietly
  // started open would run agents on the wrong identity plane — the exact failure per-user-auth
  // exists to prevent).
  if (wantUser && values.open) {
    throw new Error("--user-auth and --open contradict - a user-auth space cannot run unauthenticated");
  }
  if (values.idp && !wantUser && !values.file) {
    throw new Error('--idp is for user-auth spaces; pair it with --user-auth, or set broker.auth: "user" in a manifest');
  }
  // `up -f cotal.yaml` is a distinct path: bring up a FRESH mesh described by a manifest (broker +
  // channels + booted agents). It owns the whole space; deploying onto a RUNNING mesh is `spawn -f`.
  // CLI flags override the manifest (flag > manifest > default) so the same file runs at a different
  // port / runtime / space / auth without editing it.
  if (values.file) {
    if (values["dry-run"]) {
      await upManifest(values.file, {
        dryRun: true,
        server: values.server,
        host: values.host,
        space: values.space,
        runtime: values.runtime,
        open: values.open,
        userAuth: wantUser,
        idp: values.idp,
      });
      return;
    }
    const lock = acquireMaintenanceLock(cotalRoot());
    try {
      assertOrdinaryUpAllowed(cotalRoot());
      await upManifest(values.file, {
        dryRun: Boolean(values["dry-run"]),
        server: values.server,
        host: values.host,
        space: values.space,
        runtime: values.runtime,
        open: values.open,
        userAuth: wantUser,
        idp: values.idp,
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
  let startupLock = resumeAttempt ? undefined : acquireMaintenanceLock(cotalRoot());
  const releaseStartupLock = () => {
    if (!startupLock) return;
    releaseMaintenanceLock(startupLock);
    startupLock = undefined;
  };
  try {
    if (startupLock) assertOrdinaryUpAllowed(cotalRoot(), values["store-dir"] ? resolve(values["store-dir"]) : cotalPath("nats"));
    let server = values.server ?? DEFAULT_SERVER;
    const host = values.host ?? "127.0.0.1";
    const restoredAttempt = resumeAttempt ? pendingRestores.get(resumeAttempt) : undefined;
    if (restoredAttempt?.reentry) {
      if (!restoredAttempt.listenerProof)
        throw new Error(`restore attempt ${resumeAttempt} re-entry has no bound listener proof; preserving recovery state`);
      const ownerStatus = localProcessOwnerStatus(restoredAttempt.listenerProof.processOwner);
      if (ownerStatus === "alive") {
        await resumeProvenRestoreListener(restoredAttempt);
        return;
      }
      if (ownerStatus === "unknown")
        throw new Error(`restore attempt ${resumeAttempt} listener ownership is ambiguous; refusing replacement`);
      if (restoredAttempt.managerCommit)
        throw new Error(`restore attempt ${resumeAttempt} is manager-committed but its bound listener is dead; preserving the commit token and retained suppression`);
      if (await isReachable(restoredAttempt.server))
        throw new Error(`restore attempt ${resumeAttempt} refuses the occupied foreign listener at ${restoredAttempt.server}`);
      replacePreparedDeadRestoreListener(restoredAttempt);
    }
    const ordinaryAttempt = resumeAttempt ? pendingOrdinaryResumes.get(resumeAttempt) : undefined;
    if (ordinaryAttempt?.adoptProof) {
      // The recovered attempt's exact bound listener is alive: prove it over the wire and adopt it
      // instead of spawning a competitor over the same store.
      await resumeProvenOrdinaryListener(ordinaryAttempt);
      return;
    }
    if (ordinaryAttempt?.journalState === "resume-committed")
      throw new Error(`resume attempt ${resumeAttempt} is manager-committed but has no adoptable bound listener; preserving the commit token and retained suppression`);
    const listenerReachable = await isReachable(server);
    if (resumeAttempt && listenerReachable)
      throw new Error(`resume attempt ${resumeAttempt} refuses the unproven occupied listener at ${server}`);
    if (listenerReachable) {
    const space = values.space ?? resolveSpace(process.cwd());
    const root = cotalRoot();
    // A broker is already on this port. Same root means "this project is already up" unless the
    // operator explicitly asked for a second space in the same `.cotal/` root (unsupported today: pid,
    // auth, and logs are root-scoped). Different root / unrecorded broker on the implicit default port
    // gets a fresh free port instead of making the user hunt for one.
    const held = loadMeshes().find((m) => m.server === server);
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
      console.log(c.green(`✓ mesh "${held.space}" already running at ${server}`));
      // USER MODE: re-upping IS the documented recovery for a dead auth service (the provider's
      // failure copy says "restart it with `cotal up`"), so a refresh must re-ensure the service —
      // never just reprint "already running" over a dead callout. No broker config is (re)written
      // here, so healing on a bare `cotal up` is safe: the mode can't drift, only the daemon heals.
      let userAuth = held.userAuth;
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
        const svc = await startUserAuthService(held.space, server, { prepared, stateDir });
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
        if (values.runtime && managerUp() && managerHasDeliveryMarker())
          console.error(
            c.dim(`! manager already running for "${held.space}" - its runtime is fixed at start; \`cotal down\` then \`cotal up --runtime ${values.runtime}\` to change it`),
          );
        const controlPlane = await startDeliveryWithBroker(held.space, server, { runtime: values.runtime });
        if (!controlPlane) process.exitCode = 1;
      }
      recordOurMesh({ space: held.space, server, root, mode: held.mode, ...(userAuth ? { userAuth } : {}), ts: new Date().toISOString() });
      return;
    }
    const who = held ? `mesh "${held.space}" (${held.root})` : "a broker not started here";
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

  if (values.detach) {
    const restored = resumeAttempt ? pendingRestores.get(resumeAttempt) : undefined;
    const { pid, source, authService, controlPlane, delivery, manager } = await startMeshDetached({
      server,
      storeDir: values["store-dir"],
      space: values.space,
      open: values.open,
      userAuth: wantUser ? { idpUrl: values.idp } : undefined,
      channels: values.channels,
      host,
      runtime: values.runtime,
      resumeAttempt,
      resumeCommitToken: restored?.managerCommit?.durableCommitToken ?? ordinaryAttempt?.managerCommit?.durableCommitToken,
      ...(restored ? {
        boundListener: {
          serverName: restored.serverName,
          serverNonce: restored.serverNonce,
          onSpawn: (pid: number, startedAt: string) => bindSpawnedRestoreListener(restored, pid, startedAt),
          verify: async () => { await provePreparedRestoreListener(restored); },
        },
      } : ordinaryAttempt ? {
        boundListener: {
          serverName: ordinaryAttempt.serverName,
          serverNonce: ordinaryAttempt.serverNonce,
          onSpawn: (pid: number, startedAt: string) => bindSpawnedOrdinaryResumeListener(ordinaryAttempt, pid, startedAt),
          verify: async () => { await verifySpawnedOrdinaryListener(ordinaryAttempt); },
        },
      } : {}),
      skipPostStart: Boolean(resumeAttempt),
    });
    console.log(c.dim(`Started nats-server (${source}).`));
    console.log(c.green(renderDetachedSummary({ pid, delivery, authService: wantUser && authService, manager })));
    if (restored && process.env.COTAL_SMOKE_FAIL_AFTER_RESTORE_LISTENER_READY === "1")
      throw new Error("smoke-injected failure after restore listener readiness");
    // A user mesh whose auth service never became ready is recorded + running (a re-`cotal up`
    // heals it), but this `up` did NOT deliver what was asked — automation must see that in the
    // exit code, not only in the red line above.
    if (!authService) process.exitCode = 1;
    await completeResumeActivation(
      resumeAttempt,
      controlPlane && authService,
      !authService ? "normal listener started but the user-auth service is unavailable" : "normal listener started but the control plane is degraded",
      server,
    );
    return;
  }

  const useAuth = !values.open;
  const space = values.space ?? resolveSpace(process.cwd());
  ensureRootForSpace(useAuth, space); // may pin the cwd as this space's root — before any cotalPath use
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
  mkdirSync(storeDir, { recursive: true });
  await claimSpace(space, server, cotalRoot());
  const seedFile = loadChannelsFile(values.channels);
  const setup = useAuth ? await authSetup(storeDir, server, space, host, wantUser ? { idpUrl: values.idp } : undefined) : undefined;
  const port = Number(new URL(server).port) || 4222;
  const restored = resumeAttempt ? pendingRestores.get(resumeAttempt) : undefined;
  const natsArgs = [
    ...(setup ? ["-c", setup.confPath] : ["-js", "-sd", storeDir, "-p", String(port), "-a", host]),
    ...(restored ? ["--name", restored.serverName]
      : ordinaryAttempt ? ["--name", ordinaryAttempt.serverName]
      : []),
  ];
  const { bin, source } = await resolveNatsServer();

  console.log(
    c.dim(
      `Starting nats-server (JetStream, ${useAuth ? "JWT auth" : "OPEN/no-auth"}, ${source}) - store: ${storeDir}, bind: ${host}`,
    ),
  );
  console.log(c.dim("Press Ctrl-C to stop.\n"));
  const listenerStartedAt = new Date().toISOString();
  const child = spawn(bin, natsArgs, { stdio: "inherit" });
  let activationFinished = !resumeAttempt;
  if (child.pid) writeFileSync(cotalPath("nats.pid"), String(child.pid));
  if (restored && process.env.COTAL_SMOKE_EXIT_AFTER_RESTORE_LISTENER_SPAWN === "1") process.exit(87);
  if (restored) try {
    bindSpawnedRestoreListener(restored, child.pid ?? 0, listenerStartedAt);
  } catch (error) {
    await stopUnboundRestoreListener(child);
    removeMatchingNatsPid(child.pid ?? 0);
    throw error;
  }
  if (ordinaryAttempt) try {
    bindSpawnedOrdinaryResumeListener(ordinaryAttempt, child.pid ?? 0, listenerStartedAt);
  } catch (error) {
    await stopUnboundRestoreListener(child);
    removeMatchingNatsPid(child.pid ?? 0);
    throw error;
  }
  releaseStartupLock();
  child.on("error", (err) => {
    console.error(c.red(`Failed to start nats-server: ${err.message}`));
    if (!resumeAttempt) process.exit(1);
  });
  // The control plane is coupled to the broker: stop the delivery daemon AND the detached manager
  // (AND the space's user-auth service) when this `up` stops (Ctrl-C), so none outlives the broker
  // it serves — a surviving manager would reconnect-loop invisibly against the dead (or the NEXT)
  // broker (the documented orphan-supervisor failure mode). All kill by pidfile, symmetric; the
  // auth service's pid is space-scoped so no other space's daemon can ever be hit.
  // stopDelivery is async (its creds delete goes through the secret store); the rest of the teardown
  // must run even if it fails — the failure is logged, never swallowed silently, and the daemon kill
  // itself happens inside stopDelivery's finally. Order preserved: delivery, manager, auth, broker.
  const stop = () => {
    void stopDelivery()
      .catch((e: Error) => console.error(`! delivery teardown: ${e.message}`))
      .then(() => {
        stopManager();
        stopAuthService(space);
        child.kill("SIGTERM");
      });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // The broker is gone — drop it from the registry (and the `current` pointer if it was the default)
  // so a later `cotal spawn` doesn't try to join a dead mesh.
  child.on("exit", async (code) => {
    rmSync(cotalPath("nats.pid"), { force: true });
    // Logged, never silently swallowed; the daemon kill runs in stopDelivery's finally regardless.
    await stopDelivery().catch((e: Error) => console.error(`! delivery teardown: ${e.message}`));
    stopManager();
    stopAuthService(space);
    // Only unrecord if the registry still points at THIS broker. A newer broker for the same space
    // (a concurrent `up`, or a different-port re-up that recorded after us) may have replaced our
    // record — removing by name would clobber the live winner and hide it from the registry.
    const mine = findMesh(space);
    if (mine && mine.server === server && mine.root === cotalRoot()) {
      removeMesh(space);
      if (getCurrent() === space) clearCurrent();
    }
    if (activationFinished) process.exit(code ?? 0);
  });

  const ready = await waitReady(server, setup?.creds);
  if (!ready) {
    child.kill("SIGTERM");
    const reason = `nats-server did not become ready at ${server}`;
    markPendingResumeDegraded(resumeAttempt ?? "", reason);
    throw new Error(reason);
  }
  if (restored) await provePreparedRestoreListener(restored);
  {
    if (!resumeAttempt) await postStart(server, space, setup, seedFile);
    // USER MODE: the auth service comes up FIRST among the daemons — until its callout answers,
    // every user-mode connect to this broker is denied, so `up` must not report a usable user mesh
    // (nor let agents race it) on a half-started auth plane. (Foreground `up` doesn't exit here, so
    // `ok` has no exit code to carry — the red consequence line above is the operator signal.)
    const svc = await startUserAuthService(space, server, setup);
    // Record BEFORE the control plane comes up: the manager's fail-closed mode detection requires
    // an authoritative registry entry (marker-without-registry is a refused start, not a guess),
    // so the record must exist by the time it boots. A manager/delivery failure after this leaves
    // a recorded-but-degraded mesh — the documented, healable posture.
    recordOurMesh({
      space, server, root: cotalRoot(),
      mode: setup?.prepared ? "user" : useAuth ? "auth" : "open",
      ...(svc.userAuth ? { userAuth: svc.userAuth } : {}),
      ts: new Date().toISOString(),
    });
    // Bring up the delivery daemon WITH the server (auth mode only — it self-gates on `.cotal/auth`).
    // It is part of the server, so `cotal up` starts it by default; open dev mode has no daemon.
    // Class-2 credential renewal is NOT wired here: the MANAGER is the renewal owner (it is resident
    // in every mesh mode — foreground, --detach, refresh — where this foreground process is not).
    const controlPlane = await startDeliveryWithBroker(space, server, {
      runtime: values.runtime,
      resumeAttempt,
      resumeCommitToken: restored?.managerCommit?.durableCommitToken ?? ordinaryAttempt?.managerCommit?.durableCommitToken,
    });
    if (restored && process.env.COTAL_SMOKE_FAIL_AFTER_RESTORE_LISTENER_READY === "1")
      throw new Error("smoke-injected failure after restore listener readiness");
    await completeResumeActivation(
      resumeAttempt,
      controlPlane && svc.ok,
      !svc.ok ? "normal listener started but the user-auth service is unavailable" : "normal listener started but the control plane is degraded",
      server,
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

function markPendingResumeDegraded(attemptId: string, reason: string): void {
  const ordinary = pendingOrdinaryResumes.get(attemptId);
  if (ordinary) {
    const lock = acquireMaintenanceLock(ordinary.root);
    try {
      const journal = readMaintenanceJournal(ordinary.root);
      if (journal && (journal.state === "resume-intent" || journal.state === "resume-active"))
        markOrdinaryResumeDegraded(lock, reason, [{
          action: "repair",
          description: "Preserve the store and retained resume inventory; repair forward, then retry the same-principal activation.",
          paths: [journal.source.path],
        }]);
    } finally {
      releaseMaintenanceLock(lock);
    }
    return;
  }
  const restored = pendingRestores.get(attemptId);
  if (restored) markPreparedRestoreDegraded(restored.root, restored.attemptId, reason);
}

async function resumeControlAuth(root: string, mode: "open" | "auth" | "user"): Promise<ControlAuth> {
  if (mode === "open") return {};
  const auth = await getSoleSpaceAuth(workspaceSecretStore(root), authDir(root));
  if (!auth) throw new Error("same-principal resume requires the existing space trust material");
  const identity = newIdentity();
  return {
    creds: await mintCreds(auth, identity, "control-caller-admin", {
      expiresAt: Math.floor((Date.now() + 30 * 60 * 1000) / 1000),
    }),
  };
}

function restoreListenerOwner(pid: number, nonce: string, startedAt: string): ProcessOwner {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("restore listener spawn returned no pid");
  return { pid, host: hostname(), startedAt, id: `restore-listener-${nonce}` };
}

function removeMatchingNatsPid(pid: number): void {
  const path = cotalPath("nats.pid");
  try {
    const stat = lstatSync(path);
    if (stat.isFile() && !stat.isSymbolicLink() && readFileSync(path, "utf8") === String(pid))
      rmSync(path);
  } catch { /* absent, changed, or not owned by this spawn */ }
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

async function stopUnboundRestoreListener(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForChildExit(child, 5_000)) return;
  child.kill("SIGKILL");
  if (!await waitForChildExit(child, 5_000))
    throw new Error(`unbound restore listener process ${child.pid ?? "unknown"} did not exit`);
}

function bindSpawnedRestoreListener(prepared: PreparedRestore, pid: number, startedAt: string): void {
  bindRestoreListenerOwner(prepared, restoreListenerOwner(pid, prepared.serverNonce, startedAt));
}

function bindRestoreListenerOwner(prepared: PreparedRestore, processOwner: ProcessOwner): void {
  bindPreparedRestoreListener(prepared, processOwner);
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

async function provePreparedRestoreListener(prepared: PreparedRestore): Promise<RestoreListenerProof> {
  const proof = prepared.listenerProof;
  if (!proof) throw new Error(`restore attempt ${prepared.attemptId} has no bound listener proof`);
  if (proof.attemptId !== prepared.attemptId || proof.serverName !== prepared.serverName ||
      proof.serverNonce !== prepared.serverNonce || proof.serverEndpoint !== prepared.server ||
      proof.serverName !== `${proof.attemptId}-${proof.serverNonce}` || !/^[0-9a-f]{32}$/.test(proof.serverNonce) ||
      proof.processOwner.id !== `restore-listener-${proof.serverNonce}`)
    throw new Error(`restore attempt ${prepared.attemptId} listener proof does not match its launch record`);
  const journal = readMaintenanceJournal(prepared.root);
  if (!journal || (journal.state !== "commit-intent" && journal.state !== "manager-committed" && journal.state !== "degraded" && journal.state !== "active") ||
      journal.restore.attemptId !== prepared.attemptId || !journal.listenerProof ||
      !sameRestoreListenerProof(journal.listenerProof, proof) || journal.launch.server !== proof.serverEndpoint)
    throw new Error(`restore attempt ${prepared.attemptId} listener proof does not exactly match durable recovery state`);
  if (proof.processOwner.host !== hostname())
    throw new Error(`restore attempt ${prepared.attemptId} listener process ownership is not live and local`);
  try {
    process.kill(proof.processOwner.pid, 0);
  } catch {
    throw new Error(`restore attempt ${prepared.attemptId} listener process ownership is not live and local`);
  }
  const pidPath = join(prepared.root, ".cotal", "nats.pid");
  let exactPidFile = false;
  try {
    const stat = lstatSync(pidPath);
    exactPidFile = stat.isFile() && !stat.isSymbolicLink() &&
      readFileSync(pidPath, "utf8") === String(proof.processOwner.pid);
  } catch { /* absent or unprovable */ }
  if (!exactPidFile)
    throw new Error(`restore attempt ${prepared.attemptId} listener pidfile does not match its process proof`);
  const target = readStoreIdentity(prepared.targetPath);
  if (!sameStoreIdentity(target, proof.target) || !sameStoreIdentity(journal.restore.target, proof.target))
    throw new Error(`restore attempt ${prepared.attemptId} target identity changed`);
  const mesh = findMesh(prepared.space);
  if (mesh && (mesh.server !== prepared.server || mesh.root !== prepared.root || mesh.mode !== prepared.mode))
    throw new Error(`restore attempt ${prepared.attemptId} conflicts with the recorded mesh identity`);

  const info = await readNatsInfo(proof.serverEndpoint);
  if (info.server_name !== proof.serverName)
    throw new Error(`restore attempt ${prepared.attemptId} reached a foreign NATS server name/nonce`);

  const auth = await resumeControlAuth(prepared.root, prepared.mode);
  const nc = await connect({
    servers: prepared.server,
    ...standaloneConnectOpts(auth),
    maxReconnectAttempts: 0,
  });
  try {
    if (nc.info?.server_name !== proof.serverName)
      throw new Error(`restore attempt ${prepared.attemptId} authenticated to a foreign NATS server name/nonce`);
    if (!nc.info.jetstream) throw new Error(`restore attempt ${prepared.attemptId} listener has no JetStream`);
  } finally {
    await nc.drain().catch(() => {});
  }
  return proof;
}

function bindSpawnedOrdinaryResumeListener(pending: PendingOrdinaryResume, pid: number, startedAt: string): void {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("resume listener spawn returned no pid");
  const lock = acquireMaintenanceLock(pending.root);
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
    releaseMaintenanceLock(lock);
  }
}

/** Prove the recovered attempt's live bound listener IS ours end-to-end before adoption: launch
 *  binding, durable journal match, local pid + exact pidfile, source identity, mesh identity, the
 *  raw NATS INFO server name, and an authenticated connect confirming name + JetStream. */
async function proveOrdinaryResumeListener(pending: PendingOrdinaryResume): Promise<RestoreListenerProof> {
  const proof = pending.adoptProof;
  if (!proof) throw new Error(`resume attempt ${pending.attemptId} has no bound listener proof`);
  if (proof.attemptId !== pending.attemptId || proof.serverName !== pending.serverName ||
      proof.serverNonce !== pending.serverNonce || proof.serverEndpoint !== pending.server ||
      proof.serverName !== `${proof.attemptId}-${proof.serverNonce}` || !/^[0-9a-f]{32}$/.test(proof.serverNonce) ||
      proof.processOwner.id !== `resume-listener-${proof.serverNonce}`)
    throw new Error(`resume attempt ${pending.attemptId} listener proof does not match its launch record`);
  const journal = readMaintenanceJournal(pending.root);
  if (!journal || !("ordinaryResume" in journal) || journal.ordinaryResume.attemptId !== pending.attemptId ||
      !journal.listenerProof || !sameRestoreListenerProof(journal.listenerProof, proof) ||
      journal.ordinaryResume.launch.server !== proof.serverEndpoint)
    throw new Error(`resume attempt ${pending.attemptId} listener proof does not exactly match durable recovery state`);
  if (proof.processOwner.host !== hostname())
    throw new Error(`resume attempt ${pending.attemptId} listener process ownership is not live and local`);
  try {
    process.kill(proof.processOwner.pid, 0);
  } catch {
    throw new Error(`resume attempt ${pending.attemptId} listener process ownership is not live and local`);
  }
  const pidPath = join(pending.root, ".cotal", "nats.pid");
  let exactPidFile = false;
  try {
    const stat = lstatSync(pidPath);
    exactPidFile = stat.isFile() && !stat.isSymbolicLink() &&
      readFileSync(pidPath, "utf8") === String(proof.processOwner.pid);
  } catch { /* absent or unprovable */ }
  if (!exactPidFile)
    throw new Error(`resume attempt ${pending.attemptId} listener pidfile does not match its process proof`);
  const source = readStoreIdentity(pending.storeDir);
  if (!sameStoreIdentity(source, proof.target) || !sameStoreIdentity(journal.source, proof.target))
    throw new Error(`resume attempt ${pending.attemptId} preserved source identity changed`);
  const mesh = findMesh(pending.space);
  if (mesh && (mesh.server !== pending.server || mesh.root !== pending.root || mesh.mode !== pending.mode))
    throw new Error(`resume attempt ${pending.attemptId} conflicts with the recorded mesh identity`);

  const info = await readNatsInfo(proof.serverEndpoint);
  if (info.server_name !== proof.serverName)
    throw new Error(`resume attempt ${pending.attemptId} reached a foreign NATS server name/nonce`);

  const auth = await resumeControlAuth(pending.root, pending.mode);
  const nc = await connect({
    servers: pending.server,
    ...standaloneConnectOpts(auth),
    maxReconnectAttempts: 0,
  });
  try {
    if (nc.info?.server_name !== proof.serverName)
      throw new Error(`resume attempt ${pending.attemptId} authenticated to a foreign NATS server name/nonce`);
    if (!nc.info.jetstream) throw new Error(`resume attempt ${pending.attemptId} listener has no JetStream`);
  } finally {
    await nc.drain().catch(() => {});
  }
  return proof;
}

/** Light wire check for a freshly SPAWNED ordinary-resume listener: the greeted server must carry
 *  the attempt's exact name/nonce (the full seven-point prove is for adopting a survivor). */
async function verifySpawnedOrdinaryListener(pending: PendingOrdinaryResume): Promise<void> {
  const info = await readNatsInfo(pending.server);
  if (info.server_name !== pending.serverName)
    throw new Error(`resume attempt ${pending.attemptId} spawned listener reports a foreign NATS server name`);
}

async function resumeProvenOrdinaryListener(pending: PendingOrdinaryResume): Promise<void> {
  await proveOrdinaryResumeListener(pending);
  const svc = await ensureRecoveredUserAuth(pending);
  recordOurMesh({
    space: pending.space,
    server: pending.server,
    root: pending.root,
    mode: pending.mode,
    ...(svc.userAuth ? { userAuth: svc.userAuth } : {}),
    ts: new Date().toISOString(),
  });
  const controlPlane = await startDeliveryWithBroker(pending.space, pending.server, {
    runtime: pending.runtime,
    resumeAttempt: pending.attemptId,
    resumeCommitToken: pending.managerCommit?.durableCommitToken,
  });
  await completeResumeActivation(
    pending.attemptId,
    controlPlane && svc.ok,
    !svc.ok ? "adopted resume listener has no user-auth service" : "adopted resume listener has a degraded control plane",
    pending.server,
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

async function resumeProvenRestoreListener(prepared: PreparedRestore): Promise<void> {
  await provePreparedRestoreListener(prepared);
  const svc = await ensureRecoveredUserAuth(prepared);
  recordOurMesh({
    space: prepared.space,
    server: prepared.server,
    root: prepared.root,
    mode: prepared.mode,
    ...(svc.userAuth ? { userAuth: svc.userAuth } : {}),
    ts: new Date().toISOString(),
  });
  const controlPlane = await startDeliveryWithBroker(prepared.space, prepared.server, {
    runtime: prepared.runtime,
    resumeAttempt: prepared.attemptId,
    resumeCommitToken: prepared.managerCommit?.durableCommitToken,
  });
  await completeResumeActivation(
    prepared.attemptId,
    controlPlane && svc.ok,
    !svc.ok ? "proven restore listener has no user-auth service" : "proven restore listener has a degraded control plane",
    prepared.server,
  );
}

async function completeResumeActivation(
  attemptId: string | undefined,
  healthy: boolean,
  reason: string,
  server: string,
): Promise<void> {
  if (!attemptId) return;
  const ordinary = pendingOrdinaryResumes.get(attemptId);
  const restored = pendingRestores.get(attemptId);
  const pending = ordinary ?? restored;
  if (!pending) throw new Error(`resume activation lost attempt context ${attemptId}`);
  if (!healthy) {
    markPendingResumeDegraded(attemptId, reason);
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
      const lock = acquireMaintenanceLock(ordinary!.root);
      try { consumeRetiredMaintenance(lock); }
      finally { releaseMaintenanceLock(lock); }
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
    const ready = await askManager(pending.space, server, "ps", undefined, auth, CONTROL_ADMIN, 2_000);
    if (!ready.error?.startsWith("no manager reachable")) break;
    if (Date.now() >= readinessDeadline) {
      markPendingResumeDegraded(attemptId, ready.error);
      throw new Error(ready.error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
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
    auth,
    CONTROL_ADMIN,
    10 * 60 * 1000,
  );
  if (!resumed.ok) {
    const detail = resumed.data ? ` (${JSON.stringify(resumed.data)})` : "";
    const message = `${resumed.error ?? "retained-agent resume failed"}${detail}`;
    markPendingResumeDegraded(attemptId, message);
    throw new Error(message);
  }
  if (restored && process.env.COTAL_SMOKE_EXIT_AFTER_RESUME_PRESERVED === "1") process.exit(88);
  if (ordinary && !managerCommit) {
    const lock = acquireMaintenanceLock(ordinary.root);
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
      releaseMaintenanceLock(lock);
    }
  }
  if (!managerCommit) {
    const committed = await askManager(
      pending.space,
      server,
      "commitResume",
      { attemptId },
      auth,
      CONTROL_ADMIN,
      40_000,
    );
    if (!committed.ok) {
      const message = committed.error ?? "manager resume commit failed";
      markPendingResumeDegraded(attemptId, message);
      throw new Error(message);
    }
    if (!isManagerCommitResult(committed.data, attemptId)) {
      const message = `manager resume commit returned invalid awaiting-finalize evidence for attempt ${attemptId}`;
      markPendingResumeDegraded(attemptId, message);
      throw new Error(message);
    }
    managerCommit = committed.data;
    if (ordinary) {
      const lock = acquireMaintenanceLock(ordinary.root);
      try {
        recordOrdinaryResumeManagerCommit(lock, managerCommit);
        ordinary.journalState = "resume-committed";
        ordinary.managerCommit = managerCommit;
      } finally {
        releaseMaintenanceLock(lock);
      }
    } else {
      recordPreparedRestoreManagerCommit(restored!, managerCommit);
    }
    if (process.env.COTAL_SMOKE_EXIT_AFTER_RESUME_COMMIT === "1") process.exit(89);
  } else {
    const recommitted = await askManager(
      pending.space,
      server,
      "commitResume",
      { attemptId },
      auth,
      CONTROL_ADMIN,
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
    auth,
    CONTROL_ADMIN,
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
    const lock = acquireMaintenanceLock(ordinary.root);
    try {
      retireOrdinaryResume(lock, finalizeEvidence);
      consumeRetiredMaintenance(lock);
    } finally {
      releaseMaintenanceLock(lock);
    }
    pendingOrdinaryResumes.delete(attemptId);
  } else {
    restored!.managerCommit = managerCommit;
    markPreparedRestoreActive(restored!, finalizeEvidence);
    restored!.cleanupStage();
    pendingRestores.delete(attemptId);
  }
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
): Promise<{ userAuth?: UserAuthInfo; ok: boolean }> {
  if (!setup?.prepared || !setup.stateDir) return { ok: true };
  try {
    const endpoints = await ensureAuthService({ space, server, stateDir: setup.stateDir, prepared: setup.prepared });
    const info = assertUserAuthInfo({ ...setup.prepared.publicAuth, endpoints });
    console.log(c.green("✓ user-auth service up") + c.dim(` - sign in with: cotal login --idp ${info.idp.url}`));
    return { userAuth: info, ok: true };
  } catch (e) {
    console.error(c.red(`✗ user-auth service did not come up (${(e as Error).message}) - user connects to "${space}" will fail until a re-\`cotal up\` succeeds`));
    return { userAuth: assertUserAuthInfo(setup.prepared.publicAuth), ok: false };
  }
}

/** `cotal up -f cotal.yaml` — bring up a FRESH mesh from a manifest (broker + channels + booted
 *  agents). `up -f` is a broker-CREATION command: `broker.servers` is the bind address for the NEW
 *  local broker, never a connect target. A broker already reachable there (local OR remote) means
 *  "deploy onto it" — refuse and redirect to `spawn -f`; an unbindable/remote address makes the
 *  broker fail to start (no silent local fallback). It owns the whole space, so `cotal down` tears it
 *  down and no ownership ledger is needed (that's `spawn -f`). */
async function upManifest(file: string, opts: UpManifestFlags): Promise<void> {
  let prepared: PreparedManifest;
  try {
    prepared = loadManifest(resolve(file));
  } catch (e) {
    failManifest(e);
  }
  // The auth-mode sources (flags vs manifest) must AGREE — any mismatch names both sources and the
  // exact correction in one sentence (a no-fallback identity decision, never a bare enum error).
  const declared = prepared.manifest.broker?.auth;
  const declaredStr = declared === undefined ? '"static" (the unset default)' : JSON.stringify(declared);
  if (opts.open && declared === "user") {
    console.error(c.red('✗ --open contradicts this manifest\'s broker.auth: "user" - a user-auth space cannot run unauthenticated. Drop --open, or change the manifest.'));
    process.exit(1);
  }
  if (opts.userAuth && declared !== "user") {
    console.error(c.red(`✗ --user-auth requires manifest broker.auth: "user" (this manifest's broker.auth is ${declaredStr}). Either set broker.auth: "user" in the manifest, or drop --user-auth.`));
    process.exit(1);
  }
  if (opts.idp && declared !== "user") {
    console.error(c.red(`✗ --idp is for user-auth spaces (this manifest's broker.auth is ${declaredStr}) - set broker.auth: "user" in the manifest, or drop --idp.`));
    process.exit(1);
  }
  // Apply CLI overrides to one effective manifest (flag > manifest > default) so render + seed +
  // broker + launch all agree on the same values.
  const eff = applyUpOverrides(prepared, opts);
  const m = eff.manifest;
  const server = m.broker?.servers ?? DEFAULT_SERVER;
  const host = m.broker?.host ?? "127.0.0.1";
  const open = m.broker?.auth === false; // default is auth
  const userAuth = m.broker?.auth === "user" ? { idpUrl: opts.idp ?? m.broker?.idp } : undefined; // flag > manifest
  const runtime = m.runtime ?? "pty";

  if (opts.dryRun) {
    console.log(renderUpPlan(eff, server));
    return;
  }

  // Preflight an extension runtime before starting the broker. The detached manager re-execs this
  // CLI and resolves the same installed package when `supervise --runtime <name>` starts.
  await preflightRuntime(runtime);

  // up -f never adopts a running broker. Reachable at the bind address ⇒ redirect to spawn -f.
  if (await isReachable(server)) {
    console.error(c.red(`✗ ${server} already has a broker - deploy this manifest onto it with \`cotal spawn -f ${file}\``));
    process.exit(1);
  }
  // Connectors + their required binaries must exist before any mutation (no fallback).
  const conn = await preflightConnectors(prepared);
  if (conn) {
    console.error(c.red(`✗ connector preflight failed: ${conn}`));
    process.exit(1);
  }

  // USER-AUTH manifest: the agents run under the LOGGED-IN operator's owner, and the launch spec
  // (consumed by the manager at boot) must carry it — so resolve it NOW. On a fresh mesh the
  // derivation material doesn't exist yet; ensure it just-in-time (authSetup + prepareServer are
  // idempotent ensure-* — the same contract the refresh-heal path already rides). Not logged in /
  // no provider = the exact recovery sentence, before anything boots.
  let owner: string | undefined;
  if (userAuth) {
    try {
      mkdirSync(cotalPath("nats"), { recursive: true });
      const setup = await authSetup(cotalPath("nats"), server, m.space, host, userAuth);
      owner = await resolveAuthProvider().ownerForLogin({ store: workspaceSecretStore(cotalRoot()), dir: setup.stateDir!, space: m.space });
    } catch (e) {
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
  const specPath = writeLaunchSpec(cotalRoot(), buildLaunchSpec(eff, genRunId(), owner));
  // A leftover detached manager (its broker is gone — the reachability check above proved nothing
  // lives at this address) would win the fresh mesh's lease and the launch manager would refuse.
  // Stop it, so the manager started below WITH the launch spec is THE manager.
  stopManager();
  let pid: number;
  let controlPlane = false;
  let authService = true;
  try {
    ({ pid, controlPlane, authService } = await startMeshDetached({ server, space: m.space, open, userAuth, host, seed: manifestToChannels(eff), runtime, launch: specPath }));
  } catch (e) {
    console.error(c.red(`✗ ${(e as Error).message}`));
    process.exit(1);
  }
  console.log(c.green(`✓ mesh "${m.space}" up at ${server}`) + c.dim(` (broker pid ${pid})`));
  console.log(c.dim(`  seeded ${m.channels.length} channel(s): ${m.channels.map((ch) => "#" + ch.name).join(", ")}`));
  // Never claim a launch the control plane can't deliver: the manager carries the launch spec, so a
  // degraded control plane (announced above) means the agents are NOT coming up.
  if (controlPlane) {
    // U6: on a user mesh the agents run under the OPERATOR's identity — say whose they are.
    console.log(c.green(`✓ launching ${eff.agents.length} agent(s)`) + c.dim(` via manager (${runtime})${owner ? ` as you (owner ${owner})` : ""} - see .cotal/manager.log`));
  } else {
    console.error(c.red(`✗ ${eff.agents.length} agent(s) NOT launched - the control plane did not come up (see above)`));
  }

  // Loud summary: any persona-inherited access an `include` manifest dragged in, plus warnings.
  const inherited = renderInherited(eff);
  if (inherited) console.log("\n" + inherited);
  if (eff.warnings.length) console.log("\n" + renderWarnings(eff.warnings));
  console.log(c.dim(`\nWatch: \`cotal console --space ${m.space}\` or \`cotal web\`   ·   Tear down: \`cotal down\``));
  // A declared-user-auth manifest whose auth service never became ready: the mesh is up + recorded
  // (re-`cotal up` heals), but this launch did not deliver a usable identity plane — exit non-zero
  // so CI/wrappers don't read success (the red consequence line printed at the failure above).
  if (!authService) process.exitCode = 1;
}

/** CLI overrides for `up -f` — each wins over the manifest's own value (flag > manifest > default).
 *  `userAuth`/`idp` are consistency ASSERTIONS against the manifest, not overrides: the manifest
 *  declares the auth mode; a disagreeing flag is a hard error, never a silent re-mode. */
interface UpManifestFlags {
  dryRun: boolean;
  server?: string;
  host?: string;
  space?: string;
  runtime?: string;
  open?: boolean;
  userAuth?: boolean;
  idp?: string;
}

/** Return a copy of the prepared manifest with CLI overrides applied to broker/space/runtime, so the
 *  whole launch (render, seed, broker, manager, launch spec) runs against one effective manifest. */
function applyUpOverrides(prepared: PreparedManifest, o: UpManifestFlags): PreparedManifest {
  const m = prepared.manifest;
  const broker = { ...m.broker };
  if (o.server) broker.servers = o.server;
  if (o.host) broker.host = o.host;
  if (o.open) broker.auth = false;
  return {
    ...prepared,
    manifest: {
      ...m,
      broker: Object.keys(broker).length ? broker : undefined,
      space: o.space ?? m.space,
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
 *  so the launch can never be a second supervise). Returns whether the control plane came up, so a
 *  caller whose output claims a manager (the `up -f` launching line) can tell the truth. */
async function startDeliveryWithBroker(
  space: string,
  server: string,
  mgr?: { runtime?: string; launch?: string; resumeAttempt?: string; resumeCommitToken?: string },
): Promise<boolean> {
  try {
    await ensureControlPlane({ space, server, ...mgr });
    return true;
  } catch (e) {
    // Non-fatal (live messaging is unaffected) — but never SILENT: without the manager,
    // `spawn --detach` / cotal_spawn have no responder, and the operator must hear it here,
    // not as an unexplained "no manager reachable" later.
    console.error(c.dim(`! control plane degraded: ${(e as Error).message} - durable delivery/manager may be down; start one with: cotal supervise`));
    return false;
  }
}

export interface DetachOpts {
  server?: string;
  storeDir?: string;
  space?: string;
  open?: boolean;
  /** USER MODE: enable per-user auth (presence = on; `idpUrl` pins the IdP on first enable). */
  userAuth?: { idpUrl?: string };
  channels?: string;
  host?: string;
  /** Channel-registry seed in memory (the `cotal up -f` manifest path), used instead of reading a
   *  `--channels` file. Takes precedence over {@link channels}. */
  seed?: ChannelRegistryFile;
  /** Live boot lines, tailed from the server's log file (safe for a detached child). */
  onLine?: (line: string) => void;
  /** Manifest launch (`cotal up -f`): the ONE control-plane manager started alongside the broker
   *  carries this runtime + resolved launch-spec path — never a second supervise (singleton lease). */
  runtime?: string;
  launch?: string;
  resumeAttempt?: string;
  resumeCommitToken?: string;
  /** Maintenance-bound listener (restore target or ordinary-resume source): named spawn, durable
   *  ownership bind immediately after, wire verification after readiness. */
  boundListener?: {
    serverName: string;
    serverNonce: string;
    onSpawn(pid: number, startedAt: string): void;
    verify(): Promise<void>;
  };
  /** Preservation/restore already established every canonical stream before listener exposure. */
  skipPostStart?: boolean;
}

/**
 * Start a background nats-server (JetStream), wait until it's reachable, pre-create the
 * space's streams, and leave it running detached (pid in `.cotal/nats.pid`). Used by
 * `up --detach`. When `onLine` is given, boot output is tailed from the
 * log file and forwarded — the child writes to the file (not a pipe), so it survives the
 * parent exiting.
 */
export async function startMeshDetached(
  opts: DetachOpts = {},
): Promise<{ server: string; pid: number; source: string; controlPlane: boolean; authService: boolean; delivery: boolean; manager: boolean }> {
  const server = opts.server ?? DEFAULT_SERVER;
  const useAuth = !opts.open;
  const space = opts.space ?? resolveSpace(process.cwd());
  ensureRootForSpace(useAuth, space); // may pin the cwd as this space's root — before any cotalPath use
  refuseOpenOverUserState(Boolean(opts.open), space);
  const storeDir = opts.storeDir ? resolve(opts.storeDir) : cotalPath("nats");
  mkdirSync(storeDir, { recursive: true });
  await claimSpace(space, server, cotalRoot());
  const seedFile = opts.seed ?? loadChannelsFile(opts.channels);
  const host = opts.host ?? "127.0.0.1";
  const setup = useAuth ? await authSetup(storeDir, server, space, host, opts.userAuth) : undefined;
  const port = Number(new URL(server).port) || 4222;
  const args = [
    ...(setup ? ["-c", setup.confPath] : ["-js", "-sd", storeDir, "-p", String(port), "-a", host]),
    ...(opts.boundListener ? ["--name", opts.boundListener.serverName] : []),
  ];
  const { bin, source } = await resolveNatsServer();

  const logPath = cotalPath("nats.log");
  const startOffset = existsSync(logPath) ? statSync(logPath).size : 0;
  const fd = openSync(logPath, "a");
  const listenerStartedAt = new Date().toISOString();
  const child = spawn(bin, args, { detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  if (opts.boundListener) {
    writeFileSync(cotalPath("nats.pid"), String(child.pid));
    if (process.env.COTAL_SMOKE_EXIT_AFTER_RESTORE_LISTENER_SPAWN === "1") process.exit(87);
    try {
      opts.boundListener.onSpawn(child.pid ?? 0, listenerStartedAt);
    } catch (error) {
      await stopUnboundRestoreListener(child);
      removeMatchingNatsPid(child.pid ?? 0);
      throw error;
    }
  }
  child.unref();

  let tailing = Boolean(opts.onLine);
  if (opts.onLine) tailLines(logPath, startOffset, opts.onLine, () => !tailing);

  const ready = await waitReady(server, setup?.creds);
  tailing = false;
  if (!ready) {
    child.kill("SIGTERM");
    if (opts.boundListener) rmSync(cotalPath("nats.pid"), { force: true });
    throw new Error(`nats-server did not become reachable at ${server} - see ${logPath}`);
  }
  if (!opts.boundListener) writeFileSync(cotalPath("nats.pid"), String(child.pid));
  if (opts.boundListener) await opts.boundListener.verify();
  if (!opts.skipPostStart) await postStart(server, space, setup, seedFile);
  // USER MODE: the auth service comes up FIRST among the daemons (see the foreground path).
  const svc = await startUserAuthService(space, server, setup);
  // Record BEFORE the control plane: the manager's fail-closed mode detection needs the
  // authoritative registry entry at boot (marker-without-registry refuses). Detached: the entry
  // outlives this process — `cotal down` removes it.
  recordOurMesh({
    space, server, root: cotalRoot(),
    mode: setup?.prepared ? "user" : useAuth ? "auth" : "open",
    ...(svc.userAuth ? { userAuth: svc.userAuth } : {}),
    ts: new Date().toISOString(),
  });
  // Bring up the delivery daemon WITH the detached broker (auth mode only; `cotal down` tears both down).
  const controlPlane = await startDeliveryWithBroker(space, server, {
    runtime: opts.runtime,
    launch: opts.launch,
    resumeAttempt: opts.resumeAttempt,
    resumeCommitToken: opts.resumeCommitToken,
  });
  return {
    server,
    pid: child.pid ?? 0,
    source,
    controlPlane,
    authService: svc.ok,
    delivery: useAuth && deliveryUp(),
    manager: managerUp(),
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

/** Today a root's `.cotal/auth` is created for one space (its account is space-bound), so an
 *  explicit `--space` naming a different space cannot run against this root's trust material — the
 *  registry would point a `spawn --space` at mismatched creds. A mismatch only exists when
 *  `--space` was given (the default IS this root's space): clear intent for a different mesh. When
 *  the root was merely inherited from an ancestor folder (the cwd has no `.cotal` of its own),
 *  honor that intent — make the cwd the new space's own root. Only a folder that itself holds the
 *  other space's material refuses. (When multi-space-per-root lands, that refusal becomes
 *  provision-the-new-space instead.) */
function ensureRootForSpace(useAuth: boolean, space: string): void {
  if (!useAuth) return;
  const root = cotalRoot();
  const existing = loadSoleSpaceAuth(authDir(root));
  if (!existing || existing.space === space) return;
  const cwd = process.cwd();
  if (root !== cwd) {
    mkdirSync(join(cwd, ".cotal"), { recursive: true });
    console.log(c.dim(`nearest mesh root ${root} is space "${existing.space}" - making this folder its own root for "${space}"`));
    return;
  }
  throw new Error(`this folder is the root of space "${existing.space}" (${authDir(root)}), so it can't also run "${space}" - drop \`--space\` to run "${existing.space}", or start "${space}" from a different folder (it becomes that mesh's own root)`);
}

/** A space name maps to one mesh in the registry (the key `--space`/`use`/`down` act on). Before
 *  starting a broker, refuse to reuse a space already claimed by a DIFFERENT live mesh — a stale/dead
 *  holder is reclaimed. Re-`up`ping the same mesh (same server + root) is a refresh (port-reachable
 *  path). NOTE: this is a best-effort sequential guard — two `cotal up --space X` racing from
 *  different roots within the same instant can both pass the check before either records; that
 *  concurrent case is out of scope (a single-operator CLI action), not synchronized with a lock. */
async function claimSpace(space: string, server: string, root: string): Promise<void> {
  const existing = findMesh(space);
  if (!existing || (existing.server === server && existing.root === root)) return;
  if (await isReachable(existing.server)) {
    throw new Error(`space "${space}" is already in use by a mesh at ${existing.server} (${existing.root}) - pick a different \`--space\`, or \`cotal down\` it first`);
  }
  removeMesh(space); // the prior holder's broker is gone — reclaim the name
}

/** Record this mesh in the registry, and set it as the `current` default when there's no usable one
 *  — i.e. the first mesh, OR when `current` dangles at a space that's no longer in the registry (a
 *  ghost pointer is not a default). Never silently redirect a `current` that still resolves to a live
 *  mesh; just say another is the default and how to switch. */
function recordOurMesh(m: MeshEntry): void {
  const cur = getCurrent();
  const usableCurrent = cur && findMesh(cur) ? cur : undefined; // compute before recording m
  recordMesh(m);
  if (!usableCurrent) {
    setCurrent(m.space);
    return;
  }
  if (usableCurrent !== m.space)
    console.log(c.dim(`"${m.space}" up; current is still "${usableCurrent}" - \`cotal use ${m.space}\` to switch`));
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

/** Ensure the space's trust material exists, render a server config, and mint a privileged
 *  setup creds (used to pre-create streams once the server is up). The account signing key
 *  in `.cotal/auth` is what `cotal mint` and the manager later use to issue per-agent creds.
 *
 *  USER MODE (`user` set): additionally run the registered auth provider's `prepareServer` over the
 *  SPACE-SCOPED state dir (`.cotal/auth/<space>/` — the multi-space-ready layout; nothing user-auth
 *  lives flat) and preload its extra account(s) into the broker config. The inverse is fail-closed:
 *  a space whose user-auth state exists MUST keep being started with --user-auth — regenerating the
 *  config without the callout account would silently break every sentinel connect. */
async function authSetup(
  storeDir: string,
  server: string,
  space: string,
  host: string = "127.0.0.1",
  user?: { idpUrl?: string },
): Promise<{ confPath: string; creds: string; prepared?: AuthPrepared; stateDir?: string }> {
  const dir = authDir(cotalRoot()); // the broker config (server.conf) still lands under the FS auth dir
  const store = workspaceSecretStore(cotalRoot());
  let auth: SpaceAuth | undefined = await getSpaceAuth(store, space);
  if (!auth) {
    auth = await createSpaceAuth(space);
    await putSpaceAuth(store, auth); // strips the $SYS seed at rest, but leaves the in-memory `auth` intact …
    await provisionMembershipCreds(auth, cotalRoot()); // … so the observer can still be minted here (fresh-space only)
  }
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
  const confPath = resolve(dir, "server.conf");
  writeFileSync(confPath, serverConfig(auth, [auth], { port, storeDir, host, ...(prepared ? { extraAccounts: prepared.extraAccounts } : {}) }));
  // Ephemeral setup cred: used only to probe reachability, pre-create the space streams/buckets
  // (setupSpaceStreams) and seed the channel registry (seedChannelRegistry) — all within the
  // enumerated `provisioner` scope. No broad `manager` residual for the up path.
  const creds = await mintCreds(auth, newIdentity(), "provisioner");
  return { confPath, creds, ...(prepared ? { prepared, stateDir } : {}) };
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
async function provisionMembershipCreds(auth: SpaceAuth, root: string): Promise<void> {
  try {
    const observer = await mintMembershipObserverCreds(auth, newIdentity());
    const rw = await mintCreds(auth, newIdentity(), "membership-rw");
    // D5 slice 4: the KICK-only connection-evictor cred — same mint-only-at-fresh-`up` window as
    // the observer ($SYS seed in memory here). The delivery daemon pairs it with the observer to
    // close a revoked/removed principal's live connections. A space without it degrades to
    // deny-new-only (durable reauth) — surfaced loudly by the removal path, never silent.
    const evictor = await mintConnectionEvictorCreds(auth, newIdentity());
    mkSecretDir(cotalPath()); // harden .cotal/ before the creds land (born under a private ACL, no race)
    writeSecretFile(cotalPath("membership-observer.creds"), observer);
    await workspaceSecretStore(root).put(MEMBERSHIP_RW_CREDS_KEY, rw); // migrated kind: through the seam (0600 FS put)
    writeSecretFile(cotalPath("connection-evictor.creds"), evictor);
    writeSecretFile(cotalPath("membership.json"), JSON.stringify({ accountId: auth.account.pub }));
  } catch (e) {
    console.error(c.dim(`• broker-sourced membership not provisioned: ${(e as Error).message}`));
  }
}
