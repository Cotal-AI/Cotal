import { darwinBootSession } from "./host.js";
import { loadNativeHelper } from "./peercred.js";
import type { DarwinSharedIdentity } from "./shared-identity-darwin.js";

interface ProcessRow {
  pid: number;
  start: string;
  parent: number;
  group: number;
  session: number;
  uid: number;
  exited: number;
}

interface SessionNative {
  processSession(pid: number): ProcessRow | undefined;
  accountProcesses(): number[];
}

const birth = /^[1-9]\d*\.\d{6}$/;

/** Capture the actual direct child before dispatch. An unpinned session is not stop authority. */
export function captureDarwinPtySession(pid: number): DarwinSharedIdentity | undefined {
  const uid = process.getuid?.();
  if (process.platform !== "darwin" || !uid || !Number.isInteger(pid) || pid <= 1 || pid > 0x7fffffff) return undefined;
  try {
    const root = loadNativeHelper<SessionNative>().processSession(pid);
    if (root?.pid !== pid || root.uid !== uid || root.exited || root.parent !== process.pid ||
        root.group !== pid || root.session !== pid || !birth.test(root.start)) return undefined;
    return { pid, uid, start: root.start, bootId: darwinBootSession() };
  } catch { return undefined; }
}

/** Same-account evidence observed in one pass. Even an empty result is not proof of drain. */
export function observeDarwinPtySession(root: Readonly<DarwinSharedIdentity>): readonly DarwinSharedIdentity[] | undefined {
  if (process.platform !== "darwin" || !root.uid || root.uid !== process.getuid?.() ||
      !Number.isInteger(root.pid) || root.pid <= 1 || root.pid > 0x7fffffff || !birth.test(root.start)) return undefined;
  try {
    if (darwinBootSession() !== root.bootId) return undefined;
    const native = loadNativeHelper<SessionNative>();
    const matchesRoot = (): boolean => {
      const row = native.processSession(root.pid);
      return !row || row.pid === root.pid && row.start === root.start && row.uid === root.uid && row.session === root.pid;
    };
    if (!matchesRoot()) return undefined;
    const members: DarwinSharedIdentity[] = [];
    for (const pid of native.accountProcesses()) {
      const row = native.processSession(pid);
      if (!row || row.exited || row.session !== root.pid) continue;
      if (row.pid !== pid || row.uid !== root.uid || !birth.test(row.start)) return undefined;
      members.push({ pid, uid: row.uid, start: row.start, bootId: root.bootId });
    }
    return matchesRoot() ? members : undefined;
  } catch { return undefined; }
}
