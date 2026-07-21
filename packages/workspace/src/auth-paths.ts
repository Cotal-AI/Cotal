import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import {
  composeSpaceAuth,
  jwtIssuedAt,
  mkSecretDir,
  writeSecretFile,
  writeSecretFileAtomic,
  type BrokerAuth,
  type SecretStore,
  type SpaceAccountAuth,
  type SpaceAuth,
} from "@cotal-ai/core";

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

/** The ONE injective, case-safe space key: lowercase hex of the space's UTF-8 bytes. Every
 *  tenant-keyed namespace derives its key from this — the account filename, the user-auth state
 *  dir, the auth secret-store keys, and the machine mesh registry — because every namespace that
 *  invented its own encoding (raw name, `encodeURIComponent`) turned out to alias: ASCII case is
 *  preserved by those, so on a case-insensitive filesystem (the macOS/Windows default) `alpha` and
 *  `Alpha` addressed ONE path and the second tenant silently absorbed the first. Hex over
 *  `[0-9a-f]` cannot case-fold-collide, cannot contain a separator, and round-trips exactly. */
export function spaceKey(space: string): string {
  if (!space) throw new Error("a space name is required");
  if (space === "." || space === "..")
    throw new Error(`"${space}" cannot name a space - its state would escape the space's own segment`);
  // The hex key is injective ONLY over well-formed strings: `Buffer.from(s,"utf8")` maps EVERY lone
  // surrogate to U+FFFD, so `"\uD800"`, `"\uDFFF"` and `"�"` would all key to `efbfbd` - two
  // such spaces collapse to one `account.<key>.json`/`space.<key>` and the undercount/aliasing
  // class hex was introduced to close re-opens, sourced from malformed Unicode instead of ASCII
  // case. Reject the ill-formed input at THE one builder; every legitimate name (BMP, combining,
  // supplementary/emoji via PAIRED surrogates) is well-formed and passes untouched.
  if (!isWellFormedUnicode(space))
    throw new Error(`"${space}" is not a well-formed Unicode string (unpaired surrogate) - it cannot name a space`);
  return Buffer.from(space, "utf8").toString("hex");
}

/** Whether every UTF-16 code unit is either a BMP scalar or part of a valid surrogate PAIR — i.e.
 *  the string has no LONE surrogate. `String.prototype.isWellFormed` is ES2024 (past this build's
 *  lib target), so scan the units directly. Paired surrogates (emoji/supplementary) pass; a stray
 *  high or low surrogate fails. This is the exact predicate that makes {@link spaceKey}'s UTF-8 hex
 *  injective — `Buffer.from` folds every lone surrogate to U+FFFD, collapsing distinct names. */
function isWellFormedUnicode(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false; // high not followed by low
      i++; // valid pair — skip the low half
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false; // lone low surrogate
    }
  }
  return true;
}

/** THE per-space path/key segment — `space.<hex>`, the {@link spaceKey} under a fixed prefix so a
 *  segment is self-describing on disk and can never collide with a reserved sibling of the auth
 *  dir (`broker.json`, `account.<hex>.json`, `server.conf`, `creds/`): none of those start with
 *  `space.`, and the hex body cannot smuggle one in. Consumed by the state dir AND the auth
 *  secret-store key builders; two independently-guarded encoders were the defect generator (one
 *  gains a rule the other doesn't), so keep exactly one. */
export function spaceSegment(space: string): string {
  return `space.${spaceKey(space)}`;
}

const SPACE_SEGMENT_PREFIX = "space.";

/** The space a canonical segment encodes, or undefined when the name is not one {@link spaceSegment}
 *  wrote (wrong prefix, non-hex body, or a body that does not round-trip). Enumeration and the
 *  legacy-layout shim both need this to tell the canonical namespace from strays. */
export function spaceFromSegment(name: string): string | undefined {
  if (!name.startsWith(SPACE_SEGMENT_PREFIX)) return undefined;
  const key = name.slice(SPACE_SEGMENT_PREFIX.length);
  if (key.length === 0 || key.length % 2 !== 0 || !/^[0-9a-f]+$/.test(key)) return undefined;
  const space = Buffer.from(key, "hex").toString("utf8");
  return space.length > 0 && spaceKey(space) === key ? space : undefined;
}

/** The SPACE-SCOPED user-auth state dir (`<root>/.cotal/auth/space.<hex>`) — the one layout fact
 *  the workstation layer owns about user auth: the auth provider persists its material under this
 *  dir (opaque to us), and its EXISTENCE marks the space as user-auth-enabled on disk. Keyed by
 *  {@link spaceSegment} so two case-differing tenants can never share one state dir and no space
 *  name can alias a reserved sibling of the auth dir. Fails loud on a degenerate space — BEFORE
 *  any caller can mutate at an aliased path.
 *
 *  Also the ONE migration point for pre-hex layouts (`<authDir>/<encodeURIComponent(space)>`):
 *  every consumer of a space's user-auth state — the marker check, the provider's `dir`, and the
 *  secret-store keys resolved beside it — obtains this path first, so renaming the legacy dir to
 *  the canonical segment HERE means no flow can ever read (or worse, `ensure*`-REGENERATE) beside
 *  material the old layout still holds. Deliberately not in {@link hasUserAuthState} alone: a
 *  user-mode connect through a registry record never consults the marker before minting. */
export function userAuthStateDir(root: string, space: string): string {
  const canonical = join(authDir(root), spaceSegment(space));
  migrateLegacyUserAuthState(root, space, canonical);
  return canonical;
}

/** One-time shim for state dirs written before the hex segment. Byte-exact only: the legacy name
 *  must appear verbatim in the directory listing — a mere `existsSync` would case-fold on
 *  macOS/Windows and migrate a DIFFERENT space's dir. `creds` is the agent-creds dir, the one
 *  legacy spelling that was always an alias rather than state, so it is excluded rather than
 *  renamed out from under every agent secret. Only a dir carrying a provider pin migrates — an
 *  empty husk is a crashed enable, not state.
 *
 *  The one irreducibly AMBIGUOUS case fails LOUD: a space literally named `space.<validhex>` has a
 *  pre-hex dir whose name IS a canonical segment of a DIFFERENT space (e.g. `space.616c706861` is
 *  both that space's legacy dir and the canonical home of `alpha`). Nothing on disk can say which
 *  space owns it, so migrating either way would misattribute state - silently reading it as static
 *  (the old bug: a user-auth space flips, and `mint` writes static admin creds) or stealing another
 *  tenant's canonical dir. Refuse and make the operator disambiguate, rather than infer ownership
 *  from the directory spelling. */
function migrateLegacyUserAuthState(root: string, space: string, canonical: string): void {
  const legacyName = encodeURIComponent(space);
  if (legacyName === "creds") return;
  if (existsSync(canonical)) return; // already canonical (hex cannot case-fold, so this is exact)
  const dir = authDir(root);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  const hit = entries.find((e) => e.name === legacyName && e.isDirectory());
  if (!hit || !pathHasUserAuthMarker(join(dir, legacyName))) return;
  if (spaceFromSegment(legacyName) !== undefined)
    throw new Error(
      `${join(dir, legacyName)} is ambiguous: it is the pre-hex user-auth state dir of space "${space}" AND a canonical segment of space "${spaceFromSegment(legacyName)}" - refusing to guess which tenant owns it. Move it to ${canonical} yourself if it belongs to "${space}", or remove it.`,
    );
  renameSync(join(dir, legacyName), canonical);
}

/** The provider's first-written user-auth pins. Workspace owns the LOCATION of a space's user-auth
 *  state ({@link userAuthStateDir}) and the fact that one of these files inside it marks the space
 *  user-auth-enabled; the auth provider owns their contents. `idp.json` is written first at enable and
 *  `callout.json` right after, so EITHER marks a real state dir. The pin check is what makes the marker
 *  sound where a bare `existsSync` is not: neither file can appear inside a sibling like `creds/`, nor
 *  can a plain file (`broker.json`, `account.<hex>.json`) that aliases the state-dir PATH ever satisfy
 *  it (a file has no children). */
const USER_AUTH_MARKER_FILES = ["idp.json", "callout.json"] as const;

function pathHasUserAuthMarker(dir: string): boolean {
  let st;
  try {
    st = statSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  if (!st.isDirectory()) return false;
  // The pin check must be errno-disciplined like the dir stat above: a bare `existsSync` maps EVERY
  // failure (EACCES, ELOOP, EIO, …) to `false`, which reads a REAL but momentarily unreadable
  // user-auth state dir as "static mode" — and a caller like `mint` then writes static admin creds
  // onto a user-auth space. Only ENOENT means "this pin is absent"; anything else is uncertainty
  // about a trust marker, and uncertainty fails CLOSED (loud), never open.
  return USER_AUTH_MARKER_FILES.some((f) => {
    try {
      return statSync(join(dir, f)).isFile();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
  });
}

/** Whether `space` is user-auth-enabled ON DISK under `root` — the authoritative marker, NOT a bare
 *  `existsSync` on {@link userAuthStateDir}: only a real provider pin inside a real directory
 *  counts. The state-dir read goes through {@link userAuthStateDir}, so a pre-hex legacy layout
 *  has already been migrated by the time the marker is checked. */
export function hasUserAuthState(root: string, space: string): boolean {
  return pathHasUserAuthMarker(userAuthStateDir(root, space));
}

/** Every space with user-auth state under this auth dir, detectable WITHOUT `broker.json`/accounts:
 *  each enabled space is a `space.<hex>` subdirectory carrying a provider pin. The enumerating
 *  companion to {@link hasUserAuthState}; both share {@link pathHasUserAuthMarker} so a single
 *  space and the whole-dir sweep can never disagree on what "user-auth on disk" means. Pre-hex
 *  legacy dirs are reported too (decoded from their verbatim names), so a guard reading this stays
 *  fail-closed before the one-time migration has run. */
export function userAuthSpacesOnDisk(dir: string): string[] {
  if (!existsSync(dir)) return []; // no auth dir at all — nothing user-auth here
  const out = new Set<string>();
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === "creds" || !pathHasUserAuthMarker(join(dir, e.name))) continue;
    const canonical = spaceFromSegment(e.name);
    if (canonical !== undefined) {
      out.add(canonical);
      continue;
    }
    try {
      out.add(decodeURIComponent(e.name)); // legacy layout — verbatim name, decoded
    } catch {
      /* a stray dir that decodes as neither layout is not a space */
    }
  }
  return [...out];
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

// ---- broker trust and space accounts are SEPARATE persisted authorities (W4) ----
//
// A nats-server trusts exactly one operator and one system account, so broker trust is per-BROKER
// and has exactly one owner on disk (`auth/broker.json`). Each space owns only its own data account
// (`auth/account.<key>.json`, a flat file beside `broker.json`, keyed by {@link accountFileKey})
// and REFERENCES broker trust rather than embedding it. Embedding it per space is the bug this split
// exists to prevent: a rotation done through space A would update A's embedded copy while space B
// kept loading a stale one and resurrected dead broker trust.
//
// The composed {@link SpaceAuth} is a READ view only (see core's `composeSpaceAuth`); there is no
// persisted document with that shape any more. The pre-W4 monolith is migration INPUT only.

const BROKER_FILE = "broker.json";
const SPACE_ACCOUNT_PREFIX = "account.";
const SPACE_ACCOUNT_SUFFIX = ".json";

/** Where the one broker trust record lives. */
export function brokerAuthPath(dir: string): string {
  return join(dir, BROKER_FILE);
}

/** The account file's key IS {@link spaceKey} — one injective, case-safe encoder for every
 *  tenant-keyed namespace. The space's real name rides in the document, never inferred from the
 *  key alone. */
function accountFileKey(space: string): string {
  return spaceKey(space);
}

/** Read one auth-material record: the file's raw text, or undefined when absent. lstat-disciplined
 *  and framed, shared by every load/save below so the readers cannot disagree:
 *   - a non-regular entry at a trust path (symlink, directory, fifo) is REFUSED, never followed —
 *     nothing in this module writes one, so following it would trust material this module cannot
 *     vouch for (and enumeration counts the same entry as corrupt: one answer everywhere);
 *   - only ENOENT means absent; any other errno is uncertainty about trust material and throws;
 *   - the JSON parse is wrapped so a truncated/hand-edited record surfaces as one legible sentence
 *     naming the file, never a raw SyntaxError deep in a caller. */
function readAuthRecord<T>(f: string, what: string): T | undefined {
  let st;
  try {
    st = lstatSync(f);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  if (!st.isFile())
    throw new Error(`${f} is not a regular file - refusing to read ${what} through it; remove or restore the real record`);
  try {
    return JSON.parse(readFileSync(f, "utf8")) as T;
  } catch (e) {
    throw new Error(`${f} does not parse as ${what} (${e instanceof Error ? e.message : String(e)}) - restore it from backup or remove it deliberately`);
  }
}

/** The space a canonical account filename encodes, or undefined when the name is not one THIS module
 *  wrote (wrong prefix/suffix, non-hex body, or a body that does not round-trip back to the same
 *  filename). Enumeration treats an undefined result as a corrupt/foreign record, never as a tenant. */
function spaceFromAccountFile(name: string): string | undefined {
  if (!name.startsWith(SPACE_ACCOUNT_PREFIX) || !name.endsWith(SPACE_ACCOUNT_SUFFIX)) return undefined;
  const key = name.slice(SPACE_ACCOUNT_PREFIX.length, name.length - SPACE_ACCOUNT_SUFFIX.length);
  if (key.length === 0 || key.length % 2 !== 0 || !/^[0-9a-f]+$/.test(key)) return undefined;
  const space = Buffer.from(key, "hex").toString("utf8");
  return space.length > 0 && accountFileKey(space) === key ? space : undefined;
}

/** Whether `v` carries the {@link SpaceAccountAuth} account material a reader will dereference. A
 *  record can round-trip its `space` yet be semantically empty (`{"space":"alpha"}`, no `account`),
 *  which a name-only check counts as a tenant - then `composeSpaceAuth`/`status` crash on
 *  `account.jwt` of undefined. "Validated inventory" must mean the shape those readers compose, so
 *  the fields they read (pub/jwt/signingSeed/signingPub, all non-empty strings) are required here. */
function isAccountShape(v: unknown): boolean {
  if (v === null || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return (["pub", "jwt", "signingSeed", "signingPub"] as const).every((k) => typeof a[k] === "string" && (a[k] as string).length > 0);
}

/** Where one space's own account record lives: a FLAT file beside `broker.json`, keyed by
 *  {@link accountFileKey}. Flat (not `<space>/account.json`) because `<authDir>/<space>/` is
 *  {@link userAuthStateDir}; hex-keyed because a raw space name in the filename both aliased that
 *  user-auth marker and case-folded on macOS/Windows. The name of a space is authoritative in the
 *  document, so enumeration never has to trust the filename beyond finding the record. */
export function spaceAccountPath(dir: string, space: string): string {
  return join(dir, `${SPACE_ACCOUNT_PREFIX}${accountFileKey(space)}${SPACE_ACCOUNT_SUFFIX}`);
}

/** Runtime-validate a system-account generation. `readAuthRecord` is only a type CAST over JSON,
 *  so a hand-edited string/float/negative/unsafe value would otherwise flow into the successor
 *  arithmetic and destroy the discriminator ("0"+1 is "01"; at 2^53, gen+1 === gen). ONLY an
 *  ABSENT field reads as 0 - that is the one shape a pre-generation record can have, because the
 *  writer always emits a number. An explicit JSON `null` can only come from tampering/corruption,
 *  and defaulting it would turn a doctored current record into a "generation-0 predecessor" and
 *  re-arm the very rollback this field exists to refuse (found live in review). Every PRESENT
 *  value must be a non-negative safe integer or the record is corrupt - fail closed BEFORE any
 *  idempotent/successor handling. */
function brokerGen(v: unknown, where: string): number {
  if (v === undefined) return 0;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
    throw new Error(`${where}: system-account generation ${JSON.stringify(v)} is not a non-negative integer - the record is corrupt; restore it from backup`);
  return v;
}

/** Persist BROKER trust. `sys.signingSeed` is STRIPPED before writing: it is broker-admin minting
 *  capability, so it never lands on disk (it lives only in the in-memory {@link createBrokerAuth}
 *  result). A composition that must add spaces after first boot has to hold that seed in a
 *  BROKER-scoped secret store instead; see core's `BrokerAuth`. */
export function saveBrokerAuth(dir: string, broker: BrokerAuth): void {
  if (!broker.operator.seed || !broker.operator.jwt || !broker.sys.pub)
    throw new Error("saveBrokerAuth: refusing to persist blank broker trust - a stripped auth value cannot own the broker record");
  const f = brokerAuthPath(dir);
  const existing = readAuthRecord<BrokerAuth>(f, "broker trust");
  let gen: number;
  if (existing) {
    // Overwriting the broker record is only safe for the SAME operator (a system-account rotation
    // keeps the operator SEED and only re-issues its JWT + `sys`). A DIFFERENT operator seed means a
    // fresh broker root - every space account here is signed by the current operator, so replacing it
    // orphans them ALL. That is exactly what a naive `createSpaceAuth` for a second space on this root
    // would do; refuse it loud rather than silently break the existing tenants. A new space must be
    // signed by the existing broker, never mint its own.
    if (existing.operator?.seed !== broker.operator.seed)
      throw new Error(
        `${f} already holds a different broker operator - refusing to overwrite it: every space account on this broker is signed by the current operator, so replacing it would orphan them all. Sign the new space under the existing broker instead of minting a fresh operator.`,
      );
    // Same operator: the write must still move FORWARD. "Same seed" alone would let a stale
    // pre-rotation value (e.g. a copy held in memory across a rotateSystemAccount) overwrite the
    // newer record and resurrect the RETIRED system account. The discriminator is the GENERATION:
    // rotateSystemAccount bumps it in memory, so a sys-changing value is writable only when it is
    // the DIRECT SUCCESSOR of the current record - a pre-rotation copy is generations behind even
    // when the record itself never held it (rotation persisted first). The JWT `iat` alone cannot
    // order generations - it is second-resolution, so a rotation minted within the same second as
    // its predecessor is `iat`-equal yet a different authority (found live in review); it stays
    // only as a belt against a hand-edited gen smuggling a provably OLDER sys back in.
    if (!existing.sys?.jwt)
      throw new Error(`${f} holds broker trust without a system-account JWT - the record is corrupt; restore it from backup before overwriting`);
    // BOTH generations validate before EITHER branch: a malformed value refuses even on the
    // byte-identical idempotent path, rather than being silently absorbed and rewritten - a
    // corrupt input never gets a success exit from a trust write.
    const persistedGen = brokerGen(existing.gen, f);
    const incomingGen = brokerGen(broker.gen, "the value being written");
    const sysUnchanged = existing.sys.pub === broker.sys.pub && existing.sys.jwt === broker.sys.jwt;
    if (sysUnchanged) {
      gen = persistedGen; // idempotent re-save of the current authority - the generation holds
    } else {
      if (incomingGen !== persistedGen + 1)
        throw new Error(
          `${f} is at system-account generation ${persistedGen} and a system-account change must be its direct successor (generation ${persistedGen + 1}), but the value being written carries generation ${incomingGen} - refusing the stale write: it would resurrect a retired system account. Rotate from the current broker record and save that result.`,
        );
      if (jwtIssuedAt(broker.sys.jwt) < jwtIssuedAt(existing.sys.jwt))
        throw new Error(
          `${f} holds a NEWER system account (issued ${jwtIssuedAt(existing.sys.jwt)}) than the value being written (issued ${jwtIssuedAt(broker.sys.jwt)}) - refusing the rollback: it would resurrect a retired system account.`,
        );
      gen = incomingGen; // the successor generation the rotation minted
    }
  } else {
    // No broker record - but that alone must not authorize a FRESH operator: with account records
    // present (broker.json lost, tenants intact) an unconditional write would install a new
    // operator and orphan every tenant. The write is a legitimate REPAIR only when the incoming
    // operator provably signed the existing accounts, so verify each one; and the check must range
    // over the VALIDATED inventory - an unreadable record might be a real tenant, so any corrupt
    // entry keeps the refusal (the same fail-closed posture as the broker-wide guard).
    // Residual (accepted): two concurrent FIRST-TIME writes on a genuinely fresh root both pass
    // this check and last-writer-wins; real usage serializes on the single `up`/store per root.
    gen = brokerGen(broker.gen, "the value being written"); // a fresh record keeps the value's generation (0 if new)
    const { spaces, corrupt } = accountInventory(dir);
    if (corrupt.length > 0)
      throw new Error(
        `${dir} has no broker record but holds unreadable account record(s) (${corrupt.join(", ")}) - refusing to install an operator while the tenant list is uncertain; repair or remove them first`,
      );
    for (const space of spaces) {
      const account = loadSpaceAccountAuth(dir, space);
      if (!account) continue; // raced away since the inventory read - nothing left to orphan
      try {
        composeSpaceAuth(broker, account);
      } catch (e) {
        throw new Error(
          `${dir} has no broker record but holds accounts for ${spaces.join(", ")}, and the operator being written did not sign "${space}" (${e instanceof Error ? e.message : String(e)}) - refusing to install it: the existing tenants would be orphaned. Restore the original broker.json from backup instead.`,
        );
      }
    }
  }
  mkSecretDir(dir); // harden the auth dir BEFORE the secret lands (private ACL on win32, 0700 POSIX)
  const onDisk: BrokerAuth = { operator: broker.operator, sys: { pub: broker.sys.pub, jwt: broker.sys.jwt }, gen };
  writeSecretFile(f, JSON.stringify(onDisk, null, 2));
}

/** Load BROKER trust, or undefined if auth was never set up here. Reads the pre-W4 monolith as
 *  MIGRATION INPUT when the broker record does not exist yet. */
export function loadBrokerAuth(dir: string): BrokerAuth | undefined {
  const broker = readAuthRecord<BrokerAuth>(brokerAuthPath(dir), "broker trust");
  if (broker) return broker;
  const legacy = loadLegacySpaceAuth(dir);
  return legacy ? { operator: legacy.operator, sys: legacy.sys } : undefined;
}

/** Persist ONE space's account record. Never carries broker material. Refuses to overwrite a record
 *  that already holds a DIFFERENT space: with an injective hex key that only happens on a corrupted
 *  or hand-swapped file, and silently replacing one tenant's signing authority with another's must
 *  fail loud. */
export function saveSpaceAccountAuth(dir: string, spaceAccount: SpaceAccountAuth): void {
  const target = spaceAccountPath(dir, spaceAccount.space);
  const existing = readAuthRecord<SpaceAccountAuth>(target, "a space account record");
  if (existing && existing.space !== spaceAccount.space)
    throw new Error(`${target} holds space "${existing.space}"; refusing to overwrite it with "${spaceAccount.space}"`);
  mkSecretDir(dirname(target));
  const onDisk: SpaceAccountAuth = { space: spaceAccount.space, account: spaceAccount.account };
  writeSecretFile(target, JSON.stringify(onDisk, null, 2));
}

/** Load ONE space's account record, or undefined. Reads the pre-W4 monolith as MIGRATION INPUT when
 *  the per-space record does not exist yet AND that monolith is for this same space - a monolith for
 *  a DIFFERENT space must never satisfy a load for this one. */
export function loadSpaceAccountAuth(dir: string, space: string): SpaceAccountAuth | undefined {
  const doc = readAuthRecord<SpaceAccountAuth>(spaceAccountPath(dir, space), "a space account record");
  if (doc) {
    if (doc.space !== space)
      throw new Error(`${spaceAccountPath(dir, space)} holds space "${doc.space}", not "${space}" - the account record was renamed or corrupted`);
    if (!isAccountShape(doc.account))
      throw new Error(`${spaceAccountPath(dir, space)} is missing its account material (pub/jwt/signingSeed/signingPub) - the record is corrupt; restore it from backup`);
    return doc;
  }
  const legacy = loadLegacySpaceAuth(dir);
  if (!legacy || legacy.space !== space) return undefined;
  return { space: legacy.space, account: legacy.account };
}

/** The pre-W4 single-document trust material. MIGRATION INPUT ONLY - nothing writes this shape now. */
function loadLegacySpaceAuth(dir: string): SpaceAuth | undefined {
  return readAuthRecord<SpaceAuth>(join(dir, AUTH_FILE), "pre-W4 trust material");
}

/** Load the COMPOSED read view of one space's trust chain, or undefined if either authority is
 *  missing. The space key is REQUIRED: once a broker holds N accounts, a root-wide "the auth" load is
 *  intrinsically ambiguous, and picking a default silently would let (for example) a manager bound to
 *  space B mint B's agents into space A's account. Composition also asserts that this account really
 *  was signed by this broker's operator. */
export function loadSpaceAuth(dir: string, space: string): SpaceAuth | undefined {
  // The STRIPPED SIGNER bundle (`cotal mint --signer`, mounted read-only at `auth/auth.json` in a
  // containerized manager) is the one legacy shape that can never compose: `stripSpaceAuth`
  // deliberately blanks the broker root-of-trust and keeps only this space's account signing
  // material, so there is no signature chain to verify - its trust IS the operator's decision to
  // mount it (unchanged from pre-split). Recognize it precisely - split records absent, monolith
  // present for THIS space, operator blanked, signing seed present - and return it as-is; any
  // other shape must compose and verify the account really was signed by this broker's operator.
  if (!existsSync(brokerAuthPath(dir)) && !existsSync(spaceAccountPath(dir, space))) {
    const legacy = loadLegacySpaceAuth(dir);
    if (legacy && legacy.space === space && !legacy.operator?.seed && legacy.account?.signingSeed)
      return legacy;
  }
  const broker = loadBrokerAuth(dir);
  const spaceAccount = loadSpaceAccountAuth(dir, space);
  if (!broker || !spaceAccount) return undefined;
  return composeSpaceAuth(broker, spaceAccount);
}

/** The composed trust of the ONE space this auth dir holds - the space-blind convenience for callers
 *  that predate multi-space (a folder's own mesh, `mint` in a checkout, a status read). Fails loud
 *  when the root holds several, via {@link soleSpaceOf}. Prefer {@link loadSpaceAuth} with an
 *  explicit space wherever the caller can know it. */
export function loadSoleSpaceAuth(dir: string): SpaceAuth | undefined {
  const space = soleSpaceOf(dir);
  return space ? loadSpaceAuth(dir, space) : undefined;
}

/** Persist a composed value by DECOMPOSING it into its two authorities. This is the migration-era
 *  writer for the many existing callers that hold a composed {@link SpaceAuth}; it is safe because
 *  there is exactly ONE broker record, so writing broker trust through any space updates the single
 *  owner rather than a per-space copy. It refuses a stripped value outright: `stripSpaceAuth` blanks
 *  the operator and system account, and decomposing that would blank broker persistence. */
export function saveSpaceAuth(dir: string, auth: SpaceAuth): void {
  saveBrokerAuth(dir, auth); // throws on a stripped/blank broker half
  saveSpaceAccountAuth(dir, auth);
}

/** The ONE space this auth dir holds, for the legacy paths that predate multi-space and carry no
 *  explicit space (a folder's "its own" space, a root-wide daemon remint). Undefined when the root
 *  has no auth at all.
 *
 *  FAILS LOUD when the root holds several, rather than picking the first or a "current": a
 *  space-blind caller that silently picks is exactly how a component bound to space B mints into
 *  space A's account. Callers that can know their space must pass it explicitly instead of using
 *  this; this exists so the remaining space-blind paths become a loud error rather than a wrong
 *  answer the day a root holds two. */
export function soleSpaceOf(dir: string): string | undefined {
  const { spaces, corrupt } = accountInventory(dir);
  if (corrupt.length > 0)
    throw new Error(
      `${dir} holds ${corrupt.length} unreadable account record(s) (${corrupt.join(", ")}) - refusing to name a sole space while the tenant count is uncertain; repair or remove them`,
    );
  if (spaces.length === 0) return undefined;
  if (spaces.length > 1)
    throw new Error(
      `${dir} holds accounts for ${spaces.length} spaces (${spaces.join(", ")}) - this operation has no explicit space and refuses to pick one; pass the space explicitly`,
    );
  return spaces[0];
}

/** Refuse a BROKER-WIDE operation on a root that hosts several spaces - or whose tenant list cannot
 *  be read with certainty.
 *
 *  Distinct from {@link soleSpaceOf}'s ambiguity, and the distinction is the whole point: the
 *  broker process, its JetStream store and the single `.cotal/auth` broker record are shared by
 *  every space on the root, so naming a space cannot scope `down`, `clean store|all`, `backup` or a
 *  restore - they would apply to all of them regardless. Sending the operator after a `--space` they
 *  cannot use (two of these commands do not even take one) is a dead end dressed as advice, so this
 *  refusal names the blast radius and stops, and stays a refusal until per-space teardown exists.
 *
 *  A corrupt/foreign account record is refused too, NOT skipped: an under-count is the fail-open
 *  this guard exists to prevent - a file that occupies the account namespace but will not validate
 *  might be a real tenant, so the blast radius is unknown and a broker-wide delete must not proceed. */
export function assertSingleSpaceBroker(dir: string, operation: string): void {
  const { spaces, corrupt } = accountInventory(dir);
  if (corrupt.length > 0)
    throw new Error(
      `${operation} is broker-wide and this broker's tenant list is not fully readable (${corrupt.join(", ")}) - refusing to act while the blast radius is uncertain; repair or remove those account records first`,
    );
  if (spaces.length > 1)
    throw new Error(
      `${operation} is broker-wide, and this broker hosts ${spaces.length} spaces (${spaces.join(", ")}) - it would apply to every one of them, and naming a single space cannot scope it; a per-space form does not exist yet`,
    );
}

/** The VALIDATED tenant inventory of an auth dir - the ONE read of "how many tenants" every other
 *  surface derives from (the broker-wide guards, `soleSpaceOf`, `cotal status`, the target
 *  resolver). Four surfaces each reading the disk their own way is how an under-count slips past
 *  exactly one of them; there must be a single answer.
 *
 *  `spaces` are the tenants whose account records are regular files that parse, carry a `space`
 *  equal to their own injective filename key, and round-trip. `corrupt` is every entry that
 *  OCCUPIES the account namespace (`account.*.json`) yet fails any of that - including a
 *  non-regular entry (symlink, directory): `Dirent.isFile()` is lstat-semantics, so skipping those
 *  would drop a tenant whose record was symlinked while `loadSpaceAccountAuth`'s path still
 *  resolved it - the exact under-count the guards exist to refuse. The authoritative name is the
 *  record's own `space`, never inferred from the filename. `corrupt` is what turns the guards
 *  fail-CLOSED: an unreadable record is uncertainty about how many tenants exist, and a
 *  broker-wide operation must not proceed on an under-count. */
export function accountInventory(dir: string): { spaces: string[]; corrupt: string[] } {
  const spaces: string[] = [];
  const corrupt: string[] = [];
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.name.startsWith(SPACE_ACCOUNT_PREFIX) || !entry.name.endsWith(SPACE_ACCOUNT_SUFFIX)) continue;
      // From here the entry CLAIMS the account namespace; anything wrong is corruption, never a skip.
      const fromName = spaceFromAccountFile(entry.name);
      if (fromName === undefined || !entry.isFile()) {
        corrupt.push(entry.name);
        continue;
      }
      let doc: { space?: unknown; account?: unknown };
      try {
        doc = JSON.parse(readFileSync(join(dir, entry.name), "utf8")) as { space?: unknown; account?: unknown };
      } catch {
        corrupt.push(entry.name);
        continue;
      }
      // The name must round-trip AND the record must carry the account material it claims to.
      // "Validated inventory" has to mean the shape a reader will compose, or a semantically-empty
      // record (`{"space":"alpha"}`, no `account`) counts as a tenant here and then crashes the very
      // `status`/compose path this inventory exists to keep fail-closed. Match the SpaceAccountAuth
      // fields those readers dereference; a missing/blank one is corruption, not a tenant.
      if (typeof doc.space !== "string" || doc.space !== fromName || !isAccountShape(doc.account)) {
        corrupt.push(entry.name);
        continue;
      }
      spaces.push(doc.space);
    }
  }
  // The pre-W4 monolith counts as a tenant too; one that will not read counts as CORRUPT, not as
  // absent - a reader like `status` must see the uncertainty, not crash or under-count on it.
  try {
    const legacy = loadLegacySpaceAuth(dir);
    if (legacy && typeof legacy.space === "string" && legacy.space && !spaces.includes(legacy.space)) spaces.push(legacy.space);
  } catch {
    corrupt.push(AUTH_FILE);
  }
  return { spaces: spaces.sort(), corrupt: corrupt.sort() };
}

/** Every space that has a VALID account record under this auth dir. The broker's tenant list on disk;
 *  names come from each record's authoritative `space`. Callers that must act on the blast radius use
 *  {@link assertSingleSpaceBroker} / {@link soleSpaceOf}, which also refuse on an unreadable record. */
export function listSpaceAccounts(dir: string): string[] {
  return accountInventory(dir).spaces;
}
