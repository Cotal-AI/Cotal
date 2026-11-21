import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { bootToken, importProcess, requestProcessStorageRemoval, type LinuxProcessHandle, type LinuxProcessIdentity, type LinuxProcessKernelIdentity } from "@cotal-ai/seat";

/** Trusted host installation receipt, not a unit selected from an ambient environment. */
export interface NativeServicePin { unit: string; path: string; sha256: string }
/** Namespace ownership journal binding the exact retained object to its original service. */
export interface StoredNamespace {
  name: string;
  kernel: LinuxProcessKernelIdentity;
  service: NativeServicePin & { boot: string; uid: number; invocation: string };
}

/** Use the standard JSON reviver source to retain D-Bus uint64 values without rounding. */
export function parseSystemdJson(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source: string }) => {
    if (typeof value !== "number") return value;
    if (!context || !/^(0|[1-9]\d*)$/.test(context.source)) throw new Error("lossless native service integers unavailable");
    return context.source;
  });
}

const execute = promisify(execFile);
const equalKernel = (a: LinuxProcessKernelIdentity, b: LinuxProcessKernelIdentity) =>
  ["deviceMajor", "deviceMinor", "mode", "inode"].every(key => a[key as keyof typeof a] === b[key as keyof typeof b]);

/** Explicit user-service custody for the unregistered namespace adapter. The host supplies
 * its trusted source pin and exclusive ownership of inherited activation descriptors. */
export class SystemdNamespaceCustody {
  readonly #pin: NativeServicePin;
  readonly #env: NodeJS.ProcessEnv;
  readonly #slots = new Map<string, number>();
  readonly #live = new Map<string, LinuxProcessHandle>();
  #service!: StoredNamespace["service"];
  #maximum = 0;

  private constructor(pin: NativeServicePin) {
    if (process.platform !== "linux" || !/^[A-Za-z0-9_-]+\.service$/.test(pin.unit) ||
        !isAbsolute(pin.path) || !/^[a-f0-9]{64}$/.test(pin.sha256)) throw new Error("invalid trusted native service pin");
    this.#pin = Object.freeze({ ...pin });
    const runtime = `/run/user/${process.getuid!()}`;
    this.#env = { PATH: "/usr/bin:/bin", XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus` };
  }

  static async open(pin: NativeServicePin): Promise<SystemdNamespaceCustody> {
    const store = new SystemdNamespaceCustody(pin);
    store.#service = await store.#scope();
    const count = process.env.LISTEN_FDS;
    if (count !== undefined && count !== "0") {
      if (!/^[1-9]\d*$/.test(count) || Number(count) > store.#maximum || process.env.LISTEN_PID !== String(process.pid))
        throw new Error("native activation does not belong to this service process");
      const names = process.env.LISTEN_FDNAMES?.split(":") ?? [];
      if (names.length !== Number(count) || new Set(names).size !== names.length || names.some(name => !/^cotal-ns-[a-f0-9]{32}$/.test(name)))
        throw new Error("native activation contains unknown or ambiguous namespace handles");
      names.forEach((name, i) => store.#slots.set(name, i + 3));
    }
    return store;
  }

  async #bus(args: string[]): Promise<any> {
    let stdout: string;
    try { ({ stdout } = await execute("/usr/bin/busctl", ["--user", "--timeout=3", "--json=short", ...args], { env: this.#env, timeout: 4_000, maxBuffer: 4 * 1024 * 1024 })); }
    catch { throw new Error("native service metadata unavailable"); }
    const value = parseSystemdJson(stdout) as { data?: unknown };
    if (!value || !("data" in value)) throw new Error("invalid native service metadata");
    return value.data;
  }

  async #path(): Promise<string> {
    const value = await this.#bus(["call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "GetUnit", "s", this.#pin.unit]);
    if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== "string" || !value[0].startsWith("/org/freedesktop/systemd1/unit/")) throw new Error("invalid native service object");
    return value[0];
  }

  async #scope(): Promise<StoredNamespace["service"]> {
    const path = await this.#path();
    const get = (iface: string, key: string) => this.#bus(["get-property", "org.freedesktop.systemd1", path, `org.freedesktop.systemd1.${iface}`, key]);
    const [id, main, invocation, fragment, reload, drops, access, preserve, maximum] = await Promise.all([
      get("Unit", "Id"), get("Service", "MainPID"), get("Unit", "InvocationID"), get("Unit", "FragmentPath"),
      get("Unit", "NeedDaemonReload"), get("Unit", "DropInPaths"), get("Service", "NotifyAccess"),
      get("Service", "FileDescriptorStorePreserve"), get("Service", "FileDescriptorStoreMax"),
    ]);
    if (id !== this.#pin.unit || main !== String(process.pid) || fragment !== this.#pin.path || reload !== false ||
        !Array.isArray(drops) || drops.length || access !== "main" || preserve !== "restart" ||
        typeof maximum !== "string" || !/^[1-9]\d*$/.test(maximum) || Number(maximum) > 0xffffffff ||
        !Array.isArray(invocation) || invocation.length !== 16 || invocation.some(v => typeof v !== "string" || !/^\d+$/.test(v) || Number(v) > 255))
      throw new Error("native service invocation or storage policy does not match the owned host");
    const fd = openSync(this.#pin.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o022) || createHash("sha256").update(readFileSync(fd)).digest("hex") !== this.#pin.sha256)
        throw new Error("native service source no longer matches the trusted installation");
    } finally { closeSync(fd); }
    this.#maximum = Number(maximum);
    const boot = bootToken(); if (!boot) throw new Error("native service boot identity unavailable");
    return { ...this.#pin, boot, uid: process.getuid!(), invocation: Buffer.from(invocation.map(Number)).toString("hex") };
  }

  async #current(): Promise<void> {
    const now = await this.#scope();
    if (JSON.stringify(now) !== JSON.stringify(this.#service)) throw new Error("native service invocation changed");
  }

  #record(record: StoredNamespace): void {
    if (!record || !/^cotal-ns-[a-f0-9]{32}$/.test(record.name) || !record.kernel ||
        ![record.kernel.deviceMajor, record.kernel.deviceMinor, record.kernel.mode].every(v => Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff) ||
        typeof record.kernel.inode !== "string" || !/^[1-9]\d{0,19}$/.test(record.kernel.inode) || BigInt(record.kernel.inode) > 0xffffffffffffffffn ||
        !record.service || record.service.unit !== this.#service.unit || record.service.path !== this.#service.path || record.service.sha256 !== this.#service.sha256 ||
        record.service.boot !== this.#service.boot || record.service.uid !== this.#service.uid || !/^[a-f0-9]{32}$/.test(record.service.invocation))
      throw new Error("namespace storage receipt does not belong to this native host");
  }

  async #entries(record: StoredNamespace): Promise<any[]> {
    const path = await this.#path();
    const data = await this.#bus(["call", "org.freedesktop.systemd1", path, "org.freedesktop.systemd1.Service", "DumpFileDescriptorStore"]);
    if (!Array.isArray(data) || data.length !== 1 || !Array.isArray(data[0]) || data[0].some((row: unknown) => !Array.isArray(row) || row.length !== 9))
      throw new Error("invalid native descriptor-store metadata");
    const entries = data[0].filter((row: any[]) => row[0] === record.name), k = record.kernel;
    if (entries.length > 1 || entries.some((row: any[]) => row[1] !== String(k.mode) || row[2] !== String(k.deviceMajor) || row[3] !== String(k.deviceMinor) || row[4] !== k.inode || row[7] !== "anon_inode:[pidfd]"))
      throw new Error("native descriptor-store object is ambiguous or mismatched");
    return entries;
  }

  prepare(id: string, handle: LinuxProcessHandle): StoredNamespace {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("invalid namespace storage reference");
    return { name: `cotal-ns-${id}`, kernel: handle.kernel, service: { ...this.#service } };
  }

  async retain(record: StoredNamespace, handle: LinuxProcessHandle): Promise<void> {
    this.#record(record); await this.#current();
    if (record.service.invocation !== this.#service.invocation || !equalKernel(record.kernel, handle.kernel) || this.#live.has(record.name))
      throw new Error("namespace storage intent conflicts with an existing object");
    this.#live.set(record.name, handle.retain());
    if ((await this.#entries(record)).length) throw new Error("namespace storage name is already retained");
    await handle.requestStorage(record.name);
    await this.#current();
    if ((await this.#entries(record)).length !== 1) throw new Error("namespace descriptor storage was not accepted");
  }

  async recover(record: StoredNamespace, identity: LinuxProcessIdentity): Promise<LinuxProcessHandle> {
    this.#record(record); await this.#current();
    if ((await this.#entries(record)).length !== 1) throw new Error("namespace retained descriptor is missing");
    const held = this.#live.get(record.name);
    if (held) {
      if (!equalKernel(held.kernel, record.kernel) || ["pid", "uid", "birth", "boot", "namespace"].some(key => held.identity[key as keyof LinuxProcessIdentity] !== identity[key as keyof LinuxProcessIdentity]))
        throw new Error("namespace local custody disagrees with its journal");
      return held.retain();
    }
    const fd = this.#slots.get(record.name);
    if (fd === undefined) throw new Error("namespace activation descriptor unavailable");
    const handle = importProcess(fd, { identity, kernel: record.kernel });
    try { closeSync(fd); this.#slots.delete(record.name); this.#live.set(record.name, handle.retain()); return handle; }
    catch (error) { handle.close(); throw error; }
  }

  async release(record: StoredNamespace, identity: LinuxProcessIdentity): Promise<void> {
    this.#record(record); await this.#current(); await this.#entries(record);
    const fd = this.#slots.get(record.name);
    let imported: LinuxProcessHandle | undefined;
    try {
      if (fd !== undefined) {
        imported = importProcess(fd, { identity, kernel: record.kernel });
        this.#live.set(record.name, imported.retain());
        closeSync(fd); this.#slots.delete(record.name);
      }
      // Always send the removal and barrier, including after an unconfirmed retain request.
      await requestProcessStorageRemoval(record.name);
      await this.#current();
      if ((await this.#entries(record)).length) throw new Error("namespace storage removal unconfirmed");
      this.#live.get(record.name)?.close(); this.#live.delete(record.name);
    } finally { imported?.close(); }
  }
}
