import { readFileSync, readlinkSync } from "node:fs";
import type { Socket } from "node:net";
import { constants } from "node:os";
import { loadNativeHelper, socketFd } from "./peercred.js";
import { bootToken, processStartToken } from "./record.js";

/** A process identity recorded on this host. Namespace identity alone can be reused. */
export interface LinuxProcessIdentity {
  readonly pid: number;
  readonly uid: number;
  readonly birth: string;
  readonly boot: string;
  readonly namespace: string;
}

/** A kernel-bound process, not proof that its descendants or remote work have ended.
 * Close explicitly when finished. Closing releases observation, and never means process exit. */
export interface LinuxProcessHandle {
  readonly identity: Readonly<LinuxProcessIdentity>;
  hasExited(): boolean;
  waitForExit(options?: { signal?: AbortSignal }): Promise<void>;
  signal(signal: NodeJS.Signals): void;
  close(): void;
}

type NativeHandle = object;
type ProcessNative = {
  capturePeerProcess(fd: number): NativeHandle;
  openProcessCandidate(pid: number): NativeHandle;
  processPid(handle: NativeHandle): number;
  hasProcessExited(handle: NativeHandle): boolean;
  signalProcess(handle: NativeHandle, signal: number): void;
  closeProcess(handle: NativeHandle): void;
  waitForProcess(handle: NativeHandle, callback: (error: Error | null) => void): object;
  cancelProcessWait(wait: object): void;
};

function nativeProcesses(): ProcessNative {
  if (process.platform !== "linux") throw new Error(`kernel process custody unsupported on ${process.platform}`);
  return loadNativeHelper<ProcessNative>();
}

function snapshot(native: ProcessNative, handle: NativeHandle): LinuxProcessIdentity {
  if (native.hasProcessExited(handle)) throw new Error("process identity unavailable after exit");
  const pid = native.processPid(handle);
  const birth = processStartToken(pid);
  const boot = bootToken();
  const namespace = readlinkSync(`/proc/${pid}/ns/pid`);
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const ids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(status);
  const uid = process.getuid!();
  if (!birth || !boot || !/^pid:\[\d+\]$/.test(namespace) ||
      !ids || ids.slice(1).some((id) => Number(id) !== uid) || native.hasProcessExited(handle)) {
    throw new Error("process identity unavailable or not owned by this user");
  }
  return Object.freeze({ pid, uid, birth, boot, namespace });
}

function assertIdentity(expected: LinuxProcessIdentity, actual: LinuxProcessIdentity): void {
  for (const key of ["pid", "uid", "birth", "boot", "namespace"] as const) {
    if (expected[key] !== actual[key]) throw new Error(`process identity mismatch: ${key}`);
  }
}

class KernelProcess implements LinuxProcessHandle {
  readonly identity: Readonly<LinuxProcessIdentity>;
  readonly #native: ProcessNative;
  readonly #handle: NativeHandle;

  constructor(native: ProcessNative, handle: NativeHandle, identity: LinuxProcessIdentity) {
    this.#native = native;
    this.#handle = handle;
    this.identity = identity;
  }

  hasExited(): boolean { return this.#native.hasProcessExited(this.#handle); }

  async waitForExit(options: { signal?: AbortSignal } = {}): Promise<void> {
    const signal = options.signal;
    signal?.throwIfAborted();
    if (this.hasExited()) return;
    const native = this.#native;
    const handle = this.#handle;
    await new Promise<void>((resolve, reject) => {
      let wait: object | undefined;
      let settled = false;
      const abort = () => {
        if (settled) return;
        settled = true;
        if (wait) native.cancelProcessWait(wait);
        signal?.removeEventListener("abort", abort);
        reject(signal?.reason);
      };
      wait = native.waitForProcess(handle, (error) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  signal(signal: NodeJS.Signals): void {
    const number = Object.hasOwn(constants.signals, signal) ? constants.signals[signal] : undefined;
    if (number === undefined) throw new Error(`unsupported process signal: ${String(signal)}`);
    assertIdentity(this.identity, snapshot(this.#native, this.#handle));
    this.#native.signalProcess(this.#handle, number);
  }

  close(): void { this.#native.closeProcess(this.#handle); }
}

/** Capture the kernel identity of a connected Unix peer. This requires Linux SO_PEERPIDFD;
 * unsupported kernels refuse instead of reopening a potentially reused numeric peer PID. */
export function capturePeerProcess(socket: Socket): LinuxProcessHandle {
  const native = nativeProcesses();
  const handle = native.capturePeerProcess(socketFd(socket));
  try { return new KernelProcess(native, handle, snapshot(native, handle)); }
  catch (error) { native.closeProcess(handle); throw error; }
}

/** Reacquire a live process only when every recorded identity component still matches.
 * Missing, unreadable, exited or mismatched identity refuses. This neither authenticates a
 * supplied record nor establishes descendant ownership; the caller must own the record. */
export function recoverProcess(identity: LinuxProcessIdentity): LinuxProcessHandle {
  const native = nativeProcesses();
  if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 0 || identity.pid > 0x7fffffff ||
      identity.uid !== process.getuid!() || typeof identity.birth !== "string" || !/^\d+$/.test(identity.birth) ||
      typeof identity.boot !== "string" || identity.boot !== bootToken() ||
      typeof identity.namespace !== "string" || !/^pid:\[\d+\]$/.test(identity.namespace)) {
    throw new Error("invalid recorded process identity");
  }
  const expected = Object.freeze({ ...identity });
  const handle = native.openProcessCandidate(expected.pid);
  try {
    const actual = snapshot(native, handle);
    assertIdentity(expected, actual);
    return new KernelProcess(native, handle, actual);
  } catch (error) { native.closeProcess(handle); throw error; }
}
