/** Move only the authenticated updater pair out of the daemon's stop boundary. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { claimUpdateClosureAccess, inspectGlobalUpdateChild, readUpdateRecovery } from "@cotal-ai/workspace";
import { updateRuntime } from "@cotal-ai/cli/update";
import { queryDaemon } from "./client.js";
import { daemonPaths } from "./endpoint.js";
import { installedDaemonIdentity, planUninstall, unitReceiptFile } from "./install.js";
import { processBirth, readLifetimeRecord } from "./lifetime.js";

function run(file: string, args: string[]): string {
  return execFileSync(file, args, { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function property(unit: string, name: string): string {
  return run("systemctl", ["--user", "--no-ask-password", "show", unit, `--property=${name}`, "--value"]);
}
function group(pid: number): string {
  const rows = readFileSync(`/proc/${pid}/cgroup`, "utf8").trim().split("\n").filter(row => row.startsWith("0::"));
  if (rows.length !== 1) throw new Error("automatic update custody requires unified cgroup v2");
  return rows[0]!.slice(3);
}
const pause = () => new Promise(resolve => setTimeout(resolve, 50));

/** The old parent retains all restart, result, and rollback decisions. */
export async function adoptAutomaticUpdateChild(): Promise<void> {
  if (process.env.COTAL_AUTO_UPDATE !== "1" || process.platform !== "linux") return;
  const parent = process.ppid;
  const self = process.pid;
  const births = [processBirth(self), processBirth(parent)];
  if (parent <= 1 || births.some(value => !value)) throw new Error("updater process births are unavailable");
  const prefix = updateRuntime.installPrefix();
  if (!prefix) throw new Error("automatic update custody requires a verified global installation");
  const rootResult = updateRuntime.npm(["root", "-g", "--prefix", prefix]);
  if (rootResult.status !== 0 || !rootResult.stdout.trim()) throw new Error("cannot resolve the installed global root for update custody");
  const root = rootResult.stdout.trim();
  let markerNonce: string | undefined;
  function authenticate(): boolean {
    if (process.ppid !== parent || process.env.COTAL_UPDATE_PARENT !== String(parent) || process.env.COTAL_UPDATE_TARGET_VERSION !== updateRuntime.version()) throw new Error("update child binding changed");
    for (const [index, pid] of [self, parent].entries()) {
      if (statSync(`/proc/${pid}`).uid !== process.getuid!() || processBirth(pid) !== births[index]) throw new Error("updater UID or process birth changed");
    }
    const recovery = readUpdateRecovery();
    const owner = recovery?.owner;
    if (!owner || owner.pid !== parent || owner.start !== births[1] || owner.start !== process.env.COTAL_UPDATE_CLOSURE_START || owner.nonce !== process.env.COTAL_UPDATE_CLOSURE_NONCE || process.env.COTAL_UPDATE_CLOSURE_OWNER !== String(parent)) throw new Error("update journal does not authenticate this parent");
    const release = claimUpdateClosureAccess();
    release();
    const custody = inspectGlobalUpdateChild(root);
    if (custody.owner.state !== "active" || custody.owner.owner.pid !== parent || custody.owner.owner.start !== births[1]) throw new Error("global update lock does not authenticate this parent");
    const child = custody.child;
    if (!child || child.owner !== parent || child.operation !== "global reconcile" || child.phase === "ambiguous" || child.ownerStart !== births[1] || (markerNonce !== undefined && markerNonce !== child.nonce)) throw new Error("global reconcile marker changed or does not authenticate this parent");
    markerNonce = child.nonce;
    if (child.phase === "pending") return false;
    if (child.pid !== self || child.start !== births[0] || child.intermediary) throw new Error("global reconcile marker does not identify this child");
    return true;
  }
  const publicationDeadline = Date.now() + 5000;
  while (!authenticate()) {
    if (Date.now() >= publicationDeadline) throw new Error("parent did not publish its live reconcile child within five seconds");
    await pause();
  }
  const paths = daemonPaths();
  const receipt = readFileSync(unitReceiptFile(paths), "utf8");
  const plan = planUninstall(paths, process.env.COTAL_DAEMON_HOME);
  if (plan.mechanism !== "systemd-user" || !installedDaemonIdentity(paths, process.env.COTAL_DAEMON_HOME).same) throw new Error("automatic update does not own this systemd installation");
  const daemon = await queryDaemon({ paths });
  const lifetime = readLifetimeRecord(paths.lock);
  if (!daemon.ok || !lifetime?.start || daemon.result.pid !== lifetime.pid || processBirth(lifetime.pid) !== lifetime.start || statSync(`/proc/${lifetime.pid}`).uid !== process.getuid!() || [self, parent].includes(lifetime.pid)) throw new Error("daemon lifetime does not authenticate the native MainPID");
  const serviceGroup = property(plan.unit, "ControlGroup");
  function nativeIdentity(): void {
    if (readFileSync(unitReceiptFile(paths), "utf8") !== receipt || !installedDaemonIdentity(paths, process.env.COTAL_DAEMON_HOME).same || property(plan.unit, "MainPID") !== String(lifetime!.pid) || processBirth(lifetime!.pid) !== lifetime!.start || group(lifetime!.pid) !== serviceGroup) throw new Error("native daemon ownership changed during update adoption");
  }
  nativeIdentity();
  if (!serviceGroup || property(plan.unit, "FragmentPath") !== plan.unitPath) throw new Error("loaded native unit does not match its recorded service");
  const token = createHash("sha256").update(`${receipt}\0${parent}\0${births[1]}\0${process.env.COTAL_UPDATE_CLOSURE_NONCE}`).digest("hex");
  const scope = `cotal-update-${token.slice(0, 32)}.scope`;
  const description = `Cotal update ${token}`;
  const parentGroup = group(parent);
  const childGroup = group(self);
  if (parentGroup === serviceGroup && childGroup === serviceGroup) {
    const accepted = run("busctl", ["--user", "--no-pager", "--timeout=15s", "call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "StartTransientUnit", "ssa(sv)a(sa(sv))", scope, "fail", "2", "Description", "s", description, "PIDs", "au", "2", String(self), String(parent), "0"]);
    if (!/^o "\/org\/freedesktop\/systemd1\/job\/\d+"$/.test(accepted)) throw new Error(`scope start outcome is unknown: ${accepted}`);
  } else {
    // Retry children inherit the original parent's scope. Never create a new scope on retry.
    if (property(scope, "Description") !== description || property(scope, "Transient") !== "yes" || parentGroup !== property(scope, "ControlGroup") || childGroup !== parentGroup) throw new Error("updater pair is neither in its owned service nor its authenticated transaction scope");
  }
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (!authenticate()) throw new Error("live child marker reverted to pending");
    nativeIdentity();
    const scopeGroup = property(scope, "ControlGroup");
    if (scopeGroup && scopeGroup !== serviceGroup && !scopeGroup.startsWith(`${serviceGroup}/`) && property(scope, "Description") === description && property(scope, "Transient") === "yes" && property(scope, "ActiveState") === "active" && ["", "0"].includes(property(scope, "Job").split(" ")[0]!) && group(self) === scopeGroup && group(parent) === scopeGroup) {
      if (!authenticate()) throw new Error("live child marker changed after scope completion");
      nativeIdentity();
      console.log(`automatic update custody: parent ${parent} and child ${self} in ${scope}`);
      return;
    }
    if (Date.now() >= deadline) throw new Error("scope job completion and stable updater membership were not established");
    await pause();
  }
}
