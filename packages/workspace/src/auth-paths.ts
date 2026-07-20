import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { mkSecretDir, writeSecretFile, writeSecretFileAtomic, type SecretStore, type SpaceAuth } from "@cotal-ai/core";

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

/** THE per-space path/key segment — the single guarded encoder every space-keyed surface consumes
 *  (this state dir AND the auth secret-store key builders). `encodeURIComponent` keeps any real
 *  name one flat segment (`a/b` → `a%2Fb`) but leaves dots alone, so `.`/`..`/empty would alias a
 *  parent (`auth/..` normalizes OUT of the space's own segment) — refused HERE, before any path is
 *  built or state touched. Two independently-guarded encoders were the defect generator (one gains
 *  a rule the other doesn't); keep exactly one. */
export function spaceSegment(space: string): string {
  if (!space) throw new Error("a space name is required");
  const enc = encodeURIComponent(space);
  if (enc === "." || enc === "..")
    throw new Error(`"${space}" cannot name a space - its state would escape the space's own segment`);
  return enc;
}

/** The SPACE-SCOPED user-auth state dir (`<root>/.cotal/auth/<space>`) — the one layout fact the
 *  workstation layer owns about user auth: the auth provider persists its material under this dir
 *  (opaque to us), and its EXISTENCE marks the space as user-auth-enabled on disk. Space-keyed now
 *  so multi-space-per-root is a caller change, never an on-disk migration; a (broker, space) key
 *  later extends the same shape. Fails loud on a degenerate space (see {@link spaceSegment}) —
 *  BEFORE any caller can mutate at an aliased path. */
export function userAuthStateDir(root: string, space: string): string {
  return join(authDir(root), spaceSegment(space));
}

// ---- per-agent standing secrets (static creds / actor token / sentinel creds) ----

/** The dir every per-agent standing secret materializes under (`<root>/.cotal/auth/creds`) —
 *  space-INDEPENDENT today (one root serves one space); multi-space-per-root re-keys this layout
 *  as a caller change, same as {@link userAuthStateDir}'s note. */
export function agentCredsDir(root: string): string {
  return join(authDir(root), "creds");
}

/** THE per-agent file segment — the single guarded encoder under every agent-secret key AND path
 *  (the {@link spaceSegment} posture: one encoder, guarded before any key or path exists). The
 *  alphabet is the manager's spawn-name discipline (`manager.nameError`); the CLI's `--name`
 *  override historically had no such guard, so a path-hostile name is refused HERE, before it can
 *  address a key or file outside the creds dir. */
export function agentSecretSegment(name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name))
    throw new Error(`unsafe agent name ${JSON.stringify(name)} for secret material (allowed: letters, digits, _ -)`);
  return name;
}

// One filename source per kind — the store key and the materialized path project the SAME name,
// so the two can never drift apart (the `DELIVERY_CREDS_KEY` lesson, per kind).
const agentFile = {
  creds: (name: string) => `${agentSecretSegment(name)}.creds`,
  actorToken: (name: string) => `${agentSecretSegment(name)}.actor-token`,
  sentinelCreds: (name: string) => `${agentSecretSegment(name)}.sentinel.creds`,
};

/** Canonical {@link SecretStore} keys of the per-agent standing secrets, mirroring today's
 *  `.cotal/auth/creds/<name>.<kind>` layout byte-for-byte under the workspace FS composition.
 *  `<name>.creds` is the static-auth scoped cred; the actor token + sentinel cred are the
 *  user-mode pair a spawn mints. The transient `<name>.auth-health.json` is runtime state, NOT a
 *  secret kind — it stays plain-file. */
export const agentCredsKey = (name: string): string => `auth/creds/${agentFile.creds(name)}`;
export const agentActorTokenKey = (name: string): string => `auth/creds/${agentFile.actorToken(name)}`;
export const agentSentinelCredsKey = (name: string): string => `auth/creds/${agentFile.sentinelCreds(name)}`;

/** The FS materialization paths of one agent's secret family (plus its non-secret health file) —
 *  built from the SAME filename source as the key builders. These are the paths subprocesses read
 *  (the bearer re-exec's `--token-file`, a launch's creds handoff), never an alternate source of
 *  truth: under the local FS composition each path IS its key's storage location. */
export function agentSecretFilePaths(root: string, name: string): {
  creds: string; actorToken: string; sentinelCreds: string; health: string;
} {
  const dir = agentCredsDir(root);
  return {
    creds: join(dir, agentFile.creds(name)),
    actorToken: join(dir, agentFile.actorToken(name)),
    sentinelCreds: join(dir, agentFile.sentinelCreds(name)),
    health: join(dir, `${agentSecretSegment(name)}.auth-health.json`),
  };
}

/** Enumerate the store keys of every per-agent standing secret currently materialized under this
 *  root — the reset/backstop sweep (`clean all`; despawn owns the primary delete). Deliberately
 *  filename-driven over the LOCAL creds dir: this surface is the FS composition (a hosted reset
 *  rides its own store), and a file only maps to a key if a valid spawn could have written it —
 *  health files and strays are left to the caller's raw cleanup. */
export function agentSecretKeysUnder(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(agentCredsDir(root));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; // no creds dir → nothing minted
    throw e;
  }
  const keys: string[] = [];
  // Longest suffix first: `<name>.sentinel.creds` must never parse as `<name>.sentinel` + `.creds`.
  for (const file of entries) {
    for (const suffix of [".sentinel.creds", ".actor-token", ".creds"]) {
      if (!file.endsWith(suffix)) continue;
      const base = file.slice(0, -suffix.length);
      if (/^[A-Za-z0-9_-]+$/.test(base)) keys.push(`auth/creds/${file}`);
      break; // longest match decides; a rejected base is a stray either way
    }
  }
  return keys;
}

/** Materialize a store secret into a 0600 file for a process that can only read files — the
 *  agent-bearer re-exec (`--token-file`) and the launch-time creds handoff. The STORE is the
 *  source of truth; the file is a caller-owned projection at an explicit path (under the local FS
 *  composition, a byte-identical rewrite of the key's own location). An absent key fails loud:
 *  materializing nothing would hand the subprocess an empty credential. Lives here, OUTSIDE core,
 *  by decision — core's seam stays get/put/delete; where a projection lands on THIS machine is a
 *  workstation concern. */
export async function materializeSecretToFile(store: SecretStore, key: string, path: string): Promise<void> {
  const value = await store.get(key);
  if (value === undefined)
    throw new Error(`secret "${key}" is not in the store - cannot materialize it at ${path}`);
  mkSecretDir(dirname(path)); // harden the parent BEFORE the secret lands
  writeSecretFileAtomic(path, value);
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
