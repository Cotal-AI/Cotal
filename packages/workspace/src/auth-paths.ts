import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { mkSecretDir, writeSecretFile, type SpaceAuth } from "@cotal-ai/core";

/**
 * On-disk auth-material I/O for a local checkout's `.cotal/` — machine-local path resolution plus
 * reading/writing the space trust material. Lives in `@cotal-ai/workspace` (not core) because it's a
 * workstation concern — *where a checkout's `.cotal/` is on THIS disk* — not part of the wire
 * protocol. The minting / JWT / `nats-server` config machinery stays in `@cotal-ai/core`; these
 * helpers persist its output. `SpaceAuth` is core's type — imported here, owned there.
 *
 * Deliberately explicit-root/path APIs: no ambient `findAndMint()` that fuses root discovery with
 * signing. File modes (0700 dirs / 0600 files) and the no-arbitrary-delete posture are preserved.
 */

const AUTH_FILE = "auth.json";

export function authDir(root: string): string {
  return join(root, ".cotal", "auth");
}

/** Find the project's `.cotal/` by walking up from `start` (like git finds `.git`), returning the
 *  directory that *contains* `.cotal/`. Falls back to `start` when none is found up the tree (a
 *  fresh setup creates `.cotal/` there). Lets `cotal` run from any subdirectory of a project. */
export function findCotalRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".cotal"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

/** Persist the space trust material. The file holds the data-account signing seed — treat as a secret.
 *  The system-account `sys.signingSeed` is STRIPPED before writing: it is broker-admin minting capability,
 *  so it never lands on disk (it lives only in the in-memory {@link createSpaceAuth} result). */
export function saveSpaceAuth(dir: string, auth: SpaceAuth): void {
  mkSecretDir(dir); // harden the auth dir BEFORE the secret lands (private ACL on win32, 0700 POSIX)
  const onDisk: SpaceAuth = { ...auth, sys: { pub: auth.sys.pub, jwt: auth.sys.jwt } };
  writeSecretFile(join(dir, AUTH_FILE), JSON.stringify(onDisk, null, 2));
}

/** Load the space trust material, or undefined if auth was never set up here. */
export function loadSpaceAuth(dir: string): SpaceAuth | undefined {
  const f = join(dir, AUTH_FILE);
  if (!existsSync(f)) return undefined;
  return JSON.parse(readFileSync(f, "utf8")) as SpaceAuth;
}
