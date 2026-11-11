import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, parse } from "node:path";
import { homedir, uptime } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { cpus, freemem, loadavg, platform, totalmem } from "node:os";
import { statfs } from "node:fs/promises";
import { EpEnvelopeError } from "@cotal-ai/core";

export const MANAGER_VITALS_MAX_MOUNTS = 128;
export const MANAGER_VITALS_MAX_MOUNT_BYTES = 1024;

export interface ManagerVitals {
  sampledAt: string;
  cpu: { logicalCount: number; load1: number; load5: number; load15: number };
  memory: { totalBytes: number; availableBytes: number };
  filesystems: Array<{ mount: string; totalBytes: number; freeBytes: number }>;
}

export interface ManagerVitalsDeps {
  platform(): NodeJS.Platform;
  logicalCount(): number;
  load(): [number, number, number];
  totalMemory(): number;
  freeMemory(): number;
  linuxMeminfo(): Promise<string>;
  mounts(platform: NodeJS.Platform): Promise<string[]>;
  filesystem(mount: string): Promise<{ bsize: number | bigint; blocks: number | bigint; bfree: number | bigint }>;
  now(): Date;
}

const refusal = (message: string, code: "unimplemented" | "resource-exhausted" = "unimplemented"): never => {
  throw new EpEnvelopeError(code, message, undefined, "not-executed");
};
const finite = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value < 0) refusal(`manager vitals could not measure ${name}`);
  return value;
};
const integer = (value: number | bigint, name: string): number => {
  const n = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n < 0) refusal(`manager vitals could not measure ${name}`);
  return n;
};
const bytes = (blocks: number | bigint, blockSize: number | bigint, name: string): number => {
  const value = BigInt(blocks) * BigInt(blockSize);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) refusal(`manager vitals ${name} exceeds the safe integer bound`, "resource-exhausted");
  return Number(value);
};
const safeMount = (mount: string): string => {
  if (!mount || Buffer.byteLength(mount, "utf8") > MANAGER_VITALS_MAX_MOUNT_BYTES || /\p{Cc}/u.test(mount))
    refusal("manager vitals found an invalid mount point");
  if (/^(?:\\\\|\/\/)/.test(mount)) refusal("manager vitals excludes remote filesystem endpoints");
  return mount;
};
const unescapeMount = (mount: string): string => mount.replace(/\\(040|011|012|134)/g, (_, code: string) =>
  code === "040" ? " " : code === "011" ? "\t" : code === "012" ? "\n" : "\\");

const LOCAL_LINUX_FILESYSTEMS = new Set(["btrfs", "exfat", "ext2", "ext3", "ext4", "f2fs", "ntfs3", "vfat", "xfs", "zfs"]);
const privateMount = (mount: string): boolean => mount === "/home" || mount.startsWith("/home/") || mount.startsWith("/run/user/");
const relevantLinuxMount = (mount: string, fsType: string): boolean =>
  mount === "/" || (LOCAL_LINUX_FILESYSTEMS.has(fsType) && mount.split("/").filter(Boolean).length <= 2);

async function linuxMounts(): Promise<string[]> {
  const text = await readFile("/proc/self/mountinfo", "utf8");
  return text.trim().split("\n").flatMap((line) => {
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    if (separator < 6) refusal("manager vitals could not parse /proc/self/mountinfo");
    const source = fields[separator + 2] ?? "";
    const fsType = fields[separator + 1] ?? "";
    const mount = unescapeMount(fields[4]!);
    if (!relevantLinuxMount(mount, fsType) || source.startsWith("//") || source.startsWith("\\\\") || privateMount(mount)) return [];
    return [mount];
  });
}
async function darwinMounts(): Promise<string[]> {
  return ["/"];
}
async function windowsMounts(): Promise<string[]> {
  const rows: string[] = [];
  for (let code = 65; code <= 90; code++) {
    const root = `${String.fromCharCode(code)}:\\`;
    try { await statfs(root); rows.push(root); }
    catch (error) { if (!["ENOENT", "ENODEV", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  }
  return rows;
}

const systemDeps: ManagerVitalsDeps = {
  platform,
  logicalCount: () => cpus().length,
  load: () => loadavg() as [number, number, number],
  totalMemory: totalmem,
  freeMemory: freemem,
  linuxMeminfo: () => readFile("/proc/meminfo", "utf8"),
  mounts: (os) => os === "linux" ? linuxMounts() : os === "darwin" ? darwinMounts() : os === "win32" ? windowsMounts() : Promise.resolve([]),
  filesystem: (mount) => statfs(mount, { bigint: true }),
  now: () => new Date(),
};

export async function measureManagerVitals(deps: ManagerVitalsDeps = systemDeps): Promise<ManagerVitals> {
  const os = deps.platform();
  if (!(["linux", "darwin", "win32"] as NodeJS.Platform[]).includes(os)) refusal(`manager vitals is unsupported on ${os}`);
  if (os === "win32") refusal("manager vitals cannot report CPU load on Windows because Node returns unsupported zero load averages");

  return measureResources(deps, os);
}

async function measureResources(deps: ManagerVitalsDeps, os: NodeJS.Platform): Promise<ManagerVitals> {
  const logicalCount = integer(deps.logicalCount(), "CPU count");
  if (logicalCount < 1) refusal("manager vitals found no logical CPUs");
  const [load1, load5, load15] = deps.load().map((value, i) => finite(value, `CPU load${[1, 5, 15][i]}`)) as [number, number, number];
  const totalBytes = integer(deps.totalMemory(), "total memory");
  let availableBytes = integer(deps.freeMemory(), "available memory");
  if (os === "linux") {
    const hit = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(await deps.linuxMeminfo());
    const kb = hit?.[1];
    if (kb === undefined) refusal("manager vitals could not read MemAvailable from /proc/meminfo");
    availableBytes = integer(Number(kb) * 1024, "available memory");
  }
  if (availableBytes > totalBytes) refusal("manager vitals available memory exceeds total memory");

  const mounts = [...new Set((await deps.mounts(os)).map(safeMount))].sort();
  if (mounts.length > MANAGER_VITALS_MAX_MOUNTS) refusal(`manager vitals found ${mounts.length} mounts (maximum ${MANAGER_VITALS_MAX_MOUNTS})`, "resource-exhausted");
  const filesystems = [] as ManagerVitals["filesystems"];
  for (const mount of mounts) {
    const fs = await deps.filesystem(mount);
    const total = bytes(fs.blocks, fs.bsize, `${mount} total bytes`);
    const free = bytes(fs.bfree, fs.bsize, `${mount} free bytes`);
    if (free > total) refusal(`manager vitals free bytes exceed total bytes at ${mount}`);
    filesystems.push({ mount, totalBytes: total, freeBytes: free });
  }
  return { sampledAt: deps.now().toISOString(), cpu: { logicalCount, load1, load5, load15 }, memory: { totalBytes, availableBytes }, filesystems };
}

export interface ComputerVitals extends Omit<ManagerVitals, "cpu"> {
  cpu: { logicalCount: number; utilisationPercent: number; intervalMs: number; load1?: number; load5?: number; load15?: number };
  uptimeSeconds: number;
}

export interface ComputerVitalsDeps {
  resources: ManagerVitalsDeps;
  cpuTimes(): Array<{ user: number; nice: number; sys: number; idle: number; irq: number }>;
  wait(): Promise<void>;
  clock(): number;
  uptime(): number;
}

async function homeMount(): Promise<string[]> {
  const home = await realpath(homedir());
  if (process.platform === "win32") {
    if (!process.env.SystemRoot) refusal("computer vitals cannot locate the Windows system volume");
    const roots = [...new Set([safeMount(parse(home).root), safeMount(parse(process.env.SystemRoot).root)])];
    for (const root of roots) {
      if (root.length !== 3 || !/^[A-Za-z]$/.test(root[0]!) || root[1] !== ":" || root[2] !== "\\") refusal("computer vitals requires a local Windows drive root");
      const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[int]([System.IO.DriveInfo]::new('${root}').DriveType)`], { timeout: 5000, maxBuffer: 1024, windowsHide: true });
      if (stdout.trim() !== "3") refusal("computer vitals excludes non-fixed Windows volumes");
    }
    return roots;
  }
  let mount = home;
  const device = (await stat(home)).dev;
  while (dirname(mount) !== mount && (await stat(dirname(mount))).dev === device) mount = dirname(mount);
  if (mount === home || mount.startsWith("/home/") || mount.startsWith("/Users/")) refusal("computer vitals cannot disclose a personal mount point");
  if (process.platform === "darwin") {
    const { stdout } = await promisify(execFile)("/sbin/mount", [], { timeout: 5000, maxBuffer: 1024 * 1024 });
    for (const point of new Set(["/", mount])) {
      const row = stdout.split("\n").find(line => line.includes(` on ${point} (`));
      if (!row || !/\((?:apfs|hfs),/.test(row) || !row.includes(", local")) refusal("computer vitals requires local macOS volumes");
    }
  }
  if (process.platform === "linux") {
    const rows = (await readFile("/proc/self/mountinfo", "utf8")).trim().split("\n");
    const row = rows.map(line => line.split(" ")).find(fields => unescapeMount(fields[4] ?? "") === mount);
    const separator = row?.indexOf("-") ?? -1;
    const fsType = row?.[separator + 1];
    const source = row?.[separator + 2];
    if (!row || separator < 6 || !fsType || !source || (!LOCAL_LINUX_FILESYSTEMS.has(fsType) && fsType !== "overlay") || source.startsWith("/dev/loop") || mount.startsWith("/run/user/")) refusal("computer vitals excludes remote or transient home volumes");
  }
  return [...new Set(["/", safeMount(mount)])];
}

const computerDeps: ComputerVitalsDeps = {
  resources: { ...systemDeps, mounts: homeMount },
  cpuTimes: () => cpus().map(cpu => cpu.times),
  wait: async () => { await delay(250); },
  clock: () => performance.now(),
  uptime,
};

/** Sample the computer using the same memory and filesystem measurements as Manager vitals. */
export async function measureComputerVitals(deps: ComputerVitalsDeps = computerDeps): Promise<ComputerVitals> {
  const os = deps.resources.platform();
  if (!(["linux", "darwin", "win32"] as NodeJS.Platform[]).includes(os)) refusal(`computer vitals is unsupported on ${os}`);
  const before = deps.cpuTimes();
  const start = deps.clock();
  await deps.wait();
  const after = deps.cpuTimes();
  const intervalMs = integer(Math.round(deps.clock() - start), "CPU interval");
  if (!intervalMs || !before.length || before.length > 4096 || before.length !== after.length) refusal("computer vitals CPU observation changed topology or has no interval");
  let total = 0, idle = 0;
  for (let i = 0; i < before.length; i++) {
    for (const key of ["user", "nice", "sys", "idle", "irq"] as const) {
      const delta = integer(after[i]![key], "CPU counter") - integer(before[i]![key], "CPU counter");
      if (delta < 0) refusal("computer vitals CPU counters reset");
      total += delta;
      if (key === "idle") idle += delta;
    }
  }
  if (!Number.isSafeInteger(total) || total <= 0) refusal("computer vitals CPU counters did not advance");
  const filesystem: ManagerVitalsDeps["filesystem"] = async mount => {
    const fs = await deps.resources.filesystem(mount);
    integer(fs.blocks, "filesystem blocks"); integer(fs.bsize, "filesystem block size"); integer(fs.bfree, "filesystem free blocks");
    return fs;
  };
  const resources = await measureResources({ ...deps.resources, filesystem, logicalCount: () => after.length, ...(os === "win32" ? { load: (): [number, number, number] => [0, 0, 0] } : {}) }, os);
  const cpu: ComputerVitals["cpu"] = { logicalCount: after.length, utilisationPercent: 100 * (total - idle) / total, intervalMs };
  if (os !== "win32") Object.assign(cpu, resources.cpu);
  return { ...resources, cpu, uptimeSeconds: integer(Math.floor(deps.uptime()), "system uptime") };
}
