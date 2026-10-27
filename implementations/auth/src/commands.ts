import { readAuthResponseJson } from "./response-json.js";
import { agentBearerCommand } from "./agent-bearer.js";
import { authCalloutOnlyFlag, authServiceFlags, authSpacesFlag } from "./daemon-flags.js";
import { serviceEndpointHostCall, type ServiceEndpointValues } from "./service-host-client.js";
/**
 * Self-registering `login` / `logout` commands (the delivery-daemon pattern): importing
 * `@cotal-ai/auth` registers them into the core `Registry`, and the `cotal` binary pulls the
 * package in at its composition root. Session state lives under the workspace's `homeCotalDir()`
 * (`~/.cotal`, `COTAL_HOME`-overridable) — per human, per machine, NOT per checkout: you are
 * logged in as YOU across every repo on this box.
 */
import * as prompts from "@clack/prompts";
import { assertDerivedOwnerToken, assertLifecycleToken, assertValidChannel, assertValidOwnerToken, assertValidRole, registry, resolveAuthProvider, resolveSpaceCatalogConsumer, type Command, type FlagSpec, type ParsedArgs, type SecretStore } from "@cotal-ai/core";
import { CommandFailure, STORE_CONTENTS, storeContentsText, credentialMintFlags, validateCredentialMintArguments, validateCredentialRevokeArguments, exportSpaceSigner, signerExportFlags, validateSignerExportInput, inputDisabledByFlag, isWorkspaceTargetError, resolveMeshTarget, targetErrorCode, spaceFlag, isCommandFailure, oneLine, boundedValue, SHOWN_VALUE_MAX, jsonFlag, plainFlag, presentationOf, renderReport, terminalWidth, writeResult, CLI_USER_ACTOR, findCotalRoot, getSpaceAuth, homeCotalDir, loadMeshes, removeCatalogMeshes, untilInputEnds, userAuthStateDir, deprecatedDaemonEntry, workspaceErrorParts, workspaceSecretStore, type CredentialAction, type MeshEntry, type MeshTarget, type RefusalCode } from "@cotal-ai/workspace";
import {
  deleteIdpSession,
  deleteIdpSpaceCatalog,
  establishIdpSession,
  IdpUnreachableError,
  loadIdpSession,
  listIdpAccounts,
  normalizeIdpUrl,
  revokeIdpSession,
} from "./login.js";
import { inspectHandleFile } from "./handle-inspect.js";
import { checkedEviction } from "./barrier-evict.js";
import { deriveOwnerForIdpSubject } from "./derive.js";
import { withDeliveryAdminEndpoint } from "./delivery-admin.js";
import { findInteractiveActor, findManagedActor, loadActorLedger, withManagedGrantTransaction, type ActorRow } from "./ledger.js";
import { INTERACTIVE_RETIRE_PATH, runAuthService } from "./service.js";
import { loadAuthServiceInfo, loadOwnerSecret, loadPinnedIdp } from "./store.js";

const DEFAULT_CLIENT_ID = "cotal-cli";

/** Every operational failure in these commands is a deliberately-legible thrown sentence
 *  (a refused client id, a revoked session, a malformed IdP response …) — the CLI's generic
 *  catch would re-throw it into a raw stack trace. Print the sentence, exit 1. */
async function legibly(fn: () => Promise<void>, failure?: () => CommandFailure): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (isCommandFailure(e)) throw e;
    if (failure) throw failure();
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

/** The refusal each status of the retirement route is, once the service states the retirement did
 *  not run (`outcome: "not-executed"`). */
const RETIREMENT_REFUSAL: Readonly<Partial<Record<number, RefusalCode>>> = {
  400: "UNSUPPORTED", 401: "PERMISSION_DENIED", 403: "PERMISSION_DENIED", 404: "CONFLICT", 405: "UNSUPPORTED",
  409: "CONFLICT", 412: "CONFLICT", 415: "UNSUPPORTED", 503: "DEPENDENCY_UNAVAILABLE",
};

/** Retire the row's interactive lifecycle through the auth service. True only when this call
 *  retired it: a row with no lifecycle, a lifecycle the service reports never started
 *  (`retired: false`) and one that was already retired change nothing here. A retirement whose
 *  request never reached the service, or that the service states did not run, refuses, naming the
 *  unchanged row; any other failure is unknown. Neither writes the row. */
async function retireInteractiveActorLifecycle(
  dir: string,
  space: string,
  row: ActorRow,
  operation: "re-grant" | "revoke",
): Promise<boolean> {
  if (!row.lifecycleUid) return false;
  const target = { space, owner: row.owner, actor: row.actor };
  const subject = `cannot ${operation} "${row.owner}/${row.actor}"`;
  const notRun = (code: RefusalCode, why: string, remedy: string) =>
    new CommandFailure("refused", code, `${subject}: ${why}; its lifecycle was not retired and the actor row was not changed`, { target, remedy });
  const mayHaveRun = (why: string) =>
    new CommandFailure("unknown", "OPERATION_UNKNOWN", `${subject}: ${why}; its lifecycle may have been retired, and the actor row was not changed`, { target, remedy: "read the authoritative grant ledger before another mutation" });
  const service = loadAuthServiceInfo(dir);
  if (!service) throw notRun("DEPENDENCY_UNAVAILABLE", "the auth service is not running", "restart the stack with `cotal up`, then retry");
  let response: Response;
  try {
    response = await fetch(`${service.url}${INTERACTIVE_RETIRE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${service.cap}`,
      },
      body: JSON.stringify({ owner: row.owner, actor: row.actor, lifecycleUid: row.lifecycleUid }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    // A refused connection carried no request. Any other transport failure, a timeout included, may
    // have followed a request the service received.
    if ((error as { cause?: { code?: unknown } } | null)?.cause?.code === "ECONNREFUSED")
      throw notRun("DEPENDENCY_UNAVAILABLE", `the auth service at ${service.url} refused the connection`, "restart the stack with `cotal up`, then retry");
    throw mayHaveRun(`its lifecycle retirement request failed (${error instanceof Error ? error.message : String(error)})`);
  }
  const body = await readAuthResponseJson(response, `the auth service's lifecycle retirement endpoint at ${service.url}${INTERACTIVE_RETIRE_PATH}`)
    .catch((error: unknown) => { throw mayHaveRun(error instanceof Error ? error.message : String(error)); }) as { error?: string; outcome?: unknown; retired?: unknown; lifecycleUid?: unknown; alreadyRetired?: unknown };
  if (!response.ok) {
    const answer = body.error ?? `HTTP ${response.status}`;
    // Only the service knows whether the retirement began, and an error without its outcome may
    // have followed a barrier that had (SPEC 13.3).
    if (body.outcome !== "not-executed") throw mayHaveRun(`the auth service answered lifecycle retirement with an error (${answer})`);
    const code = RETIREMENT_REFUSAL[response.status] ?? "DEPENDENCY_UNAVAILABLE";
    throw notRun(code, `the auth service refused lifecycle retirement (${answer})`, code === "CONFLICT" ? "re-read `cotal actor list`, then decide whether to grant or revoke again" : "restart the stack with `cotal up`, then retry");
  }
  if (typeof body.retired !== "boolean" || body.lifecycleUid !== row.lifecycleUid)
    throw mayHaveRun(`the auth service answered lifecycle retirement for ${row.lifecycleUid} without a readable result`);
  return body.retired && body.alreadyRetired !== true;
}

function canChooseAccount(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && !inputDisabledByFlag() && process.env.COTAL_NO_PROMPT !== "1";
}

function validateAccountArguments(args: ParsedArgs, mode: "login" | "logout"): void {
  presentationOf(args.values);
  if (args.values.idp !== undefined) {
    try { normalizeIdpUrl(String(args.values.idp)); }
    catch { throw new CommandFailure("refused", "USAGE_INVALID", "use an HTTPS provider auth URL, or an HTTP loopback IP URL, without embedded credentials, a query or a fragment"); }
  }
  if (args.values["client-id"] !== undefined && !String(args.values["client-id"]).trim())
    throw new CommandFailure("refused", "USAGE_INVALID", "--client-id cannot be empty");
  if (mode === "login" && inputDisabledByFlag()) throw new CommandFailure("refused", "UNSUPPORTED", "this provider login uses device approval and has no noninteractive grant in this client", { remedy: "sign in from an interactive terminal" });
}

async function chooseAccount(args: ParsedArgs, mode: "login" | "logout"): Promise<string | undefined> {
  if (typeof args.values.idp === "string") return normalizeIdpUrl(args.values.idp);
  let cached: ReturnType<typeof listIdpAccounts>;
  try { cached = listIdpAccounts(homeCotalDir()); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "cached account metadata could not be read; it was not reset"); }
  const providers = new Map(cached.map((item) => [item.idp, item.sub]));
  if (mode === "login") for (const mesh of loadMeshes()) if (mesh.userAuth?.idp.url) providers.set(normalizeIdpUrl(mesh.userAuth.idp.url), providers.get(normalizeIdpUrl(mesh.userAuth.idp.url)));
  if (providers.size === 1) return providers.keys().next().value;
  if (mode === "logout" && providers.size === 0) return undefined;
  if (!canChooseAccount() || presentationOf(args.values) === "json") throw new CommandFailure("refused", "USAGE_INVALID", "select the provider explicitly with --idp outside an interactive terminal");
  if (providers.size) {
    const chosen = await untilInputEnds((signal) => prompts.select({ message: mode === "login" ? "Choose a sign-in provider" : "Choose the account to sign out", options: [...providers].map(([idp, sub]) => ({ value: idp, label: oneLine(idp), ...(sub ? { hint: oneLine(sub) } : {}) })), signal }));
    return prompts.isCancel(chosen) ? undefined : chosen;
  }
  const answer = await untilInputEnds((signal) => prompts.text({ message: "Sign-in provider auth URL", placeholder: "https://example.org/api/auth", signal, validate: (value) => {
    try { normalizeIdpUrl(value ?? ""); }
    catch { return "Enter the HTTPS auth base URL without a query, fragment or embedded credentials."; }
  } }));
  return prompts.isCancel(answer) ? undefined : normalizeIdpUrl(answer);
}

async function runLogin(args: ParsedArgs): Promise<void> {
  const values = args.values as { idp?: string; "client-id"?: string };
  validateAccountArguments(args, "login");
  const presentation = presentationOf(args.values);
  const idpArg = await chooseAccount(args, "login");
  if (idpArg === undefined) { console.error("Sign-in cancelled. No provider session was requested."); return; }
  await legibly(async () => {
    const idp = normalizeIdpUrl(idpArg);
    // establishIdpSession proves the session mints user JWTs BEFORE persisting it — a failed
    // proof leaves no cache entry to fool requireIdpSession later. Every provider request runs
    // before that, so a provider that cannot be reached leaves nothing cached: a dependency
    // refusal, never a raw transport error.
    const { session, sub, previousSub, label } = await establishIdpSession({
      dir: homeCotalDir(),
      idpUrl: idp,
      clientId: values["client-id"] ?? DEFAULT_CLIENT_ID,
      onPrompt: (p) => {
        console.error(renderReport({ sections: [{ title: "Approve sign-in", blocks: [
          { kind: "fields", rows: [["Provider", idp], ["Open", p.verificationUriComplete], ["Or open", p.verificationUri], ["Approval code", p.userCode], ["Expires", `in ${Math.ceil(p.expiresInSec / 60)} minutes`]] },
          { kind: "lines", lines: [{ text: "Waiting for the provider's approval. Ctrl-C aborts this request. Do not share the approval link or code.", tone: "hint" }] },
        ] }] }, presentation === "plain" ? "plain" : "rich", terminalWidth(process.stderr)));
      },
    }).catch((error: unknown) => {
      if (error instanceof IdpUnreachableError)
        throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `${error.message}; no session was cached`, { target: { idp }, remedy: "check --idp <auth base URL>; it must serve <base>/device/code" });
      throw error;
    });
    const provider = resolveAuthProvider();
    if (previousSub) {
      const removed = removeCatalogMeshes(deleteIdpSpaceCatalog(homeCotalDir(), idp, previousSub));
      if (removed.length)
        console.log(`Removed the previous account's discovered spaces: ${removed.join(", ")}. No replacement was selected automatically.`);
    }
    let discovered: MeshEntry[] = [];
    if (provider.hasSpaceCatalog?.({ dir: homeCotalDir(), idpUrl: idp, sub })) {
      const consumer = resolveSpaceCatalogConsumer();
      const results = await provider.syncSpaceCatalogAfterLogin?.({ dir: homeCotalDir(), idpUrl: idp, validate: consumer.validate, apply: consumer.apply }) ?? [];
      const owners = new Set(results.map((r) => r.account.ownerKey));
      discovered = loadMeshes().filter((m) => m.origin === "catalog" && owners.has(m.catalogOwner ?? "")).sort((a, b) => a.space.localeCompare(b.space));
    }
    // WHO signed in must be human-readable (per-user auth exists for operator-visible identity):
    // prefer the IdP's email/name claim; the raw `sub` stays as the stable id (dim when secondary).
    console.log(renderReport({ sections: [
      { title: "Signed in", blocks: [{ kind: "fields", rows: [["Account", label || sub], ["Subject", sub], ["Provider", idp], ["Session expires", new Date(session.expiresAt * 1000).toISOString()]] }, { kind: "lines", lines: [{ text: "Account identity is verified. Each space's grants decide access separately. No session token is printed.", tone: "hint" }] }] },
      ...(discovered.length ? [{ title: "Your spaces", blocks: [{ kind: "fields" as const, rows: discovered.map((m): [string, string] => [m.space, [m.catalogName ?? m.space, m.catalogRole].filter(Boolean).join(" · ")]) }] }] : []),
      { title: "Next", blocks: [{ kind: "commands", items: discovered.length
        ? [{ command: "cotal use <name>", description: "Select one of your spaces for the commands that follow" }, { command: "cotal space", description: "See every registered space" }]
        : [{ command: "cotal space", description: "See registered spaces and choose one" }, { command: "cotal sync", description: "Refresh spaces the provider makes available to this account" }] }] },
    ] }, presentation === "plain" ? "plain" : "rich", terminalWidth(process.stdout)));
  });
}

async function runLogout(args: ParsedArgs): Promise<void> {
  validateAccountArguments(args, "logout");
  const idp = await chooseAccount(args, "logout");
  const presentation = presentationOf(args.values);
  if (idp === undefined) {
    writeResult(presentation, { command: "logout", target: null, result: { kind: "logout", providerSelected: false, serverRevoked: null }, noOp: true }, () => ({ sections: [{ title: "No sign-out performed", blocks: [{ kind: "lines", lines: ["No provider was selected. No server session was revoked."] }] }] }));
    return;
  }
  const dir = homeCotalDir();
  let session: ReturnType<typeof loadIdpSession>;
  try { session = loadIdpSession(dir, idp); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the cached login could not be read; nothing was cleared", { target: { idp } }); }
  if (!session) {
    writeResult(presentation, { command: "logout", target: { idp }, result: { kind: "logout", localLogin: "absent", serverRevoked: null }, noOp: true }, () => ({ sections: [{ title: "No cached sign-in", blocks: [{ kind: "fields", rows: [["Provider", idp]] }, { kind: "lines", lines: [{ text: "No local session was found. Other server sessions were not checked or revoked.", tone: "hint" }] }] }] }));
    return;
  }
  // `--local` forgets this machine's login without contacting the provider, whose session stays valid.
  const local = args.values.local === true;
  if (!local) {
    try { await revokeIdpSession(idp, session.token); }
    catch { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "server-side session revocation was not confirmed; the local login is kept so it can be retried", { target: { idp }, remedy: `retry logout for this provider, or revoke the session at the provider; to forget the login on this machine only, run cotal logout --idp ${idp} --local` }); }
  }
  let localCleared = false;
  let removed: string[] = [];
  try {
    deleteIdpSession(dir, idp);
    localCleared = true;
    if (session.sub) removed = removeCatalogMeshes(deleteIdpSpaceCatalog(dir, idp, session.sub));
  } catch {
    if (local && !localCleared) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the cached login could not be confirmed cleared; the provider was not contacted", { target: { idp } });
    if (local) throw new CommandFailure("partial", "OPERATION_PARTIAL", "the cached login was cleared, but discovered-space cleanup was not confirmed; the provider was not contacted", { target: { idp }, changed: [{ kind: "local-login", idp, cleared: true }] });
    throw new CommandFailure("partial", "OPERATION_PARTIAL", localCleared ? "the server session was revoked and the cached login cleared, but discovered-space cleanup was not confirmed" : "the server session was revoked, but local cleanup was not confirmed", { target: { idp }, changed: [{ kind: "idp-session", idp, revoked: true }, ...(localCleared ? [{ kind: "local-login", idp, cleared: true }] : [])] });
  }
  writeResult(presentation, { command: "logout", target: { idp }, result: { kind: "logout", serverRevoked: !local, localLoginCleared: true, removedRegistrations: removed } }, (result) => ({ sections: [
    { title: local ? "Signed out on this machine" : "Signed out", blocks: [{ kind: "fields", rows: [["Provider", idp], ["Provider session", local ? { text: "not contacted; it stays valid until it expires or is revoked at the provider", tone: "waiting" } : { text: "revoked", tone: "ok" }], ["Local login", "cleared"], ["Discovered spaces removed", String(result.removedRegistrations.length)]] }, { kind: "lines", lines: [{ text: "This does not claim that independently running agents or other provider sessions were stopped.", tone: "hint" }] }] },
    { title: "Next", blocks: [{ kind: "commands", items: [{ command: "cotal login", description: "Sign in deliberately when needed" }] }] },
  ] }));
}

/** The space-scoped provider state the `actor` commands operate on, at the target
 *  {@link localAuthTarget} resolved: the ledger dir (`userAuthStateDir` — the multi-space-ready
 *  layout; nothing user-auth lives flat in `.cotal/auth/`) plus the local secret store (these are
 *  workstation commands — the ledger machine — so the workspace FS composition IS the correct
 *  one, not a fallback). */
function actorState(target: AuthTarget): { dir: string; space: string; mode?: MeshTarget["mode"]; store: SecretStore } {
  return { dir: userAuthStateDir(target.root, target.space), space: target.space, mode: target.mode, store: workspaceSecretStore(target.root) };
}

/** The refusal of a grant read or change on a root that holds no owner secret and IdP pin for the
 *  space. A static or open space has no user-auth ledger on any machine, so its refusal says grants
 *  need a user-auth space; another space's ledger may live at another root. `unwritten` says what
 *  this command did not do. */
function noLedger(st: { space: string; mode?: MeshTarget["mode"] }, unwritten: string): CommandFailure {
  const target = { space: st.space };
  if (st.mode === "auth" || st.mode === "open")
    return new CommandFailure("refused", "UNSUPPORTED", `space "${st.space}" is ${st.mode === "auth" ? "a static-credential" : "an open"} space and has no user-auth ledger; ${unwritten}`, { target, remedy: "actor grants apply only to a space started with `cotal up --user-auth`" });
  return new CommandFailure("refused", "UNSUPPORTED", `this root does not hold the space's authoritative user-auth ledger; ${unwritten}`, { target, remedy: "manage grants on the machine and root that host this space's user-auth ledger; a space started without `--user-auth` has none" });
}

/** Resolve the operator's target (owner) for `actor grant`/`revoke`: an explicit derived `--owner`
 *  token, or `--sub` (the IdP subject `cotal login` prints) derived through the SAME frozen encoding
 *  the bridge exchange uses. BOTH require the space's owner secret + IdP pin under `dir` — i.e. this
 *  IS the machine that ran `cotal up --user-auth`, where the authoritative ledger lives. Without
 *  them a grant would write an INERT LOCAL row and print a misleading success while the mesh's real
 *  ledger is untouched (an off-machine `--owner` cannot mutate authority), so we refuse instead. */
async function resolveGrantOwner(
  st: ReturnType<typeof actorState>,
  values: { owner?: string; sub?: string },
  unwritten: string,
): Promise<string> {
  const secret = await loadOwnerSecret(st.store, st.space);
  const idp = loadPinnedIdp(st.dir);
  if (!secret || !idp) throw noLedger(st, unwritten);
  if (values.owner) return values.owner;
  return deriveOwnerForIdpSubject(secret, idp.issuer, values.sub!);
}

/** The two explicit shapes of a grant in either spelling, printed by its usage refusal. */
const grantForms = (command: "auth" | "actor"): string =>
  `cotal ${command} grant <actor> --sub <IdP subject> --full   (all channels, scope spawn,role:default; a named flag still overrides its field), or cotal ${command} grant <actor> --sub <IdP subject> --scope a,b --allow-subscribe a,b --allow-publish a,b   ('' = none, e.g. --scope '' --allow-subscribe general --allow-publish ''). [--role r] [--label l]`;

/** The grant verbs of each spelling. */
const grantUsage = (command: "auth" | "actor"): string =>
  command === "auth" ? "use auth, auth grants, auth grant <actor>, or auth revoke <actor>" : "use actor list, actor grant <actor>, actor label <actor> <label>, or actor revoke <actor>";

const csv = (s: string | undefined, dflt: string[]): string[] =>
  s === undefined ? dflt : s.split(",").map((x) => x.trim()).filter(Boolean);

/** Close a revoked principal's LIVE window (D5 acceptance gate: removal stops live delivery
 *  IMMEDIATELY, not at bearer expiry): mint an ephemeral supervisor cred from the local signer and
 *  request the delivery daemon's `evictPrincipal` (privileged delivery-admin rail — scan→KICK→
 *  verify). BEST-EFFORT with honest copy: deny-new is already committed by the ledger revoke
 *  before this runs, so a missing daemon/signer/registry only widens the end back to the bearer's
 *  own expiry — reported, never silent, and never a reason to fail the revoke. */
async function evictRevokedPrincipal(space: string, principal: string, rootOverride?: string): Promise<string> {
  const fallback = (why: string) =>
    `live-connection eviction skipped (${why}) - deny-new is committed and the revoke cannot be re-run; the already-open connection ends at its current bearer's expiry. To evict live connections at revoke time, run \`cotal actor revoke\` from the mesh root (local signer + registry).`;
  const incomplete = (why: string) => `live-connection eviction INCOMPLETE (${why}) - run \`cotal doctor auth\``;
  const root = rootOverride ?? findCotalRoot();
  const auth = await getSpaceAuth(workspaceSecretStore(root), space);
  if (!auth) return fallback("no local signer here");
  const mesh = loadMeshes().find((m) => m.space === space);
  if (!mesh) return fallback("mesh not in the local registry");
  try {
    return await withDeliveryAdminEndpoint({ space, server: mesh.server, dataAccount: auth.account }, "supervisor", "revoke-evict", async (ep) => {
      const r = await ep.requestDeliveryAdmin("evictPrincipal", { principal }, 15_000);
      if (!r.ok) return `live-connection eviction refused: ${r.error}`;
      const d = checkedEviction(principal, r.data, (_principal, note) => note);
      if (typeof d === "string") return incomplete(d);
      return d.verifiedGone ? `live connections closed now (${d.kicked} kicked, verified gone)` : incomplete(`${d.kicked} kicked, ${d.remaining} still live`);
    });
  } catch (e) {
    return fallback(e instanceof Error ? e.message : String(e));
  }
}

function publicActor(row: ActorRow & { kind?: string }) {
  return { owner: row.owner, actor: row.actor, kind: row.kind, role: row.role ?? null, label: row.label ?? null, parent: row.parent ?? null, scope: row.scope, allowSubscribe: row.allowSubscribe, allowPublish: row.allowPublish };
}

/** The ledger rows of one IdP subject, as `--sub` names them: the ledger keeps no subject, so the
 *  owner they derive to is shown beside it. */
type SubjectRows = { subject: string; owner: string };

function grantView(space: string, rows: readonly ReturnType<typeof publicActor>[], only?: SubjectRows) {
  const title = only ? `Rows for ${oneLine(boundedValue(only.subject, SHOWN_VALUE_MAX))} (owner ${only.owner})` : "Recorded actor grants";
  return { sections: [{ title, blocks: [
    { kind: "fields" as const, rows: [["Space", space], ["Source", "local authoritative actor ledger"]] as [string, string][] },
    // A re-grant replaces the whole row, so every field it must spell again is shown.
    rows.length ? { kind: "table" as const, columns: [{ key: "principal", label: "Principal" }, { key: "kind", label: "Kind" }, { key: "scope", label: "Capabilities" }, { key: "read", label: "May read" }, { key: "post", label: "May post" }, { key: "role", label: "Role" }, { key: "label", label: "Label" }, { key: "parent", label: "Parent" }], rows: rows.map((row) => ({ principal: `${row.owner}.${row.actor}`, kind: row.kind ?? "not recorded", scope: row.scope.join(", ") || "none", read: row.allowSubscribe.join(", ") || "none", post: row.allowPublish.join(", ") || "none", role: row.role ?? "none", label: row.label ?? "none", parent: row.parent ?? "none" })) } : { kind: "lines" as const, lines: [only ? "No rows for this owner in this authoritative ledger snapshot." : "No rows in this authoritative ledger snapshot."] },
    { kind: "lines" as const, lines: [{ text: "Recorded grants are not proof of current connections, task progress or the authority of a cached account session.", tone: "hint" as const }] },
  ] }] };
}

/** `cotal service-endpoint`: one host request ({@link serviceEndpointHostCall}) at the resolved
 *  local authority root, and its answer rendered. */
async function runServiceEndpoint(args: ParsedArgs, target: AuthTarget): Promise<void> {
  const { dir, space } = actorState(target);
  const presentation = presentationOf(args.values);
  await legibly(async () => {
    const call = await serviceEndpointHostCall(dir, space, args.positionals, args.values as ServiceEndpointValues);
    writeResult(presentation, { command: "service-endpoint", target: { space }, result: { kind: "service-endpoint-host", ...call } }, (result) => ({
      space,
      sections: [{ title: `Service endpoint ${result.request}`, blocks: [
        { kind: "fields" as const, rows: [["Space", space], ["Subject", result.subject], ["State", String((result.answer as { state: string }).state)],
          ...(result.requestId !== undefined ? [["Request id", result.requestId]] : [])] as [string, string][] },
        { kind: "lines" as const, lines: [{ text: JSON.stringify(result.answer), tone: "hint" as const }] },
      ] }],
    }));
  });
}

/** A grant read or change, `auth grants|grant|revoke` or its `actor list|grant|revoke` spelling, at
 *  the target {@link localAuthTarget} resolved, once {@link validateGrantUsage} has passed. */
async function runActor(args: ParsedArgs, target: AuthTarget, command: "auth" | "actor"): Promise<void> {
  const [sub, actor] = args.positionals;
  const values = args.values as {
    sub?: string; owner?: string; scope?: string; "allow-subscribe"?: string;
    "allow-publish"?: string; role?: string; label?: string; parent?: string; full?: boolean;
  };
  const st = actorState(target);
  const { dir, space } = st;
  let mutationAttempted = false;
  // A guard that fires after `retireInteractiveActorLifecycle` returned. When that call retired the
  // predecessor's lifecycle and this command wrote nothing, the result is partial, never unknown.
  // When it retired nothing, the same guard is a plain conflict.
  const rowConflict = (row: ActorRow, retired: boolean, verb: "re-grant" | "revoke", what: string, unwritten: string): CommandFailure => {
    const target = { space, owner: row.owner, actor: row.actor };
    const remedy = "re-read `cotal actor list`, then decide whether to grant or revoke again";
    if (!retired) return new CommandFailure("refused", "CONFLICT", `cannot ${verb} "${row.owner}/${row.actor}": ${what}; ${unwritten}`, { target, remedy });
    return new CommandFailure("partial", "OPERATION_PARTIAL", `cannot ${verb} "${row.owner}/${row.actor}": its lifecycle ${row.lifecycleUid} was retired, but ${what}; ${unwritten}`, {
      target, remedy, changed: [{ kind: "actor-lifecycle-retired", owner: row.owner, actor: row.actor, lifecycleUid: row.lifecycleUid }],
    });
  };
  await legibly(async () => {
    if (sub === "list") {
      if (!(await loadOwnerSecret(st.store, space)) || !loadPinnedIdp(dir)) throw noLedger(st, "an empty grant list was not inferred");
      // `--sub` derives its owner as a grant does, so a subject's rows are found with no subject stored.
      const only = values.sub === undefined ? undefined : { subject: values.sub, owner: await resolveGrantOwner(st, { sub: values.sub }, "an empty grant list was not inferred") };
      const items = loadActorLedger(dir).filter((row) => !only || row.owner === only.owner).sort((a, b) => (a.owner + a.actor).localeCompare(b.owner + b.actor)).map(publicActor);
      writeResult(presentationOf(args.values), { command, target: only ? { space, owner: only.owner } : { space }, result: { kind: "actor-grants", ...only, items } }, (result) => grantView(space, result.items, only));
      return;
    }
    if (sub === "grant") {
      if (!actor) throw new CommandFailure("refused", "USAGE_INVALID", grantUsage(command));
      const owner = await resolveGrantOwner(st, values, "no inert grant was written");
      //
      // A re-grant rotates the lifecycle so a copied bearer cannot cross the authorization update.
      // Retire the predecessor through the auth plane first; issuance is not allowed to perform a
      // takeover as a side effect, and writing the successor first would strand the alias on failure.
      const current = findInteractiveActor(dir, owner, actor);
      let retired = false;
      if (current?.lifecycleUid) {
        mutationAttempted = true;
        // Async retirement runs before the transaction, never inside it.
        retired = await retireInteractiveActorLifecycle(dir, space, current, "re-grant");
      }
      mutationAttempted = true;
      const grantRow = {
        owner,
        actor,
        scope: csv(values.scope, ["spawn", "role:default"]),
        allowSubscribe: csv(values["allow-subscribe"], [">"]),
        allowPublish: csv(values["allow-publish"], [">"]),
        ...(values.role ? { role: values.role } : {}),
        ...(values.label ? { label: values.label } : {}),
        ...(values.parent ? { parent: values.parent } : {}),
      };
      // The re-read, the decision and the write are one transaction. The row read before the lock
      // must still be there: the one whose lifecycle just retired, or no row at all. A grant that
      // landed while this one waited for the lock is never overwritten.
      const row = withManagedGrantTransaction(dir, (tx) => {
        const read = tx.read(owner, actor);
        if (current === undefined) {
          if (read !== undefined)
            throw new CommandFailure("refused", "CONFLICT", `cannot grant "${owner}/${actor}": another grant for this actor landed while this one waited; nothing was written`, { target: { space, owner, actor }, remedy: "re-read `cotal actor list`, then retry" });
        } else {
          const refreshed = read?.kind === "interactive" ? read : undefined;
          if (refreshed?.lifecycleUid !== current.lifecycleUid)
            throw rowConflict(current, retired, "re-grant", "the actor row changed or was removed since it was read", "the successor grant was not written and nothing was overwritten");
        }
        return tx.grantInteractive(grantRow);
      });
      // A re-grant writes the row again and rotates its lifecycle even when no field changed, so the
      // receipt says what the earlier row held relative to this one.
      const fields = (r: Pick<ActorRow, "scope" | "allowSubscribe" | "allowPublish" | "role" | "label" | "parent">) => JSON.stringify([r.scope, r.allowSubscribe, r.allowPublish, r.role ?? null, r.label ?? null, r.parent ?? null]);
      const previous = current === undefined ? "none" as const : fields(current) === fields(row) ? "unchanged" as const : "replaced" as const;
      const result = { kind: "actor-grant", grant: publicActor({ ...row, kind: "interactive" }), fullOptionExplicit: values.full === true, previous, previousLifecycleRetired: retired };
      writeResult(presentationOf(args.values), { command, target: { space, owner: row.owner, actor: row.actor }, result }, (data) => ({ sections: [
        { title: data.previous === "unchanged" ? "Actor grant stored unchanged" : "Actor grant stored", blocks: [{ kind: "fields", rows: [["Principal", `${data.grant.owner}.${data.grant.actor}`], ["Space", space], ["Earlier grant", data.previous === "none" ? "none" : data.previous === "unchanged" ? "the same fields" : "replaced"], ...(data.previousLifecycleRetired ? [["Earlier lifecycle", "retired, so a bearer issued under it no longer works"] as [string, string]] : []), ["Capabilities", data.grant.scope.join(", ") || "none"], ["May read", data.grant.allowSubscribe.join(", ") || "none"], ["May post", data.grant.allowPublish.join(", ") || "none"], ["Role", data.grant.role ?? "none"], ["Label", data.grant.label ?? "none"], ["Parent", data.grant.parent ?? "none"], ["Wide defaults requested", data.fullOptionExplicit ? "explicit --full" : "no"]] }, { kind: "lines", lines: [{ text: "The local authority stored this grant. No process was launched and no cached login was treated as a grant.", tone: "hint" }] }] },
      ] }));
      return;
    }
    if (sub === "label") {
      const label = args.positionals[2]!;
      const owner = await resolveGrantOwner(st, values, "no label was written");
      const target = { space, owner, actor: actor! };
      mutationAttempted = true;
      // The label is outside the authorization digest, so the row keeps its lifecycle and a bearer
      // issued under it keeps working. Nothing is retired.
      const { earlier, row } = withManagedGrantTransaction(dir, (tx) => {
        const read = tx.read(owner, actor!);
        if (read === undefined)
          throw new CommandFailure("refused", "TARGET_NOT_FOUND", `"${owner}/${actor}" has no grant in this ledger; no label was written`, { target, remedy: `see the rows with cotal actor list --space ${space}` });
        if (read.kind !== "interactive")
          throw new CommandFailure("refused", "UNSUPPORTED", `"${owner}/${actor}" is a managed agent, and its row belongs to its spawn lifecycle; no label was written`, { target, remedy: "label the interactive row it was spawned from" });
        return { earlier: read.label ?? null, row: tx.relabelInteractive(owner, actor!, label)! };
      });
      const result = { kind: "actor-label", grant: publicActor({ ...row, kind: "interactive" }), previousLabel: earlier };
      writeResult(presentationOf(args.values), { command, target, result }, (data) => ({ sections: [
        { title: data.previousLabel === data.grant.label ? "Actor label stored unchanged" : "Actor label stored", blocks: [{ kind: "fields", rows: [["Principal", `${data.grant.owner}.${data.grant.actor}`], ["Space", space], ["Label", data.grant.label ?? "none"], ["Earlier label", data.previousLabel ?? "none"], ["Lifecycle", "kept, so a bearer issued under it keeps working"]] }, { kind: "lines", lines: [{ text: "Only the label changed. The row's capabilities, channels, role and parent are as they were.", tone: "hint" }] }] },
      ] }));
      return;
    }
    if (sub === "revoke") {
      if (!actor) throw new CommandFailure("refused", "USAGE_INVALID", grantUsage(command));
      const owner = await resolveGrantOwner(st, values, "nothing was revoked");
      const current = findInteractiveActor(dir, owner, actor);
      if (!current) {
        if (findManagedActor(dir, owner, actor))
          throw new Error(`${owner}.${actor} is a managed agent - its grant lives with its process: stop it if manager-owned (\`cotal stop --name ${actor}\`), or if it was a killed foreground spawn, respawn the same name (\`cotal spawn\`) to rotate the grant`);
        writeResult(presentationOf(args.values), { command, target: { space, owner, actor }, result: { kind: "actor-revoke", revoked: false, liveConnections: "not-checked" }, noOp: true }, () => ({ sections: [{ title: "No grant to revoke", blocks: [{ kind: "fields", rows: [["Principal", `${owner}.${actor}`], ["Space", space]] }, { kind: "lines", lines: ["No interactive grant was found. No live-connection result is implied."] }] }] }));
        return;
      }
      mutationAttempted = true;
      const retired = await retireInteractiveActorLifecycle(dir, space, current, "revoke");
      // The post-retirement re-read, the decision and the removal are one transaction.
      withManagedGrantTransaction(dir, (tx) => {
        const read = tx.read(owner, actor);
        const refreshed = read?.kind === "interactive" ? read : undefined;
        if (refreshed?.lifecycleUid !== current.lifecycleUid)
          throw refreshed
            ? rowConflict(current, retired, "revoke", "the actor row changed since it was read", "the changed row was not deleted")
            : rowConflict(current, retired, "revoke", "the interactive actor row was removed or replaced since it was read", "nothing was deleted");
        if (!tx.revokeInteractive(owner, actor))
          throw rowConflict(current, retired, "revoke", "the actor row disappeared before it could be deleted", "nothing was deleted");
      });
      // Deny-new is immediate at both boundaries (exchange + connect). The LIVE window no longer
      // rides the bearer's expiry by default: the flip wires revoke → the delivery daemon's
      // evictPrincipal (scan→KICK→verify on the privileged rail), best-effort with honest copy —
      // a human bearer can otherwise carry up to the IdP session cap, far beyond the agents' TTL.
      const evictionNotice = await evictRevokedPrincipal(space, `${owner}.${actor}`, target.root);
      writeResult(presentationOf(args.values), { command, target: { space, owner, actor }, result: { kind: "actor-revoke", revoked: true, denyNew: true, liveEviction: { evidence: "native notice; not independently measured by this command", notice: evictionNotice } }, warnings: [{ code: "LIVE_EVICTION_SCOPE", target: { space, owner, actor }, message: "Deny-new is committed. The separate native live-connection eviction notice describes its own evidence and limits; revocation was not repeated." }] }, (result) => ({ sections: [
        { title: "Actor grant revoked", blocks: [{ kind: "fields", rows: [["Principal", `${owner}.${actor}`], ["Space", space], ["New exchanges and connections", "denied by the removed grant"]] }, { kind: "lines", lines: [result.liveEviction.notice, { text: "Existing connections and spawned agents have their own lifecycle. This is not a claim that every related process was stopped.", tone: "hint" }] }] },
      ] }));
      return;
    }
    throw new CommandFailure("refused", "USAGE_INVALID", grantUsage(command));
  }, () => new CommandFailure(mutationAttempted ? "unknown" : "failed", mutationAttempted ? "OPERATION_UNKNOWN" : "OPERATION_FAILED", mutationAttempted ? "the grant operation did not return a confirmed complete result; lifecycle retirement or a ledger update may have occurred; nothing was retried" : "the local grant authority or records could not be read", { target: { space, ...(actor ? { actor } : {}) }, remedy: "read the authoritative grant ledger before another mutation" }));
}

const authCommands: Command[] = [
  {
    kind: "command",
    // The auth daemon `up` launches. `auth-service` is the same entry for persisted callers, plus the
    // deprecation warning; help and completion list neither.
    name: "__daemon-auth-service",
    hidden: true,
    group: "Manager",
    summary: "run the user-auth service daemon - NATS auth callout + token exchange/JWKS --space <s> --server <url> [--port <n>] [--callout-only [--spaces <manifest>]]",
    flags: [...authServiceFlags, authCalloutOnlyFlag, authSpacesFlag],
    prepareMeshTarget: false,
    run: (args) => legibly(() => runAuthService(args)),
  },
  {
    kind: "command",
    name: "actor",
    hidden: true,
    group: "Identity",
    summary: "(legacy) manage the space's actor ledger - grant/revoke which (user, actor) pairs may run agents. `auth grants`, `auth grant` and `auth revoke` replace it",
    usage: "cotal actor <grant <actor> | revoke <actor> | label <actor> <label> | list> [--sub <IdP subject>|--owner <u_…>] [--space <s>] [--full | --scope a,b --allow-subscribe a,b --allow-publish a,b] [--role r] [--label l] [--json|--plain]",
    positionals: "<grant <actor> | revoke <actor> | label <actor> <label> | list>",
    subcommands: [
      { name: "grant", flagNames: ["space", "sub", "owner", "full", "scope", "allow-subscribe", "allow-publish", "role", "label", "parent"], summary: "store an actor's whole ledger row: name all three ACL flags, or --full for the wide defaults", usage: "cotal actor grant <actor> (--sub <IdP subject> | --owner <u_…>) (--full | --scope a,b --allow-subscribe a,b --allow-publish a,b) [--role r] [--label l] [--parent <owner.actor>] [--space <s>]", outputs: ["json", "plain"] },
      { name: "revoke", flagNames: ["space", "sub", "owner"], summary: "revoke an actor's ledger row", usage: "cotal actor revoke <actor> (--sub <IdP subject> | --owner <u_…>) [--space <s>]", outputs: ["json", "plain"] },
      { name: "label", flagNames: ["space", "sub", "owner"], summary: "change only an interactive row's display label, keeping its lifecycle", usage: "cotal actor label <actor> (--sub <IdP subject> | --owner <u_…>) <label> [--space <s>]", outputs: ["json", "plain"] },
      { name: "list", flagNames: ["space", "sub"], summary: "list the space's actor ledger, or one IdP subject's rows", usage: "cotal actor list [--sub <IdP subject>] [--space <s>]", outputs: ["json", "plain"] },
    ],
    flags: [
      { name: "space", type: "string", value: "<s>", description: "space whose ledger to manage (default: the resolved mesh, as for auth grants)" },
      { name: "sub", type: "string", value: "<subject>", description: "the IdP subject (shown by `cotal login`) the actor belongs to; with list, only that subject's rows" },
      { name: "owner", type: "string", value: "<u_…>", description: "the derived owner token (alternative to --sub)" },
      { name: "full", type: "boolean", description: "grant: the full row - every ACL flag left off takes its wide default (all channels; scope spawn,role:default). Without it, grant needs --scope, --allow-subscribe and --allow-publish" },
      { name: "scope", type: "string", value: "<a,b>", description: "capability scope for the bearer, from admin, run, spawn, supervise and role:<r> (with --full: default spawn,role:default; '' = none; spawn = may run agents, role:<r> = may delegate role r)" },
      { name: "allow-subscribe", type: "string", value: "<a,b>", description: "channel read ACL (with --full: default > = all channels) - the user's envelope: their agents can never read beyond it" },
      { name: "allow-publish", type: "string", value: "<a,b>", description: "channel post ACL (with --full: default > = all channels) - also the envelope for their agents' posting" },
      { name: "role", type: "string", value: "<r>", description: "role (scopes the task-queue consumer)" },
      { name: "label", type: "string", value: "<l>", description: "display label for `actor list` (never the IdP subject)" },
      { name: "parent", type: "string", value: "<owner.actor>", description: "spawning principal audit link (operator grants are authority - this does not attenuate)" },
      jsonFlag, plainFlag,
    ],
    outputs: ["json", "plain"],
    validate: validateActorArguments,
    run: (args) => {
      validateActorArguments(args);
      return runActor(args, localAuthTarget(args.values as { space?: string }), "actor");
    },
  },
  agentBearerCommand,
  {
    kind: "command",
    name: "service-endpoint",
    group: "Identity",
    summary: "decide and inspect service endpoint registrations on this space's auth service - approve or refuse a proposal as its owner; bind a name as the operator",
    usage: "cotal service-endpoint <approve <proposalId> | refuse <proposalId> | proposal <proposalId> | operation <operationId> | name <endpoint> | name-bind <endpoint> --owner <u_…> --claim <ref>> [--caller-ceiling a,b] [--request-id <hex32>] [--space <s>] [--json|--plain]",
    positionals: "<approve <proposalId> | refuse <proposalId> | proposal <proposalId> | operation <operationId> | name <endpoint> | name-bind <endpoint>>",
    outputs: ["json", "plain"],
    flags: [
      jsonFlag, plainFlag, spaceFlag,
      { name: "owner", type: "string", value: "<u_…>", description: "name-bind: the derived owner token the name is bound to" },
      { name: "claim", type: "string", value: "<ref>", description: "name-bind: your claim reference for the namespace (the host verifies no domain control)" },
      { name: "caller-ceiling", type: "string", value: "<a,b>", description: "approve: capabilities the proposed commands declare, such as read; callers may be granted every command that declares one (default: none)" },
      { name: "request-id", type: "string", value: "<hex32>", description: "approve, refuse, name-bind: send the request an earlier run here recorded under this id again, as it was; the host replays its answer" },
    ],
    run: (args) => runServiceEndpoint(args, localAuthTarget(args.values as { space?: string })),
  },
  {
    kind: "command",
    name: "login",
    group: "Identity",
    summary: "sign in to a space's IdP (device code) and cache the session --idp <auth base URL> [--client-id <id>]",
    usage: "cotal login [--idp <auth base URL>] [--client-id <id>] [--plain]",
    prepareMeshTarget: false,
    outputs: ["plain"],
    validate: (args) => validateAccountArguments(args, "login"),
    flags: [
      plainFlag,
      { name: "idp", type: "string", value: "<auth base URL>", description: "Auth base URL, e.g. <origin>/api/auth" },
      { name: "client-id", type: "string", value: "<id>", description: "OAuth device-flow client id" },
    ],
    run: runLogin,
  },
  {
    kind: "command",
    name: "logout",
    group: "Identity",
    summary: "revoke the IdP session and clear the cached login --idp <auth base URL> [--local]",
    usage: "cotal logout [--idp <auth base URL>] [--local] [--json|--plain]",
    prepareMeshTarget: false,
    outputs: ["json", "plain"],
    validate: (args) => validateAccountArguments(args, "logout"),
    flags: [
      jsonFlag, plainFlag,
      { name: "idp", type: "string", value: "<auth base URL>", description: "Auth base URL, e.g. <origin>/api/auth" },
      { name: "local", type: "boolean", description: "forget this machine's cached login without contacting the provider; its session stays valid until it expires or is revoked there" },
    ],
    run: runLogout,
  },
];

const actorCommand = authCommands.find((command) => command.name === "actor");
if (!actorCommand?.flags) throw new Error("the native actor command must declare its shared authority flags");
const authFlagSources = [...actorCommand.flags.filter((flag) => !["space", "json", "plain"].includes(flag.name)), ...signerExportFlags, ...credentialMintFlags, { name: "yes", short: "y", type: "boolean" as const, description: "revoke-credential: revoke without a prompt; retire: explicit intent never bypasses the native caller/serve-gate requirement" }, spaceFlag, jsonFlag, plainFlag];
const authFlags = [...new Map(authFlagSources.map((flag) => [flag.name, flag])).values()] as readonly FlagSpec[];

function validateAuthArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  const [mode, actor, ...extra] = args.positionals;
  if (mode === "mint") { validateCredentialMintArguments({ ...args, positionals: args.positionals.slice(1) }); return; }
  if (mode === "revoke-credential") { validateCredentialRevokeArguments({ ...args, positionals: args.positionals.slice(1) }); return; }
  if (mode === "retire") {
    if (!actor || extra.length || Object.keys(args.values).some((key) => !["space", "yes", "json", "plain", "no-color", "no-input"].includes(key))) throw new CommandFailure("refused", "USAGE_INVALID", "use auth retire <full-lifecycle-uid> [--space <space>] [--yes] without actor, credential or grant selectors");
    try { assertLifecycleToken(actor); } catch { throw new CommandFailure("refused", "USAGE_INVALID", "auth retire needs one exact native lifecycle UID, 26 to 32 lowercase letters and digits; no alias or prefix was resolved", { remedy: "`cotal ps --wide` shows each seat's lifecycle uid" }); }
    return;
  }
  if (mode === "redeem") {
    if (!actor || extra.length || /[\u0000-\u001f\u007f]/u.test(actor) || Object.keys(args.values).some((key) => !["space", "json", "plain", "no-color", "no-input"].includes(key))) throw new CommandFailure("refused", "USAGE_INVALID", "use auth redeem <private-handle-file> [--space <space>] without signer, grant or credential-output flags");
    return;
  }
  if (mode === "handle") {
    if (actor !== "inspect" || extra.length !== 1 || !extra[0] || /[\u0000-\u001f\u007f]/u.test(extra[0])) throw new CommandFailure("refused", "USAGE_INVALID", "use auth handle inspect <private-file>");
    if (args.values.space !== undefined && (typeof args.values.space !== "string" || !args.values.space || args.values.space.length > 200 || /[\u0000-\u001f\u007f]/u.test(args.values.space))) throw new CommandFailure("refused", "USAGE_INVALID", "online handle inspection needs one bounded registered space name without terminal controls");
    if (Object.keys(args.values).some((key) => !["space", "json", "plain", "no-color", "no-input"].includes(key))) throw new CommandFailure("refused", "USAGE_INVALID", "handle inspection accepts no signer, grant, caller or mutation flags");
    return;
  }
  if (mode === "signer") {
    if (actor !== undefined || extra.length || Object.keys(args.values).some((key) => !["space", "out", "force", "json", "plain", "no-color", "no-input"].includes(key))) throw new CommandFailure("refused", "USAGE_INVALID", "use auth signer --out <private-file> [--space <space>] [--force] without actor or grant selectors");
    validateSignerExportInput(args.values);
    return;
  }
  if (mode === undefined) {
    if (Object.keys(args.values).some((key) => !GRANT_COMMON_FLAGS.includes(key))) throw new CommandFailure("refused", "USAGE_INVALID", "a flag does not belong to this auth action");
    return;
  }
  validateGrantUsage("auth", mode, actor, extra, args.values);
}

function validateActorArguments(args: ParsedArgs): void {
  const [mode, actor, ...extra] = args.positionals;
  validateGrantUsage("actor", mode, actor, extra, args.values);
}

const GRANT_COMMON_FLAGS: readonly string[] = ["space", "json", "plain", "no-color", "no-input"];

/** The usage of a grant read or change, `auth grants|grant|revoke` or the same verbs spelled
 *  `actor list|grant|revoke`. It runs before any authority is read, so a usage error is never
 *  reported as a capability refusal or a failure, and one refusal names every missing input. A grant
 *  or revoke on a space recorded as static or open refuses `UNSUPPORTED` before its inputs are
 *  checked, since no subject or ACL could make it apply.
 *  A grant is an upsert of the WHOLE row, so every field must be chosen: either all three ACL flags
 *  are named, or `--full` opts in to the wide default for the ones left off. Omission alone never
 *  means "everything": a dropped flag on a narrow reader grant would otherwise mint a space-wide row
 *  with a success line. The user's agents are still attenuated from whatever the row says (the
 *  envelope rule). */
function validateGrantUsage(command: "auth" | "actor", mode: string | undefined, actor: string | undefined, extra: readonly string[], flags: ParsedArgs["values"]): void {
  const list = command === "auth" ? "grants" : "list";
  // `actor label <actor> <label>` is the one verb with a second word.
  const labelling = command === "actor" && mode === "label";
  const labelForm = "cotal actor label <actor> --sub <IdP subject>|--owner <u_…> <label>";
  if (labelling && (!actor || extra.length !== 1))
    throw new CommandFailure("refused", "USAGE_INVALID", "actor label needs the actor and its new label", { remedy: labelForm });
  if ((extra.length && !labelling) || (mode !== list && mode !== "grant" && mode !== "revoke" && !labelling) || (mode === list ? actor !== undefined : !actor))
    throw new CommandFailure("refused", "USAGE_INVALID", grantUsage(command));
  const allowed = [...GRANT_COMMON_FLAGS, ...(mode === list ? ["sub"] : ["sub", "owner"]), ...(mode === "grant" ? ["scope", "allow-subscribe", "allow-publish", "role", "label", "parent", "full"] : [])];
  if (Object.keys(flags).some((key) => !allowed.includes(key))) throw new CommandFailure("refused", "USAGE_INVALID", `a flag does not belong to this ${command} action`);
  if (mode === list) {
    if (flags.sub === "") throw new CommandFailure("refused", "USAGE_INVALID", `${command} ${list} --sub is empty, so no subject's rows can be listed`, { remedy: `name the IdP subject \`cotal login\` prints: cotal ${command} ${list} --sub <IdP subject>`, selfContained: true });
    return;
  }
  // A static or open space has no ledger on any machine, so it refuses before this asks for a subject
  // or ACL it could never use.
  const ledgerless = ledgerlessTarget(flags as { space?: string });
  if (ledgerless) throw noLedger(ledgerless, mode === "grant" ? "no inert grant was written" : labelling ? "no label was written" : "nothing was revoked");
  const values = flags as { owner?: string; sub?: string; role?: string; parent?: string; scope?: string; full?: boolean; "allow-subscribe"?: string; "allow-publish"?: string };
  const problems: string[] = [];
  const omitted = mode === "grant" && !values.full ? (["scope", "allow-subscribe", "allow-publish"] as const).filter((flag) => values[flag] === undefined) : [];
  if (omitted.length) problems.push(`with ${omitted.map((flag) => `--${flag}`).join(", ")} left off: an omitted flag would be the WIDE default (scope spawn,role:default, read '>', post '>')`);
  if (values.owner === undefined && values.sub === undefined) problems.push("with no --sub <IdP subject> (shown by `cotal login`) or --owner <u_…> to say whose actor it is");
  else if (values.owner !== undefined && values.sub !== undefined) problems.push("with both --sub and --owner: choose one explicit authority target");
  else if (values.owner === "" || values.sub === "") problems.push("with an empty --sub or --owner");
  if (labelling && extra[0] === "") problems.push("with an empty label");
  if (problems.length)
    throw new CommandFailure("refused", "USAGE_INVALID", `refusing to ${mode} "${actor}" ${problems.join("; and ")}`, {
      remedy: mode === "grant" ? `say which grant you mean: ${grantForms(command)}` : labelling ? labelForm : `cotal ${command} revoke <actor> --sub <IdP subject>|--owner <u_…>`,
    });
  // Each input that does not hold is named with its field and reason, all in one refusal.
  const invalid: string[] = [];
  const check = (field: string, test: () => unknown) => {
    try { test(); } catch (error) { invalid.push(`${field}: ${(error as Error).message.replace(/\.$/, "")}`); }
  };
  check("the actor", () => assertValidOwnerToken(actor!));
  if (values.owner !== undefined) check("--owner", () => assertDerivedOwnerToken(values.owner!));
  if (values.role !== undefined) check("--role", () => assertValidRole(values.role!));
  if (values.parent !== undefined) check("--parent", () => {
    const parts = values.parent!.split(".");
    if (parts.length !== 2) throw new Error(`"${values.parent}" is not <owner>.<actor>`);
    assertDerivedOwnerToken(parts[0]!); assertValidOwnerToken(parts[1]!);
  });
  for (const flag of ["allow-subscribe", "allow-publish"] as const)
    for (const channel of csv(values[flag], [])) check(`--${flag}`, () => assertValidChannel(channel));
  const unknown = csv(values.scope, []).filter((scope) => !isGrantCapability(scope));
  if (unknown.length) invalid.push(`--scope: ${unknown.length === 1 ? "an unknown capability" : "unknown capabilities"} ${unknown.map((scope) => JSON.stringify(scope)).join(", ")}; the capabilities are ${GRANT_CAPABILITIES.join(", ")} and role:<role>`);
  if (invalid.length)
    throw new CommandFailure("refused", "USAGE_INVALID", `refusing to ${mode} "${actor}" with invalid input: ${invalid.join("; and ")}; no grant was changed`, {
      remedy: mode === "grant" ? `say which grant you mean: ${grantForms(command)}` : labelling ? labelForm : `cotal ${command} revoke <actor> --sub <IdP subject>|--owner <u_…>`,
    });
}

/** The ledger capabilities a grant's `--scope` may name, besides `role:<role>`: what the auth
 *  service, the manager and the views check a row's scope for. */
const GRANT_CAPABILITIES = ["admin", "run", "spawn", "supervise"] as const;

function isGrantCapability(scope: string): boolean {
  if ((GRANT_CAPABILITIES as readonly string[]).includes(scope)) return true;
  if (!scope.startsWith("role:")) return false;
  try { assertValidRole(scope.slice("role:".length)); return true; } catch { return false; }
}

/** The target when it resolves to a static or open space, which holds no actor ledger. A target that
 *  does not resolve is left to the run, which resolves it again and names its next step. */
function ledgerlessTarget(values: { space?: string }): AuthTarget | undefined {
  let target: AuthTarget;
  try { target = localAuthTarget(values); } catch { return undefined; }
  return target.mode === "auth" || target.mode === "open" ? target : undefined;
}

/** The root and space a local auth command reads, and the space's auth mode when it is recorded or
 *  found on disk. A prepared space that has not started has no mode yet. */
interface AuthTarget { root: string; space: string; mode?: MeshTarget["mode"] }

/** `auth retire <uid>` on a remote user-auth mesh that advertises an agent-provisioning endpoint:
 *  release that one lifecycle there with this machine's login, and report what the mesh answered.
 *  False when the selected mesh is not such a mesh, so the local path answers. */
async function retireOnRemoteMesh(args: ParsedArgs): Promise<boolean> {
  let mesh: MeshTarget;
  try { mesh = resolveMeshTarget(process.cwd(), { ...(args.values as { space?: string }), readOnly: true }); } catch { return false; }
  const ua = mesh.mode === "user" && mesh.userAuth?.remote ? mesh.userAuth : undefined;
  const url = ua?.endpoints?.agentProvisioningUrl;
  const provider = resolveAuthProvider();
  if (!ua || !url || !provider.releaseAgentLifecycle) return false;
  const lifecycleUid = args.positionals[1]!;
  const target = { space: mesh.space, lifecycleUid };
  const answer = await provider.releaseAgentLifecycle({ url, idpUrl: ua.idp.url, lifecycleUid });
  const who = answer.actor === undefined ? `lifecycle ${lifecycleUid}` : `lifecycle ${lifecycleUid} of "${answer.actor}"`;
  if (answer.outcome === "not-found")
    throw new CommandFailure("refused", "TARGET_NOT_FOUND", `the mesh lists no registration at lifecycle ${lifecycleUid}, so nothing was released`, { target, remedy: "`cotal ps --wide` shows each seat's lifecycle uid" });
  if (answer.outcome === "unknown")
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", `the mesh could not confirm the release of ${who} (HTTP ${answer.status}${answer.reason ? `: ${answer.reason}` : ""}); the release was not repeated`, { target, native: { detail: answer }, remedy: "run the same command again to ask the mesh once more" });
  writeResult(presentationOf(args.values), { command: "auth retire", target, result: answer, noOp: answer.outcome === "already-revoked" }, () => ({ sections: [{ title: answer.outcome === "revoked" ? "Lifecycle revoked" : "Already revoked", blocks: [{ kind: "lines", lines: [
    answer.outcome === "revoked" ? `The mesh revoked ${who}.` : `The mesh had already revoked ${who}.`,
    { text: "Its retirement may still be finishing; a spawn under that name waits for it.", tone: "hint" },
  ] }] }] }));
  return true;
}

function localAuthTarget(values: { space?: string }): AuthTarget {
  try { const target = resolveMeshTarget(process.cwd(), { ...values, readOnly: true }); return { root: target.root, space: target.space, mode: target.mode }; }
  catch (error) {
    if (isWorkspaceTargetError(error)) {
      if (error.code === "not-started" && error.details.root && error.details.space) return { root: error.details.root, space: error.details.space };
      // These commands take no --server, so the no-mesh step names only `cotal up`.
      const remedy = error.code === "no-meshes" ? "run `cotal up` in a project" : workspaceErrorParts({ kind: "target", error }).remedy;
      throw new CommandFailure("refused", targetErrorCode(error.code), "the selected space's local authority root could not be resolved; no different root was selected", remedy === undefined ? {} : { remedy });
    }
    throw error;
  }
}

async function authGroup(args: ParsedArgs): Promise<void> {
  validateAuthArguments(args);
  const mode = args.positionals[0];
  if (mode === "mint" || mode === "revoke-credential") {
    if (!registry.has("credential-action", mode)) throw new CommandFailure("refused", "UNSUPPORTED", `this composition has no registered native credential ${mode} action; no other implementation was substituted`);
    const action = registry.resolve<CredentialAction>("credential-action", mode);
    const request = { ...args, positionals: args.positionals.slice(1) };
    action.validate(request); return action.run(request);
  }
  if (mode === "retire") {
    if (await retireOnRemoteMesh(args)) return;
    const target = localAuthTarget(args.values as { space?: string });
    // Revoking the one credential keeps the store; rotating the space identity is the wider lever.
    throw new CommandFailure("refused", "UNSUPPORTED", "this CLI cannot retire a lifecycle: the registered auth endpoint accepts retirement only from the caller's own current serve identity and gate, so no request was sent", {
      target: { space: target.space, lifecycleUid: args.positionals[1] },
      remedy: `to stop one minted credential and keep the space's store: cotal down, then cotal auth revoke-credential <its creds file or public key> --yes, then cotal up. To stop every credential the space issued, rotate its identity: cotal down, then cotal reset space ${target.space} (or cotal clean all --force from the root when down left no registration), then cotal up. That reset also removes the space's store, with its ${storeContentsText(STORE_CONTENTS)}; cotal reset space ${target.space} --dry-run shows them first`,
    });
  }
  if (mode === "redeem") {
    const target = localAuthTarget(args.values as { space?: string });
    throw new CommandFailure("refused", "UNSUPPORTED", "the selected native auth path does not expose conferring-handle redemption; the file was not read, no one-use authority was spent and no credential was issued", {
      target: { space: target.space, redemption: "conferring-capability-handle" },
      remedy: "a parsed handle, session grant and agent enrollment are different authorities; none is substituted for a supported conferring-handle redemption path",
    });
  }
  if (mode === "handle") {
    const online = args.values.space === undefined ? undefined
      : await (await import("./handle-verification.js")).inspectHandleFileOnline(args.positionals[2]!, String(args.values.space));
    const result = online ?? inspectHandleFile(args.positionals[2]!);
    const readerCloseUnconfirmed = online !== undefined && !online.verification.readerClosed;
    writeResult(presentationOf(args.values), { command: "auth handle inspect", target: { path: result.path, ...("space" in result ? { space: result.space } : {}) }, result,
      ...(readerCloseUnconfirmed ? { completeness: "partial" as const, partial: { message: "The signature/registry reads completed, but the original reader's local closure was not confirmed; no credential was persisted or handle redeemed." }, warnings: [{ code: "READER_CLOSE_UNCONFIRMED", message: "Closing the original verification connection was not confirmed.", target: { path: result.path } }] } : {}) }, (data) => {
      const verified = "verification" in data;
      return { sections: [
        { title: verified ? "Online handle signature inspection" : "Unverified handle metadata", blocks: [
          { kind: "fields", rows: [["File", data.path], ["Presented artifacts", String(data.items.length)], ["Signatures", { text: verified ? "verified against native registry" : "not checked", tone: verified ? "ok" : "waiting" }], ["Revocation", verified ? "signers and required handle records checked" : "not checked"], ["Signature links and issuer scope", verified ? "verified" : "not checked"], ["Holder/process currency", "not checked"], ["Authority to use this handle", "not established"]] },
          { kind: "table", columns: [{ key: "id", label: "Declared handle" }, { key: "space", label: "Declared space" }, { key: "holder", label: "Declared holder" }, { key: "expiry", label: "Declared expiry" }], rows: data.items.map((item) => ({ id: item.id, space: item.declaredSpace, holder: `${item.holder.id} / ${item.holder.lifecycleUid}`, expiry: item.expiresAt ?? `${item.expiresAtMs} ms (outside display date range)` })) },
          { kind: "lines", lines: [{ text: verified ? "Native leader-served signer and required revocation records were read on one authenticated static connection. Signatures, issuer scope and presented chain links were checked, not presenter identity, live epochs or use authorization. Expiry observations remain separate. One ephemeral operator reader was minted without persisting it; no holder credential was conferred, handle redeemed or signature printed." : "Shape and local-clock metadata only. Claims are not authenticated, parent links are not verified and no capability was conferred or redeemed. Signature bytes and the signed artifact are omitted.", tone: "hint" }] },
        ] },
        { title: "Declared scope", blocks: [{ kind: "table", columns: [{ key: "handle", label: "Handle" }, { key: "endpoint", label: "Endpoint" }, { key: "instance", label: "Instance pin" }, { key: "commands", label: "Commands" }, { key: "reads", label: "Read subtrees" }], rows: data.items.flatMap((item) => item.grants.map((grant) => ({ handle: item.id, endpoint: grant.endpoint, instance: grant.instanceId ?? "not pinned", commands: grant.commands.map((command) => `${command.name} (${command.declaredMode})`).join(", "), reads: grant.reads.join(", ") || "none" }))).slice(0, 50) }, { kind: "lines", lines: [...(data.scopeRowCount > 50 ? [`${data.scopeRowCount - 50} scope rows are not shown; --json retains all public metadata, never signatures.`] : []), verified ? "These non-atomic registry observations grant no command or read authority and do not make this a usable presentation context." : "No broker or signer registry was read."] }] },
      ] };
    });
    return;
  }
  if (mode === "signer") {
    const result = await exportSpaceSigner(args.values);
    writeResult(presentationOf(args.values), { command: "auth signer", target: { space: result.space, path: result.path }, result, noOp: result.noOp }, (data) => ({ sections: [
      { title: data.noOp ? "Private signer already present" : "Private signer exported", blocks: [
        { kind: "fields", rows: [["Space", data.space], ["Account", data.account], ["Private output", data.path], ["Existing signer replaced", data.replaced ? "yes, after inspection" : "no"]] },
        { kind: "lines", lines: [{ text: "This file grants signing authority over the data account. It is not a least-privilege caller credential. Keep it private, mount it read-only when needed, and never attach it to logs or support bundles.", tone: "waiting" }, { text: "No operator root, caller credential or service was created, and no key was rotated. Secret contents were not printed.", tone: "hint" }] },
      ] },
    ] }));
    return;
  }
  if (mode !== undefined) {
    const target = localAuthTarget(args.values as { space?: string });
    return runActor({ ...args, positionals: [mode === "grants" ? "list" : mode, ...args.positionals.slice(1)] }, target, "auth");
  }
  let accounts: ReturnType<typeof listIdpAccounts>;
  try { accounts = listIdpAccounts(homeCotalDir()); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "cached account metadata could not be read; nothing was reset"); }
  const items = accounts.map((account) => {
    const expiry = new Date(account.expiresAt * 1000);
    return { provider: account.idp, subject: account.sub ?? null, cachedExpiry: account.expiresAt, cachedExpiryIso: Number.isFinite(expiry.getTime()) ? expiry.toISOString() : null, cachedExpiryPassed: account.expiresAt * 1000 <= Date.now(), verification: "not-checked" };
  });
  // The Next lines name a real space: the requested one, else the one a bare command resolves. With
  // none, they point to the space list rather than print an unfilled `--space`.
  let space = args.values.space as string | undefined;
  if (space === undefined) {
    try { space = resolveMeshTarget(process.cwd(), { readOnly: true }).space; }
    catch (error) { if (!isWorkspaceTargetError(error)) throw error; }
  }
  const spaceSteps = space === undefined
    ? [{ command: "cotal space", description: "See registered spaces and choose one" }]
    : [{ command: `cotal whoami --space ${space}`, description: "Resolve the selected space's actual CLI caller" }, { command: `cotal auth grants --space ${space}`, description: "Read the locally authoritative actor ledger" }];
  writeResult(presentationOf(args.values), { command: "auth", target: { requestedSpace: args.values.space ?? null }, result: { kind: "account-cache", items, liveAuthorization: "not-checked" } }, (result) => ({ sections: [
    { title: "Cached accounts", blocks: [result.items.length ? { kind: "table", columns: [{ key: "provider", label: "Provider" }, { key: "subject", label: "Account subject" }, { key: "expiry", label: "Cached expiry" }, { key: "state", label: "Cache state" }], rows: result.items.map((account) => ({ provider: account.provider, subject: account.subject ?? "not cached", expiry: account.cachedExpiryIso ?? "not representable", state: account.cachedExpiryPassed ? "expiry passed" : "not verified online" })) } : { kind: "lines", lines: ["No cached provider accounts."] }, { kind: "lines", lines: [{ text: "Cache metadata only. A sign-in is not a space grant and this view does not prove current session validity or live authorization. Tokens and grant secrets are not printed.", tone: "hint" }] }] },
    { title: "Next", blocks: [{ kind: "commands", items: [...spaceSteps, { command: "cotal login", description: "Choose a provider and approve sign-in" }] }] },
  ] }));
}

const authCommand: Command = {
  kind: "command", name: "auth", group: "Identity",
  positionals: "[grants | grant <actor> | revoke <actor> | signer | mint <name> | revoke-credential <key | file> | handle inspect <file> | redeem <file> | retire <lifecycle-uid>]",
  summary: "inspect account metadata, manage actor grants and export a protected account signer",
  usage: "cotal auth [grants | grant <actor> | revoke <actor> | signer --out <private-file> | mint <name> | revoke-credential <key | file> | handle inspect <file> | redeem <file> | retire <lifecycle-uid>] [--space <s>] [--json|--plain]",
  flagNames: ["space", "json", "plain"],
  flags: authFlags, outputs: ["json", "plain"], reads: true, prepareMeshTarget: false,
  subcommands: ([
    { name: "mint", flagNames: credentialMintFlags.map((flag) => flag.name), summary: "write a fixed-profile or supported endpoint caller credential privately", usage: "cotal auth mint <name> [--profile agent|observer|admin] [--out <private-file>] | <name> --endpoint <class> --out <private-file> [--channels <a,b>]", prepareMeshTarget: false },
    { name: "revoke-credential", flagNames: ["space", "yes", "json", "plain"], summary: "stop one static credential by its public key or creds file on a stopped stack; the broker refuses it from the next up", usage: "cotal auth revoke-credential <public-key | creds-file> [--space <space>] [--yes]", prepareMeshTarget: false },
    { name: "handle", flagNames: ["space", "json", "plain"], summary: "inspect protected claims or static-registry signatures without conferring authority", usage: "cotal auth handle inspect <private-file> [--space <space>] [--json|--plain]", reads: true, prepareMeshTarget: false, subcommands: [{ name: "inspect", flagNames: ["space", "json", "plain"], summary: "offline metadata; --space checks native static signer/revocation records", usage: "cotal auth handle inspect <private-file> [--space <space>] [--json|--plain]", reads: true, prepareMeshTarget: false, outputs: ["json", "plain"] }] },
    { name: "retire", flagNames: ["space", "yes", "json", "plain"], summary: "not available from this CLI; revoke-credential stops one minted credential, and rotating the space identity with reset space stops all of them and removes its store", usage: "cotal auth retire <full-lifecycle-uid> [--space <space>] [--yes]", prepareMeshTarget: false },
    { name: "redeem", flagNames: ["space", "json", "plain"], summary: "conferring-handle redemption requires a supported native auth path", usage: "cotal auth redeem <private-handle-file> [--space <space>]", prepareMeshTarget: false },
    { name: "signer", flagNames: ["space", "out", "force", "json", "plain"], summary: "export existing account-signing material to a protected private file", usage: "cotal auth signer --out <private-file> [--force]", prepareMeshTarget: false },
    { name: "grants", flagNames: ["space", "sub", "json", "plain"], summary: "read the authoritative local actor grants, not cached sign-in claims", usage: "cotal auth grants [--sub <IdP subject>] [--space <space>] [--json|--plain]", reads: true, prepareMeshTarget: false },
    { name: "grant", flagNames: ["space", "sub", "owner", "scope", "allow-subscribe", "allow-publish", "role", "label", "parent", "full", "json", "plain"], summary: "store a deliberate operator grant through the existing authority path", usage: "cotal auth grant <actor>", prepareMeshTarget: false },
    { name: "revoke", flagNames: ["space", "sub", "owner", "json", "plain"], summary: "retire and revoke an interactive actor grant under its existing authority", usage: "cotal auth revoke <actor>", prepareMeshTarget: false },
  ] as const).map((sub) => ({ ...sub, outputs: ["json", "plain"] as const })),
  validate: validateAuthArguments, run: authGroup,
};

const daemonAuthService = authCommands.find((command) => command.name === "__daemon-auth-service")!;
registry.register(...authCommands, deprecatedDaemonEntry("auth-service", daemonAuthService), authCommand);
