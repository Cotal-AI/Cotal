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

type PeercredNative = { peercred: (fd: number) => PeerCredentials };

export const LINUX_NATIVE_ARCHES = ["x64", "arm64"] as const;

let loaded: PeercredNative | undefined;

export function nativeHelperPath(arch: string = process.arch): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "build", "Release", `linux-${arch}`, "peercred.node");
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
  if (loaded) return loaded;
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
  return loaded;
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
