import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { LaunchSeatOpts } from "./launcher.js";
import { seatId } from "./record.js";
import { inspectWindowsAliasHold, reserveWindowsAliasHold, type WindowsAliasHold } from "./shared-alias-win32.js";
import { windowsSharedController, windowsWriterProof, type WindowsSharedIdentity } from "./shared-control-win32.js";
import { SharedControlError, type SharedController } from "./shared-controller.js";
import { withWindowsCustodyLock } from "./shared-files-win32.js";
import { observeNativeSharedHandle, type SharedHandle } from "./shared-handle.js";
import { clearRefusedWindowsAttempt, readWindowsAttempt, readWindowsBootstrap, readWindowsHostPlan, windowsHostPlanPath, windowsHostRuntime, writeWindowsAttempt } from "./shared-host-win32.js";
import type { HostBootstrap } from "./shared-platform.js";
import { publishWindowsControllerClaim, readWindowsHost, readWindowsPrivateRecord, readWindowsSeat, readWindowsSeatExit, windowsSeatWasRefused, writeWindowsPrivateRecord, type WindowsHostRecord, type WindowsSeatRecord } from "./shared-record-win32.js";
import { retainWindowsSeatRuntime } from "./shared-runtime-win32.js";
import { prepareWindowsSeatSlot, windowsSeatSlot, withWindowsSeatStoreFence, type WindowsSeatSlot } from "./shared-slot-win32.js";
import { windowsCustodyTask } from "./shared-task-win32.js";
import { SharedSeatClient } from "./shared-seat-client.js";

const opening = new Map<string, Promise<HostBootstrap<WindowsHostRecord>>>();
const channels = new Map<string, { host: WindowsHostRecord; controller: SharedController }>();
const PROOF_WAIT_MS = 12_000;

function sameSlot(a: WindowsSeatSlot, b: WindowsSeatSlot): boolean {
  return a.root === b.root && a.name === b.name && a.sid === b.sid && a.key === b.key &&
    a.lineage === b.lineage && a.generation === b.generation && a.pipe === b.pipe && a.installation === b.installation && a.space === b.space;
}

function taskFor(slot: WindowsSeatSlot, session: number) {
  const plan = readWindowsHostPlan(slot.root, slot.name);
  if (!sameSlot(plan.slot, slot) || plan.session !== session) throw new Error("Windows PTY host launch plan changed");
  return windowsCustodyTask(slot, windowsHostRuntime(slot), session);
}

function observeBootstrap(slot: WindowsSeatSlot, session: number): HostBootstrap<WindowsHostRecord> {
  const attempt = readWindowsAttempt(slot.root);
  if (attempt.state !== "verified") return { state: "unknown" };
  const receipt = readWindowsBootstrap(slot.root, attempt.value), row = readWindowsHost(slot);
  if (!receipt || receipt.host.session !== session || row.state === "unknown") return { state: "unknown" };
  if (receipt.outcome === "refused" && (row.state === "absent" || windowsWriterProof.observe(row.value) === "gone")) return { state: "ineligible" };
  if (receipt.outcome === "ready" && row.state === "verified" && row.value.token === receipt.host.token &&
      windowsWriterProof.same(row.value, receipt.host) && windowsWriterProof.observe(row.value) === "live")
    return { state: "ready", host: row.value };
  if (row.state === "absent" && windowsWriterProof.observe(receipt.host) === "gone") return { state: "ineligible" };
  return { state: "unknown" };
}

function requestBootstrap(slot: WindowsSeatSlot, session: number): HostBootstrap<WindowsHostRecord> {
  const old = readWindowsHost(slot), attempt = readWindowsAttempt(slot.root);
  if (old.state === "unknown" || attempt.state === "unknown") return { state: "unknown" };
  if (old.state === "verified" && (old.value.session !== session || windowsWriterProof.observe(old.value) !== "gone"))
    return observeBootstrap(slot, session);
  if (attempt.state === "verified") {
    const receipt = readWindowsBootstrap(slot.root, attempt.value);
    // After an unresolved RunEx or registration never issue a second one, even after Manager death.
    if (!receipt || receipt.host.session !== session || windowsWriterProof.observe(receipt.host) !== "gone") return observeBootstrap(slot, session);
  }
  const plan = readWindowsPrivateRecord(windowsHostPlanPath(slot.root), 4096);
  if (plan.state === "unknown") return { state: "unknown" };
  if (plan.state === "absent") writeWindowsPrivateRecord(windowsHostPlanPath(slot.root), { version: 1, slot, session }, 4096);
  const task = taskFor(slot, session), state = task.inspect();
  if (state.present && state.instances !== 0) return { state: "unknown" };
  if (state.present && !state.enabled) return { state: "ineligible" };
  writeWindowsAttempt(slot.root, seatId());
  const started = task.start();
  if (!started.present && started.refused) {
    clearRefusedWindowsAttempt(slot.root);
    return { state: "ineligible" };
  }
  return { state: "unknown" };
}

async function ensureHost(slot: WindowsSeatSlot, session: number): Promise<HostBootstrap<WindowsHostRecord>> {
  try {
    const request = withWindowsSeatStoreFence(slot, () => withWindowsCustodyLock(join(slot.root, "start.lock"), () => requestBootstrap(slot, session)));
    if (request.state !== "unknown") return request;
  } catch { /* A failed registration or native observation may be indeterminate. */ }
  const deadline = Date.now() + PROOF_WAIT_MS;
  do {
    const state = observeBootstrap(slot, session);
    if (state.state !== "unknown") return state;
    await delay(250);
  } while (Date.now() < deadline);
  return { state: "unknown" };
}

function controllerFor(slot: WindowsSeatSlot, host: WindowsHostRecord): SharedController {
  const existing = channels.get(slot.root);
  if (existing && windowsWriterProof.same(existing.host, host) && existing.host.token === host.token) return existing.controller;
  if (existing && windowsWriterProof.observe(existing.host) === "gone") existing.controller.close();
  const controller = windowsSharedController({ identity: host, protocol: host.protocol, token: host.token, authority: {
    pipe: slot.pipe, session: host.session, task: slot.name,
    verify(identity) {
      const task = taskFor(slot, identity.session);
      const row = readWindowsHost(slot), running = task.inspect();
      if (row.state !== "verified" || !windowsWriterProof.same(row.value, identity) || row.value.token !== host.token ||
          !running.present || !running.enabled || running.instances !== 1) throw new Error("Windows PTY host task proof is unknown");
    },
  } });
  channels.set(slot.root, { host, controller });
  return controller;
}

type WindowsSharedHandle = SharedHandle<WindowsSharedIdentity> & { waitForWorkExit(): Promise<void> };

function observeSeat(slot: WindowsSeatSlot, host: WindowsHostRecord, row: WindowsSeatRecord, client: SharedSeatClient): WindowsSharedHandle {
  const exit = () => {
    const evidence = readWindowsSeatExit(slot, row.id, host);
    return evidence.state === "verified" ? evidence.value : undefined;
  };
  const observed = observeNativeSharedHandle(row, client, {
    childIdentity: row.child,
    hostLife: () => windowsWriterProof.observe(host),
    childLife() {
      if (exit()) return "gone";
      const root = windowsWriterProof.observe(row.child);
      // The host can hold live descendants after the root has exited.
      return root === "gone" && windowsWriterProof.observe(host) !== "gone" ? "unknown" : root;
    },
    terminalEvidence: exit,
  });
  return { ...observed, async waitForWorkExit() {
    await observed.waitForExit();
    if (!exit()) throw new Error("Windows PTY exact job drain is unknown");
  } };
}

async function reconcileLaunch(slot: WindowsSeatSlot, id: string, host: WindowsHostRecord, controller: SharedController, hold: WindowsAliasHold) {
  for (;;) {
    const seat = readWindowsSeat(slot, id, host);
    if (seat.state === "verified") {
      const client = new SharedSeatClient(controller, seat.value);
      if (readWindowsSeatExit(slot, id, host).state === "verified" ||
          (windowsWriterProof.observe(host) === "gone" && windowsWriterProof.observe(seat.value.child) === "gone") ||
          (await client.health().catch(() => undefined))?.status === "running") return observeSeat(slot, host, seat.value, client);
      client.close();
    }
    if (windowsSeatWasRefused(slot, id, host).state === "verified") { hold.releaseRefused(); return undefined; }
    if (seat.state === "absent" && (windowsWriterProof.observe(host) === "gone" ||
        await controller.launchState(id).catch(() => "unknown") === "absent") && hold.releaseAbsent()) return undefined;
    await delay(250);
  }
}

type WindowsLaunch = { state: "ready"; handle: WindowsSharedHandle } | { state: "ineligible" };
const ineligible = { state: "ineligible" } as const;

/** Only a known pre-dispatch refusal permits legacy fallback. An unresolved admission stays held. */
export async function launchManagedWindowsSeat(installation: string, space: string, opts: Pick<LaunchSeatOpts, "name" | "spec" | "cwd" | "id">, holdInstallation: () => () => void): Promise<WindowsLaunch> {
  if (process.platform !== "win32") return ineligible;
  const self = windowsWriterProof.current();
  if (!self || self.session <= 0) return ineligible;
  if (inspectWindowsAliasHold(installation, space, opts.name) !== "clear") throw new Error("Windows PTY alias custody is held or unknown");
  let slot: WindowsSeatSlot;
  try {
    const runtime = retainWindowsSeatRuntime(installation);
    slot = windowsSeatSlot(installation, space, runtime.key);
    prepareWindowsSeatSlot(slot);
  } catch { return ineligible; }
  if (!publishWindowsControllerClaim(slot, slot.generation)) throw new Error("Windows PTY controller custody is unknown");
  let active = opening.get(slot.root);
  if (!active) {
    active = ensureHost(slot, self.session).finally(() => opening.delete(slot.root));
    opening.set(slot.root, active);
  }
  const bootstrap = await active;
  if (bootstrap.state === "ineligible") return ineligible;
  if (bootstrap.state === "unknown") throw new Error("Windows PTY task startup could not be confirmed");
  const host = bootstrap.host, id = opts.id ?? seatId(), controller = controllerFor(slot, host);
  const deadline = Date.now() + PROOF_WAIT_MS;
  for (;;) {
    try { await controller.connect(); break; }
    catch {
      if (windowsWriterProof.observe(host) === "gone") return ineligible;
      if (Date.now() >= deadline) throw new Error("Windows PTY host authentication could not be confirmed");
      await delay(250);
    }
  }
  const releaseInstallation = holdInstallation();
  let reserved: WindowsAliasHold | undefined;
  try { reserved = withWindowsSeatStoreFence(slot, () => reserveWindowsAliasHold(slot, opts.name, host, id)); }
  finally { releaseInstallation(); }
  // Reservation publication can have completed even if its confirmation was lost. Do not dispatch
  // or fall back on that path. The existing hold is reconciled from its own evidence.
  if (!reserved) throw new Error("Windows PTY alias custody could not be reserved");
  try {
    await controller.launch(id, { name: opts.name, cwd: opts.cwd, artifactRoot: resolve(tmpdir()), spec: opts.spec });
  } catch (error) {
    if (error instanceof SharedControlError && error.outcome === "not-admitted" && (reserved.releaseRefused() || reserved.releaseUnsent())) return ineligible;
  }
  const handle = await reconcileLaunch(slot, id, host, controller, reserved);
  if (handle) {
    const off = handle.attach().onExit(() => { off(); reserved.releaseExited(); });
  }
  return handle ? { state: "ready", handle } : ineligible;
}

export interface WindowsSeatPin {
  root: string;
  task: string;
  id: string;
  host: WindowsSharedIdentity;
  child: WindowsSharedIdentity;
}

/** Local integration/recovery seam. Never starts a host, dispatches, or selects a generation. */
export async function reopenVerifiedWindowsSeat(pin: Readonly<WindowsSeatPin>): Promise<SharedHandle<WindowsSharedIdentity>> {
  const { root, task, id } = pin;
  const hostPin = { ...pin.host }, childPin = { ...pin.child };
  const { slot, session } = readWindowsHostPlan(resolve(root), task);
  const row = readWindowsHost(slot);
  if (row.state !== "verified" || row.value.session !== session || windowsWriterProof.observe(row.value) !== "live" ||
      !windowsWriterProof.same(row.value, hostPin))
    throw new Error("Windows PTY host lifetime is unknown");
  const seat = readWindowsSeat(slot, id, row.value);
  if (seat.state !== "verified" || !windowsWriterProof.same(seat.value.child, childPin) ||
      !publishWindowsControllerClaim(slot)) throw new Error("Windows PTY seat custody is unknown");
  const client = new SharedSeatClient(controllerFor(slot, row.value), seat.value);
  try {
    const health = await client.health();
    const current = readWindowsHost(slot), exact = readWindowsSeat(slot, id, row.value);
    if (health.status !== "running" || windowsWriterProof.observe(row.value) !== "live" || current.state !== "verified" ||
        !windowsWriterProof.same(current.value, row.value) || current.value.token !== row.value.token || exact.state !== "verified" ||
        !windowsWriterProof.same(exact.value.child, seat.value.child) || exact.value.token !== seat.value.token)
      throw new Error("Windows PTY seat is not verified live");
    return observeSeat(slot, row.value, seat.value, client);
  } catch (error) { client.close(); throw error; }
}
