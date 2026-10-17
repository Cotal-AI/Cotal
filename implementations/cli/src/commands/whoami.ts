import { resolveAuthProvider, type FlagSpec, type FlagValues, type ParsedArgs, type UserAuthStatus } from "@cotal-ai/core";
import { brokerAddressForDisplay, CLI_USER_ACTOR, CommandFailure, jsonFlag, plainFlag, presentationOf, resolveMeshTarget, serverFlag, spaceFlag, userAuthStateDir, workspaceSecretStore, writeResult, type Cell, type OutputWarning, type Report } from "@cotal-ai/workspace";

export const whoamiFlags = [spaceFlag, serverFlag, jsonFlag, plainFlag] as const satisfies readonly FlagSpec[];

/** Every channel, or every capability: what an identity holds when nothing narrows it. */
type Grant = readonly string[] | "all";

/** What `cotal whoami` reports for the selected space: the identity this CLI acts under and what it
 *  may read, post and do. `null` is a grant this machine cannot read; the warnings say why. */
export interface WhoamiResult {
  readonly kind: "identity";
  readonly space: string;
  readonly server: string;
  readonly mode: "open" | "auth" | "user";
  readonly identity: {
    /** `open`: the broker authenticates nothing. `space-signer`: this machine holds the space's
     *  signing key and each command mints its own short-lived credential. `no-credential`: it holds
     *  none. `user`: the signed-in user's `cli` actor. */
    readonly kind: "open" | "space-signer" | "no-credential" | "user";
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

/** `cotal whoami`: what this CLI's one-shot identity holds in the selected space. It reads the
 *  registry, the login cache and, where it is on this machine, the grant ledger; it connects to
 *  nothing, since a one-shot process has no session to report. */
export async function whoami(args: ParsedArgs): Promise<void> {
  const v = args.values as FlagValues<typeof whoamiFlags>;
  const presentation = presentationOf(v);
  const t = resolveMeshTarget(process.cwd(), { server: v.server, space: v.space });
  const target = { space: t.space };
  const warnings: OutputWarning[] = [];
  const server = brokerAddressForDisplay(t.server);
  if (server === undefined) throw new CommandFailure("refused", v.server === undefined ? "SCHEMA_INVALID" : "USAGE_INVALID", "the server address cannot be parsed safely; the raw value was not printed", { target });
  const base = { kind: "identity" as const, space: t.space, server, mode: t.mode };
  const none = { principal: null, owner: null, actor: null, subject: null, loginExpiresAt: null, grant: null };
  let result: WhoamiResult;
  if (t.mode === "open") {
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
      ...(warnings.length ? { partial: { message: "whoami could not read this identity's grant; the warning names why", remedy: "run `cotal whoami` on the machine that hosts the space's auth service" } } : {}),
    },
    whoamiView,
  );
}

const grantText = (g: Grant | null, empty: string): Cell =>
  g === null ? { text: "unknown", tone: "waiting" } : g === "all" ? "all" : g.length ? g.map((x) => (x === ">" ? "all" : x)).join(", ") : { text: empty, tone: "hint" };

const KIND_TEXT: Record<WhoamiResult["identity"]["kind"], string> = {
  open: "none: the broker authenticates nothing",
  "space-signer": "this machine's space signer; each command mints its own short-lived credential",
  "no-credential": "none: this machine holds no signer for the space",
  user: "cached user login",
};

function whoamiView(r: WhoamiResult): Report {
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
  return { sections: [{ blocks: [{ kind: "fields", rows }, ...(hints.length ? [{ kind: "lines" as const, lines: hints }] : [])] }] };
}
