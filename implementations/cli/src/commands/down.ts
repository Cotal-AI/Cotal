import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CompletionResult, type ParsedArgs } from "@cotal-ai/core";
import {
  abortMaintenanceCut,
  acquireMaintenanceLock,
  beginMaintenanceCut,
  clearPreservationPrepareIntent,
  completeMaintenanceCut,
  loadMeshes,
  localProcessPath,
  readMaintenanceJournal,
  readPreservationPrepareIntent,
  readStoreIdentity,
  recordPreservationManagerCommit,
  releaseMaintenanceLock,
  removeMeshesByRoot,
  sameStoreIdentity,
  writePreservationPrepareIntent,
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
    const dependants = all.filter((component) => !selectedNames.has(component.name) && processAlive(component, context));
    if (dependants.length) {
      throw new Error(
        `cannot stop ${selected.filter((component) => component.stopLast).map((component) => component.name).join(", ")} while ${dependants.map((component) => component.name).join(", ")} ${dependants.length === 1 ? "is" : "are"} still running - name them too, or run bare \`cotal down\``,
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
const parsePid = (raw: string): number | undefined => {
  const pid = Number(raw.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
};
export const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

export function processRecorded(component: LocalProcess, context: LocalProcessContext): boolean {
  return existsSync(localProcessPath(component.pidFile, context)) || (component.artifacts ?? []).map((artifact) => localProcessPath(artifact, context)).some(existsSync);
}

export function processAlive(component: LocalProcess, context: LocalProcessContext): boolean {
  const pidPath = localProcessPath(component.pidFile, context);
  if (!existsSync(pidPath)) return false;
  const pid = parsePid(readFileSync(pidPath, "utf8"));
  return pid !== undefined && isAlive(pid);
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
    try {
      markerFd = openSync(marker, "wx", 0o600);
      writeFileSync(markerFd, String(process.pid));
      break;
    } catch (e) {
      if (markerFd !== undefined) {
        closeSync(markerFd);
        rmSync(marker, { force: true });
        markerFd = undefined;
      }
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let owner: number | undefined;
      try {
        owner = parsePid(readFileSync(marker, "utf8"));
      } catch (readErr) {
        if ((readErr as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw readErr;
      }
      if (owner && isAlive(owner))
        throw new Error(`${component.name} is already being stopped by another \`cotal down\` (pid ${owner})`);
      // A dead owner cannot finish cleanup. Reclaim its marker and retry the exclusive create.
      rmSync(marker, { force: true });
    }
  }
  closeSync(markerFd);

  let stopped = false;
  try {
    if (pid === undefined) {
      console.log(c.dim(`${component.label} had an invalid pidfile.`));
      stopped = true;
      return true;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      if (isAlive(pid)) throw new Error(`could not signal ${component.label} (pid ${pid})`);
      console.log(c.dim(`${component.label} (pid ${pid}) was not running.`));
      stopped = true;
      return true;
    }
    const graceDeadline = Date.now() + 15_000;
    while (isAlive(pid) && Date.now() < graceDeadline) await sleep(100);
    if (isAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* raced to exit */ }
      const hardDeadline = Date.now() + 3_000;
      while (isAlive(pid) && Date.now() < hardDeadline) await sleep(100);
    }
    if (isAlive(pid)) throw new Error(`${component.label} (pid ${pid}) did not exit; its pidfile was preserved`);
    stopped = true;
    console.log(c.green(`✓ stopped ${component.label} (pid ${pid})`));
    return true;
  } finally {
    if (stopped || pid === undefined || !isAlive(pid)) {
      rmSync(pidPath, { force: true });
    }
    rmSync(marker, { force: true });
  }
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
    if (existing?.state === "cut-intent" || existing?.state === "cut-committed") {
      attemptId = existing.cut.attemptId;
      resume = existing.resume;
      if (existing.state === "cut-intent") {
        // A cut-intent retry must not depend on volatile manager memory: re-prepare the SAME
        // attempt (idempotent on the fenced manager, a fresh fence on a restarted one) and prove
        // the re-prepared inventory is byte-identical to the journaled resume document.
        const manager = all.find((component) => component.name === "manager");
        if (!manager) throw new Error("local process registry has no manager descriptor");
        if (!processAlive(manager, context)) {
          // Pre-commit, nothing was stopped with suppression: abandon instead of wedging.
          abortMaintenanceCut(lock);
          clearPreservationPrepareIntent(lock);
          throw new Error(`preservation attempt ${attemptId} lost its manager before commit; the cut intent was aborted - heal the stack with \`cotal up\` if needed, then rerun \`cotal down --preserve-state\``);
        }
        const retryTarget = await resolveControlTarget({ space: mesh.space, server: mesh.server }, "control-caller-admin");
        // Plane-3 fence precedes the re-prepared inventory, exactly as on the fresh path.
        const retryDelivery = all.find((component) => component.name === "delivery");
        if (retryDelivery && processAlive(retryDelivery, context)) await stopLocalProcess(retryDelivery, context);
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
      if (delivery && processAlive(delivery, context)) await stopLocalProcess(delivery, context);
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
      const inventoryAgents = ((plan.inventory as { agents?: Array<{
        identity?: { mode?: string; id?: string; owner?: string; actor?: string };
      }> }).agents ?? []);
      const retainedPrincipals = new Set(inventoryAgents.map((agent) => {
        if (agent.identity?.mode === "user" && agent.identity.owner && agent.identity.actor)
          return principalKey(agent.identity.owner, agent.identity.actor).key;
        if (agent.identity?.id) return principalKey(DEV_OWNER, agent.identity.id).key;
        return undefined;
      }).filter((id): id is string => Boolean(id)));
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

    // The manager's preservation commitment is journaled BEFORE any process stops: from
    // cut-committed onward, retries finish the remaining stopped/unreachable checks idempotently
    // without requiring the (by then intentionally dead) manager.
    if (existing?.state !== "cut-committed") {
      const manager = all.find((component) => component.name === "manager");
      if (!manager) throw new Error("local process registry has no manager descriptor");
      if (!processAlive(manager, context))
        throw new Error("cannot complete preservation because the attempt-bound manager is not alive to prove every retained child stopped; recovery must preserve the cut-intent journal for inspection");
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
      recordPreservationManagerCommit(lock, { operation: "commitPreservation", attemptId, state: "preserved" });
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
    for (const component of ranked.filter((component) => !component.stopLast))
      await stopLocalProcess(component, context);
    // Wire-truth quiescence while the broker still answers: every control-plane daemon must be
    // provably lease-dead, not merely pidfile-absent, before the broker stops and ready publishes.
    // An already-unreachable broker is itself the proof - nothing can mutate broker-resident state
    // through a dead endpoint, and the final unreachable check below re-verifies it.
    if (await isReachable(mesh.server)) await assertControlPlaneQuiesced(mesh.space, mesh.server);
    for (const component of ranked.filter((component) => component.stopLast))
      await stopLocalProcess(component, context);
    const stillRunning = all.filter((component) => processAlive(component, context));
    if (stillRunning.length)
      throw new Error(`preservation cut is partial; still running: ${stillRunning.map((component) => component.name).join(", ")}`);
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
    [`auth-service.${encodeURIComponent(space)}.pid`, "user-auth service"],
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
