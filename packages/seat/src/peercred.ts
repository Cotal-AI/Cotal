import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Socket } from "node:net";
import { unsupportedTransport } from "./protocol.js";

export interface PeerCredentials {
  pid: number;
  uid: number;
  gid: number;
}

type PeercredNative = {
  peercred: (fd: number) => PeerCredentials;
  flockExclusiveNb: (fd: number) => boolean;
};

export const LINUX_NATIVE_ARCHES = ["x64", "arm64"] as const;
/** The platforms and arches the helper has a source build for. Seat custody uses only Linux; the
 *  host primitives in host.ts use all of them. */
export const NATIVE_TARGETS = { linux: LINUX_NATIVE_ARCHES, darwin: ["x64", "arm64"], win32: ["x64", "arm64"] } as const;

let loaded: unknown;

export function nativeHelperPath(arch: string = process.arch, platform: string = process.platform): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "build", "Release", `${platform}-${arch}`, "peercred.node");
}

/** Load the helper for this platform and arch, or throw naming what is missing. Never compiles. */
export function loadNativeHelper<T>(): T {
  if (loaded) return loaded as T;
  const platformArch = `${process.platform}-${process.arch}`;
  const arches = (NATIVE_TARGETS as Record<string, readonly string[]>)[process.platform];
  if (!arches?.includes(process.arch)) {
    const supported = Object.entries(NATIVE_TARGETS).flatMap(([p, a]) => a.map((x) => `${p}-${x}`)).join(", ");
    throw new Error(`@cotal-ai/seat: native helper unsupported on ${platformArch} (supported: ${supported})`);
  }
  const path = nativeHelperPath();
  if (!existsSync(path)) throw new Error(`@cotal-ai/seat: native helper missing at ${path}`);
  const require = createRequire(import.meta.url);
  try {
    loaded = require(path);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`@cotal-ai/seat: native helper failed to load at ${path} for ${platformArch}: ${detail}`);
  }
  return loaded as T;
}

function isLinuxNativeArch(arch: string): arch is (typeof LINUX_NATIVE_ARCHES)[number] {
  return (LINUX_NATIVE_ARCHES as readonly string[]).includes(arch);
}

export function unsupportedNativeArch(platform: string, arch: string): Error {
  return new Error(
    `@cotal-ai/seat: SO_PEERCRED native helper unsupported on ${platform}-${arch} (supported: linux-x64, linux-arm64)`,
  );
}

function loadNative(): PeercredNative {
  if (loaded) return loaded as PeercredNative;
  if (process.platform !== "linux") throw unsupportedTransport();
  const platformArch = `${process.platform}-${process.arch}`;
  if (!isLinuxNativeArch(process.arch)) throw unsupportedNativeArch(process.platform, process.arch);
  const path = nativeHelperPath(process.arch);
  if (!existsSync(path)) throw new Error(`@cotal-ai/seat: SO_PEERCRED native helper missing at ${path}`);
  const require = createRequire(import.meta.url);
  try {
    loaded = require(path) as PeercredNative;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `@cotal-ai/seat: SO_PEERCRED native helper failed to load at ${path} for ${platformArch}: ${detail}`,
    );
  }
  return loaded as PeercredNative;
}

export function socketFd(sock: Socket): number {
  const handle = (sock as unknown as { _handle?: { fd?: number } })._handle;
  const fd = handle?.fd;
  if (typeof fd !== "number" || fd < 0) throw new Error("unix socket has no file descriptor");
  return fd;
}

export function peerCredentials(sock: Socket): PeerCredentials {
  return loadNative().peercred(socketFd(sock));
}

/**
 * Take an exclusive `flock(2)` on `fd` without blocking. True when this process now holds it,
 * false when another open file description does.
 *
 * The kernel owns the lock's lifetime: it is released when the last descriptor referring to it
 * closes, which every way of dying includes. So a holder killed with SIGKILL, or one the OOM
 * killer takes, leaves no lock behind, and the next acquirer learns the holder is gone from the
 * kernel rather than inferring it from a recorded pid.
 */
export function flockExclusiveNb(fd: number): boolean {
  return loadNative().flockExclusiveNb(fd);
}
