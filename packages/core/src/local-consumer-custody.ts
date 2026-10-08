import { createHash } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { acquireLock, type HeldLock } from "./advisory-lock.js";

/** A terminal same-host refusal. This is cooperative custody, not broker authorization. */
export class LocalConsumerHeldError extends Error {}

/** Canonical local custody independent of cwd, HOME, XDG and launch material paths.
 * Broker aliases, other hosts and clients predating this guard are outside its guarantee. */
export function localConsumerClaimPath(servers: string, space: string, owner: string, actor: string, lifecycleUid: string): string {
  const user = userInfo();
  const root = process.platform === "linux"
    ? `/tmp/cotal-consumers-${user.uid}`
    : join(user.homedir, ".cotal-consumers");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const st = lstatSync(root);
  if (!st.isDirectory() || st.isSymbolicLink() || (process.platform !== "win32" && (st.uid !== user.uid || (st.mode & 0o077) !== 0)))
    throw new Error("local consumer custody directory is not private to this OS user");
  const targets = [...new Set(servers.split(",").map((s) => {
    const u = new URL(s.trim().includes("://") ? s.trim() : `nats://${s.trim()}`);
    u.username = "";
    u.password = "";
    if (!u.port) u.port = u.protocol === "nats:" ? "4222" : u.protocol === "wss:" ? "443" : "80";
    return u.href;
  }))].sort();
  const key = createHash("sha256").update(JSON.stringify([targets, space, owner, actor, lifecycleUid])).digest("hex");
  const path = join(root, `${key}.lock`);
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink() || (process.platform !== "win32" && (file.uid !== user.uid || (file.mode & 0o077) !== 0)))
      throw new Error("local consumer custody file is not private to this OS user");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return path;
}

/** Held by the actual consuming process, never its launcher. Reconnect retains the handle.
 * A dead process can be reclaimed by the existing PID/start-token lock protocol. */
export function acquireLocalConsumer(servers: string, space: string, owner: string, actor: string, lifecycleUid: string): HeldLock {
  return acquireLock(localConsumerClaimPath(servers, space, owner, actor, lifecycleUid), {
    waitMs: 0,
    label: "local inbox consumer",
    onTimeout: () => new LocalConsumerHeldError(`local inbox already has a consuming session for ${owner}.${actor} in space "${space}"; preserve that session and choose a distinct actor for a new launch`),
  });
}
