import { readFileSync, rmSync } from "node:fs";
import { join, dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { mkSecretDir, writeSecretFileAtomic, type SecretStore } from "@cotal-ai/core";

/** THE local composition of the secret keyspace: a filesystem store rooted at the workspace's
 *  `.cotal/` dir, so every canonical key (`delivery.creds`, `auth/<space>/callout.json`, …)
 *  lands byte-for-byte on today's paths. Every local caller composes through here — a hand-rolled
 *  root that drifted from `.cotal` would silently split the keyspace in two. */
export function workspaceSecretStore(root: string): FsSecretStore {
  return new FsSecretStore(join(root, ".cotal"));
}

/**
 * The default filesystem {@link SecretStore}: the workstation adapter behind core's abstract seam.
 *
 * Keys are opaque logical strings the owning packages build to MIRROR today's exact `.cotal` layout
 * per kind — `delivery.creds`, `auth/callout.json`, `<agent>.creds`, and so on — so a local
 * `cotal up` writes byte-for-byte the same files it does today. That layout is heterogeneous (a few
 * kinds are already space-segmented on disk, most are not), so each key builder reproduces its
 * kind's current path verbatim. Crucially the key carries NO injected tenant / `<space>` prefix: a
 * hosted KMS/Vault adapter adds per-tenant scope inside ITS OWN resolve from its injection context,
 * which keeps one backend-agnostic key per kind and preserves local byte-for-byte.
 *
 * This adapter adds nothing of its own: it delegates to the `secret-fs` primitives for the
 * 0600 / icacls / atomic-replace / fail-closed guarantees. Constructed with an EXPLICIT base root
 * (no ambient `~/.cotal`), absolutized so keys are cwd-independent. Lives in `@cotal-ai/workspace`,
 * not core, because on-disk layout is a workstation concern, not the wire protocol.
 *
 * Residual (documented): a symlink UNDER the root that points outside is not caught (no realpath) —
 * acceptable for a single-tenant workstation; a multi-tenant FS deployment should realpath-check.
 */
export class FsSecretStore implements SecretStore {
  private readonly root: string;

  constructor(root: string) {
    if (!root) throw new Error("FsSecretStore: root is required");
    this.root = normalize(resolve(root)); // absolutize so keys are cwd-independent
  }

  /** Resolve a logical key to an absolute path strictly UNDER `root`, fail-closed: reject empty,
   *  NUL, absolute keys, the root itself (`.`), and any key that normalizes outside the root
   *  (`..` traversal). Containment is checked via `path.relative`, not a `root + sep` prefix —
   *  the prefix form breaks at a filesystem-root base (`/` doubles the separator and rejects
   *  every key). A malformed key must never read or clobber a path outside the store's tree. */
  private resolve(key: string): string {
    if (!key || key.includes("\0"))
      throw new Error(`FsSecretStore: invalid key ${JSON.stringify(key)}`);
    if (isAbsolute(key))
      throw new Error(`FsSecretStore: key must be relative, got ${JSON.stringify(key)}`);
    const abs = normalize(join(this.root, key));
    const rel = relative(this.root, abs);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error(`FsSecretStore: key must name a file under the root: ${JSON.stringify(key)}`);
    return abs;
  }

  async get(key: string): Promise<string | undefined> {
    const p = this.resolve(key);
    try {
      return readFileSync(p, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; // absent → undefined, race-safe
      throw e;
    }
  }

  async put(key: string, value: string): Promise<void> {
    const p = this.resolve(key);
    mkSecretDir(dirname(p)); // harden the parent dir before the secret lands (0700 / private ACL)
    writeSecretFileAtomic(p, value); // temp + rename: a concurrent get sees old or new, never torn
  }

  async delete(key: string): Promise<void> {
    const p = this.resolve(key);
    try {
      rmSync(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; // already-absent is success (idempotent)
    }
  }
}
