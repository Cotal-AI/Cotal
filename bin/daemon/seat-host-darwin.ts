import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import type { Socket } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { assertSystemdSource, createSystemdSource } from "@cotal-ai/cli";
import { writeSecretFileCreateOnly } from "@cotal-ai/core";
import { darwinBootSession, darwinLaunchdJob, darwinUserCacheDir, localPeerCredentials, processStartTime } from "@cotal-ai/seat";
import { homeCotalDir, readLocalRecordSource } from "@cotal-ai/workspace";
import { assertSocketPathFits, checkDir, daemonPaths, daemonPathsFor, ensureDir } from "./endpoint.js";
import { launchAgentLabel } from "./install-darwin.js";
import { daemonStartedByOwnedService } from "./install.js";
import { xmlText } from "./install-xml.js";
import { nativeRun } from "./install-native-run.js";
import { launchUpdatePid } from "./update-launchd.js";

const launchctl = "/bin/launchctl";
const limit = 64 * 1024;
export const darwinSeatHostInventoryLimit = 8;
const digest = (data: string): string => createHash("sha256").update(data).digest("hex");
const refusal = (): Error => new Error("could not verify the macOS PTY host job");

interface DarwinSeatHostPlan {
  readonly cotalHome: string;
  readonly daemonHome?: string;
  readonly id: string;
  readonly label: string;
  readonly source: string;
  readonly receipt: string;
  readonly sha256: string;
  readonly argv: readonly string[];
  readonly bytes: string;
}

export interface DarwinSeatHostLifetime {
  readonly pid: number;
  readonly start: string;
  readonly boot: string;
}

function canonical(path: string): boolean {
  return isAbsolute(path) && resolve(path) === path && !/[\u0000-\u001f\u007f]/u.test(path);
}

export interface DarwinSeatHostScope {
  cotalHome: string;
  daemonHome?: string;
  installedRoot: string;
  space: string;
}

export function requireDarwinSeatInstallationScope(scope: Omit<DarwinSeatHostScope, "space">): string {
  const state = scope.daemonHome ?? join(scope.cotalHome, "daemon");
  if (![scope.cotalHome, state, scope.installedRoot].every(canonical) ||
      /(?:^|\/)Library\/LaunchAgents(?:\/|$)/i.test(scope.cotalHome)) throw refusal();
  return state;
}

function hostLineage(scope: DarwinSeatHostScope): readonly [string, string, string] {
  if (!scope.space || /[\u0000-\u001f\u007f]/u.test(scope.space)) throw refusal();
  return [requireDarwinSeatInstallationScope(scope), scope.installedRoot, scope.space];
}

export function darwinSeatHostLineageRoot(scope: DarwinSeatHostScope): string {
  return join(scope.cotalHome, "daemon", "pty-hosts", digest(JSON.stringify(hostLineage(scope))).slice(0, 32));
}

export function darwinSeatHostGenerationRoot(scope: DarwinSeatHostScope, generation: string): string {
  if (!/^[a-f0-9]{64}$/.test(generation)) throw refusal();
  return join(darwinSeatHostLineageRoot(scope), generation);
}

/** Derive the host identity from the daemon home, logical install, exact space and generation. */
export function planDarwinSeatHost(input: DarwinSeatHostScope & {
  generation: string;
  argv: readonly [node: string, entry: string, ...args: string[]];
}): DarwinSeatHostPlan {
  const { cotalHome, daemonHome, generation, argv } = input;
  const lineage = hostLineage(input);
  if (![argv[0], argv[1]].every(canonical) || !generation || /[\u0000-\u001f\u007f]/u.test(generation)) throw refusal();
  const id = digest(JSON.stringify([...lineage, generation])).slice(0, 32);
  const label = `ai.cotal.pty.${id}`;
  const directory = join(cotalHome, "daemon", "pty-host-launchd");
  const source = join(directory, `${label}.plist`);
  const args = argv.map(value => `<string>${xmlText(value)}</string>`).join("");
  const bytes = [
    '<?xml version="1.0" encoding="UTF-8"?>', '<plist version="1.0"><dict>',
    `<key>Label</key><string>${label}</string>`, `<key>ProgramArguments</key><array>${args}</array>`,
    '<key>RunAtLoad</key><true/>', '<key>KeepAlive</key><false/>', '<key>Umask</key><integer>63</integer>',
    '</dict></plist>', '',
  ].join("\n");
  if (Buffer.byteLength(bytes) > limit) throw refusal();
  return { cotalHome, ...(daemonHome === undefined ? {} : { daemonHome }), id, label, source,
    receipt: join(directory, `${label}.json`), sha256: digest(bytes), argv: [...argv], bytes };
}

export function planRetainedDarwinSeatHost(scope: DarwinSeatHostScope, generation: string): DarwinSeatHostPlan {
  darwinSeatHostGenerationRoot(scope, generation);
  const base = join(scope.cotalHome, "daemon", "app-manager-runtimes", generation);
  return planDarwinSeatHost({ ...scope, generation, argv: [join(base, "cotal-node"),
    join(base, "runtime", "dist", "daemon", "seat-host-entry-darwin.js"), scope.cotalHome, scope.installedRoot,
    scope.space, generation, ...(scope.daemonHome === undefined ? [] : [scope.daemonHome])],
  });
}

function uid(): number {
  const id = process.getuid?.();
  if (process.platform !== "darwin" || id === undefined || id === 0) throw refusal();
  return id;
}

/** The name is independent of per-seat state and of the daemon's configured home. */
export function darwinSeatHostSocket(id: string): string {
  const owner = uid();
  if (!/^[a-f0-9]{32}$/.test(id)) throw refusal();
  const cache = resolve(darwinUserCacheDir());
  checkDir(cache, owner);
  // Darwin can report /var even though the physical cache path starts with /private/var.
  const directory = join(realpathSync.native(cache), "cotal");
  checkDir(directory, owner);
  if (realpathSync.native(directory) !== directory) throw refusal();
  const path = join(directory, `p-${id}.sock`);
  assertSocketPathFits(path, "darwin");
  return path;
}

function checkHome(plan: DarwinSeatHostPlan, create = false): string {
  const actual = realpathSync.native(plan.cotalHome);
  if (plan.cotalHome !== actual || (create && actual !== realpathSync.native(homeCotalDir()))) throw refusal();
  checkDir(actual);
  const daemon = join(actual, "daemon");
  if (create) ensureDir(daemon);
  else checkDir(daemon);
  return join(daemon, "pty-host-launchd");
}

function receiptBytes(plan: DarwinSeatHostPlan): string {
  return `${JSON.stringify({ label: plan.label, source: plan.source, sha256: plan.sha256, argv: plan.argv })}\n`;
}

function checkReceipt(plan: DarwinSeatHostPlan): void {
  checkDir(checkHome(plan));
  const record = readLocalRecordSource(plan.receipt, limit, true);
  if (!record?.equals(Buffer.from(receiptBytes(plan)))) throw refusal();
  assertSystemdSource(plan.source, plan.sha256, true);
}

export function readRetainedDarwinSeatHostPlan(cotalHome: string, label: string) {
  if (!/^ai\.cotal\.pty\.[a-f0-9]{32}$/.test(label)) throw refusal();
  const receipt = join(cotalHome, "daemon", "pty-host-launchd", `${label}.json`);
  const row: unknown = JSON.parse(readLocalRecordSource(receipt, limit, true)?.toString("utf8") ?? "null");
  if (!row || typeof row !== "object" || !("argv" in row)) throw refusal();
  const { argv } = row;
  if (!Array.isArray(argv) || ![6, 7].includes(argv.length) || argv.some(arg => typeof arg !== "string")) throw refusal();
  const [, , home, installedRoot, space, generation, daemonHome] = argv as string[];
  if (home !== cotalHome || !installedRoot || !space || !generation) throw refusal();
  const scope = { cotalHome, installedRoot, space, ...(daemonHome === undefined ? {} : { daemonHome }) };
  const plan = planRetainedDarwinSeatHost(scope, generation);
  if (plan.label !== label) throw refusal();
  checkReceipt(plan);
  return { scope, generation, plan };
}

function observeJob(label: string): number | undefined {
  const list = nativeRun(launchctl, ["list"], undefined, 1500);
  if (list.status !== 0) throw refusal();
  return launchUpdatePid(list.stdout, label);
}

function requireOwnedDaemon(plan: Pick<DarwinSeatHostPlan, "cotalHome" | "daemonHome">): void {
  uid();
  if (plan.cotalHome !== realpathSync.native(homeCotalDir())) throw refusal();
  const home = plan.daemonHome;
  const paths = home === undefined ? daemonPaths(process.env, plan.cotalHome) : daemonPathsFor(home);
  const label = launchAgentLabel(home);
  if (daemonStartedByOwnedService(paths, home).state !== "owned" || observeJob(label) !== process.pid) throw refusal();
  const observed = darwinLaunchdJob(label);
  if (observed.state !== "loaded" || observed.job.label !== label || observed.job.pid !== process.pid) throw refusal();
}

/** Enumerate this GUI daemon's PTY jobs without treating a failed lookup as an empty list. */
export function listOwnedDarwinSeatHostJobs(scope: Pick<DarwinSeatHostScope, "cotalHome" | "daemonHome">): ReadonlyMap<string, number> {
  requireOwnedDaemon(scope);
  const list = nativeRun(launchctl, ["list"], undefined, 1500);
  const rows = list.stdout.trim().split(/\r?\n/);
  if (list.status !== 0 || !/^PID\s+Status\s+Label$/.test(rows.shift() ?? "")) throw refusal();
  const jobs = new Map<string, number>();
  for (const row of rows) {
    if (!row.includes("ai.cotal.pty.")) continue;
    const match = /^(\d+|-)\s+(-?\d+)\s+(ai\.cotal\.pty\.[a-f0-9]{32})$/.exec(row.trim());
    if (!match || jobs.has(match[3]!) || jobs.size >= darwinSeatHostInventoryLimit) throw refusal();
    const pid = match[1] === "-" ? 0 : Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid === 1 || (pid === 0 && match[1] !== "-")) throw refusal();
    jobs.set(match[3]!, pid);
  }
  return jobs;
}

/** Only the installed daemon in the GUI domain can publish and bootstrap a new sibling. */
export function bootstrapDarwinSeatHost(plan: DarwinSeatHostPlan): void {
  requireOwnedDaemon(plan);
  const domain = `gui/${uid()}`;
  if (nativeRun(launchctl, ["print", `${domain}/${plan.label}`], undefined, 1500).status !== 113 ||
      observeJob(plan.label) !== undefined || darwinLaunchdJob(plan.label).state !== "absent") throw refusal();
  for (const path of plan.argv.slice(0, 2)) {
    if (!lstatSync(path).isFile() || realpathSync.native(path) !== path) throw refusal();
  }
  ensureDir(checkHome(plan, true));
  const receipt = receiptBytes(plan);
  if (Buffer.byteLength(receipt) > limit) throw refusal();
  createSystemdSource(plan.source, plan.bytes, plan.sha256, true);
  writeSecretFileCreateOnly(plan.receipt, receipt);
  checkReceipt(plan);
  requireOwnedDaemon(plan);
  // Keep the receipt and source if submission is ambiguous. Do not retry or start a detached child.
  if (nativeRun(launchctl, ["bootstrap", domain, plan.source], undefined, 5000).status !== 0) throw refusal();
}

export function verifiedDarwinSeatHostJobPid(plan: DarwinSeatHostPlan, pid = observeJob(plan.label)): number {
  const detected = darwinLaunchdJob(plan.label);
  if (pid === undefined || pid <= 1 || detected.state !== "loaded" || detected.job.label !== plan.label ||
      detected.job.pid !== pid || detected.job.program !== plan.argv[0] ||
      JSON.stringify(detected.job.programArguments) !== JSON.stringify(plan.argv)) throw refusal();
  return pid;
}

/** Check this launchd job before opening a master, listener or shared custody record. */
export function admitDarwinSeatHost(plan: DarwinSeatHostPlan): void {
  uid();
  if (process.ppid !== 1 || process.argv.length !== plan.argv.length ||
      process.argv.some((arg, index) => arg !== plan.argv[index])) throw refusal();
  checkReceipt(plan);
  if (verifiedDarwinSeatHostJobPid(plan) !== process.pid) throw refusal();
}

/** Inspect from the verified GUI daemon; the lookup is not an SSH cross-session proof. */
export function readDarwinSeatHostLifetime(plan: DarwinSeatHostPlan): DarwinSeatHostLifetime {
  requireOwnedDaemon(plan);
  checkReceipt(plan);
  const pid = verifiedDarwinSeatHostJobPid(plan);
  const start = processStartTime(pid);
  if (!start) throw refusal();
  return { pid, start, boot: darwinBootSession() };
}

function verifyDarwinSeatHostLifetime(plan: DarwinSeatHostPlan, expected: DarwinSeatHostLifetime): void {
  const live = readDarwinSeatHostLifetime(plan);
  if (live.pid !== expected.pid || live.start !== expected.start || live.boot !== expected.boot) throw refusal();
}

/** Only the owned GUI daemon can supply job proof. The dialer still checks its actual peer. */
export function darwinSeatHostAuthority(plan: DarwinSeatHostPlan) {
  requireOwnedDaemon(plan);
  const address = darwinSeatHostSocket(plan.id);
  return Object.freeze({ address, verify(identity: Readonly<{ pid: number; start: string; bootId: string; uid: number }>): void {
    if (identity.uid !== uid() || address !== darwinSeatHostSocket(plan.id)) throw refusal();
    verifyDarwinSeatHostLifetime(plan, { pid: identity.pid, start: identity.start, boot: identity.bootId });
  } });
}

/** The serving daemon checks the job and the actual socket before allowing native teardown. */
export function verifyDarwinSeatHostPeer(plan: DarwinSeatHostPlan, expected: DarwinSeatHostLifetime, socket: Socket): void {
  const peer = localPeerCredentials(socket);
  if (peer.uid !== uid() || peer.pid !== expected.pid) throw refusal();
  verifyDarwinSeatHostLifetime(plan, expected);
}

/** The consented removal coordinator calls this with a fenced, authenticated live host. */
export function bootoutVerifiedDarwinSeatHost(plan: DarwinSeatHostPlan, expected: DarwinSeatHostLifetime, socket: Socket): void {
  verifyDarwinSeatHostPeer(plan, expected, socket);
  if (nativeRun(launchctl, ["bootout", `gui/${uid()}/${plan.label}`], undefined, 5000).status !== 0) throw refusal();
  // Return only the native acknowledgement. The caller must still prove terminal outcomes.
}
