import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { mkSecretDir, writeSecretFileAtomic, writeSecretFileCreateOnly, type SecretStore, type SecretStoreIdentity } from "@cotal-ai/core";

/** The file in which a filesystem store records the random id its identity carries. No key may name
 *  it: the id is published to peers, so a secret stored there would be published with it. */
const STORE_ID_FILE = "store.id";

/** What `randomUUID` writes. An id file holding anything else may hold a secret, so it is never published. */
const STORE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether `path` is the id file of the store rooted at `dir`. Its own path is, and so is any other
 *  name the filesystem resolves to that file. No spelling rule can list those (a case-insensitive
 *  filesystem folds `STORE.ID` onto it, and a link reaches it under any name), so they are found by
 *  device and inode once the file exists. */
export function isStoreIdFile(dir: string, path: string): boolean {
  const idFile = resolve(dir, STORE_ID_FILE);
  if (resolve(path) === idFile) return true;
  const id = statSync(idFile, { bigint: true, throwIfNoEntry: false });
  if (id === undefined) return false;
  const file = statSync(path, { bigint: true, throwIfNoEntry: false });
  return file !== undefined && file.dev === id.dev && file.ino === id.ino;
}

/** THE local composition of the secret keyspace: a filesystem store rooted at the workspace's
 *  `.cotal/` dir, so every canonical key (`delivery.creds`, `auth/<space>/callout.json`, …)
 *  lands byte-for-byte on today's paths. Every local caller composes through here — a hand-rolled
 *  root that drifted from `.cotal` would silently split the keyspace in two. */
export function workspaceSecretStore(root: string): FsSecretStore {
  const workspaceRoot = normalize(resolve(root));
  return new FsSecretStore(join(workspaceRoot, ".cotal"), workspaceRoot);
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
  private readonly identityRoot: string;

  /** `identityRoot` is the root the identity names when that is not the store's own directory: the
   *  workspace store lives in `<root>/.cotal` and is named by `<root>`. */
  constructor(root: string, identityRoot?: string) {
    if (!root) throw new Error("FsSecretStore: root is required");
    this.root = normalize(resolve(root)); // absolutize so keys are cwd-independent
    this.identityRoot = identityRoot ?? this.root;
  }

  /** The root is a local path, so two hosts that mount different directories at one path would
   *  name one store by it alone (#2580). The id is random and lives inside the store, so only the
   *  same directory carries it. It is written the first time a process names this store or puts a key. */
  get identity(): SecretStoreIdentity {
    const p = this.idFile();
    const id = readFileSync(p, "utf8");
    if (!STORE_ID.test(id))
      throw new Error(`FsSecretStore: ${p} does not hold a store id (a lowercase UUID and nothing else); rename or remove it`);
    return { kind: "fs", root: this.identityRoot, id };
  }

  /** The id file, written only by exclusive create, so an existing one is never replaced. */
  private idFile(): string {
    const p = join(this.root, STORE_ID_FILE);
    if (!existsSync(p)) {
      mkSecretDir(this.root);
      try {
        writeSecretFileCreateOnly(p, randomUUID());
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; // a concurrent first use won
      }
    }
    return p;
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

  private refuseIdFile(key: string, p: string): void {
    if (isStoreIdFile(this.root, p))
      throw new Error(`FsSecretStore: key ${JSON.stringify(key)} names the file that holds the store id`);
  }

  async get(key: string): Promise<string | undefined> {
    const p = this.resolve(key);
    this.refuseIdFile(key, p);
    try {
      return readFileSync(p, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; // absent → undefined, race-safe
      throw e;
    }
  }

  async put(key: string, value: string): Promise<void> {
    const p = this.resolve(key);
    this.idFile(); // a name the filesystem folds onto the id file can only be told once that file exists
    this.refuseIdFile(key, p);
    mkSecretDir(dirname(p)); // harden the parent dir before the secret lands (0700 / private ACL)
    writeSecretFileAtomic(p, value); // temp + rename: a concurrent get sees old or new, never torn
  }

  async delete(key: string): Promise<void> {
    const p = this.resolve(key);
    this.refuseIdFile(key, p);
    try {
      rmSync(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; // already-absent is success (idempotent)
    }
  }
}
