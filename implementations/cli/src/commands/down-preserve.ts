import { readFileSync, statSync } from "node:fs";
import {
  drainAndClose,
  DEV_OWNER,
  dialerFor,
  isReachable,
  LEASE_TTL_MS,
  MANAGER_LEASE_KEY,
  MANAGER_LEASE_TTL_MS,
  deliveryBucket,
  managerBucket,
  presenceBucket,
  isPresenceRow,
  parsePrincipalKey,
  principalKey,
  standaloneConnectOpts,
  type Connector,
  type ManagerLeaseInfo,
  type Presence,
} from "@cotal-ai/core";
import { join, resolve as resolvePath } from "node:path";
import {
  CommandFailure,
  isCommandFailure,
  isMaintenanceError,
  abortMaintenanceCut,
  acquireMaintenanceLock,
  beginMaintenanceCut,
  clearPreservationCommitIntent,
  clearPreservationPrepareIntent,
  completeMaintenanceCut,
  loadMeshes,
  localProcessPath,
  readMaintenanceJournal,
  readMaintenanceResumeDocument,
  readPreservationCommitIntent,
  readPreservationPrepareIntent,
  readStoreIdentity,
  recordPreservationManagerCommit,
  releaseMaintenanceLock,
  sameStoreIdentity,
  writePreservationCommitIntent,
  writePreservationPrepareIntent,
  type LocalProcess,
  type LocalProcessContext,
  MAINTENANCE_RESUME_DOCUMENT_VERSION,
  writeMaintenanceResumeDocument,
  loadSeatWriterGeneration,
  materializeFromManifest,
  type MaintenanceResumeDescriptor,
  seatCheckpointDir,
  type SeatCheckpoint,
  type JsonValue,
  resolveControlTarget,
  parsePid,
  probeLiveness,
  readPidfile,
  verifyIdentityPin,
} from "@cotal-ai/workspace";
import { jetstreamManager } from "@nats-io/jetstream";
import { localProcessSurface } from "../ext-loader.js";
import { c } from "../ui.js";
import { cotalRoot } from "../lib/paths.js";
import { directKvValue } from "./down-live-lease.js";
import { listAdditiveTeamAttempts, retainedAdditiveTeamAttempts } from "../lib/team-additive-attempt.js";
import { assertNoLiveServices } from "./down-services.js";
import { connectOrExit, userViewAuthOrExit } from "../lib/connect.js";
import { waitForEndpointUnreachable } from "../lib/endpoint-cut.js";
import { captureSeatCheckpoint } from "../lib/seat-capture.js";
import { stopLocalProcess } from "../lib/local-process-stop.js";
import { ensureDelivery } from "../lib/delivery-proc.js";
import { restoreNextStep } from "../lib/restore.js";
import { shellWord } from "../lib/endpoint-errors.js";
import { askManager } from "@cotal-ai/workspace/control";
import { cliControl } from "../lib/control.js";

/** The fields a checkpoint reads off one retained inventory entry. The manager owns
 *  `ManagerResumeAgent`; the CLI never imports it, because implementations do not depend on each
 *  other, so the coordinator states the shape it actually reads. */
interface ManagerResumeAgentShape {
  name: string;
  identity: { lifecycleUid: string };
  launch: {
    connector: string;
    cwd?: string;
    sessionId?: string;
    sessionStatePath?: string;
    unresolvedLaunchOptionKeys?: string[];
    source: { configSha256: string; manifestSha256?: string; hash?: string };
  };
}

/** How a live unmanaged endpoint is named in the preserve refusal. A missing or whitespace-only name is the id. */
export function unmanagedEndpointLabel(name: string, id: string): string {
  return name.trim() ? `${name} (${id})` : id;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether a component's pidfile names a process the `@cotal-ai/workspace` pid-attribution contract
 *  (`parsePid` + `probeLiveness`) reports alive. */
export function processAlive(component: LocalProcess, context: LocalProcessContext): boolean {
  return pidfileState(localProcessPath(component.pidFile, context)).liveness === "alive";
}

/** Whether a component MIGHT still be running. It fails CLOSED on uncertainty. A component with NO
 *  pidfile, an EMPTY husk, or a valid pid PROVEN dead (ESRCH) is not running. ANY other state - an
 *  unparsable/unattributable record, or a valid pid that is alive or whose liveness cannot be
 *  confirmed (`unknown`) - MIGHT be running. `down --preserve-state` asks it to fence an uncertain
 *  delivery daemon, to treat an uncertain manager as alive, and to refuse to call a cut complete.
 *  `processAlive` collapses unparsable and `unknown` to "not alive", which is fine for "is it worth
 *  stopping" but WRONG for those questions: it would count a live auth signer behind a torn pidfile
 *  as stopped. Only an ESRCH-confirmed death (or no record) clears a component. */
export function mayBeRunning(component: LocalProcess, context: LocalProcessContext): boolean {
  return pidfileState(localProcessPath(component.pidFile, context)).liveness !== "dead";
}

/** The principal keys of every retained agent in a preservation inventory — the dot-form ids that
 *  appear in the presence roster, so a caller can tell which retained agents are still live. */
export function retainedPrincipalKeys(inventory: unknown): Set<string> {
  const agents = ((inventory as { agents?: Array<{
    identity?: { mode?: string; id?: string; owner?: string; actor?: string };
  }> }).agents ?? []);
  return new Set(agents.map((agent) => {
    if (agent.identity?.mode === "user" && agent.identity.owner && agent.identity.actor)
      return principalKey(agent.identity.owner, agent.identity.actor).key;
    if (agent.identity?.id) return principalKey(DEV_OWNER, agent.identity.id).key;
    return undefined;
  }).filter((id): id is string => Boolean(id)));
}

/**
 * The operator's `--session-store` paths, resolved and proven to be directories.
 *
 * There is no default and nothing is inferred from a connector name: this repository does not know
 * where a harness keeps its transcript, and a guess recorded as a fact would produce a checkpoint
 * promising `exact` over bytes nobody chose. A path that does not exist or is not a directory is
 * refused HERE, before a single process is stopped, because a cut that discovers it after the stack
 * is down costs the operator the whole cut.
 */
export function assertSessionStores(paths: readonly string[]): string[] {
  return paths.map((path) => {
    const resolved = resolvePath(path);
    let stat;
    try {
      stat = statSync(resolved);
    } catch (error) {
      throw new CommandFailure("refused", "USAGE_INVALID", `--session-store ${resolved} cannot be read (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}); name the harness transcript store directory for this host`);
    }
    if (!stat.isDirectory())
      throw new CommandFailure("refused", "USAGE_INVALID", `--session-store ${resolved} is not a directory; name the harness transcript store directory for this host`);
    return resolved;
  });
}

/** Start the delivery daemon a refused cut stopped as its Plane 3 fence. Resolves to nothing when
 *  the daemon is running again, and to the reason when it is not, so the refusal can say so. */
async function restartFencedDelivery(space: string, server: string, tls: boolean): Promise<string | undefined> {
  try {
    const ensured = await ensureDelivery({ space, server, tls });
    if (!ensured.running) return "no delivery daemon is running after the attempt";
    console.error(c.dim(`• delivery daemon started again after the refused cut${ensured.pid !== undefined ? ` (pid ${ensured.pid})` : ""}`));
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

function acquirePreserveLock(root: string, space: string) {
  try { return acquireMaintenanceLock(root); }
  catch (error) {
    if (!isMaintenanceError(error) || error.code !== "lock-held") throw error;
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `${error.message}; nothing was stopped`, {
      target: { root, space }, remedy: "after the other operation finishes, repeat `cotal down --preserve-state` from this folder with the same options",
    });
  }
}

export async function preserveStateDown(storeOverride?: string, sessionStores: readonly string[] = []): Promise<void> {
  const root = cotalRoot();
  const matching = loadMeshes().filter((mesh) => mesh.root === root);
  if (matching.length !== 1)
    throw new CommandFailure("refused", matching.length ? "TARGET_AMBIGUOUS" : "TARGET_NOT_FOUND", `down --preserve-state requires exactly one recorded mesh for this root; found ${matching.length}, and nothing was stopped`, { target: { root, spaces: matching.map((mesh) => mesh.space) } });
  const mesh = matching[0];
  // The broker runs on the store its record names, such as a restore's --store-dir target, so that
  // is the store to cut. A record from before the field names none and keeps the default.
  if (storeOverride !== undefined && mesh.storeDir !== undefined && resolvePath(storeOverride) !== mesh.storeDir)
    throw new CommandFailure("refused", "CONFLICT", `the broker for "${mesh.space}" runs on the store ${mesh.storeDir}, not ${resolvePath(storeOverride)}; nothing was stopped`, { target: { root, space: mesh.space, storeDir: mesh.storeDir }, remedy: `omit --store-dir, or pass --store-dir ${shellWord(mesh.storeDir)}` });
  const storeDir = storeOverride ? resolveStore(storeOverride) : mesh.storeDir ?? join(root, ".cotal", "nats");
  // The store cap the broker was started with travels with the store, so the resume re-renders it.
  const cap: { maxFileStore?: number } = mesh.maxFileStore !== undefined ? { maxFileStore: mesh.maxFileStore } : {};
  const lock = acquirePreserveLock(root, mesh.space);
  try {
    const additiveAttempts = listAdditiveTeamAttempts(root);
    if (retainedAdditiveTeamAttempts(additiveAttempts).length || additiveAttempts.refused.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "an additive attempt or returned additive deployment remains; preserve-state down did not fold its resources into the retained stack", { target: { root, space: mesh.space, deploymentIds: retainedAdditiveTeamAttempts(additiveAttempts).map((attempt) => attempt.deploymentId), unreadable: additiveAttempts.refused.map(({ path }) => path) } });
    const all = localProcessSurface();
    const context: LocalProcessContext = { root, space: mesh.space };
    const existing = readMaintenanceJournal(root);
    // A completed restore keeps its journal, and a new cut begins only after that journal is retired.
    if (existing && "restore" in existing && existing.state === "active")
      throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a completed restore still holds this root's maintenance journal; a new preserve begins only after it is retired, so nothing was stopped", { target: { root, space: mesh.space, attemptId: existing.restore.attemptId }, remedy: restoreNextStep(existing.state, existing.restore.attemptId, existing) });
    if (existing && existing.state !== "cut-intent" && existing.state !== "cut-committed" && existing.state !== "ready")
      throw new Error(`cannot preserve while maintenance state is ${existing.state}`);
    if (existing && (existing.space !== mesh.space || existing.mode !== mesh.mode ||
        !sameStoreIdentity(existing.source, readStoreIdentity(storeDir)) || existing.cut.launch.server !== mesh.server))
      throw new Error(`preservation retry ${existing.cut.attemptId} does not match the current mesh launch`);
    if (existing?.state === "ready") {
      await waitForEndpointUnreachable(mesh.server);
      console.log(c.dim(`state for "${mesh.space}" is already preserved and offline`));
      return;
    }
    // A saved service depends on the broker, so the cut does not stop the broker under one. It
    // refuses and stops nothing, as bare down does.
    assertNoLiveServices(mesh.space, "down --preserve-state");

    let attemptId: string;
    let resume;
    // Set when recovery force-commits a cut whose manager died AFTER stopping children (commit-intent
    // present): the shared commit block below is then skipped — the cut is already committed.
    let managerCommitJournaled = false;
    if (existing?.state === "cut-intent" || existing?.state === "cut-committed") {
      attemptId = existing.cut.attemptId;
      resume = existing.resume;
      if (existing.state === "cut-intent") {
        // A cut-intent retry must not depend on volatile manager memory: re-prepare the SAME
        // attempt (idempotent on the fenced manager, a fresh fence on a restarted one) and prove
        // the re-prepared inventory is byte-identical to the journaled resume document.
        const manager = all.find((component) => component.name === "manager");
        if (!manager) throw new Error("local process registry has no manager descriptor");
        if (!mayBeRunning(manager, context)) { // fail-closed: an uncertain manager is treated as alive, not dead
          const committing = readPreservationCommitIntent(root);
          if (!committing || committing.attemptId !== attemptId) {
            // No commit intent recorded: the child-stopping RPC was never invoked, so nothing was
            // stopped with suppression. Safe to abandon instead of wedging.
            abortMaintenanceCut(lock);
            clearPreservationPrepareIntent(lock);
            throw new Error(`preservation attempt ${attemptId} lost its manager before commit; the cut intent was aborted - heal the stack with \`cotal up\` if needed, then rerun \`cotal down --preserve-state\``);
          }
          // Commit intent is durable: the manager was asked to stop its children and may already have
          // done so. Deleting the cut here would lose the retained inventory (this was the bug). While
          // the broker outlives the manager in this window, confirm no retained principal is still live
          // before finishing forward; if the broker is already gone we cannot check, but preserving the
          // cut still beats deleting it. Then journal cut-committed and finish WITHOUT the dead manager.
          if (await isReachable(mesh.server)) {
            const retained = retainedPrincipalKeys(readMaintenanceResumeDocument(root, existing.resume).inventory);
            if (retained.size) {
              const stillLive = (await readPresenceWithoutConsumer(mesh.space, mesh.server))
                .roster.filter((presence) => retained.has(presence.card.id)).map((presence) => presence.card.id);
              if (stillLive.length)
                throw new Error(`preservation attempt ${attemptId} lost its manager mid-commit and ${stillLive.length} retained principal(s) are still live (${stillLive.join(", ")}); the cut intent is PRESERVED for inspection - stop them, then rerun \`cotal down --preserve-state\``);
            }
          }
          recordPreservationManagerCommit(lock, { operation: "commitPreservation", attemptId, state: "preserved" });
          clearPreservationCommitIntent(lock);
          clearPreservationPrepareIntent(lock);
          managerCommitJournaled = true;
        }
        if (!managerCommitJournaled) {
        const retryTarget = await resolveControlTarget({ space: mesh.space, server: mesh.server }, "control-caller-admin");
        // Plane-3 fence precedes the re-prepared inventory, exactly as on the fresh path.
        const retryDelivery = all.find((component) => component.name === "delivery");
        if (retryDelivery && mayBeRunning(retryDelivery, context)) await stopLocalProcess(retryDelivery, context); // fence an uncertain delivery too (stopLocalProcess throws loud on unattributable → abort)
        const reprepared = await askManager(cliControl, retryTarget.space, retryTarget.server, "preparePreservation", { attemptId }, retryTarget.auth, "any", 60_000);
        const replan = reprepared.ok ? reprepared.data as { inventory?: unknown; failures?: unknown[]; state?: string } : undefined;
        if (!replan?.inventory || (replan.failures?.length ?? 0) !== 0 || (replan.state !== "prepared" && replan.state !== "preserved"))
          throw new Error(reprepared.error ?? "manager could not re-prepare the recorded preservation attempt");
        try {
          writeMaintenanceResumeDocument(lock, {
            version: MAINTENANCE_RESUME_DOCUMENT_VERSION,
            inventory: replan.inventory as JsonValue,
            launch: { attemptId, space: mesh.space, server: mesh.server, storeDir, ...cap, mode: mesh.mode },
          });
        } catch (cause) {
          // A restarted manager prepared a DIFFERENT inventory: the journaled cut no longer
          // matches reality. Release its fence and abandon the stale intent; a rerun cuts fresh.
          try {
            await askManager(cliControl, retryTarget.space, retryTarget.server, "abortPreservation", { attemptId }, retryTarget.auth, "any", 30_000);
          } catch { /* best effort - the fence dies with the manager */ }
          abortMaintenanceCut(lock);
          clearPreservationPrepareIntent(lock);
          throw new Error(`preservation attempt ${attemptId} no longer matches its manager's inventory (${(cause as Error).message}); the stale cut intent was aborted - rerun \`cotal down --preserve-state\``);
        }
        }
      }
    } else {
      // The cut takes its agent inventory from the manager that serves the space. A stack with no
      // manager, such as one started with --no-manager, refuses here, before the prepare intent, the
      // delivery stop or any other effect.
      if ((await readPresenceAndLease(mesh.space, mesh.server)).managerId === undefined)
        throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "no manager serves this space, so --preserve-state cannot take the agent inventory it preserves; nothing was stopped", {
          target: { root, space: mesh.space, server: mesh.server },
          remedy: "start this stack's manager with `cotal up`, then run `cotal down --preserve-state` again",
        });
      // The attempt binding is durable BEFORE the manager is fenced: a crash between manager
      // preparation and the cut-intent journal retries with the exact attempt the manager holds.
      const intent = readPreservationPrepareIntent(root);
      if (intent) {
        if (intent.space !== mesh.space || intent.mode !== mesh.mode || intent.server !== mesh.server || intent.storeDir !== storeDir)
          throw new Error(`preservation prepare intent ${intent.attemptId} does not match the current mesh launch; inspect .cotal/maintenance before retrying`);
        attemptId = intent.attemptId;
      } else {
        attemptId = `preserve-${Date.now()}-${process.pid}`;
        writePreservationPrepareIntent(lock, {
          attemptId, space: mesh.space, mode: mesh.mode, server: mesh.server, storeDir,
        });
      }
      const target = await resolveControlTarget({ space: mesh.space, server: mesh.server }, "control-caller-admin");
      // Fence Plane 3 BEFORE any inventory work: with the delivery daemon stopped, no durable
      // join/leave can mutate MEMBERS at or after the moment the inventory is taken.
      const delivery = all.find((component) => component.name === "delivery");
      const deliveryFenced = delivery !== undefined && mayBeRunning(delivery, context);
      if (delivery && deliveryFenced) await stopLocalProcess(delivery, context); // fence an uncertain delivery: no MEMBERS mutation may race the inventory
      const prepared = await askManager(
        cliControl,
        target.space,
        target.server,
        "preparePreservation",
        { attemptId },
        target.auth,
        "any",
        60_000,
      );
      let plan: { inventory?: unknown; failures?: unknown[]; state?: string } | undefined;
      try {
        if (!prepared.ok) throw new Error(prepared.error ?? "manager preservation prepare failed");
        plan = prepared.data as { inventory?: unknown; failures?: unknown[]; state?: string } | undefined;
        if (!plan?.inventory || (plan.failures?.length ?? 0) !== 0 || (plan.state !== "prepared" && plan.state !== "preserved"))
          throw new Error("manager returned an invalid or incomplete preservation plan");
        const retainedPrincipals = retainedPrincipalKeys(plan.inventory);
        let observed = await readPresenceWithoutConsumer(mesh.space, mesh.server);
        retainedPrincipals.add(observed.managerId);
        let unmanaged = observed.roster.filter((presence) => !retainedPrincipals.has(presence.card.id));
        if (unmanaged.length) {
          await sleep(11_000); // Let stopped predecessor presence and manager leases expire before refusing.
          observed = await readPresenceWithoutConsumer(mesh.space, mesh.server);
          retainedPrincipals.add(observed.managerId);
          unmanaged = observed.roster.filter((presence) => !retainedPrincipals.has(presence.card.id));
        }
        // A known, clean refusal, classified as one: it used to be a bare Error, reported as an
        // unknown outcome (`OPERATION_UNKNOWN`) with no next step (#4510).
        if (unmanaged.length)
          throw new CommandFailure("refused", "LIFECYCLE_BLOCKED",
            `cannot preserve while unmanaged endpoints are live: ${unmanaged.map((presence) => unmanagedEndpointLabel(presence.card.name, presence.card.id)).join(", ")} (manager lease holder: ${observed.managerId}); nothing was preserved`,
            { remedy: "stop those endpoints, or wait for their presence to expire, then run `cotal down --preserve-state` again" });
        // A seat that cannot be checkpointed is refused HERE, at prepare time, while every child is
        // still running. This reads only the prepared inventory, so it needs nothing that stopping
        // would provide, and refusing after the stack is down would cost the operator a running mesh
        // to tell them the cut was never going to complete.
        assertSeatsCheckpointable(plan.inventory);
      } catch (cause) {
        // A refused prepare (or a live-unmanaged / uncheckpointable refusal) must not leave the
        // manager fenced in "preserving" mode with no running preservation to finish: abort the
        // attempt (best effort, the same shape as the stale-inventory retry above) and clear the
        // intent, so the operator is left with a running, unfenced mesh and the refusal reason.
        try {
          await askManager(cliControl, target.space, target.server, "abortPreservation", { attemptId }, target.auth, "any", 30_000);
        } catch { /* best effort - the fence dies with the manager */ }
        clearPreservationPrepareIntent(lock);
        // The delivery daemon was stopped above as the Plane 3 fence, and a refusal used to leave
        // it stopped: the operator read "running, unfenced mesh" while no spawn, retirement or join
        // could complete until the next `cotal up` (#4510). Start it again, and when that fails say
        // so in the refusal, so what it names is what is actually left. An open mesh runs no
        // daemon, so one an earlier open boot left behind stays stopped.
        if (deliveryFenced && mesh.mode !== "open") {
          const notRestarted = await restartFencedDelivery(mesh.space, mesh.server, target.auth.tls === true);
          if (notRestarted !== undefined) {
            const message = `${cause instanceof Error ? cause.message : String(cause)}; the delivery daemon stopped for the cut could not be started again (${notRestarted})`;
            throw new CommandFailure("refused", isCommandFailure(cause) ? cause.code : "LIFECYCLE_BLOCKED", message,
              { remedy: "start the delivery daemon with `cotal up`, then address the refusal and run `cotal down --preserve-state` again" });
          }
        }
        throw cause;
      }
      resume = writeMaintenanceResumeDocument(lock, {
        version: MAINTENANCE_RESUME_DOCUMENT_VERSION,
        inventory: plan.inventory as JsonValue,
        launch: {
          attemptId,
          space: mesh.space,
          server: mesh.server,
          storeDir,
          ...cap,
          mode: mesh.mode,
        },
      });
      beginMaintenanceCut(lock, {
        attemptId,
        space: mesh.space,
        mode: mesh.mode,
        sourcePath: storeDir,
        resume,
        launch: { server: mesh.server, storeDir, ...cap },
      });
      clearPreservationPrepareIntent(lock);
    }

    // Stop the children through the manager, then journal cut-committed. A commit-intent marker is
    // written FIRST (the stop RPC is about to execute) and cleared once cut-committed is durable, so a
    // crash in the gap leaves proof the stop may already have run — recovery finishes forward instead
    // of deleting the cut. `managerCommitJournaled` means a dead-manager recovery already committed above.
    if (existing?.state !== "cut-committed" && !managerCommitJournaled) {
      const manager = all.find((component) => component.name === "manager");
      if (!manager) throw new Error("local process registry has no manager descriptor");
      // This one DELIBERATELY keeps `processAlive` (provably alive), not `mayBeRunning`: here we must
      // USE the manager to prove every retained child stopped, so anything short of provably-alive -
      // dead OR uncertain - must fail closed and preserve the cut. `processAlive` already returns
      // false on `unknown`, so an uncertain manager throws here rather than being trusted to attest.
      if (!processAlive(manager, context))
        throw new Error("cannot complete preservation because the attempt-bound manager is not alive to prove every retained child stopped; recovery must preserve the cut-intent journal for inspection");
      // Fault window: cut-intent journaled but the child-stopping RPC not yet invoked (no commit
      // intent). A crash here is genuinely pre-commit — recovery MUST still abort, not finish forward.
      if (process.env.COTAL_SMOKE_EXIT_AFTER_CUT_INTENT_BEFORE_COMMIT === "1") process.exit(93);
      writePreservationCommitIntent(lock, { attemptId });
      const target = await resolveControlTarget({ space: mesh.space, server: mesh.server }, "control-caller-admin");
      const commit = await askManager(
        cliControl,
        target.space,
        target.server,
        "commitPreservation",
        { attemptId },
        target.auth,
        "any",
        120_000,
      );
      if (!commit.ok) throw new Error(commit.error ?? "manager preservation commit was incomplete");
      const result = commit.data as { state?: string; failures?: unknown[] } | undefined;
      if (result?.state !== "preserved" || (result.failures?.length ?? 0) !== 0)
        throw new Error("manager could not prove every retained child stopped");
      // Fault window: the manager has COMMITTED (children stopped, preservation irreversible) but the
      // coordinator has not yet journaled cut-committed. A crash here leaves the journal at cut-intent
      // WITH the commit-intent marker set — the exact window recovery must not treat as pre-commit.
      if (process.env.COTAL_SMOKE_EXIT_AFTER_MANAGER_STOP_BEFORE_JOURNAL === "1") process.exit(92);
      recordPreservationManagerCommit(lock, { operation: "commitPreservation", attemptId, state: "preserved" });
      clearPreservationCommitIntent(lock);
      if (process.env.COTAL_SMOKE_EXIT_AFTER_PRESERVATION_MANAGER_COMMIT === "1") process.exit(90);
    }

    const rank = (component: LocalProcess): number => {
      if (component.name === "delivery") return 20;
      if (component.name === "manager") return 30;
      if (component.name === "auth") return 40;
      if (component.stopLast) return 100;
      return 10;
    };
    const ranked = [...all].sort((a, b) => rank(a) - rank(b) || (a.order ?? 50) - (b.order ?? 50));
    // The quiescence proof runs BETWEEN two stop phases. Everything it proves dead — the
    // lease-holding daemons, delivery and manager — stops before it. The user-auth service holds no
    // lease, so the proof does not cover it, and on a USER mesh the proof's own broker connect
    // exchanges through that service: stop it first and the cut can no longer prove itself, ending
    // at cut-committed with the broker still up. It stops after the proof, still before the broker.
    const afterQuiescence = (component: LocalProcess): boolean => component.stopLast || component.name === "auth";
    for (const component of ranked.filter((component) => !afterQuiescence(component)))
      await stopLocalProcess(component, context);
    // Wire-truth quiescence while the broker still answers: every control-plane daemon must be
    // provably lease-dead, not merely pidfile-absent, before the broker stops and ready publishes.
    // An already-unreachable broker is itself the proof - nothing can mutate broker-resident state
    // through a dead endpoint, and the final unreachable check below re-verifies it.
    if (await isReachable(mesh.server)) await assertControlPlaneQuiesced(mesh.space, mesh.server);
    // rank() keeps auth (40) ahead of the broker (stopLast, 100) within this phase.
    for (const component of ranked.filter(afterQuiescence))
      await stopLocalProcess(component, context);
    // Fail-closed: a component we cannot PROVE stopped (unattributable/unknown pidfile) leaves the
    // cut partial - it must not be silently counted as gone, or `unknown` becomes a "successful cut".
    const stillRunning = all.filter((component) => mayBeRunning(component, context));
    if (stillRunning.length)
      throw new Error(`preservation cut is partial; still running (or liveness unconfirmed): ${stillRunning.map((component) => component.name).join(", ")}`);
    await waitForEndpointUnreachable(mesh.server);
    // Step 7 and 8 of the cut. ONLY here: the manager has proven every child exited
    // (`commitPreservation` above returned state "preserved" with no failures) and the whole stack
    // is down, so nothing is writing to a working tree or a transcript. A capture any earlier races
    // the harness by construction.
    const captured = await captureSeatCheckpoints(root, mesh.space, resume, seatCheckpointDir(root, attemptId), sessionStores);
    completeMaintenanceCut(lock, {
      attemptId,
      observedAt: new Date().toISOString(),
      managerCommit: { operation: "commitPreservation", attemptId, state: "preserved" },
      stopped: { manager: true, broker: true, localProcesses: true },
      listener: { endpoint: mesh.server, unreachable: true },
    });
    console.log(c.green(`✓ preserved state for "${mesh.space}"`));
    console.log(c.dim(`  source: ${storeDir}`));
    console.log(c.dim(`  resume inventory: ${join(root, ".cotal", "maintenance", "v1", resume.file)}`));
    for (const seat of captured)
      console.log(c.dim(`  checkpoint: ${seat.name} (${seat.session.continuity}, generation ${seat.generation}) -> ${join(seatCheckpointDir(root, attemptId), seat.name)}`));
    console.log(c.dim("  stack remains stopped; create a backup or deliberately resume with `cotal up`"));
  } finally {
    releaseMaintenanceLock(lock);
  }
}

/**
 * Refuse any seat the cut could not checkpoint, from the prepared inventory alone.
 *
 * Called at prepare time, before a single child is stopped. The capture itself must wait until the
 * stack is proven down, but the DECISION about whether a capture is possible reads only the
 * inventory, so it belongs where the operator still has a running mesh.
 *
 * A seat the manager would refuse to resume is refused here too, with the manager's own wording:
 * `Manager.inventoryReferenceError` says `imperative launch options have no non-secret durable
 * source`, and a checkpoint inherits that refusal rather than writing something that will not
 * reproduce the seat.
 */
export function assertSeatsCheckpointable(inventory: unknown): void {
  for (const entry of ((inventory as { agents?: ManagerResumeAgentShape[] }).agents ?? [])) {
    const keys = entry.launch?.unresolvedLaunchOptionKeys ?? [];
    if (keys.length)
      throw new Error(`imperative launch options have no non-secret durable source (${keys.join(", ")}): seat ${entry.name} cannot be checkpointed`);
    if (!entry.launch?.cwd) throw new Error(`seat ${entry.name} has no launch cwd to capture`);
  }
}

/** Capture one checkpoint per retained seat, after the cut has proven the whole stack down. */
export async function captureSeatCheckpoints(
  root: string,
  space: string,
  resume: MaintenanceResumeDescriptor,
  destination: string,
  sessionStores: readonly string[],
): Promise<SeatCheckpoint[]> {
  const document = readMaintenanceResumeDocument(root, resume);
  const inventory = document.inventory as { agents?: ManagerResumeAgentShape[] } | undefined;
  const agents = inventory?.agents ?? [];
  const sealed: SeatCheckpoint[] = [];
  for (const entry of agents) {
    // Re-asserted over the document that was actually written, not the plan read at prepare time.
    assertSeatsCheckpointable({ agents: [entry] });
    const cwd = entry.launch.cwd as string;
    // The generation this cut is taken at, from what this host holds. A destination claims the
    // successor by exclusive create before it launches anything.
    const held = loadSeatWriterGeneration(root, space, entry.name);
    const connector = await connectorCapabilities(entry.launch.connector);
    // The store is applied to every CONTINUATION-CAPABLE seat and to no other. A connector that
    // does not reopen a session has nothing to reopen it from, and carrying a transcript for it
    // would put harness bytes in an artifact that can never use them.
    const carriesSession = Boolean(connector?.supportsSessionContinuation);
    sealed.push(captureSeatCheckpoint(join(destination, entry.name), entry, {
      cwd,
      space,
      name: entry.name,
      lifecycleUid: entry.identity.lifecycleUid,
      generation: held?.generation ?? 0,
      workspaceRoot: root,
      profile: {
        configSha256: entry.launch.source.configSha256,
        ...(entry.launch.source.manifestSha256 ? { manifestSha256: entry.launch.source.manifestSha256 } : {}),
        ...(entry.launch.source.hash ? { hash: entry.launch.source.hash } : {}),
      },
      connector,
      ...(entry.launch.sessionId ? { sessionId: entry.launch.sessionId } : {}),
      ...(carriesSession && entry.launch.sessionStatePath ? { sessionStatePath: entry.launch.sessionStatePath } : {}),
      ...(carriesSession && sessionStores.length ? { sessionStorePaths: sessionStores } : {}),
    }));
  }
  return sealed;
}

/** Resolve a connector's DECLARED capabilities. An unresolvable connector is `undefined`, which
 *  `sessionContinuityClass` reads as drain-only: unknown capabilities are default-deny and no
 *  continuation promise may be inferred from a package name or a host-local probe. */
async function connectorCapabilities(name: string): Promise<Pick<Connector, "supportsResume" | "supportsSessionContinuation" | "supportsFreshStart"> | undefined> {
  try {
    return await materializeFromManifest<Connector>({ kind: "connector", name });
  } catch {
    return undefined;
  }
}

function resolveStore(path: string): string {
  const resolved = path.startsWith("/") ? path : join(process.cwd(), path);
  return resolved;
}

/** Wire-truth control-plane quiescence: a live manager/delivery daemon renews its lease
 *  continuously, so the cut publishes `ready` only once BOTH lease buckets hold no live value —
 *  a dead daemon's lease expires by TTL, a pidless live one keeps renewing and is refused here.
 *  Pidfiles are hints; leases are proof. */
export async function assertControlPlaneQuiesced(space: string, server: string): Promise<void> {
  const resolved = await connectOrExit({ space, server }, "deployer");
  const user = resolved.bearer ? await userViewAuthOrExit(resolved, "deployer") : undefined;
  const nc = await dialerFor(server)({
    servers: server,
    ...standaloneConnectOpts({ ...(user ?? { creds: resolved.creds }), tls: resolved.tls }),
    maxReconnectAttempts: 0,
  });
  try {
    const jsm = await jetstreamManager(nc);
    const liveKeys = async (bucket: string): Promise<string[]> => {
      let subjects: string[];
      try {
        const info = await jsm.streams.info(`KV_${bucket}`, { subjects_filter: `$KV.${bucket}.>` });
        subjects = Object.keys(info.state.subjects ?? {});
      } catch (error) {
        if (/stream not found/i.test((error as Error).message)) return [];
        throw error;
      }
      const live: string[] = [];
      for (const subject of subjects) {
        if (await directKvValue(nc, `KV_${bucket}`, subject, true) !== undefined) live.push(subject);
      }
      return live;
    };
    const deadline = Date.now() + Math.max(LEASE_TTL_MS, MANAGER_LEASE_TTL_MS) + 5_000;
    for (;;) {
      const deliveryLive = await liveKeys(deliveryBucket(space));
      const managerLive = await liveKeys(managerBucket(space));
      if (deliveryLive.length === 0 && managerLive.length === 0) return;
      if (Date.now() >= deadline)
        throw new Error(`control-plane leases are still live past their TTL (delivery: ${deliveryLive.length}, manager: ${managerLive.length}); a pidless daemon may still be running - the cut refuses to publish ready`);
      await sleep(500);
    }
  } finally {
    await drainAndClose(nc).catch(() => {});
  }
}

/** Read current KV subjects by Direct Get so the cut check leaves no ephemeral/native consumer.
 *
 *  Exported for the gated tombstone cell. A regression test for the lease walk has to run through
 *  THIS function, not a transcription of it: a copy carries its own `allowEmpty` parameter, so it
 *  stays green when the argument at the real call site is removed and proves nothing about the fix. */
export async function readPresenceWithoutConsumer(space: string, server: string): Promise<{ roster: Presence[]; managerId: string }> {
  const { roster, managerId } = await readPresenceAndLease(space, server);
  if (managerId === undefined) throw new Error("manager lease has no authoritative holder principal");
  return { roster, managerId };
}

/** The roster and the principal holding the space's manager lease, or no holder when no manager
 *  serves the space. */
async function readPresenceAndLease(space: string, server: string): Promise<{ roster: Presence[]; managerId?: string }> {
  const resolved = await connectOrExit({ space, server }, "deployer");
  const user = resolved.bearer ? await userViewAuthOrExit(resolved, "deployer") : undefined;
  const nc = await dialerFor(server)({
    servers: server,
    ...standaloneConnectOpts({ ...(user ?? { creds: resolved.creds }), tls: resolved.tls }),
    maxReconnectAttempts: 0,
  });
  try {
    const directValue = async <T>(stream: string, subject: string, allowEmpty = false): Promise<T | undefined> =>
      directKvValue<T>(nc, stream, subject, allowEmpty);
    const bucket = presenceBucket(space);
    const stream = `KV_${bucket}`;
    const prefix = `$KV.${bucket}.`;
    const info = await (await jetstreamManager(nc)).streams.info(stream, { subjects_filter: `${prefix}>` });
    const roster: Presence[] = [];
    for (const subject of Object.keys(info.state.subjects ?? {})) {
      const presence = await directValue<unknown>(stream, subject, true);
      if (presence === undefined) continue; // A positively identified KV tombstone has no value bytes.
      if (!isPresenceRow(presence, subject.slice(prefix.length))) throw new Error(`presence record ${subject} is malformed`);
      roster.push(presence);
    }
    // ENUMERATE THE PER-INSTANCE LEASE KEYS. P2 item 3 demoted this bucket from a single `lease` key to
    // one `lease.<instanceId>` per manager, and NOTHING WRITES THE BARE PREFIX ANY MORE — the supervisor's
    // grant is `$KV.<bucket>.lease.*`, which does not even cover it, so no writer can legalise it. Reading
    // the bare subject threw inside `directKvValue` on every preserve-state cut, which meant the holder
    // guard on the next line was unreachable and the operator saw "maintenance inventory read failed"
    // instead. Same STREAM.INFO + point-get shape as `liveKeys` above: no consumer, no new grant.
    const leaseBucket = managerBucket(space);
    const leaseStream = `KV_${leaseBucket}`;
    // `lease.*`, not `lease.>`: `managerLeaseKey` is contractually ONE lowercase-alnum token, so `*`
    // matches exactly the key space that can exist while `>` would additionally admit a malformed
    // multi-token key. Matches `readManagerLease`'s filter — two probes of one bucket disagreeing on
    // their wildcard is drift the next reader has to adjudicate from scratch.
    const leaseInfo = await (await jetstreamManager(nc)).streams.info(leaseStream, { subjects_filter: `$KV.${leaseBucket}.${MANAGER_LEASE_KEY}.*` });
    let lease: ManagerLeaseInfo | undefined;
    for (const subject of Object.keys(leaseInfo.state.subjects ?? {})) {
      // `allowEmpty` MUST be true here. STREAM.INFO lists tombstoned subjects, so a cleanly stopped
      // manager's released key is in this walk; without it `directKvValue` THROWS on the tombstone
      // instead of returning undefined, and the cut dies naming a dead manager's key before a live
      // holder later in the list is ever examined. `Object.keys` order decides whether it fires, so
      // it is a coin flip on exactly the clean-stop scenario. Both sibling walks in this function
      // (`liveKeys`, the presence roster) already pass true; this one was copied from them without it.
      const held = await directValue<ManagerLeaseInfo>(leaseStream, subject, true);
      if (held?.holder) { lease = held; break; }
    }
    if (!lease?.holder) return { roster };
    return { roster, managerId: parsePrincipalKey(lease.holder) ? lease.holder : principalKey(DEV_OWNER, lease.holder).key };
  } finally {
    await drainAndClose(nc).catch(() => {});
  }
}

/** `liveness` keeps `probeLiveness`'s three states so each caller picks its direction: a presence
 *  reader requires `"alive"`, a destructive guard proceeds only on `"dead"`. No record and an empty
 *  husk are `"dead"`; unattributable content and a removal reservation are `"unknown"`, because
 *  `cotal down` refuses them as possibly fronting a live process. */
export type PidfileState = { pid?: number; liveness: "alive" | "dead" | "unknown"; note?: string };

/** The one classifier of a pidfile, read through `readPidfile`, `parsePid` and `probeLiveness` in
 *  `@cotal-ai/workspace`: positive integers only, and `EPERM` means the process exists.
 *  `processAlive` and `mayBeRunning` are its two directions. */
export function pidfileState(path: string): PidfileState {
  const raw = readPidfile(path);
  if (raw === undefined) return { liveness: "dead", note: "no pidfile" };
  if (raw.startsWith("removing:")) return { liveness: "unknown", note: "extension removal in progress" };
  const pid = parsePid(raw);
  if (!pid) return { liveness: raw ? "unknown" : "dead", note: "bad pidfile" };
  const pin = verifyIdentityPin(path);
  if (pin.kind === "mismatch") return { pid, liveness: "dead", note: "foreign pid" };
  if (pin.kind === "gone" || pin.kind === "no-pid") return { pid, liveness: "dead", note: "stale pidfile" };
  if (pin.kind !== "match" && pin.kind !== "legacy") return { pid, liveness: "unknown", note: `identity ${pin.kind}` };
  const liveness = probeLiveness(pid);
  if (liveness === "alive" && process.platform === "linux") {
    // kill(pid, 0) also succeeds after exit, until the parent reaps the process.
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = stat[stat.lastIndexOf(")") + 2];
      if (state === "Z" || state === "X") return { pid, liveness: "dead", note: "stale pidfile" };
    } catch { /* Keep the signal result when procfs cannot be read. */ }
  }
  if (liveness === "alive") return { pid, liveness };
  return { pid, liveness, note: liveness === "dead" ? "stale pidfile" : "liveness unknown" };
}
