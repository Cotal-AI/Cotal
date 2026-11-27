import type { Socket } from "node:net";
import { darwinBootSession, localPeerCredentials, processStartTime } from "./host.js";
import type { SharedWriterProof } from "./shared-control-server.js";
import type { ExactIdentity, IdentityProof } from "./shared-platform.js";

export interface DarwinSharedIdentity extends ExactIdentity {
  bootId: string;
  uid: number;
}

const birth = /^[1-9]\d*\.\d{6}$/;
const boot = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/;

function same(a: DarwinSharedIdentity, b: DarwinSharedIdentity): boolean {
  return a.pid === b.pid && a.start === b.start && a.bootId === b.bootId && a.uid === b.uid;
}

function observeMissingPid(pid: number): "gone" | "unknown" {
  try { process.kill(pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return "gone"; }
  return "unknown";
}

export const darwinSharedIdentity: IdentityProof<DarwinSharedIdentity> & SharedWriterProof<DarwinSharedIdentity, Socket> = {
  same,
  current() {
    if (process.platform !== "darwin") return undefined;
    try {
      const { pid } = process, uid = process.getuid!(), start = processStartTime(pid);
      if (start && birth.test(start)) return { pid, uid, start, bootId: darwinBootSession() };
    } catch { /* Unavailable native evidence does not establish an identity. */ }
    return undefined;
  },
  observe(identity) {
    if (process.platform !== "darwin" || !Number.isInteger(identity.pid) || identity.pid <= 1 || identity.pid > 0x7fffffff ||
        identity.uid !== process.getuid!() || !birth.test(identity.start) || !boot.test(identity.bootId) ||
        identity.bootId === "00000000-0000-0000-0000-000000000000") return "unknown";
    try {
      if (darwinBootSession() !== identity.bootId) return "gone";
      const observed = processStartTime(identity.pid);
      if (observed === undefined) return observeMissingPid(identity.pid);
      if (!birth.test(observed)) return "unknown";
      return observed === identity.start ? "live" : "gone";
    } catch { return "unknown"; }
  },
  matchesPeer(socket, identity) {
    try {
      const peer = localPeerCredentials(socket);
      return peer.uid === identity.uid && peer.pid === identity.pid && darwinSharedIdentity.observe(identity) === "live";
    } catch { return false; }
  },
};
