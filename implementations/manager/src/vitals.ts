import { readFile } from "node:fs/promises";
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
