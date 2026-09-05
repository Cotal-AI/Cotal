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

let loaded: PeercredNative | undefined;

function nativePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "build", "Release", "peercred.node");
}

function loadNative(): PeercredNative {
  if (loaded) return loaded;
  if (process.platform !== "linux") throw unsupportedTransport();
  const path = nativePath();
  if (!existsSync(path)) throw new Error(`SO_PEERCRED native helper missing at ${path}`);
  const require = createRequire(import.meta.url);
  loaded = require(path) as PeercredNative;
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
