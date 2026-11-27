import { realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CustodianIdentity } from "./custodian.js";
import { observeWindowsProcess, windowsUserSid } from "./host.js";
import { capabilityToken } from "./record.js";
import { windowsHostTransport, windowsWriterProof, type WindowsSharedIdentity } from "./shared-control-win32.js";
import { acquireWindowsCustodyLock, checkWindowsCustodyRoot } from "./shared-files-win32.js";
import { serveSharedHost } from "./shared-host-v2.js";
import { createWindowsSeatIsolation } from "./shared-isolation-win32.js";
import type { ProcessObservation } from "./shared-platform.js";
import { pinWindowsSeatArtifacts, readWindowsHost, readWindowsPrivateRecord, windowsHostRecords, writeWindowsPrivateRecord, type WindowsHostRecord } from "./shared-record-win32.js";
import { assertWindowsRetainedRuntime } from "./shared-runtime-win32.js";
import { deriveWindowsSeatSlot, windowsLineageDescriptorPath, type WindowsSeatSlot } from "./shared-slot-win32.js";
import { windowsCustodyTask } from "./shared-task-win32.js";

export interface WindowsHostPlan {
  version: 1;
  slot: WindowsSeatSlot;
  session: number;
}

export const windowsHostPlanPath = (root: string): string => join(root, "launch.json");
const attemptPath = (root: string): string => join(root, "attempt.json");
export const windowsBootstrapReceipt = (root: string): string => join(root, "bootstrap.json");

export function readWindowsAttempt(root: string) {
  const row = readWindowsPrivateRecord(attemptPath(root), 512);
  if (row.state !== "verified") return row;
  return typeof row.value === "string" && /^[a-f0-9]{32}$/.test(row.value) ? { state: "verified" as const, value: row.value } : { state: "unknown" as const };
}

export function writeWindowsAttempt(root: string, attempt: string): void {
  writeWindowsPrivateRecord(attemptPath(root), attempt, 512);
}

export function clearRefusedWindowsAttempt(root: string): void {
  unlinkSync(attemptPath(root));
}

export function readWindowsBootstrap(root: string, attempt: string) {
  const result = readWindowsPrivateRecord(windowsBootstrapReceipt(root), 2048);
  if (result.state !== "verified" || !result.value || typeof result.value !== "object") return undefined;
  const value = result.value as { attempt?: unknown; outcome?: unknown; host?: WindowsHostRecord };
  if (value.attempt !== attempt || (value.outcome !== "ready" && value.outcome !== "refused") || !value.host ||
      value.host.user !== windowsUserSid() || !Number.isSafeInteger(value.host.pid) || value.host.pid <= 1 ||
      typeof value.host.start !== "string" || !/^[1-9][0-9]{0,19}$/.test(value.host.start) || !Number.isSafeInteger(value.host.session) || value.host.session <= 0 ||
      value.host.version !== 2 || value.host.protocol !== 2 || typeof value.host.token !== "string" || !/^[a-f0-9]{64}$/.test(value.host.token)) return undefined;
  return { outcome: value.outcome, host: value.host } as const;
}

export function windowsHostRuntime(slot: WindowsSeatSlot) {
  const root = join(dirname(dirname(slot.root)), "runtime");
  return { root, key: slot.generation, program: join(root, "node.exe"), entry: join(root, "seat", "dist", "shared-host-win32.js") };
}

export function readWindowsHostPlan(root: string, name: string): WindowsHostPlan {
  const result = readWindowsPrivateRecord(windowsHostPlanPath(root), 4096);
  if (result.state !== "verified") throw new Error("Windows PTY launch plan is unknown");
  const plan = result.value as Partial<WindowsHostPlan> | null;
  const slot = plan?.slot;
  if (plan?.version !== 1 || !slot || slot.sid !== windowsUserSid() || slot.root !== root || !/^[a-f0-9]{32}$/.test(slot.key) ||
      basename(root) !== slot.key || name !== slot.name || name !== `cotal-pty-${slot.key}-${slot.sid}` || slot.pipe !== `\\\\.\\pipe\\${name}` ||
      !/^[a-f0-9]{64}$/.test(slot.generation) || basename(dirname(root)) !== "hosts" || basename(dirname(dirname(root))) !== slot.generation ||
      typeof slot.lineage !== "string" || !/^[a-f0-9]{32}$/.test(basename(slot.lineage)) ||
      dirname(slot.lineage) !== join(resolve(root, "..", "..", ".."), "lineages") ||
      !Number.isSafeInteger(plan.session) || plan.session! <= 0 || plan.session! > 0x7fffffff)
    throw new Error("Windows PTY launch plan does not match its task");
  checkWindowsCustodyRoot(slot.lineage);
  const descriptor = readWindowsPrivateRecord(windowsLineageDescriptorPath(slot.lineage), 8192);
  if (typeof slot.installation !== "string" || !/^[a-z]:\\/.test(slot.installation) || slot.installation.toLowerCase() !== slot.installation ||
      typeof slot.space !== "string" || descriptor.state !== "verified" ||
      JSON.stringify(descriptor.value) !== JSON.stringify({ version: 1, installation: slot.installation, sid: slot.sid, space: slot.space }))
    throw new Error("Windows PTY launch plan lineage is unknown");
  const pinned = deriveWindowsSeatSlot(resolve(root, "..", "..", ".."), slot.installation, slot.sid, slot.space, slot.generation);
  if (JSON.stringify(pinned) !== JSON.stringify(slot)) throw new Error("Windows PTY launch plan lineage changed");
  return { version: 1, slot, session: plan.session! };
}

/** Native root death does not prove the job empty. The terminal adapter owns that proof. */
function windowsChildProof(host: WindowsHostRecord): CustodianIdentity<WindowsSharedIdentity> {
  return {
    capture(custodianPid, childPid) {
      const child = observeWindowsProcess(childPid);
      if (custodianPid !== host.pid || !child || child.user !== host.user || child.session !== host.session)
        throw new Error("Windows PTY child identity is unknown");
      return { custodianStart: host.start, childStart: child.birth };
    },
    matches(identity, row) {
      return identity.pid === row.childPid && identity.start === row.childStart && identity.user === host.user && identity.session === host.session;
    },
    observe(row): ProcessObservation {
      if (!row.childStart) return "unknown";
      const state = windowsWriterProof.observe({ pid: row.childPid, start: row.childStart, user: host.user, session: host.session });
      return state === "gone" ? "unknown" : state;
    },
  };
}

async function serve(root: string, name: string): Promise<void> {
  if (!isAbsolute(root)) throw new Error("Windows PTY host root is not absolute");
  const { slot, session } = readWindowsHostPlan(root, name);
  const processIdentity = windowsWriterProof.current();
  if (!processIdentity || processIdentity.user !== slot.sid || processIdentity.session !== session)
    throw new Error("Windows PTY host is not in the recorded interactive session");
  const runtime = windowsHostRuntime(slot);
  if (realpathSync.native(process.execPath).toLowerCase() !== runtime.program.toLowerCase() ||
      realpathSync.native(fileURLToPath(import.meta.url)).toLowerCase() !== runtime.entry.toLowerCase())
    throw new Error("Windows PTY host is not running from the retained task action");
  const release = acquireWindowsCustodyLock(join(slot.root, "host.lock"));
  try {
    const attempt = readWindowsAttempt(slot.root);
    if (attempt.state !== "verified" || readWindowsBootstrap(slot.root, attempt.value))
      throw new Error("Windows PTY host task was not armed for this start");
    assertWindowsRetainedRuntime(runtime.root, runtime.key);
    const registration = windowsCustodyTask(slot, runtime, session).inspect();
    if (!registration.present || !registration.enabled || registration.instances !== 1)
      throw new Error("Windows PTY host task is not verified running");
    const prior = readWindowsHost(slot);
    if (prior.state === "unknown" || (prior.state === "verified" && windowsWriterProof.observe(prior.value) !== "gone"))
      throw new Error("Windows PTY host already has an unresolved lifetime");
    const host: WindowsHostRecord = { ...processIdentity, version: 2, protocol: 2, token: capabilityToken() };
    const recordBootstrap = (outcome: "ready" | "refused") =>
      writeWindowsPrivateRecord(windowsBootstrapReceipt(root), { attempt: attempt.value, outcome, host }, 2048);
    const records = windowsHostRecords(slot, host);
    await serveSharedHost({ host, generation: slot.generation, socket: slot.pipe, address: { pipe: slot.pipe, session },
      // Task Scheduler observation runs in a bounded child process before the dial can authenticate.
      initialIdleMs: 15_000,
      transport: { ...windowsHostTransport, listen(address, accept, ready) {
        return windowsHostTransport.listen(address, accept, ready, () => recordBootstrap("refused"));
      } },
      records: { ...records, publishHost() { records.publishHost(); recordBootstrap("ready"); } }, writer: windowsWriterProof, childIdentity: windowsChildProof(host),
      eligiblePayload({ name, cwd, artifactRoot, spec }) {
        return typeof name === "string" && !!name && typeof cwd === "string" && isAbsolute(cwd) &&
          typeof artifactRoot === "string" && isAbsolute(artifactRoot) && typeof spec?.command === "string" && isAbsolute(spec.command) &&
          Array.isArray(spec.args) && spec.args.every(arg => typeof arg === "string");
      },
      pinArtifacts({ spec, artifactRoot }) {
        if (artifactRoot !== join(dirname(dirname(slot.lineage)), "artifacts")) throw new Error("Windows PTY artifact root does not belong to this host");
        return pinWindowsSeatArtifacts(spec.artifacts, artifactRoot);
      },
      isolate: () => createWindowsSeatIsolation(runtime.root),
    });
  } finally { release(); }
}

if (process.platform === "win32" && process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , root, name] = process.argv;
  if (!root || !name) process.exitCode = 1;
  else void serve(root, name).catch(() => { process.exitCode = 1; });
}
