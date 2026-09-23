import { assertUserAuthInfo, findMesh, recordMesh, type MeshEntry, type UserAuthInfo } from "./mesh-registry.js";
import { isLoopbackHost } from "./join-target.js";

/** A rule's verdict: the value it produced, or the operator-facing sentence explaining the refusal. */
export type Check<T> = { ok: true; value: T } | { ok: false; message: string };
const bad = (message: string): Check<never> => ({ ok: false, message });
const good = <T>(value: T): Check<T> => ({ ok: true, value });

export interface UserBundle {
  space: string;
  server: string;
  tlsRequired: boolean;
  userAuth: UserAuthInfo;
  /** Closed registration policy. No other key or value is accepted. */
  policy?: { events: "required" };
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
  let policy: UserBundle["policy"];
  if ((doc as { policy?: unknown }).policy !== undefined) {
    const value = (doc as { policy?: unknown }).policy;
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return bad("✗ the user-auth bundle policy must be an object with exactly policy.events = \"required\"");
    const fields = Object.keys(value as Record<string, unknown>);
    const extra = fields.find((key) => key !== "events");
    if (extra) return bad(`✗ the user-auth bundle policy has unsupported field \"policy.${extra}\"`);
    if ((value as { events?: unknown }).events !== "required")
      return bad('✗ the user-auth bundle policy.events must be exactly "required"');
    policy = { events: "required" };
  }
  let userAuth: UserAuthInfo;
  try {
    userAuth = assertUserAuthInfo(doc.userAuth);
  } catch (e) {
    return bad(`✗ user-auth bundle: ${(e as Error).message}`);
  }
  if (!userAuth.endpoints?.url)
    return bad("✗ the user-auth bundle pins no exchange endpoint (userAuth.endpoints.url) - for a remote registration that URL is trust, and it must come from the export, never be guessed");
  if (userAuth.endpoints.agentProvisioningUrl !== undefined) {
    // The provisioning endpoint receives the login bearer, so it rides the same pinned-fetch
    // scheme rule as every other trust URL in this bundle: https, or a loopback http LITERAL.
    let pu: URL;
    try {
      pu = new URL(userAuth.endpoints.agentProvisioningUrl);
    } catch {
      return bad("✗ the user-auth bundle's agent-provisioning endpoint (userAuth.endpoints.agentProvisioningUrl) is not a URL");
    }
    const refusal = assertPinnedFetchUrl(pu, "the bundle's agent-provisioning endpoint (userAuth.endpoints.agentProvisioningUrl)");
    if (refusal) return bad(refusal);
  }
  if (typeof doc.sentinelCreds !== "string" || !doc.sentinelCreds)
    return bad("✗ the user-auth bundle carries no sentinelCreds - the sentinel identity is part of the export");
  return good({ space: doc.space, server: doc.server, tlsRequired: doc.tlsRequired, userAuth, ...(policy ? { policy } : {}), sentinelCreds: doc.sentinelCreds });
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
export async function pinnedFetch(target: string, what: string): Promise<Response> {
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


/** How long a trusted policy refresh stays warm. Pinned to the catalog freshness window by the
 *  user-bundle smoke, so the two cannot drift. */
export const POLICY_FRESH_MS = 5_000;

function sameRegistrationTrust(entry: MeshEntry, bundle: UserBundle): boolean {
  const ua = entry.userAuth;
  return entry.mode === "user" && ua !== undefined &&
    entry.space === bundle.space && entry.server === bundle.server && (entry.tlsRequired === true) === bundle.tlsRequired &&
    ua.idp.url === bundle.userAuth.idp.url && ua.idp.issuer === bundle.userAuth.idp.issuer &&
    ua.idp.audience === bundle.userAuth.idp.audience && ua.endpoints?.url === bundle.userAuth.endpoints?.url;
}

/**
 * The registration policy in force for a launch, a join, or a manager start on `target`.
 *
 * A manual user-auth registration made before policies existed learns its policy from its own
 * pinned exchange: the same discovery document `meshes add --from` adopts, fetched with the same
 * pinned rules, accepted only when every trust pin matches the recorded entry, and only `policy`
 * is written. This runs where the policy is CONSUMED, after the command's own local refusals,
 * never as a preparation step every command pays: a read-only `status` or `meshes` must not fail
 * on an exchange that is down, and `supervise` must name a `--server` mismatch or a missing login
 * before it dials anything. A refresh that fails once the warm window has expired refuses the
 * operation, because the entry cannot say whether the space requires events.
 */
export async function refreshRegistrationPolicy(target: { space: string; policy?: MeshEntry["policy"] }): Promise<MeshEntry["policy"]> {
  const entry = findMesh(target.space);
  if (!entry || entry.origin !== "manual" || entry.mode !== "user") return target.policy;
  if (entry.policy || !entry.userAuth?.endpoints?.url) return entry.policy ?? target.policy;
  const checkedAt = entry.policyCheckedAt ? Date.parse(entry.policyCheckedAt) : Number.NaN;
  if (Number.isFinite(checkedAt) && Date.now() - checkedAt < POLICY_FRESH_MS) return target.policy;
  let base: URL;
  try {
    base = new URL(entry.userAuth.endpoints.url);
  } catch {
    throw new Error(`manual registration for "${entry.space}" has an invalid pinned exchange URL`);
  }
  base.pathname = `${base.pathname.replace(/\/$/, "")}/.well-known/cotal-mesh`;
  base.search = "";
  base.hash = "";
  let response: Response;
  try {
    response = await pinnedFetch(base.toString(), `manual registration "${entry.space}" policy refresh at ${entry.userAuth.endpoints.url}`);
  } catch (error) {
    throw new Error((error as Error).message.replace(/^✗ /, ""));
  }
  if (!response.ok)
    throw new Error(`manual registration "${entry.space}" policy refresh at ${entry.userAuth.endpoints.url} answered HTTP ${response.status}`);
  const checked = checkUserBundle(await response.text());
  if (!checked.ok) throw new Error(`manual registration "${entry.space}" policy refresh: ${checked.message.replace(/^✗ /, "")}`);
  if (!sameRegistrationTrust(entry, checked.value))
    throw new Error(`manual registration "${entry.space}" policy refresh returned different space, broker, transport, or user-auth trust pins`);
  recordMesh({ ...entry, ...(checked.value.policy ? { policy: checked.value.policy } : {}), policyCheckedAt: new Date().toISOString() });
  return checked.value.policy;
}
