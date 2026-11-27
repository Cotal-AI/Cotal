import { spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmdirSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertSeatId, processStatFields } from "./record.js";
import { isSharedScope, recordedProcess, type SharedSeatRecord } from "./shared-record.js";

const mount = "/sys/fs/cgroup";
const cgroup2 = 0x63677270;
const hostLeaf = "host";

function unifiedPath(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  // Reject hybrid hierarchies and never normalize kernel membership into a match.
  return /^0::(\/[^\r\n\0]*)\n$/.exec(readFileSync(`/proc/${pid}/cgroup`, "utf8"))?.[1];
}

function unitPath(scope: unknown): string {
  const uid = process.getuid?.();
  if (process.platform !== "linux" || uid === undefined || !isSharedScope(scope))
    throw new Error("invalid shared PTY cgroup identity");
  return `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${scope}`;
}

function read(dir: string, name: string): string {
  const fd = openSync(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return readFileSync(fd, "utf8").trim(); }
  finally { closeSync(fd); }
}

function write(dir: string, name: string, value: string): void {
  const fd = openSync(join(dir, name), constants.O_WRONLY | constants.O_NOFOLLOW);
  try { writeFileSync(fd, value); }
  finally { closeSync(fd); }
}

function directory(path: string) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || realpathSync(path) !== path || statfsSync(path).type !== cgroup2)
    throw new Error("not a canonical cgroup v2 directory");
  return stat;
}

function pinDirectory(path: string): () => void {
  const identity = directory(path);
  return () => {
    const current = directory(path);
    if (identity.dev !== current.dev || identity.ino !== current.ino)
      throw new Error("shared PTY cgroup directory changed");
  };
}

export function sharedSeatPopulated(row: SharedSeatRecord): boolean {
  const leaf = join(mount, unitPath(row.scope), `seat-${assertSeatId(row.id)}`);
  try {
    const events = read(leaf, "cgroup.events").split("\n");
    if (events.includes("populated 0")) return false;
    if (events.includes("populated 1")) return true;
    throw new Error("shared PTY seat population is unknown");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** A requested stop can reach the one recorded leaf even while the host is unresponsive. */
export function killRecordedSharedSeat(row: SharedSeatRecord): void {
  const path = unitPath(row.scope), leaf = join(mount, path, `seat-${assertSeatId(row.id)}`);
  const check = pinDirectory(leaf);
  if (recordedProcess(row.custodianPid, row.custodianStart, row.bootId) !== "live" || unifiedPath(row.custodianPid) !== `${path}/${hostLeaf}`)
    return; // A dead host's whole control group belongs to systemd's stop job.
  check();
  write(leaf, "cgroup.kill", "1");
}

function hasMemory(controllers: string): boolean {
  return controllers.split(/\s+/).includes("memory");
}

/** Read-only preliminary capability check; only host initialization proves actual delegation. */
export function sharedCgroupAvailable(): boolean {
  if (process.platform !== "linux") return false;
  try {
    directory(mount);
    return unifiedPath(process.pid) !== undefined && hasMemory(read(mount, "cgroup.controllers"));
  } catch { return false; }
}

export interface SharedSeatCgroup {
  /** Exact cgroup v2 path for placing the child before running the seat command. */
  readonly path: string;
  /** Filesystem path to the same leaf, for the trusted child launcher. */
  readonly directory: string;
  contains(pid: number, start: string): boolean;
  /** Signal only this leaf, wait for all descendants to leave, then remove it. */
  killAndRemove(): Promise<void>;
}

export interface SharedHostCgroup {
  createSeat(id: string): SharedSeatCgroup;
}

/** Call once, from the transient service's main process, before launching seats. */
export function initializeSharedHostCgroup(scope: string): SharedHostCgroup {
  const path = unitPath(scope);
  if (unifiedPath(process.pid) !== path) throw new Error("shared PTY host is not in its exact user service");
  const result = spawnSync("/usr/bin/systemctl", ["--user", "show", "--no-pager", "-p", "ControlGroup", "-p", "MainPID",
    "-p", "Transient", "-p", "Delegate", "-p", "DelegateControllers", "--", scope],
  { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
  const properties = new Set(result.stdout?.split("\n"));
  if (result.status !== 0 || ![`ControlGroup=${path}`, `MainPID=${process.pid}`, "Transient=yes", "Delegate=yes", "DelegateControllers=memory"]
    .every(property => properties.has(property))) throw new Error("shared PTY host is not the delegated transient service main process");

  const unit = join(mount, path);
  const checkUnit = pinDirectory(unit);
  if (read(unit, "cgroup.type") !== "domain" || !hasMemory(read(unit, "cgroup.controllers")) ||
      read(unit, "cgroup.procs") !== String(process.pid)) throw new Error("shared PTY host has no exclusive domain memory delegation");
  for (const name of ["cgroup.procs", "cgroup.subtree_control"])
    accessSync(join(unit, name), constants.W_OK);
  accessSync(unit, constants.W_OK | constants.X_OK);

  const host = join(unit, hostLeaf);
  const hostPath = `${path}/${hostLeaf}`;
  mkdirSync(host);
  const checkHost = pinDirectory(host);
  write(host, "cgroup.procs", String(process.pid));
  if (unifiedPath(process.pid) !== hostPath || read(unit, "cgroup.procs") !== "")
    throw new Error("shared PTY host could not move to its dedicated leaf");
  write(unit, "cgroup.subtree_control", "+memory");
  if (!hasMemory(read(unit, "cgroup.subtree_control")) || read(host, "cgroup.type") !== "domain")
    throw new Error("shared PTY host could not enable domain memory delegation");

  function checkOwner(): void {
    if (unifiedPath(process.pid) !== hostPath) throw new Error("shared PTY host left its dedicated leaf");
    checkUnit();
    checkHost();
  }

  return Object.freeze({
    createSeat(id: string): SharedSeatCgroup {
      if (typeof id !== "string") throw new Error("invalid shared PTY seat identity");
      const name = `seat-${assertSeatId(id)}`;
      const leaf = join(unit, name);
      const leafPath = `${path}/${name}`;
      checkOwner();
      mkdirSync(leaf); // Never take over an existing cgroup, even if it is empty.
      const checkLeaf = pinDirectory(leaf);
      try {
        if (read(leaf, "cgroup.type") !== "domain" || read(leaf, "memory.max") !== "max")
          throw new Error("shared PTY seat has no unrestricted domain memory controller");
        for (const name of ["cgroup.procs", "cgroup.kill", "memory.oom.group"])
          accessSync(join(leaf, name), constants.W_OK);
        write(leaf, "memory.oom.group", "1");
        if (read(leaf, "memory.oom.group") !== "1") throw new Error("shared PTY seat could not enable group OOM");
      } catch (error) {
        try { checkOwner(); checkLeaf(); rmdirSync(leaf); } catch { /* Never kill during configuration rollback. */ }
        throw error;
      }

      function checkSeat(): void { checkOwner(); checkLeaf(); }

      function contains(pid: number, start: string): boolean {
        if (!Number.isSafeInteger(pid) || pid <= 1 || typeof start !== "string" || !/^\d+$/.test(start)) return false;
        try {
          checkSeat();
          const live = (): boolean => {
            const fields = processStatFields(pid);
            return fields?.[19] === start && fields[0] !== "Z" && fields[0] !== "X";
          };
          return live() && unifiedPath(pid) === leafPath && live();
        } catch { return false; }
      }

      let cleanup: Promise<void> | undefined;
      let removed = false;
      async function remove(): Promise<void> {
        checkSeat();
        write(leaf, "cgroup.kill", "1");
        const deadline = process.hrtime.bigint() + 3_000_000_000n;
        for (;;) {
          checkSeat();
          const events = read(leaf, "cgroup.events").split("\n");
          const populated = events.filter(line => line.startsWith("populated "));
          if (populated.length !== 1 || (populated[0] !== "populated 0" && populated[0] !== "populated 1"))
            throw new Error("shared PTY seat population is unknown");
          if (populated[0] === "populated 0") {
            rmdirSync(leaf);
            removed = true;
            return;
          }
          if (process.hrtime.bigint() >= deadline) throw new Error("shared PTY seat cgroup is still populated");
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }

      return Object.freeze({ path: leafPath, directory: leaf, contains, killAndRemove(): Promise<void> {
        if (removed) return Promise.resolve();
        return cleanup ??= remove().finally(() => { cleanup = undefined; });
      } });
    },
  });
}
