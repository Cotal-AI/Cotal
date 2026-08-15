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
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
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
  meshesForRoot,
  removeMesh,
  rotateSystemCreds,
  setCurrent,
  staleSystemCreds,
  SYSTEM_CREDS_FILES,
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
  readBrokerPolicy,
  writeBrokerPolicy,
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
  { name: "tls-cert", type: "string", value: "<file>", description: "serve the broker over TLS with this certificate (requires --tls-key)" },
  { name: "tls-key", type: "string", value: "<file>", description: "the private key for --tls-cert" },
  { name: "restore", type: "string", value: "<dir>", description: "restore an offline backup before exposing the normal listener" },
  { name: "restore-only", type: "string", value: "<registry>", description: "restore only the registry component" },
  { name: "accept-missing-source", type: "boolean", description: "explicit disaster consent when the inode-bound preserved source is absent" },
  { name: "open", type: "boolean", description: "unauthenticated dev mesh (no JWT/ACLs)" },
  { name: "user-auth", type: "boolean", description: "per-USER auth: login + bearer through the space's auth service" },
  { name: "idp", type: "string", value: "<url>", description: "with --user-auth: the IdP auth base URL to pin (first enable)" },
  { name: "rotate-sys", type: "boolean", description: "renew the expired/expiring $SYS creds by rotating the system account (agents, data and creds survive; needs a stopped mesh)" },
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
    restore?: string; "restore-only"?: string; "accept-missing-source"?: boolean; "rotate-sys"?: boolean;
    "tls-cert"?: string; "tls-key"?: string;
    __restoreAttempt?: string;
    __ordinaryResumeAttempt?: string;
  };
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
  // MAINTENANCE RE-ENTRY. `--restore` is refused with `--rotate-sys` above, but that guard only sees
  // the EXPLICIT flag: a restore/resume re-entry arrives with `restore` cleared and an `__*Attempt`
  // set, and an auto-recovered journal reaches the same place with no restore flag ever typed. Both
  // re-entries then hit adopt-the-live-listener paths that RETURN before `authSetup`, so the flag
  // would be accepted, nothing would rotate, and the command would exit 0. That is the silent
  // success this whole change exists to remove, so it is refused here, before any attempt state is
  // read. A rotation is a stopped, fresh boot; a half-finished maintenance attempt is neither.
  if (values["rotate-sys"] && (values.__restoreAttempt || values.__ordinaryResumeAttempt))
    throw new Error("--rotate-sys cannot run during a restore/resume re-entry - finish or roll back the maintenance attempt, then `cotal down` and `cotal up --rotate-sys`");
  if (!values.__restoreAttempt && !values.__ordinaryResumeAttempt && !values.file) {
    const root = cotalRoot();
    // Same refusal for the AUTO-recovered journal, raised before the recovery is prepared and
    // re-entered, so the operator reads one clear error instead of one thrown from inside a nested
    // `up` that has already begun adopting a maintenance attempt.
    if (values["rotate-sys"] && readMaintenanceJournal(root))
      throw new Error("--rotate-sys is refused while this root has a maintenance attempt to recover - finish or roll back that attempt (`cotal up` alone recovers it), then `cotal down` and `cotal up --rotate-sys`");
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
    const spaceForRoot = values.space ?? resolveSpace(process.cwd());
    if (values.file) {
      try {
        const prepared = loadManifest(resolve(values.file));
        const space = values.space ?? prepared.manifest.space;
        const open = Boolean(values.open) || prepared.manifest.broker?.auth === false;
        ensureRootForSpace(!open, space);
      } catch {
        // Manifest errors are reported by the -f path with the same load; do not double-print.
      }
    } else {
      ensureRootForSpace(!values.open, spaceForRoot);
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
  const meshRoot = cotalRoot();
  const transport = resolveTransport(values, undefined, meshRoot, {
    persist: false,
    quiet: true,
  });

  // `up -f cotal.yaml` is a distinct path: bring up a FRESH mesh described by a manifest (broker +
  // channels + booted agents). It owns the whole space; deploying onto a RUNNING mesh is `spawn -f`.
  // CLI flags override the manifest (flag > manifest > default) so the same file runs at a different
  // port / runtime / space / auth without editing it.
  if (values.file) {
    if (values["dry-run"]) {
      await upManifest(values.file, {
        transport,
        dryRun: true,
        server: values.server,
        host: values.host,
        space: values.space,
        runtime: values.runtime,
        open: values.open,
        userAuth: wantUser,
        idp: values.idp,
        rotateSys: values["rotate-sys"],
      });
      return;
    }
    const lock = acquireMaintenanceLock(cotalRoot());
    try {
      assertOrdinaryUpAllowed(cotalRoot());
      await upManifest(values.file, {
        transport,
        dryRun: Boolean(values["dry-run"]),
        server: values.server,
        host: values.host,
        space: values.space,
        runtime: values.runtime,
        open: values.open,
        userAuth: wantUser,
        idp: values.idp,
        rotateSys: values["rotate-sys"],
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
    // `--host` is the BIND address; `server` is the URL the readiness probe, the mesh registry, and
    // every later client use. They must name the SAME address. Left independent, `--host <non-loopback>`
    // bound correctly and was then probed on the loopback default, found nothing, timed out, and
    // SIGTERM'd a broker that had started perfectly — so `--host` alone could never succeed.
    // Derive the URL from `--host` when no explicit `--server` pins it, and refuse a contradicting
    // pair rather than starting a broker nothing can reach.
    if (values.host) server = reconcileHostAndServer(values.host, values.server);
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
        // A repair replaces the manager, so it must carry the mesh's recorded exposure forward — a
        // bare `cotal up` here has no `--host` of its own, and dropping it silently moves the attach
        // face back to loopback while everything else keeps working.
        const controlPlane = await startDeliveryWithBroker(held.space, server, {
          runtime: values.runtime,
          attachHost: attachHostFor(held.space, values.host),
        });
        if (!controlPlane) process.exitCode = 1;
      }
      const heldAttachHost = attachHostFor(held.space, values.host);
      // A broker was already answering here — this branch starts nothing, so it must not claim the
      // record as ours (see `Provenance`).
      // `tlsRequired` is CARRIED FORWARD, not re-derived. This branch starts no listener, so it has
      // no transport decision to record — and `recordOurMesh` writes the entry whole, so omitting
      // the field here would erase the requirement on every bare refresh, exactly the way dropping
      // `attachHost` would silently demote the mesh to loopback.
      recordOurMesh({ space: held.space, server, root, mode: held.mode, ...(held.tlsRequired !== undefined ? { tlsRequired: held.tlsRequired } : {}), ...(userAuth ? { userAuth } : {}), ...(heldAttachHost ? { attachHost: heldAttachHost } : {}), ts: new Date().toISOString() }, "refresh");
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

  if (values.detach) {
    const restored = resumeAttempt ? pendingRestores.get(resumeAttempt) : undefined;
    const { pid, source, authService, controlPlane, delivery, manager } = await startMeshDetached({
      transport,
      server,
      storeDir: values["store-dir"],
      space: values.space,
      open: values.open,
      userAuth: wantUser ? { idpUrl: values.idp } : undefined,
      rotateSys: values["rotate-sys"],
      channels: values.channels,
      // The RAW flag, not the loopback-defaulted `host` above: `startMeshDetached` applies the same
      // default itself, and what it records must distinguish "the operator asked for this address"
      // from "nobody asked", or every mesh would persist an exposure decision it never made.
      host: values.host,
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
    // Transport policy is committed inside startMeshDetached before delivery launch (S5+S9).
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
  // Decided above the branch; the dial host is only settled here (a port collision may have moved
  // the server, and the hostname is what the certificate has to match).
  assertServesDialHost(transport, new URL(server).hostname);
  const setup = useAuth ? await authSetup(storeDir, server, space, host, wantUser ? { idpUrl: values.idp } : undefined, transport, values["rotate-sys"]) : undefined;
  const port = Number(new URL(server).port) || 4222;
  const restored = resumeAttempt ? pendingRestores.get(resumeAttempt) : undefined;
  // Both modes go through a RENDERER, never bare CLI flags. Open mode used to start from
  // `-js -sd … -p … -a …`, which never called a renderer at all — so the required transport union
  // protected the auth path and was silent on the open one, and a cert/key pair passed to an
  // open-mode `up` would have been accepted while the listener came up in cleartext.
  const confPath = setup ? setup.confPath : writeOpenBrokerConf(storeDir, { port, host, transport });
  const natsArgs = [
    "-c", confPath,
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
        void stopManager()
          .then(() => stopAuthService(space))
          .catch((e: Error) => console.error(`! teardown: ${e.message}`));
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
    await stopManager().catch((e: Error) => console.error(`! manager teardown: ${e.message}`));
    await stopAuthService(space).catch((e: Error) => console.error(`! auth teardown: ${e.message}`));
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
  });

  const ready = await waitReady(server, setup?.creds);
  if (!ready) {
    child.kill("SIGTERM");
    const reason = `nats-server did not become ready at ${server}`;
    markPendingResumeDegraded(resumeAttempt ?? "", reason);
    throw new Error(reason);
  }
  if (restored) await provePreparedRestoreListener(restored);
  // Listener ready — commit the transport decision (S5: not before start).
  commitTransportPolicy(meshRoot, transport);
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
    // Resolve exposure BEFORE recording. This path also serves a RESUME of an already-recorded mesh
    // (`down --preserve-state` then a bare `up`), where the operator's `--host` lives only in the
    // registry — and the record below is written whole, so reading it afterwards would find the
    // field this very call had just erased.
    const effectiveAttachHost = attachHostFor(space, values.host);
    recordOurMesh({
      space, server, root: cotalRoot(),
      mode: setup?.prepared ? "user" : useAuth ? "auth" : "open",
      // Written ALWAYS, as a boolean, unlike `attachHost` below. Absence and `false` resolve
      // identically for clients, so an omitted field would be indistinguishable from a deliberate
      // plaintext mesh — and this is the one field whose whole purpose is that the answer was
      // stated rather than defaulted.
      tlsRequired: transport.kind === "tls-required",
      ...(svc.userAuth ? { userAuth: svc.userAuth } : {}),
      // Only a real decision is persisted — an explicit `--host` now, or one carried forward from a
      // previous launch. The bare case stays absent rather than recording the loopback default as
      // though the operator had chosen it.
      ...(effectiveAttachHost ? { attachHost: effectiveAttachHost } : {}),
      ts: new Date().toISOString(),
    }, "started");
    // Bring up the delivery daemon WITH the server (auth mode only — it self-gates on `.cotal/auth`).
    // It is part of the server, so `cotal up` starts it by default; open dev mode has no daemon.
    // Class-2 credential renewal is NOT wired here: the MANAGER is the renewal owner (it is resident
    // in every mesh mode — foreground, --detach, refresh — where this foreground process is not).
    const controlPlane = await startDeliveryWithBroker(space, server, {
      runtime: values.runtime,
      // The address the broker was bound to. This is what lets `cotal attach` reach this manager
      // from another machine; without it the attach face stays loopback-only, so exposing terminals
      // is never a side effect of anything but the operator binding the mesh somewhere reachable.
      attachHost: effectiveAttachHost,
      resumeAttempt,
      resumeCommitToken: restored?.managerCommit?.durableCommitToken ?? ordinaryAttempt?.managerCommit?.durableCommitToken,
      transport,
      wsPort: setup?.wsPort, // P2 item 6: the console session client's broker ws port
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
    ...standaloneConnectOpts({ ...auth, /* not yet wired to a recorded transport - see broker-policy/MeshEntry work */ tls: false }),
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
    ...standaloneConnectOpts({ ...auth, /* not yet wired to a recorded transport - see broker-policy/MeshEntry work */ tls: false }),
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
  // Read the recorded exposure BEFORE re-recording: `recordOurMesh` writes the entry whole, so a
  // record built without this field would erase the operator's decision, and the adopted manager
  // below would then be launched loopback-only from an entry that no longer remembers otherwise.
  const adoptAttachHost = attachHostFor(pending.space);
  recordOurMesh({
    space: pending.space,
    server: pending.server,
    root: pending.root,
    mode: pending.mode,
    // Adopted from the recorded policy: this path proves and re-adopts a listener it did not start.
    tlsRequired: adoptedTlsRequired(pending.root),
    ...(svc.userAuth ? { userAuth: svc.userAuth } : {}),
    ...(adoptAttachHost ? { attachHost: adoptAttachHost } : {}),
    ts: new Date().toISOString(),
  }, "started");
  const controlPlane = await startDeliveryWithBroker(pending.space, pending.server, {
    runtime: pending.runtime,
    attachHost: adoptAttachHost,
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
  // Same ordering constraint as the pending-adopt path above: capture the recorded exposure before
  // `recordOurMesh` rewrites the entry, or a restore silently demotes the mesh to loopback attach.
  const restoreAttachHost = attachHostFor(prepared.space);
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
    ts: new Date().toISOString(),
  }, "started");
  const controlPlane = await startDeliveryWithBroker(prepared.space, prepared.server, {
    runtime: prepared.runtime,
    attachHost: restoreAttachHost,
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
    const ready = await askManager(pending.space, server, "ps", undefined, auth, "any", 2_000);
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
    "any",
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
      "any",
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
    auth,
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
  const host = m.broker?.host ?? "127.0.0.1";
  // Same bind-vs-probe reconciliation as the flag path: a manifest that sets `broker.host` without
  // an explicit `broker.servers` would otherwise bind one address and be probed at another.
  const server = m.broker?.host ? reconcileHostAndServer(m.broker.host, m.broker?.servers) : (m.broker?.servers ?? DEFAULT_SERVER);
  const open = m.broker?.auth === false; // default is auth
  const userAuth = m.broker?.auth === "user" ? { idpUrl: opts.idp ?? m.broker?.idp } : undefined; // flag > manifest
  const runtime = m.runtime ?? "pty";
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
    if (opts.transport.kind === "tls-required") announceTransport(opts.transport);
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
      // NO `rotateSys` here on purpose: this is an owner-derivation pre-resolve that runs BEFORE the
      // real boot, and the boot below carries the flag. Rotating in both would burn two generations
      // per `up -f --rotate-sys` and retire the account the first pass just minted creds against.
      const setup = await authSetup(cotalPath("nats"), server, m.space, host, userAuth, assertServesDialHost(opts.transport, new URL(server).hostname));
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
  await stopManager();
  let pid: number;
  let controlPlane = false;
  let authService = true;
  try {
    // `m.broker?.host`, not the defaulted `host`: same reason as the flag path — only a host the
    // manifest actually declared is an exposure decision worth persisting.
    ({ pid, controlPlane, authService } = await startMeshDetached({ transport: opts.transport, server, space: m.space, open, userAuth, rotateSys: opts.rotateSys, host: m.broker?.host, seed: manifestToChannels(eff), runtime, launch: specPath }));
  } catch (e) {
    console.error(c.red(`✗ ${(e as Error).message}`));
    process.exit(1);
  }
  // Transport committed inside startMeshDetached before delivery (S5+S9).
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
  mgr?: {
    runtime?: string;
    launch?: string;
    attachHost?: string;
    resumeAttempt?: string;
    resumeCommitToken?: string;
    /** When the caller already applied a transport this turn, pass it so delivery does not
     *  re-read a policy file that is not yet committed (S9). Otherwise fall back to the record. */
    transport?: BrokerTransport;
    /** P2 item 6: broker ws listener port for the console session client. */
    wsPort?: number;
  },
): Promise<boolean> {
  try {
    // Prefer the in-memory decision for a fresh apply (policy may not be on disk yet — S9).
    // Fall back to the recorded policy for resume/restore/refresh paths that start no new listener.
    const tls =
      mgr?.transport?.kind === "tls-required" ||
      readBrokerPolicy(cotalRoot())?.transport.kind === "tls-required";
    const { transport: _t, ...mgrRest } = mgr ?? {};
    await ensureControlPlane({ space, server, tls, ...mgrRest });
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
  // The `= {}` default is gone with the optional transport: an options object that can be omitted
  // entirely cannot carry a mandatory decision.
  opts: DetachOpts,
): Promise<{ server: string; pid: number; source: string; controlPlane: boolean; authService: boolean; delivery: boolean; manager: boolean }> {
  const server = opts.server ?? DEFAULT_SERVER;
  const useAuth = !opts.open;
  // Belt on the one boot that both renders the broker config and can be reached by any caller: an
  // open boot skips `authSetup` entirely, so a `rotateSys` arriving here would be dropped in silence
  // rather than refused. Callers guard this too; this is the seam that cannot be bypassed.
  if (opts.rotateSys && !useAuth)
    throw new Error("startMeshDetached: --rotate-sys is for auth meshes; an open mesh has no system account or $SYS credentials to rotate");
  const space = opts.space ?? resolveSpace(process.cwd());
  ensureRootForSpace(useAuth, space); // may pin the cwd as this space's root — before any cotalPath use
  refuseOpenOverUserState(Boolean(opts.open), space);
  const storeDir = opts.storeDir ? resolve(opts.storeDir) : cotalPath("nats");
  mkdirSync(storeDir, { recursive: true });
  await claimSpace(space, server, cotalRoot());
  const seedFile = opts.seed ?? loadChannelsFile(opts.channels);
  const host = opts.host ?? "127.0.0.1";
  // The transport arrives decided. The dial-host SAN is re-checked here because THIS is where the
  // effective server is finally known — a manifest may name a different host than the flags did, and
  // a certificate that is valid for one is not thereby valid for the other.
  const transport = assertServesDialHost(opts.transport, new URL(server).hostname);
  const setup = useAuth ? await authSetup(storeDir, server, space, host, opts.userAuth, transport, opts.rotateSys) : undefined;
  const port = Number(new URL(server).port) || 4222;
  // Same rule as the foreground path: every route to a listener names its transport (see
  // `writeOpenBrokerConf`). Detach must not be the mode where the fence quietly does not apply.
  const confPath = setup ? setup.confPath : writeOpenBrokerConf(storeDir, { port, host, transport });
  const args = [
    "-c", confPath,
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
  // POST-START MUST NOT LEAVE AN ORPHAN LISTENER.
  //
  // Everything above has already bound the port and written `nats.pid`, but NOTHING has recorded the
  // mesh yet — `recordOurMesh` is below. So a throw between here and there used to exit non-zero
  // while leaving a live broker holding the port with no registry entry, which `cotal down` cannot
  // reach because `down` works from the registry. A third state between "started" and "refused",
  // and the operator's only recourse is to hunt a pid.
  //
  // This is reachable BECAUSE of TLS and cannot happen on `main`: the post-start client verifies the
  // certificate, so a private CA without `NODE_EXTRA_CA_CERTS` fails here — after the listener is up.
  // The feature introduced the state, so the feature tears it down.
  //
  // Deliberately narrow: this is a teardown on the failure path, not a restructuring of the launch
  // sequence. The listener is stopped and the pid file removed, then the original error is rethrown
  // unchanged — the operator needs the certificate error, not a message about cleanup.
  if (!opts.skipPostStart) {
    try {
      await postStart(server, space, setup, seedFile);
    } catch (e) {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      try { rmSync(cotalPath("nats.pid"), { force: true }); } catch { /* best effort */ }
      throw e;
    }
  }
  // USER MODE: the auth service comes up FIRST among the daemons (see the foreground path).
  const svc = await startUserAuthService(space, server, setup);
  // Record BEFORE the control plane: the manager's fail-closed mode detection needs the
  // authoritative registry entry at boot (marker-without-registry refuses). Detached: the entry
  // outlives this process — `cotal down` removes it.
  // Same capture-before-record as the foreground path: this also runs for a bare `up --detach` that
  // RESUMES an already-recorded mesh, whose exposure decision exists only in the registry entry the
  // call below rewrites.
  const effectiveAttachHost = attachHostFor(space, opts.host);
  recordOurMesh({
    space, server, root: cotalRoot(),
    mode: setup?.prepared ? "user" : useAuth ? "auth" : "open",
    // The detached listener is started from `transport` a few lines above, so this is the same
    // decision that shaped the config file — not a re-derivation.
    tlsRequired: transport.kind === "tls-required",
    ...(svc.userAuth ? { userAuth: svc.userAuth } : {}),
    // Persist only a real decision — declared now, or carried forward — never the loopback default.
    ...(effectiveAttachHost ? { attachHost: effectiveAttachHost } : {}),
    ts: new Date().toISOString(),
  }, "started");
  // Commit policy BEFORE delivery launch (S9). Listener is proved; refuse paths never reach here.
  // startDeliveryWithBroker also receives `transport` so it does not depend on the file alone.
  commitTransportPolicy(cotalRoot(), transport);
  // Bring up the delivery daemon WITH the detached broker (auth mode only; `cotal down` tears both down).
  const controlPlane = await startDeliveryWithBroker(space, server, {
    runtime: opts.runtime,
    launch: opts.launch,
    // See the foreground path: the broker's bind address is what makes attach reachable off-box.
    attachHost: effectiveAttachHost,
    resumeAttempt: opts.resumeAttempt,
    resumeCommitToken: opts.resumeCommitToken,
    transport,
    wsPort: setup?.wsPort, // P2 item 6: the console session client's broker ws port
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
 *  (When multi-space-per-root lands, that refusal becomes provision-the-new-space instead.) */
function ensureRootForSpace(_useAuth: boolean, space: string): void {
  const root = cotalRoot();
  const cwd = process.cwd();
  // What space does this root already host? Prefer auth material; fall back to a live MeshEntry
  // whose root is this directory (open meshes have no auth dir).
  const existingAuth = loadSoleSpaceAuth(authDir(root));
  const existingSpace =
    existingAuth?.space ??
    loadMeshes().find((m) => m.root === root || realpathSafe(m.root) === realpathSafe(root))?.space;
  if (!existingSpace || existingSpace === space) return;
  if (root !== cwd) {
    mkdirSync(join(cwd, ".cotal"), { recursive: true });
    console.log(c.dim(`nearest mesh root ${root} is space "${existingSpace}" - making this folder its own root for "${space}"`));
    return;
  }
  throw new Error(`this folder is the root of space "${existingSpace}" (${root}/.cotal), so it can't also run "${space}" - drop \`--space\` to run "${existingSpace}", or start "${space}" from a different folder (it becomes that mesh's own root)`);
}

function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** A space name maps to one mesh in the registry (the key `--space`/`use`/`down` act on). Before
 *  starting a broker, refuse to reuse a space already claimed by a DIFFERENT live mesh — a stale/dead
 *  holder is reclaimed. Re-`up`ping the same mesh (same server + root) is a refresh (port-reachable
 *  path). NOTE: this is a best-effort sequential guard — two `cotal up --space X` racing from
 *  different roots within the same instant can both pass the check before either records; that
 *  concurrent case is out of scope (a single-operator CLI action), not synchronized with a lock. */
export async function claimSpace(space: string, server: string, root: string): Promise<void> {
  const existing = findMesh(space);
  if (!existing || (existing.server === server && existing.root === root)) return;
  // An OPERATOR-REGISTERED holder is decided FIRST, before liveness, because liveness changes
  // nothing about it and the two outcomes would otherwise print the wrong remedy. It is never
  // reclaimed: unreachable is not proof the mesh is gone (the record describes a broker on another
  // machine), the reclaim runs BEFORE this launch starts anything, and `cotal down` — what the
  // liveness branch below would advise — cannot stop a mesh this machine does not run.
  if (existing.origin === "manual")
    throw new Error(`space "${space}" is registered to a mesh at ${existing.server} (${existing.root}) - it was registered by hand, so \`cotal up\` neither takes it over nor reclaims the name: \`cotal meshes rm ${space}\` to drop that record first, or start this one under a different \`--space\``);
  if (await isReachable(existing.server)) {
    throw new Error(`space "${space}" is already in use by a mesh at ${existing.server} (${existing.root}) - pick a different \`--space\`, or \`cotal down\` it first`);
  }
  removeMesh(space); // the prior holder's broker is gone — reclaim the name
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

/** Record this mesh in the registry, and set it as the `current` default when there's no usable one
 *  — i.e. the first mesh, OR when `current` dangles at a space that's no longer in the registry (a
 *  ghost pointer is not a default). Never silently redirect a `current` that still resolves to a live
 *  mesh; just say another is the default and how to switch. */
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

function recordOurMesh(m: MeshEntry, provenance: Provenance): void {
  const cur = getCurrent();
  const usableCurrent = cur && findMesh(cur) ? cur : undefined; // compute before recording m
  const prior = findMesh(m.space);
  const origin = provenance === "refresh" && prior?.origin === "manual" ? "manual" : "up";
  // A REFRESH starts nothing: it concluded the mesh is up from reachability alone, and rebuilds `m`
  // from what THIS launch knows, which is never the operator's past decisions. `origin` was already
  // carried across for that reason; the overlay acceptance is the same class and was not, so a
  // no-op refresh silently erased a consent the operator had given. A `started` takeover may
  // replace it (that launch really is the mesh now); a refresh may not quietly drop it.
  const unencryptedOverlay =
    provenance === "refresh" && m.unencryptedOverlay === undefined ? prior?.unencryptedOverlay : m.unencryptedOverlay;
  recordMesh({ ...m, origin, ...(unencryptedOverlay !== undefined ? { unencryptedOverlay } : {}) });
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

/** Wildcard binds mean "every interface", so they are NOT an address a client can be told to dial:
 *  the probe/registry URL stays whatever it already is (loopback by default), which the wildcard
 *  bind necessarily covers. */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

/**
 * Reconcile the bind address (`--host`, manifest `broker.host`) with the broker URL the readiness
 * probe, the mesh registry, and every later client use.
 *
 * They must name the same address. Left independent, `--host <non-loopback>` bound correctly and was
 * then probed at the loopback default: the probe found nothing, timed out, and the caller SIGTERM'd
 * a broker that had started perfectly, so `--host` alone could never succeed. With no explicit URL,
 * derive one from the host (keeping the URL's port); with both, refuse a contradicting pair rather
 * than starting a broker that nothing can reach.
 */
function reconcileHostAndServer(host: string, explicitServer: string | undefined): string {
  const url = new URL(explicitServer ?? DEFAULT_SERVER);
  if (WILDCARD_HOSTS.has(host)) return explicitServer ?? DEFAULT_SERVER;
  // An unbracketed IPv6 literal cannot be assigned to a URL host — bracket it so the URL parses.
  const literal = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  if (!explicitServer) return `nats://${literal}:${url.port || "4222"}`;
  if (url.hostname !== new URL(`nats://${literal}:1`).hostname) {
    console.error(
      c.red(
        `✗ --host ${host} and --server ${explicitServer} name different addresses - the broker would bind ${host} but be probed at ${url.hostname}. Pass one, or make them agree.`,
      ),
    );
    process.exit(1);
  }
  return explicitServer;
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
 *  config without the callout account would silently break every sentinel connect.
 *
 *  `rotateSys` (`cotal up --rotate-sys`) is the class-3 renewal for an EXISTING space: rotate the
 *  system account, re-mint `membership-observer.creds` + `connection-evictor.creds` against the
 *  successor, and render the config from the ROTATED record so the broker this `up` starts is the one
 *  that trusts them. It belongs here because this is the single site that both owns the trust record
 *  and renders `server.conf`; anywhere else would publish creds the live broker cannot honor. */
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

/** Persist + announce a transport that has been APPLIED (listener started and proved). */
function commitTransportPolicy(root: string, transport: BrokerTransport): void {
  if (transport.kind !== "tls-required") return;
  writeBrokerPolicy(root, { version: 1, transport });
  announceTransport(transport);
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
function writeOpenBrokerConf(storeDir: string, opts: { port: number; host: string; transport: BrokerTransport }): string {
  const confPath = resolve(storeDir, "..", "server-open.conf");
  writeFileSync(
    confPath,
    openServerConfig({ port: opts.port, host: opts.host, storeDir, transport: opts.transport }),
  );
  return confPath;
}

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
): Promise<{ confPath: string; creds: string; wsPort: number; prepared?: AuthPrepared; stateDir?: string }> {
  const dir = authDir(cotalRoot()); // the broker config (server.conf) still lands under the FS auth dir
  const store = workspaceSecretStore(cotalRoot());
  let auth: SpaceAuth | undefined = await getSpaceAuth(store, space);
  if (!auth) {
    auth = await createSpaceAuth(space);
    await putSpaceAuth(store, auth); // strips the $SYS seed at rest, but leaves the in-memory `auth` intact …
    await provisionMembershipCreds(auth, cotalRoot()); // … so the observer can still be minted here (fresh-space only)
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
  await healMembershipDataCreds(auth, cotalRoot());
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
  const stale = staleSystemCreds(cotalRoot(), auth.sys.pub);
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
  writeFileSync(confPath, serverConfig(auth, [auth], { transport, port, storeDir, host, wsPort, wsHost: host, ...(prepared ? { extraAccounts: prepared.extraAccounts } : {}) }));
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
 * WHAT IT CANNOT SEE, stated because an earlier version of this comment claimed otherwise: both
 * records are mutable, and neither is written by a broker started outside `cotal up`. Delete both
 * while the process lives, or run `nats-server -c <root>/.cotal/auth/server.conf` by hand, and this
 * returns success having probed nothing. The requested address is covered separately (an unidentified
 * listener there refuses the rotation rather than moving to a free port), which leaves a hand-started
 * broker on a DIFFERENT port as the honest residual. Closing that needs something a survivor holds
 * and cannot delete, an exclusive store lock, which does not exist today; until it does, do not run
 * `nats-server` against this root's config outside `cotal up`.
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
async function healMembershipDataCreds(auth: SpaceAuth, root: string): Promise<void> {
  try {
    const store = workspaceSecretStore(root);
    const wrote: string[] = [];
    if ((await store.get(MEMBERSHIP_RW_CREDS_KEY)) === undefined) {
      await store.put(MEMBERSHIP_RW_CREDS_KEY, await mintCreds(auth, newIdentity(), "membership-rw"));
      wrote.push(MEMBERSHIP_RW_CREDS_KEY);
    }
    if (!existsSync(cotalPath("membership.json"))) {
      mkSecretDir(cotalPath()); // harden .cotal/ before the file lands, as the fresh path does
      writeSecretFile(cotalPath("membership.json"), JSON.stringify({ accountId: auth.account.pub }));
      wrote.push("membership.json");
    }
    if (wrote.length)
      console.log(c.dim(`• membership: provisioned ${wrote.join(" + ")} - the data-account half needs no system-account rotation`));
  } catch (e) {
    // Best-effort, exactly like the fresh-space provisioner: a failure here leaves the graph on
    // traffic-only and leaves delivery untouched. It must never keep the mesh from starting.
    console.error(c.dim(`• broker-sourced membership not repaired: ${(e as Error).message}`));
  }
}

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
    writeSecretFile(cotalPath(SYSTEM_CREDS_FILES[0]), observer);
    await workspaceSecretStore(root).put(MEMBERSHIP_RW_CREDS_KEY, rw); // migrated kind: through the seam (0600 FS put)
    writeSecretFile(cotalPath(SYSTEM_CREDS_FILES[1]), evictor);
    writeSecretFile(cotalPath("membership.json"), JSON.stringify({ accountId: auth.account.pub }));
  } catch (e) {
    console.error(c.dim(`• broker-sourced membership not provisioned: ${(e as Error).message}`));
  }
}
