import { resolve } from "node:path";
import { credsClaims, dlvStream, dmStream, principalKey, resolveAuthProvider, spacePrefix, type FlagSpec, type FlagValues, type ParsedArgs, type UserAuthStatus } from "@cotal-ai/core";
import { brokerAddressForDisplay, recordOperationSpace, CLI_USER_ACTOR, CommandFailure, findMesh, isMeshRegistryError, jsonFlag, plainFlag, presentationOf, readCredsFile, resolveMeshTarget, serverFlag, spaceFlag, spaceInCreds, userAuthStateDir, workspaceSecretStore, writeResult, type Cell, type OutputWarning, type Presentation, type Report, type Section } from "@cotal-ai/workspace";
import { registryFailure } from "../lib/registry-errors.js";

const credsFlag = { name: "creds", type: "string", value: "<file>", description: "report what this credential file may do, from its own claims; no broker is contacted" } as const satisfies FlagSpec;

export const whoamiFlags = [spaceFlag, serverFlag, credsFlag, jsonFlag, plainFlag] as const satisfies readonly FlagSpec[];

/** Every channel, or every capability: what an identity holds when nothing narrows it. */
type Grant = readonly string[] | "all";

/** What `cotal whoami` reports for the selected space: the identity this CLI acts under and what it
 *  may read, post and do. `null` is a grant this machine cannot read; the warnings say why. */
export interface WhoamiResult {
  readonly kind: "identity";
  readonly space: string;
  readonly server: string;
  /** `null` when no registration here names the server, so its auth mode is not known. */
  readonly mode: "open" | "auth" | "user" | null;
  readonly identity: {
    /** `open`: the broker authenticates nothing. `space-signer`: this machine holds the space's
     *  signing key and each command mints its own short-lived credential. `no-credential`: it holds
     *  none. `user`: the signed-in user's `cli` actor. `unknown`: a `--server` no registration here
     *  names, with no trust for it in this folder; whoami does not contact the broker. */
    readonly kind: "open" | "space-signer" | "no-credential" | "user" | "unknown";
    readonly principal: string | null;
    readonly owner: string | null;
    readonly actor: string | null;
    readonly subject: string | null;
    readonly loginExpiresAt: string | null;
    /** A signed-in user's ledger row: `granted`, `not-granted`, or `not-local` when the ledger is
     *  not on this machine. `null` for every other kind of identity, and before sign-in. */
    readonly grant: "granted" | "not-granted" | "not-local" | null;
  };
  readonly read: Grant | null;
  readonly post: Grant | null;
  readonly dms: boolean | null;
  readonly capabilities: Grant | null;
}

/** What `cotal whoami --creds <file>` reports: what a credential file's own claims permit, in the
 *  one space they name. The claims are decoded, not verified, and no broker is contacted; the broker
 *  enforces them. */
export interface WhoamiCredentialResult {
  readonly kind: "credential";
  readonly file: string;
  /** `null` when its permissions name no single space, so read, post and DMs are `null` too. */
  readonly space: string | null;
  /** The profile it was minted with: the user JWT's `name` claim. */
  readonly profile: string | null;
  readonly principal: string | null;
  /** The agent lifecycle its delivery and history grants are keyed to; `null` for a credential
   *  that holds none, such as the observer and admin profiles. */
  readonly lifecycleUid: string | null;
  readonly issuedAt: string | null;
  /** `null` when it carries no expiry. */
  readonly expiresAt: string | null;
  readonly expired: boolean;
  readonly read: Grant | null;
  readonly post: Grant | null;
  /** Direct-message history: every DM in the space, only its own, or none. */
  readonly dms: "all" | "own" | "none" | null;
}

/** `cotal whoami`: what this CLI's one-shot identity holds in the selected space. It reads the
 *  registry, the login cache and, where it is on this machine, the grant ledger; it connects to
 *  nothing, since a one-shot process has no session to report. With `--creds`, it reports what that
 *  credential file permits instead (see {@link WhoamiCredentialResult}). */
export async function whoami(args: ParsedArgs): Promise<void> {
  const v = args.values as FlagValues<typeof whoamiFlags>;
  const presentation = presentationOf(v);
  if (v.creds !== undefined) {
    if (v.space !== undefined || v.server !== undefined)
      throw new CommandFailure("refused", "USAGE_INVALID", "--creds reports what the credential file permits in the space it names, and contacts no broker, so it takes no --space or --server", { remedy: "run `cotal whoami --creds <file>` on its own" });
    return whoamiCredential(v.creds, presentation);
  }
  let t: ReturnType<typeof resolveMeshTarget>;
  try { t = resolveMeshTarget(process.cwd(), { server: v.server, space: v.space }); }
  catch (error) {
    if (isMeshRegistryError(error)) throw registryFailure(error);
    throw error;
  }
  // A folder whose records name no space was given the held default only to report on it, so the
  // target names the folder and the space it assumed.
  const assumed = t.namesNoSpace === true;
  const target = assumed ? { root: t.root, assumed: t.space } : { space: t.space };
  recordOperationSpace(t.space);
  const warnings: OutputWarning[] = [];
  const server = brokerAddressForDisplay(t.server);
  if (server === undefined) throw new CommandFailure("refused", v.server === undefined ? "SCHEMA_INVALID" : "USAGE_INVALID", "the server address cannot be parsed safely; the raw value was not printed", { target });
  const base = { kind: "identity" as const, space: t.space, server, mode: t.mode };
  const none = { principal: null, owner: null, actor: null, subject: null, loginExpiresAt: null, grant: null };
  let result: WhoamiResult;
  // A `--server` this space is not registered at says nothing about the broker there, and whoami does
  // not contact it. The folder's trust for the space does not reach an address nothing records.
  const registered = v.server === undefined ? undefined : findMesh(t.space);
  if (v.server !== undefined && registered?.server !== t.server) {
    const message = t.mode === "open" && !t.auth
      ? `${server} is not registered here and this folder holds no trust for it; whoami does not contact the broker, so whether it authenticates, and what this identity may do there, is unknown`
      : `${server} is not where ${t.space} is registered here; whoami does not contact the broker, so whether it serves ${t.space}, and what this identity may do there, is unknown`;
    warnings.push({ code: "BROKER_NOT_PROBED", target: { ...target, server }, message });
    result = { ...base, mode: null, identity: { kind: "unknown", ...none }, read: null, post: null, dms: null, capabilities: null };
  } else if (t.mode === "open") {
    result = { ...base, identity: { kind: "open", ...none }, read: "all", post: "all", dms: true, capabilities: "all" };
  } else if (t.mode === "auth") {
    result = t.auth
      ? { ...base, identity: { kind: "space-signer", ...none }, read: "all", post: "all", dms: true, capabilities: "all" }
      : { ...base, identity: { kind: "no-credential", ...none }, read: [], post: [], dms: false, capabilities: [] };
  } else {
    let st: UserAuthStatus;
    try {
      st = await resolveAuthProvider().userStatus({ store: workspaceSecretStore(t.root), dir: userAuthStateDir(t.root, t.space), space: t.space, actor: CLI_USER_ACTOR });
    } catch (e) {
      throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `the login for ${t.space} could not be read: ${(e as Error).message}`, { target });
    }
    const signedIn = st.login !== undefined;
    const owner = signedIn ? st.owner ?? null : null;
    const grant = !signedIn ? null : st.grant === "not-granted" ? "not-granted" : st.grant ? "granted" : "not-local";
    const identity = {
      kind: "user" as const,
      principal: owner === null ? null : `${owner}.${CLI_USER_ACTOR}`,
      owner,
      actor: signedIn ? CLI_USER_ACTOR : null,
      subject: st.login?.sub ?? null,
      loginExpiresAt: st.login ? new Date(st.login.expiresAt * 1000).toISOString() : null,
      grant,
    } as const;
    if (grant === null || grant === "not-granted") result = { ...base, identity, read: [], post: [], dms: false, capabilities: [] };
    else if (st.grant && st.grant !== "not-granted") result = { ...base, identity, read: [...st.grant.allowSubscribe], post: [...st.grant.allowPublish], dms: false, capabilities: [...st.grant.scope] };
    else {
      // The ledger runs where the space was provisioned. From any other machine the grant is the
      // auth service's to apply, and nothing here can read it.
      warnings.push({ code: "GRANT_NOT_LOCAL", target, message: `the grant ledger for ${t.space} is not on this machine, so what this identity may read, post and do is unknown here` });
      result = { ...base, identity, read: null, post: null, dms: false, capabilities: null };
    }
  }
  writeResult(
    presentation,
    {
      command: "whoami",
      target,
      result,
      completeness: warnings.length ? "partial" : "complete",
      warnings,
      ...(warnings.length ? { partial: result.identity.kind === "unknown"
        ? { message: "whoami could not tell what this identity may do at that address; the warning names why", remedy: registered ? `run \`cotal whoami --space ${t.space}\` without --server to read it at the address it is registered at` : "add the space with `cotal space add <name> --server <url> --root <dir>`, which checks the broker, then run `cotal whoami --space <name>`" }
        : { message: "whoami could not read this identity's grant; the warning names why", remedy: "run `cotal whoami` on the machine that hosts the space's auth service" } } : {}),
    },
    (r) => whoamiView(r, assumed),
  );
}

/** The channels a credential's allowed subjects reach on the space's chat plane: `all` for the whole
 *  plane, else the channel of each `chat.<owner>.<actor>.<channel>` row. */
function chatChannels(rows: readonly string[], space: string): Grant {
  const chat = `${spacePrefix(space)}.chat.`;
  const channels: string[] = [];
  for (const row of rows) {
    if (!row.startsWith(chat)) continue;
    const parts = row.slice(chat.length).split(".");
    const channel = parts.slice(2).join(".");
    if (parts.slice(0, 2).includes(">") || channel === ">") return "all";
    if (channel) channels.push(channel);
  }
  return [...new Set(channels)];
}

/** {@link WhoamiCredentialResult} for one credential file, read as every `--creds` file is read. */
function whoamiCredential(path: string, presentation: Presentation): void {
  const file = resolve(path);
  const creds = readCredsFile(file);
  const claims = credsClaims(creds);
  const nats = (claims.nats ?? {}) as NonNullable<typeof claims.nats> & { tags?: unknown };
  const tags = Array.isArray(nats.tags) ? nats.tags.filter((tag): tag is string => typeof tag === "string") : [];
  const tag = (name: string) => tags.find((t) => t.startsWith(`${name}:`))?.slice(name.length + 1);
  const owner = tag("owner"), actor = tag("actor");
  const pub = nats.pub?.allow ?? [], sub = nats.sub?.allow ?? [];
  const space = spaceInCreds(creds) ?? null;
  let lifecycleUid: string | null = null;
  if (space !== null && owner !== undefined && actor !== undefined) {
    let name: string | undefined;
    try { name = principalKey(owner, actor).name; } catch { name = undefined; }
    const prefix = `$JS.API.CONSUMER.MSG.NEXT.${dlvStream(space)}.dlv_${name}-`;
    const uid = name === undefined ? undefined : pub.find((row) => row.startsWith(prefix))?.slice(prefix.length);
    lifecycleUid = uid !== undefined && /^[a-z0-9]+$/.test(uid) ? uid : null;
  }
  const dm = space === null ? "" : dmStream(space);
  const dms = space === null ? null
    : pub.some((row) => row === `$JS.API.CONSUMER.CREATE.${dm}` || row === `$JS.API.CONSUMER.CREATE.${dm}.>`) ? "all"
    : pub.some((row) => row.startsWith(`$JS.API.CONSUMER.MSG.NEXT.${dm}.dm_`)) ? "own"
    : "none";
  const iso = (seconds: unknown) => typeof seconds === "number" && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
  const result: WhoamiCredentialResult = {
    kind: "credential",
    file,
    space,
    profile: typeof claims.name === "string" ? claims.name : null,
    principal: tag("principal") ?? null,
    lifecycleUid,
    issuedAt: iso(claims.iat),
    expiresAt: iso(claims.exp),
    expired: typeof claims.exp === "number" && claims.exp * 1000 <= Date.now(),
    read: space === null ? null : chatChannels(sub, space),
    post: space === null ? null : chatChannels(pub, space),
    dms,
  };
  if (space !== null) recordOperationSpace(space);
  const warnings: OutputWarning[] = space === null
    ? [{ code: "CREDENTIAL_SPACE_UNKNOWN", target: { path: file }, message: `the permissions in ${file} name no single space, so what it may read and post is not known` }]
    : [];
  writeResult(
    presentation,
    {
      command: "whoami",
      target: space === null ? { path: file } : { space, path: file },
      result,
      completeness: warnings.length ? "partial" : "complete",
      warnings,
      ...(warnings.length ? { partial: { message: "whoami could not tell what this credential may read and post; the warning names why", remedy: "pass the credential file as it was issued; `cotal auth mint <label> --out <file>` writes a new one" } } : {}),
    },
    credentialView,
  );
}

const DMS_TEXT: Record<NonNullable<WhoamiCredentialResult["dms"]>, string> = { all: "yes, every DM in the space", own: "its own", none: "no" };

function credentialView(r: WhoamiCredentialResult): Report {
  const unknown: Cell = { text: "unknown", tone: "waiting" };
  const rows: (readonly [string, Cell])[] = [
    ["file", r.file],
    ["space", r.space === null ? unknown : { text: r.space, tone: "selected" }],
    ["profile", r.profile ?? unknown],
    ["principal", r.principal ?? unknown],
    ["lifecycle", r.lifecycleUid ?? { text: "none: no agent lifecycle", tone: "hint" }],
    ["issued", r.issuedAt ?? unknown],
    ["expires", r.expiresAt === null ? "never: it has no expiry" : r.expired ? { text: `${r.expiresAt} (expired)`, tone: "waiting" } : r.expiresAt],
    ["read", grantText(r.read, "no channels")],
    ["post", grantText(r.post, "no channels")],
    ["dm history", r.dms === null ? unknown : DMS_TEXT[r.dms]],
  ];
  const hint: Cell = { text: "Read from the file's own claims: its signature is not checked and no broker is contacted. The broker enforces these permissions.", tone: "hint" };
  return { sections: [{ title: "Credential", blocks: [{ kind: "fields", rows }, { kind: "lines", lines: [hint] }] }] };
}

const grantText = (g: Grant | null, empty: string): Cell =>
  g === null ? { text: "unknown", tone: "waiting" } : g === "all" ? "all" : g.length ? g.map((x) => (x === ">" ? "all" : x)).join(", ") : { text: empty, tone: "hint" };

const KIND_TEXT: Record<WhoamiResult["identity"]["kind"], string> = {
  open: "none: the broker authenticates nothing",
  "space-signer": "this machine's space signer; each command mints its own short-lived credential",
  "no-credential": "none: this machine holds no signer for the space",
  user: "cached user login",
  unknown: "unknown: this address is not registered here, and whoami does not contact the broker",
};

function whoamiView(r: WhoamiResult, assumed: boolean): Report {
  const id = r.identity;
  const rows: (readonly [string, Cell])[] = [
    ["space", { text: r.space, tone: "selected" }],
    ["server", r.server],
    ["identity", id.kind === "user" && !id.subject ? "not signed in" : KIND_TEXT[id.kind]],
  ];
  if (id.kind === "user") {
    rows.push(["principal", id.principal ?? { text: id.subject ? "not known on this machine" : "not signed in", tone: "waiting" }]);
    if (id.subject) rows.push(["login", `${id.subject}, cached expiry ${id.loginExpiresAt}`]);
  }
  rows.push(["read", grantText(r.read, "no channels")], ["post", grantText(r.post, "no channels")], ["dm history", r.dms === null ? { text: "unknown", tone: "waiting" } : r.dms ? "yes" : "no"], ["capabilities", grantText(r.capabilities, "none")]);
  const hints: Cell[] = [];
  if (id.kind === "user" && !id.subject) hints.push({ text: "sign in with `cotal login`", tone: "hint" });
  else if (id.grant === "not-granted") hints.push({ text: "the space's operator grants this identity with `cotal actor grant cli`", tone: "hint" });
  if (id.kind === "no-credential") hints.push({ text: "commands against this space need `--creds <file>`", tone: "hint" });
  const identity: Section = { title: "Identity and access", blocks: [{ kind: "fields", rows }, ...(hints.length ? [{ kind: "lines" as const, lines: hints }] : [])] };
  // The heading names the space the folder was given; the line under it says it was only assumed.
  if (!assumed) return { sections: [identity] };
  return { space: r.space, sections: [{ blocks: [{ kind: "lines", lines: [{ text: `this folder names no space; the held default ${r.space} was assumed`, tone: "hint" }] }] }, identity] };
}
