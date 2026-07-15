import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { extensionMutationLockPath, extensionMutationLockState } from "@cotal-ai/workspace";

/**
 * The extension-prefix writer lock: serializes every `cotal ext` mutation (add/remove) AND the
 * built-in seeding reconcile against each other. A dead owner's lock is reclaimed (ESRCH → stale);
 * a live owner fails loud. Lives in its own lib so both `commands/ext.ts` and the `seed/` reconcile
 * hold it without an import cycle: the reconcile keeps it for its WHOLE run (across every seed child)
 * so an operator `ext add`/`remove` can't interleave between children and strand a stale refresh
 * decision; each seed child skips claiming it (its parent already holds it — see `commands/ext.ts`).
 */
export function claimExtensionMutation(): () => void {
  const lock = extensionMutationLockPath();
  mkdirSync(dirname(lock), { recursive: true });
  for (;;) {
    let fd: number;
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const status = extensionMutationLockState();
      if (status.state === "absent") continue; // raced with the owner's cleanup
      if (status.state === "active")
        throw new Error(`another \`cotal ext\` mutation is in progress (pid ${status.owner})`);
      rmSync(lock, { force: true });
      continue;
    }
    try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        if (readFileSync(lock, "utf8").trim() === String(process.pid)) rmSync(lock, { force: true });
      } catch { /* already reclaimed/removed */ }
    };
  }
}
