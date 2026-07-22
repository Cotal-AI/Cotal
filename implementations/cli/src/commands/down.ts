import { closeSync, existsSync, linkSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { type CompletionResult, type ParsedArgs } from "@cotal-ai/core";
import {
  abortMaintenanceCut,
  acquireMaintenanceLock,
  assertSingleSpaceBroker,
  authDir,
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
  removeMeshesByRoot,
  sameStoreIdentity,
  writePreservationCommitIntent,
  writePreservationPrepareIntent,
  spaceKey,
  type LocalProcess,
  type LocalProcessContext,
  MAINTENANCE_RESUME_DOCUMENT_VERSION,
  writeMaintenanceResumeDocument,
  type JsonValue,
} from "@cotal-ai/workspace";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import {
  CONTROL_ADMIN,
  DEV_OWNER,
  isReachable,
  LEASE_TTL_MS,
  MANAGER_LEASE_KEY,
  MANAGER_LEASE_TTL_MS,
  deliveryBucket,
  managerBucket,
  presenceBucket,
  parsePrincipalKey,
  principalKey,
  standaloneConnectOpts,
  type ManagerLeaseInfo,
  type Presence,
} from "@cotal-ai/core";
import { extensionNames, localProcessSurface } from "../ext-loader.js";
import { c } from "../ui.js";
import { cotalRoot } from "../lib/paths.js";
import { parsePid, probeLiveness } from "../lib/pid.js";
import { resolveSpace } from "../lib/status.js";
import { downManifest } from "./down-manifest.js";
import { askManager, resolveControlTarget } from "../lib/control.js";
import { connectOrExit, userViewAuthOrExit } from "../lib/connect.js";
import { waitForEndpointUnreachable } from "../lib/endpoint-cut.js";

/** Complete selective component names without importing installed packages. */
export function downComplete(argv: string[]): CompletionResult {
  if (argv.some((word) => word === "-f" || word === "--file" || word === "--run"))
    return { items: [], directive: "nofiles" };
  if ((argv[argv.length - 1] ?? "").startsWith("-")) return { items: [], directive: "nofiles" };
  const used = new Set(argv.slice(0, -1).filter((word) => !word.startsWith("-")));
  return {
    items: extensionNames("local-process").filter((name) => !used.has(name)).map((value) => ({ value })),
    directive: "nofiles",
  };
}

/** Stop the whole local stack by default, or only named self-registered process components. The
 *  manifest forms remain ownership-scoped deploy teardown and cannot be mixed with components. */
export async function down(args: ParsedArgs): Promise<void> {
  const values = args.values as { file?: string; run?: string; "dry-run"?: boolean; "preserve-state"?: boolean; "store-dir"?: string };
  const requested = [...new Set(args.positionals)];
  // Every non-manifest `down` stops the shared broker and its per-space daemons; none of them can
  // address one space, so a multi-space root is refused up front rather than at the space-blind
  // pidfile lookup below. A manifest teardown (`-f`/`--run`) names its own space and is exempt.
  if (!values.file && !values.run) assertSingleSpaceBroker(authDir(cotalRoot()), "cotal down");
  if (values["preserve-state"]) {
    if (requested.length || values.file || values.run || values["dry-run"])
      throw new Error("--preserve-state is bare-whole-stack only and cannot be combined with components, --file, --run, or --dry-run");
    await preserveStateDown(values["store-dir"]);
    return;
  }
  if (values["store-dir"]) throw new Error("--store-dir is only valid with down --preserve-state");
  if ((values.file || values.run) && requested.length) {
    throw new Error("component names cannot be combined with --file or --run");
  }
  if (values.file || values.run) {
    await downManifest(values.file ?? "<run>", { run: values.run, dryRun: Boolean(values["dry-run"]) });
    return;
  }
  const all = localProcessSurface();
  const known = all.map((component) => component.name).sort();
  const unknown = requested.filter((name) => !known.includes(name));
  if (unknown.length)
    throw new Error(`unknown component${unknown.length > 1 ? "s" : ""} ${unknown.map((name) => JSON.stringify(name)).join(", ")} - known: ${known.join(", ")}`);
  const selected = (requested.length ? requested.map((name) => all.find((part) => part.name === name)!) : all)
    .sort((a, b) => Number(Boolean(a.stopLast)) - Number(Boolean(b.stopLast)) || (a.order ?? 50) - (b.order ?? 50));
  const context: LocalProcessContext = { root: cotalRoot(), space: resolveSpace(process.cwd()) };

  if (selected.some((component) => component.stopLast)) {
    const selectedNames = new Set(selected.map((component) => component.name));
    // Fail CLOSED: an unselected dependant that MIGHT be running (including one behind an
    // unattributable/unknown pidfile) blocks a stop-last shutdown - stopping the broker out from
    // under a live dependant we could not confirm gone is exactly the signer-orphan the contract
    // forbids. `mayBeRunning`, not `processAlive` (which reads uncertainty as "not running").
    const dependants = all.filter((component) => !selectedNames.has(component.name) && mayBeRunning(component, context));
    if (dependants.length) {
      throw new Error(
        `cannot stop ${selected.filter((component) => component.stopLast).map((component) => component.name).join(", ")} while ${dependants.map((component) => component.name).join(", ")} ${dependants.length === 1 ? "is" : "are"} still running (or its liveness cannot be confirmed) - name them too, or run bare \`cotal down\``,
      );
    }
  }

  if (values["dry-run"]) {
    const recorded = selected.filter((component) => processRecorded(component, context));
    for (const component of recorded) console.log(c.dim(`would stop ${component.label}`));
    if (!recorded.length) {
      const target = requested.length ? requested.join(", ") : "the local stack";
      console.error(c.red(`Nothing running for ${target} (no recorded pidfiles).`));
      process.exit(1);
    }
    console.log(c.dim("Dry run - nothing was changed. Re-run without --dry-run to stop these components."));
    return;
  }

  let any = false;
  let allStopped = true;
  for (const component of selected) {
    any = processRecorded(component, context) || any;
    if (component.stopLast && !allStopped) {
      console.error(c.red(`✗ not stopping ${component.label} because an earlier component did not stop`));
      continue;
    }
    try {
      await stopLocalProcess(component, context);
    } catch (e) {
      allStopped = false;
      console.error(c.red(`✗ ${(e as Error).message}`));
    }
  }
  if (!allStopped) {
    console.error(c.red("✗ not cleanly stopped - keeping artifacts and the registry entry"));
    process.exitCode = 1;
    return;
  }

  for (const component of selected) {
    for (const artifact of component.artifacts ?? []) rmSync(localProcessPath(artifact, context), { force: true });
  }

  // The broker owns the mesh registry entry and transient whole-mesh launch material. Selective
  // control-plane shutdown leaves both intact so `cotal up` can heal only what was stopped.
  if (selected.some((component) => component.clearsMesh)) {
    rmSync(join(context.root, ".cotal", "run"), { recursive: true, force: true });
    removeMeshesByRoot(context.root);
  }
  if (!any) {
    const target = requested.length ? requested.join(", ") : "the local stack";
    console.error(c.red(`Nothing running for ${target} (no recorded pidfiles).`));
    process.exit(1);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// The pid parser + liveness probe are the SHARED pid-attribution contract (`lib/pid.ts`), the same
// one `auth-proc` uses - so `cotal down`'s stop of the auth-service (a callout SIGNER) attributes a
// torn pidfile exactly as the direct helper does, instead of the old unbounded parser + two-state
// probe that mapped a kernel-unsignalable value to "dead" and orphaned the process under a clean
// stop. `isAlive` = the probe says the process EXISTS; every caller below feeds it a parsed pid.
export const isAlive = (pid: number): boolean => probeLiveness(pid) === "alive";

export function processRecorded(component: LocalProcess, context: LocalProcessContext): boolean {
  return existsSync(localProcessPath(component.pidFile, context)) || (component.artifacts ?? []).map((artifact) => localProcessPath(artifact, context)).some(existsSync);
}

export function processAlive(component: LocalProcess, context: LocalProcessContext): boolean {
  const pidPath = localProcessPath(component.pidFile, context);
  if (!existsSync(pidPath)) return false;
  const pid = parsePid(readFileSync(pidPath, "utf8"));
  return pid !== undefined && isAlive(pid);
}

/** Whether a component MIGHT still be running - the question the pre-stop `stopLast` guard must ask,
 *  and it fails CLOSED on uncertainty. A component with NO pidfile, an EMPTY husk, or a valid pid
 *  PROVEN dead (ESRCH) is not running. ANY other state - an unparsable/unattributable record, or a
 *  valid pid that is alive or whose liveness cannot be confirmed (`unknown`) - MIGHT be running, so
 *  it must BLOCK a stop-last (broker) shutdown. `processAlive` collapses unparsable and `unknown` to
 *  "not alive", which is fine for "is it worth stopping" but WRONG for "is it safe to stop the broker
 *  out from under this": that read would let `cotal down nats` orphan a live auth signer behind a
 *  torn pidfile. Only an ESRCH-confirmed death (or no record) clears a dependant. */
export function mayBeRunning(component: LocalProcess, context: LocalProcessContext): boolean {
  const pidPath = localProcessPath(component.pidFile, context);
  if (!existsSync(pidPath)) return false;
  const raw = readFileSync(pidPath, "utf8");
  if (raw.trim() === "") return false; // empty pre-protocol husk: no process behind it
  const pid = parsePid(raw);
  if (pid === undefined) return true; // unattributable content: cannot prove it gone → may be running
  return probeLiveness(pid) !== "dead"; // alive OR unknown → may be running; only ESRCH clears it
}

/** Stop one recorded process and await its actual exit before the next dependency is stopped. */
export async function stopLocalProcess(component: LocalProcess, context: LocalProcessContext): Promise<boolean> {
  const pidPath = localProcessPath(component.pidFile, context);
  const found = processRecorded(component, context);
  if (!existsSync(pidPath)) return found;

  const rawPid = readFileSync(pidPath, "utf8").trim();
  if (rawPid.startsWith("removing:")) {
    const owner = parsePid(rawPid.slice("removing:".length));
    throw new Error(
      owner && isAlive(owner)
        ? `${component.name} extension removal is in progress (pid ${owner})`
        : `${component.name} has a stale extension-removal reservation at ${pidPath} - remove that file and retry`,
    );
  }
  const pid = parsePid(rawPid);
  const marker = `${pidPath}.stopping`;
  let markerFd: number | undefined;
  for (;;) {
    // ATOMIC publish (the pid-slot pattern): fill a private temp inode with our pid FIRST, then
    // `link(2)` it as the marker - a no-overwrite atomic op. A contender therefore never observes an
    // empty marker mid-publish; the old `openSync(marker,"wx")` then `writeFileSync` left exactly
    // that window, and a reader in it saw owner=undefined and reclaimed a LIVE owner's reservation
    // (mutual exclusion defeated). The published name and the held fd both keep the inode alive.
    const temp = `${marker}.${process.pid}.${randomBytes(4).toString("hex")}`;
    try {
      markerFd = openSync(temp, "wx", 0o600);
      writeFileSync(markerFd, String(process.pid));
      linkSync(temp, marker); // EEXIST here = the marker is already held
      rmSync(temp, { force: true });
      break;
    } catch (e) {
      if (markerFd !== undefined) {
        closeSync(markerFd);
        markerFd = undefined;
      }
      try { rmSync(temp, { force: true }); } catch { /* never created, or already gone */ }
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let owner: number | undefined;
      try {
        owner = parsePid(readFileSync(marker, "utf8"));
      } catch (readErr) {
        if ((readErr as NodeJS.ErrnoException).code === "ENOENT") continue; // holder released between publish-refusal and read
        throw readErr;
      }
      // The atomic publish above is what closes the race: a LIVE `down` holding the marker always
      // wrote its own POSITIVE pid into it (no empty/partial window), so a live holder is always a
      // valid pid that is alive/EPERM/unknown - and THOSE we never reclaim (that is the mutual
      // exclusion). An UNATTRIBUTABLE marker (empty / 0 / negative / garbled) therefore cannot
      // represent a live holder; it is a stale or crashed reservation, and reclaiming it is both safe
      // and required so a crashed `down` never wedges the next one. So: reclaim an unattributable
      // owner or a valid pid PROVEN dead (ESRCH); refuse only a valid pid that is alive or whose
      // liveness we cannot confirm.
      if (owner !== undefined && probeLiveness(owner) !== "dead")
        throw new Error(`${component.name} is already being stopped by another \`cotal down\` (pid ${owner})`);
      rmSync(marker, { force: true });
    }
  }
  closeSync(markerFd);

  let stopped = false;
  try {
    if (pid === undefined) {
      // An EMPTY pidfile is a pre-protocol husk (no process behind it) and is safe to clear. Any
      // OTHER unattributable content (garbled, fractional, out-of-range - anything `parsePid`
      // rejects) may still front a LIVE process we cannot identify or signal; removing it would
      // orphan that process while reporting a clean stop (the signer-orphan this slice must not do).
      // Refuse loud and preserve it.
      if (rawPid === "") {
        console.log(c.dim(`${component.label} had an empty pidfile.`));
        stopped = true; // husk cleared in `finally`
        return true;
      }
      throw new Error(
        `${component.label} has an unattributable pidfile at ${pidPath} (${JSON.stringify(rawPid)}) - it may still front a running process; refusing to remove it or report a clean stop. Stop that process and remove the file manually.`,
      );
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch (e) {
      // ONLY an ESRCH proves the process is already gone (safe to clear). EPERM (exists, another
      // user's) or any other errno (EIO, argument errors, unknown) means we could NOT confirm death
      // - reporting it stopped and removing its record would orphan a live process. Fail loud, keep
      // the record. A two-state "not alive => gone" is exactly the bug: `unknown` is not `dead`.
      if ((e as NodeJS.ErrnoException).code === "ESRCH") {
        console.log(c.dim(`${component.label} (pid ${pid}) was not running.`));
        stopped = true;
        return true;
      }
      throw new Error(`could not signal ${component.label} (pid ${pid}) (${(e as NodeJS.ErrnoException).code ?? "unknown error"}) - refusing to report it stopped or remove its record; stop it manually`);
    }
    // Wait for CONFIRMED death (ESRCH), escalating to SIGKILL; `unknown`/`alive` both keep us
    // waiting, and if death is never confirmed the record is preserved (never deleted on a guess).
    const graceDeadline = Date.now() + 15_000;
    while (probeLiveness(pid) !== "dead" && Date.now() < graceDeadline) await sleep(100);
    if (probeLiveness(pid) !== "dead") {
      try { process.kill(pid, "SIGKILL"); } catch { /* raced to exit */ }
      const hardDeadline = Date.now() + 3_000;
      while (probeLiveness(pid) !== "dead" && Date.now() < hardDeadline) await sleep(100);
    }
    if (probeLiveness(pid) !== "dead")
      throw new Error(`${component.label} (pid ${pid}) did not exit, or its death could not be confirmed; its pidfile was preserved`);
    stopped = true;
    console.log(c.green(`✓ stopped ${component.label} (pid ${pid})`));
    return true;
  } finally {
    // Remove the pidfile ONLY when we confirmed a clean stop: `stopped` is set exclusively on an
    // ESRCH-proven death (already-gone, or a confirmed exit). Every other exit from the try above is
    // a throw that must PRESERVE the record - an unattributable pidfile, a process we could not
    // signal, or a death we could not confirm (`unknown`). The old `|| !isAlive(pid)` clause treated
    // `unknown` as gone and deleted a live process's record; it is gone.
    if (stopped) rmSync(pidPath, { force: true });
    rmSync(marker, { force: true });
  }
}

/** The principal keys of every retained agent in a preservation inventory — the dot-form ids that
 *  appear in the presence roster, so a caller can tell which retained agents are still live. */
function retainedPrincipalKeys(inventory: unknown): Set<string> {
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

async function preserveStateDown(storeOverride?: string): Promise<void> {
  const root = cotalRoot();
  const matching = loadMeshes().filter((mesh) => mesh.root === root);
  if (matching.length !== 1)
    throw new Error(`down --preserve-state requires exactly one recorded mesh for this root; found ${matching.length}`);
  const mesh = matching[0];
  const storeDir = storeOverride ? resolveStore(storeOverride) : join(root, ".cotal", "nats");
  const lock = acquireMaintenanceLock(root);
  try {
    const all = localProcessSurface();
    const context: LocalProcessContext = { root, space: mesh.space };
    const existing = readMaintenanceJournal(root);
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
        const reprepared = await askManager(retryTarget.space, retryTarget.server, "preparePreservation", { attemptId }, retryTarget.auth, CONTROL_ADMIN, 60_000);
        const replan = reprepared.ok ? reprepared.data as { inventory?: unknown; failures?: unknown[]; state?: string } : undefined;
        if (!replan?.inventory || (replan.failures?.length ?? 0) !== 0 || (replan.state !== "prepared" && replan.state !== "preserved"))
          throw new Error(reprepared.error ?? "manager could not re-prepare the recorded preservation attempt");
        try {
          writeMaintenanceResumeDocument(lock, {
            version: MAINTENANCE_RESUME_DOCUMENT_VERSION,
            inventory: replan.inventory as JsonValue,
            launch: { attemptId, space: mesh.space, server: mesh.server, storeDir, mode: mesh.mode },
          });
        } catch (cause) {
          // A restarted manager prepared a DIFFERENT inventory: the journaled cut no longer
          // matches reality. Release its fence and abandon the stale intent; a rerun cuts fresh.
          try {
            await askManager(retryTarget.space, retryTarget.server, "abortPreservation", { attemptId }, retryTarget.auth, CONTROL_ADMIN, 30_000);
          } catch { /* best effort - the fence dies with the manager */ }
          abortMaintenanceCut(lock);
          clearPreservationPrepareIntent(lock);
          throw new Error(`preservation attempt ${attemptId} no longer matches its manager's inventory (${(cause as Error).message}); the stale cut intent was aborted - rerun \`cotal down --preserve-state\``);
        }
        }
      }
    } else {
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
      if (delivery && mayBeRunning(delivery, context)) await stopLocalProcess(delivery, context); // fence an uncertain delivery: no MEMBERS mutation may race the inventory
      const prepared = await askManager(
        target.space,
        target.server,
        "preparePreservation",
        { attemptId },
        target.auth,
        CONTROL_ADMIN,
        60_000,
      );
      if (!prepared.ok) throw new Error(prepared.error ?? "manager preservation prepare failed");
      const plan = prepared.data as { inventory?: unknown; failures?: unknown[]; state?: string } | undefined;
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
      if (unmanaged.length)
        throw new Error(`cannot preserve while unmanaged endpoints are live: ${unmanaged.map((presence) => `${presence.card.name} (${presence.card.id})`).join(", ")} (manager lease holder: ${observed.managerId})`);
      resume = writeMaintenanceResumeDocument(lock, {
        version: MAINTENANCE_RESUME_DOCUMENT_VERSION,
        inventory: plan.inventory as JsonValue,
        launch: {
          attemptId,
          space: mesh.space,
          server: mesh.server,
          storeDir,
          mode: mesh.mode,
        },
      });
      beginMaintenanceCut(lock, {
        attemptId,
        space: mesh.space,
        mode: mesh.mode,
        sourcePath: storeDir,
        resume,
        launch: { server: mesh.server, storeDir },
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
        target.space,
        target.server,
        "commitPreservation",
        { attemptId },
        target.auth,
        CONTROL_ADMIN,
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
    console.log(c.dim("  stack remains stopped; create a backup or deliberately resume with `cotal up`"));
  } finally {
    releaseMaintenanceLock(lock);
  }
}

function resolveStore(path: string): string {
  const resolved = path.startsWith("/") ? path : join(process.cwd(), path);
  return resolved;
}

/** Direct Get one KV subject's last value without creating any consumer. `allowEmpty` treats a
 *  DEL/PURGE tombstone as absence instead of an error. */
async function directKvValue<T>(
  nc: NatsConnection,
  stream: string,
  subject: string,
  allowEmpty = false,
): Promise<T | undefined> {
  const response = await nc.request(
    `$JS.API.STREAM.MSG.GET.${stream}`,
    JSON.stringify({ last_by_subj: subject }),
    { timeout: 5_000 },
  );
  const body = JSON.parse(new TextDecoder().decode(response.data)) as {
    message?: { data?: string; hdrs?: string };
    error?: { description?: string };
  };
  if (body.error) throw new Error(`maintenance inventory read failed: ${body.error.description ?? "JetStream error"}`);
  if (!body.message?.data) {
    const headers = body.message?.hdrs ? Buffer.from(body.message.hdrs, "base64").toString("utf8") : "";
    if (allowEmpty && /^KV-Operation:\s*(?:DEL|PURGE)\s*$/im.test(headers)) return undefined;
    throw new Error(`maintenance inventory is missing ${subject}`);
  }
  return JSON.parse(Buffer.from(body.message.data, "base64").toString("utf8")) as T;
}

/** Wire-truth control-plane quiescence: a live manager/delivery daemon renews its lease
 *  continuously, so the cut publishes `ready` only once BOTH lease buckets hold no live value —
 *  a dead daemon's lease expires by TTL, a pidless live one keeps renewing and is refused here.
 *  Pidfiles are hints; leases are proof. */
async function assertControlPlaneQuiesced(space: string, server: string): Promise<void> {
  const resolved = await connectOrExit({ space, server }, "deployer");
  const user = resolved.bearer ? await userViewAuthOrExit(resolved, "deployer") : undefined;
  const nc = await connect({
    servers: server,
    ...standaloneConnectOpts(user ?? { creds: resolved.creds }),
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
    await nc.drain().catch(() => {});
  }
}

/** Read current KV subjects by Direct Get so the cut check leaves no ephemeral/native consumer. */
async function readPresenceWithoutConsumer(space: string, server: string): Promise<{ roster: Presence[]; managerId: string }> {
  const resolved = await connectOrExit({ space, server }, "deployer");
  const user = resolved.bearer ? await userViewAuthOrExit(resolved, "deployer") : undefined;
  const nc = await connect({
    servers: server,
    ...standaloneConnectOpts(user ?? { creds: resolved.creds }),
    maxReconnectAttempts: 0,
  });
  try {
    const directValue = async <T>(stream: string, subject: string, allowEmpty = false): Promise<T | undefined> =>
      directKvValue<T>(nc, stream, subject, allowEmpty);
    const bucket = presenceBucket(space);
    const stream = `KV_${bucket}`;
    const info = await (await jetstreamManager(nc)).streams.info(stream, { subjects_filter: `$KV.${bucket}.>` });
    const roster: Presence[] = [];
    for (const subject of Object.keys(info.state.subjects ?? {})) {
      const presence = await directValue<Presence>(stream, subject, true);
      if (!presence) continue; // A positively identified KV tombstone has no value bytes.
      if (!presence.card?.id) throw new Error(`presence record ${subject} is malformed`);
      roster.push(presence);
    }
    const leaseBucket = managerBucket(space);
    const lease = await directValue<ManagerLeaseInfo>(`KV_${leaseBucket}`, `$KV.${leaseBucket}.${MANAGER_LEASE_KEY}`);
    if (!lease?.holder) throw new Error("manager lease has no authoritative holder principal");
    return { roster, managerId: parsePrincipalKey(lease.holder) ? lease.holder : principalKey(DEV_OWNER, lease.holder).key };
  } finally {
    await nc.drain().catch(() => {});
  }
}

/** Compatibility inventory for `clean`; lifecycle commands use the registered descriptors above. */
export function pidfileTargets(space: string): Array<[file: string, label: string]> {
  return [
    ["manager.pid", "manager"],
    ["delivery.pid", "delivery daemon"],
    [`auth-service.${spaceKey(space)}.pid`, "user-auth service"],
    ["web.pid", "web dashboard"],
    ["nats.pid", "nats-server"],
  ];
}

export type PidfileState = { pid?: number; live: boolean; note?: string };

/** Shared hardened pid probe: positive integers only, and EPERM means the process exists. */
export function pidfileState(path: string): PidfileState {
  if (!existsSync(path)) return { live: false, note: "no pidfile" };
  const raw = readFileSync(path, "utf8").trim();
  if (raw.startsWith("removing:")) return { live: false, note: "extension removal in progress" };
  const pid = parsePid(raw);
  if (!pid) return { live: false, note: "bad pidfile" };
  return isAlive(pid) ? { pid, live: true } : { pid, live: false, note: "stale pidfile" };
}
