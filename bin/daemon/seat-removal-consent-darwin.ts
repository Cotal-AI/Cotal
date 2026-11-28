import { lstatSync } from "node:fs";
import type { Socket } from "node:net";
import { join } from "node:path";
import { inspectLock } from "@cotal-ai/core";
import { localPeerCredentials } from "@cotal-ai/seat";
import { readLocalRecordSource } from "@cotal-ai/workspace";
import { checkDir, DAEMON_PROTOCOL_VERSION, type DaemonPaths } from "./endpoint.js";
import { verifiedDarwinRemovalReceipt } from "./install.js";
import { processBirth } from "./lifetime.js";
import type { DaemonResponse } from "./protocol.js";

export const darwinRemovalLockLabel = "consented daemon uninstall";

interface DarwinRemovalPeer { readonly pid: number; readonly uid: number; readonly birth: string }

function readDarwinRemovalPeer(socket: Socket): DarwinRemovalPeer | undefined {
  if (process.platform !== "darwin" || socket.destroyed) return undefined;
  try {
    const { pid, uid } = localPeerCredentials(socket);
    if (uid !== process.getuid?.() || uid === 0 || !Number.isSafeInteger(pid) || pid < 2) return undefined;
    const birth = processBirth(pid);
    if (birth) return { pid, uid, birth };
  } catch { /* Missing peer evidence is not consent. */ }
  return undefined;
}

/** The request ID is the nonce of the existing uninstall transaction, not a client consent flag.
 * Check the original socket incarnation and the protected lock on every destructive boundary. */
function hasDarwinRemovalConsent(state: string, socket: Socket, peer: DarwinRemovalPeer | undefined, id: string): boolean {
  if (!peer || !/^[a-f0-9]{24}$/.test(id)) return false;
  const actual = readDarwinRemovalPeer(socket);
  if (!actual || actual.pid !== peer.pid || actual.uid !== peer.uid || actual.birth !== peer.birth) return false;
  const path = join(state, "service-repair.lock");
  try {
    checkDir(state, actual.uid);
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.uid !== BigInt(actual.uid) || (before.mode & 0o777n) !== 0o600n || before.nlink !== 1n) return false;
    const bytes = readLocalRecordSource(path, 1024, true);
    if (!bytes) return false;
    const record = JSON.parse(bytes.toString("utf8"));
    if (record?.pid !== peer.pid || record?.nonce !== id || record?.label !== darwinRemovalLockLabel || typeof record?.start !== "string") return false;
    const held = inspectLock(path), after = lstatSync(path, { bigint: true });
    return held.state === "active" && held.owner.pid === peer.pid && held.owner.nonce === id && held.owner.start === record.start &&
      held.owner.label === darwinRemovalLockLabel && before.dev === after.dev && before.ino === after.ino && before.ctimeNs === after.ctimeNs &&
      processBirth(peer.pid) === peer.birth && !socket.destroyed;
  } catch { return false; }
}

export function darwinRemovalGateReply(paths: DaemonPaths, daemonHome: string | undefined, socket: Socket, restartOwner: () => string, id: string): DaemonResponse {
  let message = "hosted-pty-remove requires the active consented uninstall transaction";
  const peer = readDarwinRemovalPeer(socket);
  const consent = () => Boolean(peer && restartOwner() === JSON.stringify(["peer", peer.uid, peer.pid, peer.birth]) &&
    hasDarwinRemovalConsent(paths.state, socket, peer, id));
  try {
    if (consent()) {
      message = "hosted-pty-remove could not verify the owned daemon receipt";
      verifiedDarwinRemovalReceipt(paths, daemonHome, consent);
      message = "hosted-pty-remove has no verified hosted stop coordinator";
    }
  } catch { /* The reply stays a refusal. */ }
  return { v: DAEMON_PROTOCOL_VERSION, id, ok: false, error: { code: "DEPENDENCY_UNAVAILABLE", message } };
}
