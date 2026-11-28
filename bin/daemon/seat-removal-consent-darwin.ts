import { lstatSync, opendirSync, realpathSync } from "node:fs";
import type { Socket } from "node:net";
import { join } from "node:path";
import { inspectLock } from "@cotal-ai/core";
import { darwinUserCacheDir, localPeerCredentials } from "@cotal-ai/seat";
import { homeCotalDir, readLocalRecordSource } from "@cotal-ai/workspace";
import { checkDir, DAEMON_PROTOCOL_VERSION, type DaemonPaths } from "./endpoint.js";
import { verifiedDarwinRemovalReceipt } from "./install.js";
import { processBirth } from "./lifetime.js";
import type { holdDarwinRemovalManagers } from "./seat-removal-manager-darwin.js";
import { holdDarwinSeatInstallationFence } from "./seat-host-darwin.js";
import type { DaemonResponse } from "./protocol.js";

export const darwinRemovalLockLabel = "consented daemon uninstall";

export async function requestDarwinHostedRemoval(socket: Socket, id: string, uncertain: (detail: string) => Error): Promise<void> {
  const { readLine } = await import("./client.js");
  const { encode } = await import("./protocol.js");
  let reply: DaemonResponse;
  try {
    const answer = readLine(socket, 70_000);
    socket.write(encode({ v: DAEMON_PROTOCOL_VERSION, id, op: "hosted-pty-remove" }));
    reply = JSON.parse(await answer);
  } catch { throw uncertain("hosted-pty-remove did not confirm the removal outcome"); }
  if (!reply || typeof reply !== "object" || reply.v !== DAEMON_PROTOCOL_VERSION || reply.id !== id || "event" in reply || typeof reply.ok !== "boolean")
    throw uncertain("hosted-pty-remove did not confirm this uninstall transaction");
  if (!reply.ok) {
    const detail = typeof reply.error?.message === "string" && reply.error.message.startsWith("machine-hosted-pty-remove: ")
      ? `: ${reply.error.message}` : "";
    throw uncertain(`hosted-pty-remove was refused (${reply.error?.code ?? "unknown"})${detail}`);
  }
  if (!reply.result || typeof reply.result !== "object" || !("pid" in reply.result) || reply.result.pid !== readDarwinRemovalPeer(socket)?.pid)
    throw uncertain("hosted-pty-remove did not confirm the verified daemon lifetime");
}

/** A stopped daemon cannot authorize host removal. Only the legacy path with no local hosted
 * evidence is eligible here. Refuse rather than guess whether a receipt or cached socket is stale. */
export function requireNoDarwinHostedEvidence(): void {
  const uid = process.getuid?.();
  if (!uid) throw new Error("hosted-pty-remove could not verify the installation account");
  const home = realpathSync.native(homeCotalDir());
  checkDir(home, uid);
  const base = join(home, "daemon");
  if (lstatSync(base, { throwIfNoEntry: false })) {
    checkDir(base, uid);
    for (const name of ["pty-hosts", "pty-host-launchd"]) {
      const path = join(base, name);
      if (!lstatSync(path, { throwIfNoEntry: false })) continue;
      checkDir(path, uid);
      const dir = opendirSync(path);
      try { if (dir.readSync()) throw new Error("hosted-pty-remove needs the owned daemon to verify retained custody"); }
      finally { dir.closeSync(); }
    }
  }
  const sockets = join(realpathSync.native(darwinUserCacheDir()), "cotal");
  if (!lstatSync(sockets, { throwIfNoEntry: false })) return;
  checkDir(sockets, uid);
  const dir = opendirSync(sockets);
  try {
    for (let n = 0, entry = dir.readSync(); entry; entry = dir.readSync(), n++) {
      if (n >= 256 || /^p-[a-f0-9]{32}\.sock$/.test(entry.name))
        throw new Error("hosted-pty-remove needs the owned daemon to verify local PTY sockets");
    }
  } finally { dir.closeSync(); }
}

interface DarwinRemovalPeer { readonly pid: number; readonly uid: number; readonly birth: string }

function readDarwinRemovalPeer(socket: Socket): DarwinRemovalPeer | undefined {
  if (process.platform !== "darwin" || socket.destroyed || socket.readableEnded || !socket.writable) return undefined;
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

export async function darwinRemovalGateReply(paths: DaemonPaths, daemonHome: string | undefined, socket: Socket, restartOwner: () => string, id: string,
  holdManagers: () => ReturnType<typeof holdDarwinRemovalManagers>, status: () => import("./protocol.js").DaemonStatus): Promise<DaemonResponse> {
  let message = "hosted-pty-remove requires the active consented uninstall transaction";
  const peer = readDarwinRemovalPeer(socket);
  const consent = () => Boolean(peer && restartOwner() === JSON.stringify(["peer", peer.uid, peer.pid, peer.birth]) &&
    hasDarwinRemovalConsent(paths.state, socket, peer, id));
  let launchFence: ReturnType<typeof holdDarwinSeatInstallationFence> | undefined;
  let managers: ReturnType<typeof holdDarwinRemovalManagers> | undefined;
  let committed = false;
  const release = () => { try { launchFence?.release(); } finally { managers?.release(); } };
  try {
    if (consent()) {
      message = "hosted-pty-remove could not verify the owned daemon receipt";
      const { receipt, installedRoot } = verifiedDarwinRemovalReceipt(paths, daemonHome, consent);
      const installation = { cotalHome: realpathSync.native(homeCotalDir()), installedRoot, ...(daemonHome === undefined ? {} : { daemonHome }) };
      message = "hosted-pty-remove could not verify the installation launch fence";
      launchFence = holdDarwinSeatInstallationFence(installation);
      managers = holdManagers();
      const verify = () => {
        if (!consent()) return false;
        const now = verifiedDarwinRemovalReceipt(paths, daemonHome, consent);
        return now.installedRoot === installedRoot && now.receipt.installedAt === receipt.installedAt && now.receipt.unitSha256 === receipt.unitSha256;
      };
      const { removeDarwinHostedSeats } = await import("./seat-removal-coordinator-darwin.js");
      message = "hosted-pty-remove could not verify the hosted stop outcome";
      await removeDarwinHostedSeats(installation, id, verify, managers);
      if (!verify() || socket.destroyed) throw new Error("uninstall consent was lost");
      const result = status();
      socket.once("close", release);
      committed = true;
      return { v: DAEMON_PROTOCOL_VERSION, id, ok: true, result };
    }
  } catch (error) {
    if (error instanceof Error && /^(?:hosted-pty-remove: |machine-hosted-pty-remove: )/.test(error.message)) message = error.message;
  } finally { if (!committed) release(); }
  return { v: DAEMON_PROTOCOL_VERSION, id, ok: false, error: { code: "DEPENDENCY_UNAVAILABLE", message } };
}
