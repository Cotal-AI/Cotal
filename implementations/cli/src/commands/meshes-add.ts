import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { probeConnect, type SpaceAuth } from "@cotal-ai/core";
import { classifyJoinTarget, type JoinTarget } from "../lib/join-target.js";
import {
  authDir,
  findCotalRoot,
  findMesh,
  getCurrent,
  homeCotalDir,
  listSpaceAccounts,
  loadSpaceAuth,
  personaDir,
  preflightTarget,
  recordMesh,
  setCurrent,
  type MeshEntry,
  type MeshTarget,
  type PreflightFailure,
} from "@cotal-ai/workspace";

/**
 * The rules behind `cotal meshes add`, as decisions rather than side effects.
 *
 * There are two front ends — the flag form (`--server …`, what scripts and agents drive) and the
 * guided form (a bare `cotal meshes add` on a terminal) — and they must agree on every question:
 * what a usable broker URL is, what a usable root is, which mode the broker actually enforces,
 * whether the trust composes. A second copy of any of those inside the wizard is precisely the
 * drift this file exists to prevent, so each rule lives here once, returns a {@link Check}, and the
 * front ends decide only how to *present* a failure: exit with the sentence, or offer a way out.
 */

/** A rule's verdict: the value it produced, or the operator-facing sentence explaining the refusal. */
export type Check<T> = { ok: true; value: T } | { ok: false; message: string };

const bad = (message: string): Check<never> => ({ ok: false, message });
const good = <T>(value: T): Check<T> => ({ ok: true, value });

/** Is this path a directory? `existsSync` is not the question: a regular FILE named `.cotal` would
 *  pass it and record a root whose `.cotal/auth` and `.cotal/agents` can never exist. `statSync`
 *  follows symlinks, so a symlinked project dir keeps working. */
export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The broker URL, checked before it is probed, printed or persisted.
 *
 * Credentials embedded in the URL are refused for the same reason a manifest refuses them
 * (`validateBroker`): this record is written to disk and echoed back by `add` and `meshes`, so an
 * inline password would be copied into the registry and onto the operator's screen. No message
 * here repeats the input — the commonest malformed broker URL is a half-typed credential one.
 */
export function checkServer(raw: string): Check<string> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return bad("✗ --server is not a valid URL (expected something like nats://127.0.0.1:4222)");
  }
  if (!["nats:", "tls:", "ws:", "wss:"].includes(u.protocol))
    return bad(`✗ --server scheme "${u.protocol.replace(":", "")}" is not a broker scheme - use nats://, tls://, ws:// or wss://`);
  if (u.username || u.password)
    return bad(`✗ --server must not embed credentials ("${u.username}:***@…") - the registry records this URL and prints it back; pass trust material under --root instead`);
  if (u.search || u.hash)
    return bad(`✗ --server must be a bare broker URL - drop its ${u.search ? "query string" : "fragment"}`);
  if (u.pathname && u.pathname !== "/") return bad("✗ --server must be a bare broker URL - drop its path");
  if (!u.hostname) return bad("✗ --server names no host - a broker URL needs one (e.g. nats://127.0.0.1:4222)");
  return good(raw);
}

/**
 * May this machine send its credentials to that address?
 *
 * Registering a mesh is how a machine joins a broker it does not run, and every later command then
 * dials that address with an agent credential in the CONNECT line. NATS sends the initial INFO in
 * plaintext and unauthenticated, so an on-path attacker forges one that does not set
 * `tls_required` and reads the credential; the client side is the only fence, and this build has
 * no client-TLS surface yet. So the address itself is the gate. See {@link classifyJoinTarget} for
 * the ranges and for why hostnames are refused even when they resolve somewhere permitted.
 *
 * This is a SAFETY rule, not a liveness check, which is why it sits with {@link checkServer} above
 * the `--force` branch rather than inside it. `--force` exists to register a mesh that is *down*
 * right now; it must not double as permission to ship credentials across an untrusted network,
 * where there is nothing to verify later and no error to come back and fix.
 */
export function checkDialPolicy(server: string, allowUnencryptedOverlay = false): Check<JoinTarget> {
  try {
    // WHEN THE RECORD CAN CARRY TLS INTENT, THIS LINE CHANGES AND THIS COMMENT GOES.
    // `tlsRequired` is a property of the connection this registration will produce, and no field
    // records it yet; it arrives with the work that teaches the broker to serve TLS. Passing a
    // hardcoded `false` is honest rather than lazy: today no dial can require TLS.
    //
    // What that means CONCRETELY: public addresses, ordinary private ranges and hostnames are
    // refused outright. An overlay literal is refused TOO unless the operator passed the explicit
    // opt-in, because a printed warning is not a fence — stderr is not read by scripts, and the
    // warning was never persisted, so nothing repeated it at the dials that followed. With the
    // opt-in it is permitted and returns a residual, which the caller both prints AND records as
    // consent. When the TLS field exists this passes the record's real intent and the opt-in goes.
    return good(classifyJoinTarget(server, { tlsRequired: false, allowUnencryptedOverlay }));
  } catch (e) {
    return bad(`✗ ${(e as Error).message}`);
  }
}

/** Where this mesh's local trust + personas live. An explicit path must be an existing directory
 *  (the record's whole job is to point at `.cotal/auth` and `.cotal/agents` under it). With no
 *  flag, the nearest genuine project up-tree — and `findCotalRoot` returns its STARTING directory
 *  when it finds none, so the inferred case must prove the `.cotal` is really there. */
export function checkRoot(flag: string | undefined, cwd: string): Check<string> {
  if (flag) {
    const dir = resolve(flag);
    return isDir(dir)
      ? good(dir)
      : bad(`✗ --root ${dir} is not a directory - it must be the folder holding this mesh's .cotal/auth and .cotal/agents`);
  }
  const root = findCotalRoot(cwd);
  if (!isDir(join(root, ".cotal")) || resolve(root, ".cotal") === resolve(homeCotalDir()))
    return bad("✗ --root <dir> is required outside a mesh project - it is the folder whose .cotal/auth holds this mesh's credentials and whose .cotal/agents holds its personas");
  return good(root);
}

/** The recorded auth mode: what the operator said, or what `--root` proves. A root holding this
 *  space's account record means auth; anything else is an open broker. */
export function checkMode(space: string, root: string, accounts: string[], flag: string | undefined): Check<MeshEntry["mode"]> {
  if (flag !== undefined && flag !== "auth" && flag !== "open" && flag !== "user")
    return bad(`✗ --mode must be auth or open (got "${flag}")`);
  // A user-auth mesh is registered by the login/exchange trust it was configured with — an issuer,
  // an audience and an IdP URL pinned at `cotal up --user-auth`, not derivable from a broker URL.
  // Guessing them would be inventing trust.
  if (flag === "user")
    return bad(`✗ --mode user cannot be registered by hand - a user-auth space carries pinned IdP trust (issuer, audience, login URL) that only \`cotal up --user-auth\` establishes, in the root where its broker runs`);
  const mode = flag ?? (accounts.includes(space) ? "auth" : "open");
  if (mode === "auth" && !accounts.includes(space))
    return bad(`✗ --mode auth needs "${space}"'s trust material under ${authDir(root)}${accounts.length ? ` (it holds "${accounts.join('", "')}")` : " (it holds none)"} - copy the mesh's account + creds there, point --root at where they already are, or register it --mode open`);
  return good(mode);
}

/** For an AUTH registration the root must yield trust that actually COMPOSES. An account record on
 *  disk only proves the space was known here: `loadSpaceAuth` still returns undefined when the
 *  broker record or the signing material is missing, and recording that as `auth` produces a record
 *  whose probe ran credlessly and whose every later use fails at resolution. */
export function checkTrust(mode: MeshEntry["mode"], root: string, space: string): Check<SpaceAuth | undefined> {
  if (mode !== "auth") return good(undefined);
  const auth = loadSpaceAuth(authDir(root), space);
  return auth
    ? good(auth)
    : bad(`✗ "${space}" has an account record under ${authDir(root)} but its trust does not compose (the broker record or signing material is missing) - copy the mesh's full .cotal/auth from where it runs, or register it --mode open`);
}

/** Budget for the credless mode probe. Generous on purpose: a slow answer must not be read as "the
 *  broker is open" (it is only ever read as `ok` vs a reason), and this runs once, at registration,
 *  where a second of patience is cheaper than a wrong record. */
const MODE_PROBE_TIMEOUT_MS = 5_000;

/** What the broker ENFORCES, asked with no credential at all.
 *
 *  A NATS broker with no auth configured accepts a CONNECT that carries credentials and ignores
 *  them — so "my creds were accepted" says nothing about enforcement, and recording `auth` off that
 *  promises JWT/ACL protection that is not there. An auth broker refuses a bare connect; an open
 *  one lets us straight in. */
export async function probeEnforcement(server: string): Promise<"auth" | "open" | "unreachable"> {
  const bare = await probeConnect(server, { timeoutMs: MODE_PROBE_TIMEOUT_MS });
  if (bare.ok) return "open";
  return bare.reason === "auth-required" ? "auth" : "unreachable";
}

/** The claimed mode must match what the broker actually enforces, in both directions. */
export function checkEnforcement(mode: MeshEntry["mode"], enforces: "auth" | "open" | "unreachable", server: string, space: string, root: string): Check<void> {
  if (mode === "auth" && enforces === "open")
    return bad(`✗ the broker at ${server} accepts unauthenticated connections, so it cannot be registered as an auth mesh - it enforces no credentials; register it \`--mode open\`, or point --server at the authenticated broker for "${space}"`);
  if (mode === "open" && enforces === "auth")
    return bad(`✗ the broker at ${server} requires auth, so it cannot be registered as an open mesh - copy that mesh's account + creds under ${authDir(root)} and re-run with --mode auth`);
  return good(undefined);
}

/** The target this registration would resolve to. `flag-server` is the source that can never
 *  classify as a prune — nothing is recorded yet, so no entry may be blamed for a failure. */
export function candidateTarget(space: string, server: string, root: string, mode: MeshEntry["mode"], auth: SpaceAuth | undefined): MeshTarget {
  return {
    root,
    server,
    space,
    mode,
    // A probe target for a registration that has not happened yet, so there is no recorded
    // transport to honour and this stays non-strict. That reason stands on its own and is the
    // whole justification.
    //
    // WHAT USED TO BE WRITTEN HERE WAS FALSE, and it is worth saying so rather than quietly
    // deleting it. This comment claimed the scheme could not enforce because "`MeshEntry` cannot
    // persist the intent" — a constraint removed three commits earlier by adding
    // `MeshEntry.tlsRequired`. A dead premise was holding a live decision in place, and it is
    // exactly why that field had no writers.
    //
    // The open question is now genuinely open: `tls://` is COSMETIC at the client (nats.js connects
    // plaintext to `tls://host` with empty options; only the explicit `tls` option refuses), so an
    // operator who types `tls://` today gets a record that resolves to a plaintext-tolerant client.
    // Deriving `tlsRequired` from the scheme would make that typed intent real.
    //
    // It is deliberately NOT done in this change, for a reason that is true: it converts `meshes
    // add tls://…` against a plaintext broker from a successful registration into a refusal. That
    // is a behaviour change to this command's accept/refuse contract, it belongs with the dial-policy
    // work being done in this file by another lane, and it is not one of the downgrades this branch
    // exists to close. Tracked, owned, and not smuggled in beside them.
    tlsRequired: false,
    ...(auth ? { auth } : {}),
    personaRoot: personaDir(root),
    source: "flag-server",
  };
}

/** The registration-time wording for a failed probe. Deliberately NOT the shared preflight copy:
 *  that speaks to a mesh already in the registry ("stale entry", "re-run `cotal up`"), and here
 *  nothing is recorded yet — the operator is being told what to fix in the command they just ran. */
export function verifyFailureMessage(kind: PreflightFailure, space: string, server: string, root: string): string {
  switch (kind) {
    case "unreachable":
      return `✗ no broker answered at ${server} - check the address and that the mesh is up on that machine`;
    case "creds-rejected":
    case "registry-creds-rejected":
      return `✗ the broker at ${server} rejected the credentials for "${space}" under ${authDir(root)} - re-mint them where the mesh runs, or check that --server points at that mesh`;
    case "open-wants-auth":
    case "registry-open-now-auth":
      return `✗ the broker at ${server} requires auth, but nothing under ${authDir(root)} covers "${space}" - copy the mesh's account + creds there and re-run with --mode auth`;
    case "stale-auth":
      return `✗ the credentials for "${space}" under ${authDir(root)} have EXPIRED - re-mint them where the mesh runs (the broker itself is up)`;
    case "tls-trust":
      return `✗ the broker at ${server} requires TLS but this client could not complete the handshake (untrusted or missing CA?) - set \`NODE_EXTRA_CA_CERTS\` to the issuing CA for a private CA, then re-run`;
  }
}

/** Probe the candidate for real (liveness + credentials), after {@link checkEnforcement} has
 *  settled what the broker is. */
export async function verifyTarget(target: MeshTarget): Promise<Check<void>> {
  const r = await preflightTarget(target);
  return r.ok ? good(undefined) : bad(verifyFailureMessage(r.kind, target.space, target.server, target.root));
}

/** Write the record. Returns whether it became the default — same policy as `cotal up`: adopt only
 *  when there is no usable one, and never silently redirect a default that still resolves. */
export function writeRecord(entry: MeshEntry): { adoptedCurrent: boolean; keptCurrent?: string } {
  const cur = getCurrent();
  const usableCurrent = cur && findMesh(cur) ? cur : undefined; // compute before recording
  recordMesh(entry);
  if (!usableCurrent) {
    setCurrent(entry.space);
    return { adoptedCurrent: true };
  }
  return { adoptedCurrent: false, ...(usableCurrent !== entry.space ? { keptCurrent: usableCurrent } : {}) };
}

/**
 * The spaces this root holds account records for — the candidates a guided registration offers,
 * and the evidence the mode is inferred from.
 *
 * An enumeration failure is REPORTED, never flattened to "none". `listSpaceAccounts` throws when
 * the auth dir cannot be read (EACCES, a corrupt record), and treating that as an empty inventory
 * would infer `open` for a root whose trust merely could not be read — recording a credless connect
 * against a mesh whose credentials are sitting right there, unreadable. The pre-refactor call let
 * that throw reach the operator; so does this.
 */
export function spacesAtRoot(root: string): Check<string[]> {
  try {
    return good(listSpaceAccounts(authDir(root)));
  } catch (e) {
    return bad(`✗ ${authDir(root)} cannot be read (${(e as Error).message}) - repair or remove the unreadable account record before registering against this folder`);
  }
}
