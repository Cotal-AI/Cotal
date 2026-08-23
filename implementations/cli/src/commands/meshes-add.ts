import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { mkSecretDir, probeConnect, writeSecretFileAtomic, type SpaceAuth } from "@cotal-ai/core";
import { classifyJoinTarget, isLoopbackHost, type DialPolicy, type JoinTarget } from "../lib/join-target.js";
import {
  authDir,
  findCotalRoot,
  findMesh,
  getCurrent,
  homeCotalDir,
  listSpaceAccounts,
  loadSpaceAuth,
  assertUserAuthInfo,
  personaDir,
  preflightTarget,
  recordMesh,
  setCurrent,
  userAuthStateDir,
  type MeshEntry,
  type MeshTarget,
  type PreflightFailure,
  type UserAuthInfo,
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

/** The cost of the copy every "copy the mesh's auth here" recovery asks the operator to make.
 *
 *  It is one shared constant because there are five such instructions and the review found four of
 *  them saying only "credentials". A directory that composes for an auth mesh carries the account
 *  SIGNING SEED, so the machine holding it can mint any identity in the space: the honest word is
 *  authority, not credentials, and the operator hears it at the moment they are told to copy
 *  rather than only in a guide they may never open. */
const CA_COST =
  "\n  Note: that directory carries the space's account signing seed, so any machine holding it can mint" +
  "\n  any identity in the space until the signing key is rotated and every credential re-minted. Copy it" +
  "\n  only to machines you would trust with the whole mesh.";
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
  // A path is refused on nats:// and tls:// because the NATS wire protocol has no notion of one,
  // but on ws:// and wss:// it addresses the websocket route (`wss://host/mesh-ws` behind a
  // reverse proxy) — the same contract classifyJoinTarget and the dial already honour.
  if (u.pathname && u.pathname !== "/" && u.protocol !== "ws:" && u.protocol !== "wss:")
    return bad("✗ --server must be a bare broker URL - drop its path");
  if (!u.hostname) return bad("✗ --server names no host - a broker URL needs one (e.g. nats://127.0.0.1:4222)");
  return good(raw);
}

/**
 * May this machine send its credentials to that address?
 *
 * Registering a mesh is how a machine joins a broker it does not run, and every later command then
 * dials that address with an agent credential in the CONNECT line. NATS sends the initial INFO in
 * plaintext and unauthenticated, so an on-path attacker forges one that does not set
 * `tls_required` and reads the credential; the client side is the only fence. The address class
 * and the RECORDED TLS INTENT together are the gate: see {@link classifyJoinTarget} for the
 * ranges, why hostnames need required TLS, and why RFC1918 is refused in both modes.
 *
 * `policy.tlsRequired` is the strictness this registration will record — sourced from `--tls` or
 * a `tls://` scheme ({@link tlsIntent}) — and it is what the dial will ENFORCE, because the
 * candidate target and the written record carry the same value and preflight requires the
 * handshake off it.
 *
 * This is a SAFETY rule, not a liveness check, which is why it sits with {@link checkServer} above
 * the `--force` branch rather than inside it. `--force` exists to register a mesh that is *down*
 * right now; it must not double as permission to ship credentials across an untrusted network,
 * where there is nothing to verify later and no error to come back and fix.
 */
export function checkDialPolicy(server: string, policy: DialPolicy): Check<JoinTarget> {
  try {
    return good(classifyJoinTarget(server, policy));
  } catch (e) {
    return bad(`✗ ${(e as Error).message}`);
  }
}

/** The TLS intent this registration records, from its two sources: the explicit `--tls` flag, or
 *  a `tls://` scheme. The scheme is typed intent — and today nats.js connects PLAINTEXT to
 *  `tls://host` with empty options, so honoring it here is what converts typed-but-unenforced
 *  intent into enforcement: the record carries `tlsRequired: true`, and every dial resolved
 *  through it requires the handshake rather than tolerating plaintext. */
export function tlsIntent(server: string, tlsFlag: boolean): boolean {
  if (tlsFlag) return true;
  try {
    const p = new URL(server).protocol;
    // `wss:` is typed intent the same way `tls:` is - the websocket transport performs the TLS
    // handshake itself, so recording it strict is stating what the dial already enforces.
    return p === "tls:" || p === "wss:";
  } catch {
    return false; // checkServer refuses the malformed URL; this never decides anything for it
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
 *  space's account record means auth; anything else is an open broker. `--mode user` is permitted
 *  IFF the pinned trust was SUPPLIED (`userTrustSupplied`) — the old blanket refusal reasoned
 *  that IdP pins must be established, never guessed, and supplying them (a bundle exported where
 *  the mesh runs, or a confirmed HTTPS discovery document) satisfies exactly that reasoning. */
export function checkMode(space: string, root: string, accounts: string[], flag: string | undefined, userTrustSupplied = false): Check<MeshEntry["mode"]> {
  if (flag !== undefined && flag !== "auth" && flag !== "open" && flag !== "user")
    return bad(`✗ --mode must be auth, open or user (got "${flag}")`);
  if (flag === "user" && !userTrustSupplied)
    return bad(`✗ --mode user needs its pinned trust SUPPLIED, never guessed - a user-auth space carries IdP pins (issuer, audience, login URL) established where the mesh runs. Pass --user-auth-file <bundle.json> exported there, or --from <https://…/.well-known/cotal-mesh> to fetch, review and confirm them`);
  if (flag === "user") return good("user");
  const mode = flag ?? (accounts.includes(space) ? "auth" : "open");
  if (mode === "auth" && !accounts.includes(space))
    return bad(`✗ --mode auth needs "${space}"'s trust material under ${authDir(root)}${accounts.length ? ` (it holds "${accounts.join('", "')}")` : " (it holds none)"} - copy the mesh's account + creds there, point --root at where they already are, or register it --mode open` + CA_COST);
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
    : bad(`✗ "${space}" has an account record under ${authDir(root)} but its trust does not compose (the broker record or signing material is missing) - copy the mesh's full .cotal/auth from where it runs, or register it --mode open` + CA_COST);
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

/** The claimed mode must match what the broker actually enforces, in both directions. The USER
 *  arm reads the refusal as the evidence: a user-mode target has no probe credential by design,
 *  so a credless probe against a user-auth broker reporting auth-required IS the pass — the one
 *  fact a bare connect can prove about a broker whose admission runs through the callout. */
export function checkEnforcement(mode: MeshEntry["mode"], enforces: "auth" | "open" | "unreachable", server: string, space: string, root: string): Check<void> {
  if (mode === "auth" && enforces === "open")
    return bad(`✗ the broker at ${server} accepts unauthenticated connections, so it cannot be registered as an auth mesh - it enforces no credentials; register it \`--mode open\`, or point --server at the authenticated broker for "${space}"`);
  if (mode === "open" && enforces === "auth")
    return bad(`✗ the broker at ${server} requires auth, so it cannot be registered as an open mesh - copy that mesh's account + creds under ${authDir(root)} and re-run with --mode auth` + CA_COST);
  if (mode === "user" && enforces === "open")
    return bad(`✗ the broker at ${server} accepts unauthenticated connections, so it cannot be registered as a user-auth mesh - user auth means the broker REFUSES a bare connect and admits only exchanged bearers; check that the bundle's server points at the user-auth broker for "${space}"`);
  if (mode === "user" && enforces === "unreachable")
    return bad(`✗ no broker answered at ${server} - a user-auth registration is verified by the broker's own auth-required refusal, so it cannot be recorded while the broker is unreachable`);
  return good(undefined);
}

// ---- the user arm: supplied pinned trust ----------------------------------------------------

/** What a remote user-auth registration supplies: the pins nothing on this machine could derive.
 *  Exported where the mesh runs; carried by `--user-auth-file`, or served at the space's
 *  `/.well-known/cotal-mesh` for `--from`. */
export interface UserBundle {
  space: string;
  server: string;
  tlsRequired: boolean;
  userAuth: UserAuthInfo;
  /** The sentinel creds blob. IN THE BUNDLE ONLY — registration lands it in a 0600 file under
   *  the entry's root and records the PATH; the registry document never carries the blob. */
  sentinelCreds: string;
}

/** Validate a user-auth bundle, fail-loud on every missing pin. The `userAuth` arm goes through
 *  {@link assertUserAuthInfo} — the same boundary every provider blob crosses — and additionally
 *  requires the pinned exchange URL: for a remote entry the endpoints are a trust position, not a
 *  convenience, because no local `up` exists to re-derive them. */
export function checkUserBundle(raw: string): Check<UserBundle> {
  let doc: Partial<UserBundle> & { userAuth?: unknown };
  try {
    doc = JSON.parse(raw) as never;
  } catch {
    return bad("✗ the user-auth bundle is not JSON - export it where the mesh runs and pass the file unmodified");
  }
  if (doc === null || typeof doc !== "object") return bad("✗ the user-auth bundle must be a JSON object");
  if (typeof doc.space !== "string" || !doc.space) return bad("✗ the user-auth bundle names no space");
  if (typeof doc.server !== "string" || !doc.server) return bad("✗ the user-auth bundle names no broker server");
  if (typeof doc.tlsRequired !== "boolean") return bad("✗ the user-auth bundle must state tlsRequired explicitly (true or false) - transport strictness is part of what the export pins");
  let userAuth: UserAuthInfo;
  try {
    userAuth = assertUserAuthInfo(doc.userAuth);
  } catch (e) {
    return bad(`✗ user-auth bundle: ${(e as Error).message}`);
  }
  if (!userAuth.endpoints?.url)
    return bad("✗ the user-auth bundle pins no exchange endpoint (userAuth.endpoints.url) - for a remote registration that URL is trust, and it must come from the export, never be guessed");
  if (typeof doc.sentinelCreds !== "string" || !doc.sentinelCreds)
    return bad("✗ the user-auth bundle carries no sentinelCreds - the sentinel identity is part of the export");
  return good({ space: doc.space, server: doc.server, tlsRequired: doc.tlsRequired, userAuth, sentinelCreds: doc.sentinelCreds });
}

/** Budget for the exchange trust probe — same posture as the mode probe above: run once, at
 *  registration, where patience is cheaper than a wrong record. */
const EXCHANGE_PROBE_TIMEOUT_MS = 5_000;

/**
 * Fetch that CANNOT be walked off HTTPS.
 *
 * `fetch` follows redirects by default and will happily follow `https://` → `http://`, so a
 * 302 from anyone on the path turns a pinned, encrypted fetch into a plaintext one — and the
 * document being fetched IS the trust being adopted. `redirect: "manual"` stops the hop here;
 * a redirect is then reported as the refusal it is, rather than silently followed.
 *
 * Loopback `http://` stays usable for tests and for an exchange on this machine (nothing leaves
 * the box), which is also what keeps the suites honest without a TLS fixture. Everything else
 * must be `https:`.
 */
export function assertPinnedFetchUrl(u: URL, what: string): string | undefined {
  if (u.protocol === "https:") return undefined;
  // The loopback exception is decided by PARSING the host as an address, never by how the text
  // begins: `/^127\./` also matched `127.evil.com`, `127.0.0.1.nip.io` and `127.com`, which anyone
  // can register, and it missed real spellings like `0177.0.0.1`. `isLoopbackHost` is the one
  // authority for the question, canonicalization included. A name that does not parse as an IP is
  // a NAME and gets no exception, however it starts — `localhost` included, since a hosts entry or
  // a poisoned lookup can point it anywhere.
  if (u.protocol === "http:" && isLoopbackHost(u.hostname)) return undefined;
  // Name the ACTUAL rule. "must be https://" alone misleads the developer whose local flow used
  // http://localhost: it blames the scheme, when the same scheme on 127.0.0.1 would have passed.
  return (
    `✗ ${what} must be https:// (got ${u.protocol}//) - the pins this registration adopts cannot be fetched over a channel the network can rewrite` +
    (u.protocol === "http:"
      ? `. Plain http is accepted only for a loopback LITERAL (127.0.0.1, ::1), where nothing leaves this machine - "${u.hostname}" is a name, and a hosts entry or a poisoned lookup could point it anywhere, so use the literal`
      : "")
  );
}

/** The pinned-fetch policy's verdict for ONE url, as data — so a suite can assert WHY a fetch was
 *  refused rather than only that something failed. A cert error, a timeout and a refused redirect
 *  are all "it did not work"; only this distinguishes them. Test seam, no production caller. */
export async function pinnedFetchProbe(target: string): Promise<{ refused: boolean; message: string }> {
  try {
    await pinnedFetch(target, "the pinned exchange");
    return { refused: false, message: "" };
  } catch (e) {
    return { refused: true, message: (e as Error).message };
  }
}

/** One hop, no downgrade, no redirect-following. */
async function pinnedFetch(target: string, what: string): Promise<Response> {
  const u = new URL(target);
  const bad = assertPinnedFetchUrl(u, what);
  if (bad) throw new Error(bad);
  const res = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(EXCHANGE_PROBE_TIMEOUT_MS) });
  if (res.status >= 300 && res.status < 400)
    throw new Error(
      `✗ ${what} answered ${res.status} (a redirect to ${JSON.stringify(res.headers.get("location") ?? "")}) - a redirect can move a pinned fetch onto plaintext or onto another host, so it is refused rather than followed; publish the document at the pinned URL itself`,
    );
  return res;
}

/** The issuer a space's exchange answers /health with — the auth daemon's own token issuer, a
 *  stable URN derived from the space (auth's `spaceIssuer`), deliberately NOT the IdP issuer:
 *  the IdP names who vouches for humans, this names the exchange minting for the space. The cli
 *  package carries no runtime dependency on @cotal-ai/auth, so the derivation is restated here
 *  and the user-bundle smoke pins the two against each other across the package boundary. */
export function userExchangeIssuer(space: string): string {
  return `urn:cotal:auth:${space}`;
}

/** The user arm of trust composition: the pinned exchange must ANSWER, and answer as itself.
 *  `/health` must report the pinned issuer (a base that answers with a foreign issuer is a
 *  different authority, however reachable) and `/jwks` must serve a non-empty key set (the
 *  verification material the pins promise). Nothing here trusts the response beyond consistency
 *  with the pins the operator supplied. */
export async function verifyUserExchange(base: string, issuer: string): Promise<Check<void>> {
  const url = (p: string) => new URL(p, base.endsWith("/") ? base : `${base}/`).toString();
  // The exchange base is a PIN. It must be an https URL (or loopback), and neither probe below
  // may be redirected off it — otherwise the "pinned" exchange is whatever a 302 chooses.
  try {
    const badBase = assertPinnedFetchUrl(new URL(base), `the pinned exchange at ${base}`);
    if (badBase) return bad(badBase);
  } catch {
    return bad(`✗ the bundle's pinned exchange endpoint ${JSON.stringify(base)} is not a URL`);
  }
  let health: { ok?: boolean; issuer?: string };
  try {
    const res = await pinnedFetch(url("health"), `the pinned exchange at ${base}`);
    if (!res.ok) return bad(`✗ the pinned exchange at ${base} answered /health with ${res.status} - it is not serving as the bundle promises`);
    health = (await res.json()) as never;
  } catch (e) {
    const m = (e as Error).message;
    if (m.startsWith("✗")) return bad(m);
    return bad(`✗ the pinned exchange at ${base} did not answer /health (${m}) - the bundle's endpoint must be reachable to register against it`);
  }
  if (health.issuer !== issuer)
    return bad(`✗ the exchange at ${base} answers for issuer ${JSON.stringify(health.issuer)} but the bundle pins ${JSON.stringify(issuer)} - a different issuer is a different authority; nothing was registered`);
  try {
    const res = await pinnedFetch(url("jwks"), `the pinned exchange at ${base}`);
    if (!res.ok) return bad(`✗ the pinned exchange at ${base} answered /jwks with ${res.status}`);
    const jwks = (await res.json()) as { keys?: unknown[] };
    if (!Array.isArray(jwks.keys) || jwks.keys.length === 0)
      return bad(`✗ the pinned exchange at ${base} serves an empty /jwks - it holds no verification keys for the trust the bundle pins`);
  } catch (e) {
    const m = (e as Error).message;
    if (m.startsWith("✗")) return bad(m);
    return bad(`✗ the pinned exchange at ${base} did not answer /jwks (${m})`);
  }
  return good(undefined);
}

/** Land the sentinel and write the remote user entry — ONE writer for both front ends, so the
 *  wizard cannot drift from the flag form on what a remote record looks like. The sentinel blob
 *  goes into a 0600 file under the entry's own root (its space-scoped user-auth state dir) and
 *  the record carries the PATH: the registry document is echoed by `cotal meshes` and `status`,
 *  and secret material must never ride a file that gets printed. */
export function persistRemoteUserEntry(
  space: string,
  server: string,
  root: string,
  bundle: UserBundle,
  tlsRequired: boolean,
  overlayConsent: boolean,
): ReturnType<typeof writeRecord> {
  const dir = userAuthStateDir(root, space);
  mkSecretDir(dir);
  const sentinelCredsPath = join(dir, "sentinel.creds");
  writeSecretFileAtomic(sentinelCredsPath, bundle.sentinelCreds);
  return writeRecord({
    space,
    server,
    root,
    mode: "user",
    origin: "manual",
    ...(tlsRequired ? { tlsRequired: true } : {}),
    ...(overlayConsent ? { unencryptedOverlay: true } : {}),
    userAuth: { ...bundle.userAuth, remote: true, sentinelCredsPath },
    ts: new Date().toISOString(),
  });
}

/** The target this registration would resolve to. `flag-server` is the source that can never
 *  classify as a prune — nothing is recorded yet, so no entry may be blamed for a failure. */
export function candidateTarget(space: string, server: string, root: string, mode: MeshEntry["mode"], auth: SpaceAuth | undefined, tlsRequired: boolean): MeshTarget {
  return {
    root,
    server,
    space,
    mode,
    // The SAME source the dial policy read ({@link tlsIntent}) — the decision the old comment here
    // reserved for the dial-policy work, now taken. A candidate that probed non-strict while the
    // record it vouched for said strict would verify a connection the record's own dials refuse;
    // carrying the real intent means `meshes add tls://…` against a plaintext broker is a REFUSAL
    // at registration, not a surprise at the first spawn.
    tlsRequired,
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
      return `✗ the broker at ${server} requires auth, but nothing under ${authDir(root)} covers "${space}" - copy the mesh's account + creds there and re-run with --mode auth` + CA_COST;
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
