import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { LaunchSeatOpts } from "./launcher.js";
import { exitPath, seatId } from "./record.js";
import { sharedCgroupAvailable } from "./shared-cgroup.js";
import { acquireSharedClosureLease, collectSharedRuntimeClosures } from "./shared-closure-lease.js";
import { publishControllerClaim } from "./shared-controller-claim.js";
import { dialSharedLinuxSocket } from "./shared-control-linux.js";
import { SharedControlError, SharedController } from "./shared-controller.js";
import { acquireSharedExecutionLease } from "./shared-execution-lease.js";
import { observeSharedHandle, openSharedSeat, type SharedHandle } from "./shared-handle.js";
import { childIdentity, generationIdentity, matchesSeatPin, observeLinuxSharedProcess, readManagedHost, readSeatInHost, sameGeneration, type SharedSeatIdentity } from "./shared-managed-platform.js";
import type { HostBootstrap } from "./shared-platform.js";
import { privateDirectory, readSharedHost, readSharedSeat, sharedSeatRecord, sharedSeatWasRefused, SHARED_PROTOCOL_VERSION, writePrivateRecord, type SharedHostRecord, type SharedSeatRecord } from "./shared-record.js";
import { prepareSharedRuntimeClosure, prepareStagedSharedRuntime, verifySharedRuntimeClosure, verifyStagedSharedRuntime, type SharedRuntimeClosure, type VerifiedStagedRuntimeSource } from "./shared-runtime-closure.js";
import { SharedSeatClient } from "./shared-seat-client.js";

const run = promisify(execFile);
const closures = new Map<string, SharedRuntimeClosure>();
const channels = new Map<string, { host: SharedHostRecord; controller: SharedController }>();
const opening = new Map<string, Promise<HostBootstrap<SharedHostRecord>>>();

/** Linux-only authority to start an empty retained host. Not the Manager's writer claim. */
interface LinuxBootstrapAuthority {
  root: string;
  store: string;
  closure: SharedRuntimeClosure;
  staged?: VerifiedStagedRuntimeSource | undefined;
}

async function ensureManagedHost({ root, store, closure, staged }: LinuxBootstrapAuthority): Promise<HostBootstrap<SharedHostRecord>> {
  let hold: ReturnType<typeof acquireSharedExecutionLease> | undefined;
  let copy: ReturnType<typeof acquireSharedClosureLease> | undefined;
  let dispatched = false;
  try {
    const existing = readManagedHost(root);
    if (existing.state === "verified") return { state: "ready", host: existing.value };
    if (existing.state === "unknown") return existing;
    const scope = `cotal-pty-${seatId()}.service`;
    copy = acquireSharedClosureLease(store, closure.digest);
    if (staged) hold = acquireSharedExecutionLease(staged.root, "shared", staged.inventorySha256);
    const pinned = staged ? verifyStagedSharedRuntime(store, closure.digest, staged) : verifySharedRuntimeClosure(store, closure.digest);
    copy.assertCurrent();
    writePrivateRecord(join(root, "execution.json"), { version: 1, digest: closure.digest, scope, copyDev: copy.dev, copyIno: copy.ino,
      ...(staged && hold ? { root: staged.root, inventorySha256: staged.inventorySha256, dev: hold.dev, ino: hold.ino } : {}) });
    dispatched = true;
    await run("/usr/bin/systemd-run", ["--user", "--quiet", "--collect", "--service-type=exec", `--unit=${scope}`,
      "--property=Delegate=memory", "--property=OOMPolicy=continue", "--property=KillMode=control-group", "--property=TimeoutStopSec=3s", "--property=Restart=no",
      "--property=UnsetEnvironment=NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH", "--setenv=PATH=/usr/bin:/bin",
      `--setenv=HOME=${homedir()}`, `--setenv=TMPDIR=${tmpdir()}`,
      ...(process.env.DO_NOT_TRACK === "1" ? ["--setenv=DO_NOT_TRACK=1"] : []),
      "--", pinned.nodePath, pinned.entryPath, root, scope, store, closure.digest,
      ...(staged ? [staged.root, staged.inventorySha256] : [])],
    { timeout: 5_000 });
    for (let n = 0; n < 60; n++) {
      const host = readManagedHost(root);
      if (host.state === "unknown") return host;
      if (host.state === "verified") { copy.assertCurrent(); hold?.assertCurrent(); return { state: "ready", host: host.value }; }
      await delay(50);
    }
  } catch { return { state: dispatched ? "unknown" : "ineligible" }; }
  finally { hold?.release(); copy?.release(); }
  return { state: "unknown" };
}

function controllerFor(root: string, host: SharedHostRecord, exact = false): SharedController {
  const channel = channels.get(root);
  if (channel?.host.pid === host.pid && channel.host.start === host.start && channel.host.bootId === host.bootId && channel.host.scope === host.scope &&
      (!exact || sameGeneration(generationIdentity(root, channel.host), generationIdentity(root, host))))
    return channel.controller;
  if (channel && observeLinuxSharedProcess(channel.host) === "gone") channel.controller.close();
  const recorded = { ...host };
  const controller = new SharedController(recorded, timeout => dialSharedLinuxSocket(root, recorded, timeout));
  channels.set(root, { host: recorded, controller });
  return controller;
}

function seatInHost(root: string, id: string, host: SharedHostRecord): SharedSeatRecord | undefined {
  const row = readSeatInHost(root, id, host);
  return row.state === "verified" ? row.value : undefined;
}

function observedSeat(root: string, row: SharedSeatRecord, controller: SharedController): SharedHandle {
  return observeSharedHandle(row, new SharedSeatClient(controller, row), exitPath(sharedSeatRecord(root, row.id)));
}

/** No fallback after an unconfirmed write until either its exact seat appears or the host and
 * that seat's pre-commit record are proved absent. Hold the Manager admission meanwhile. */
async function reconcileLaunch(root: string, id: string, host: SharedHostRecord, controller: SharedController): Promise<SharedHandle | undefined> {
  for (;;) {
    if (sharedSeatWasRefused(root, id, host)) return undefined;
    const row = seatInHost(root, id, host);
    if (row) return observedSeat(root, row, controller);
    if (observeLinuxSharedProcess(host) === "gone") {
      try { readSharedSeat(root, id); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && !seatInHost(root, id, host)) return undefined; }
    } else if (await controller.launchState(id).catch(() => "unknown") === "absent") return undefined;
    await delay(250);
  }
}

/** Undefined means this runtime has proof that it did not admit a payload. */
export async function launchManagedSharedSeat(lineage: string, opts: LaunchSeatOpts, executionGeneration = "", staged?: VerifiedStagedRuntimeSource): Promise<SharedHandle | undefined> {
  let host: SharedHostRecord | undefined, root: string;
  const base = resolve(lineage), store = join(dirname(base), "host-runtime");
  try {
    if (!sharedCgroupAvailable() || typeof (process as typeof process & { execve?: unknown }).execve !== "function") return undefined;
    const closureKey = JSON.stringify([store, staged?.root, staged?.inventorySha256]);
    let closure = closures.get(closureKey);
    if (!closure) {
      closure = staged ? prepareStagedSharedRuntime(store, staged) : prepareSharedRuntimeClosure(store);
      closures.set(closureKey, closure);
      collectSharedRuntimeClosures(store, closure.digest);
    }
    const generation = createHash("sha256").update(JSON.stringify([executionGeneration, closure.digest])).digest("hex");
    if (!publishControllerClaim(base, generation)) return undefined;
    root = join(base, generation);
    privateDirectory(root);
    let active = opening.get(root);
    if (!active) {
      active = ensureManagedHost({ root, store, closure, staged }).finally(() => opening.delete(root));
      opening.set(root, active);
    }
    const bootstrap = await active;
    if (bootstrap.state === "ready") host = bootstrap.host;
  } catch { return undefined; }
  // Linux bootstraps only an empty host. Neither bootstrap failure state can have dispatched a seat.
  if (!host) { closures.delete(JSON.stringify([store, staged?.root, staged?.inventorySha256])); return undefined; }
  const controller = controllerFor(root, host), id = opts.id ?? seatId();
  const { command, args, env, confirm, confirmBefore, confirmReady, confirmBlockers, confirmNotice, artifacts } = opts.spec;
  try {
    await controller.launch(id, { name: opts.name, cwd: opts.cwd, artifactRoot: resolve(tmpdir()),
      spec: { command, args, env, confirm, confirmBefore, confirmReady, confirmBlockers, confirmNotice, artifacts } });
  } catch (error) {
    if (error instanceof SharedControlError && error.outcome === "not-admitted") return undefined;
  }
  return reconcileLaunch(root, id, host, controller);
}

/** Local acceptance/recovery seam. It does not install a Manager lifecycle or start a seat. */
export async function reopenManagedSharedSeat(root: string, id: string): Promise<SharedHandle> {
  root = resolve(root);
  if (readSharedHost(root).protocol === SHARED_PROTOCOL_VERSION) return openSharedSeat(root, id, true);
  return reopenMultiplexedSeat(root, id);
}

/** Reopen an exact read-only reference, without starting a host or selecting a launch generation. */
export async function reopenVerifiedSharedSeat(pin: SharedSeatIdentity): Promise<SharedHandle> {
  return reopenMultiplexedSeat(pin.host.authority.root, pin.id, pin);
}

async function reopenMultiplexedSeat(root: string, id: string, pin?: SharedSeatIdentity): Promise<SharedHandle> {
  const observation = readManagedHost(root);
  if (observation.state !== "verified") throw new Error("shared PTY host lifetime is unknown");
  const host = observation.value;
  const row = seatInHost(root, id, host);
  const child = row && childIdentity(row);
  if (!row || !child || observeLinuxSharedProcess(child) !== "live" ||
      (pin && !matchesSeatPin(pin, generationIdentity(root, host), row))) throw new Error("shared PTY seat is not verified live");
  if (!publishControllerClaim(dirname(root))) throw new Error("shared PTY host lifetime is unknown");
  const controller = controllerFor(root, host, pin !== undefined), client = new SharedSeatClient(controller, row);
  try {
    const health = await client.health();
    if (health.status !== "running" || observeLinuxSharedProcess(child) !== "live") throw new Error("shared PTY seat is not verified live");
    if (pin) {
      const current = readManagedHost(root);
      const currentRow = current.state === "verified" && seatInHost(root, id, current.value);
      if (current.state !== "verified" || !currentRow || !matchesSeatPin(pin, generationIdentity(root, current.value), currentRow))
        throw new Error("shared PTY seat is not verified live");
    }
    return observeSharedHandle(row, client, exitPath(sharedSeatRecord(root, id)));
  } catch (error) { client.close(); throw error; }
}
