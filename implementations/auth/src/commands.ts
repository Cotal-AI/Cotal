import { authServiceFlags } from "./daemon-flags.js";
import { randomBytes } from "node:crypto";
import type { EpCapability } from "@cotal-ai/core";
import { postServiceEndpointHost, type ServiceHostRouteRequest } from "./service-host-client.js";
import type { ServiceHostInputs, ServiceHostOperation, ServiceHostResult } from "./service-host-contract.js";
/**
 * Self-registering `login` / `logout` commands (the delivery-daemon pattern): importing
 * `@cotal-ai/auth` registers them into the core `Registry`, and the `cotal` binary pulls the
 * package in at its composition root. Session state lives under the workspace's `homeCotalDir()`
 * (`~/.cotal`, `COTAL_HOME`-overridable) — per human, per machine, NOT per checkout: you are
 * logged in as YOU across every repo on this box.
 */
import { readFileSync } from "node:fs";
import * as prompts from "@clack/prompts";
import { assertDerivedOwnerToken, assertLifecycleToken, assertValidChannel, assertValidOwnerToken, assertValidRole, isLoopbackLiteral, registry, resolveAuthProvider, resolveSpaceCatalogConsumer, writePrivateRecord, type Command, type FlagSpec, type ParsedArgs, type SecretStore } from "@cotal-ai/core";
import { CommandFailure, credentialMintFlags, validateCredentialMintArguments, exportSpaceSigner, signerExportFlags, validateSignerExportInput, inputDisabledByFlag, isWorkspaceTargetError, resolveMeshTarget, targetErrorCode, spaceFlag, isCommandFailure, oneLine, jsonFlag, plainFlag, presentationOf, renderReport, terminalWidth, writeResult, CLI_USER_ACTOR, findCotalRoot, getSpaceAuth, homeCotalDir, loadMeshes, probeLiveness, removeCatalogMeshes, untilInputEnds, userAuthStateDir, deprecatedDaemonEntry, workspaceErrorParts, workspaceSecretStore, type AgentAuthHealth, type CredentialAction, type MeshTarget, type RefusalCode } from "@cotal-ai/workspace";
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
  const body = await response.json().catch(() => ({})) as { error?: string; outcome?: unknown; retired?: unknown; lifecycleUid?: unknown; alreadyRetired?: unknown };
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
    if (provider.hasSpaceCatalog?.({ dir: homeCotalDir(), idpUrl: idp, sub })) {
      const consumer = resolveSpaceCatalogConsumer();
      await provider.syncSpaceCatalogAfterLogin?.({ dir: homeCotalDir(), idpUrl: idp, validate: consumer.validate, apply: consumer.apply });
    }
    // WHO signed in must be human-readable (per-user auth exists for operator-visible identity):
    // prefer the IdP's email/name claim; the raw `sub` stays as the stable id (dim when secondary).
    console.log(renderReport({ sections: [
      { title: "Signed in", blocks: [{ kind: "fields", rows: [["Account", label || sub], ["Subject", sub], ["Provider", idp], ["Session expires", new Date(session.expiresAt * 1000).toISOString()]] }, { kind: "lines", lines: [{ text: "Account identity is verified. Each space's grants decide access separately. No session token is printed.", tone: "hint" }] }] },
      { title: "Next", blocks: [{ kind: "commands", items: [{ command: "cotal space", description: "See registered spaces and choose one" }, { command: "cotal sync", description: "Refresh spaces the provider makes available to this account" }] }] },
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
  try { await revokeIdpSession(idp, session.token); }
  catch { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "server-side session revocation was not confirmed; the local login is kept so it can be retried", { target: { idp }, remedy: "retry logout for this provider, or revoke the session at the provider" }); }
  let localCleared = false;
  let removed: string[] = [];
  try {
    deleteIdpSession(dir, idp);
    localCleared = true;
    if (session.sub) removed = removeCatalogMeshes(deleteIdpSpaceCatalog(dir, idp, session.sub));
  } catch {
    throw new CommandFailure("partial", "OPERATION_PARTIAL", localCleared ? "the server session was revoked and the cached login cleared, but discovered-space cleanup was not confirmed" : "the server session was revoked, but local cleanup was not confirmed", { target: { idp }, changed: [{ kind: "idp-session", idp, revoked: true }, ...(localCleared ? [{ kind: "local-login", idp, cleared: true }] : [])] });
  }
  writeResult(presentation, { command: "logout", target: { idp }, result: { kind: "logout", serverRevoked: true, localLoginCleared: true, removedRegistrations: removed } }, (result) => ({ sections: [
    { title: "Signed out", blocks: [{ kind: "fields", rows: [["Provider", idp], ["Provider session", { text: "revoked", tone: "ok" }], ["Local login", "cleared"], ["Discovered spaces removed", String(result.removedRegistrations.length)]] }, { kind: "lines", lines: [{ text: "This does not claim that independently running agents or other provider sessions were stopped.", tone: "hint" }] }] },
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
  command === "auth" ? "use auth, auth grants, auth grant <actor>, or auth revoke <actor>" : "use actor list, actor grant <actor>, or actor revoke <actor>";

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
  return { owner: row.owner, actor: row.actor, kind: row.kind, role: row.role ?? null, label: row.label ?? null, scope: row.scope, allowSubscribe: row.allowSubscribe, allowPublish: row.allowPublish };
}

function grantView(space: string, rows: readonly ReturnType<typeof publicActor>[]) {
  return { sections: [{ title: "Recorded actor grants", blocks: [
    { kind: "fields" as const, rows: [["Space", space], ["Source", "local authoritative actor ledger"]] as [string, string][] },
    rows.length ? { kind: "table" as const, columns: [{ key: "principal", label: "Principal" }, { key: "kind", label: "Kind" }, { key: "scope", label: "Capabilities" }, { key: "read", label: "May read" }, { key: "post", label: "May post" }], rows: rows.map((row) => ({ principal: `${row.owner}.${row.actor}`, kind: row.kind ?? "not recorded", scope: row.scope.join(", ") || "none", read: row.allowSubscribe.join(", ") || "none", post: row.allowPublish.join(", ") || "none" })) } : { kind: "lines" as const, lines: ["No rows in this authoritative ledger snapshot."] },
    { kind: "lines" as const, lines: [{ text: "Recorded grants are not proof of current connections, task progress or the authority of a cached account session.", tone: "hint" as const }] },
  ] }] };
}

const SERVICE_ENDPOINT_USAGE = "service-endpoint <approve <proposalId> | refuse <proposalId> | proposal <proposalId> | operation <operationId> | name <endpoint> | name-bind <endpoint> --owner <u_…> --claim <ref>>";

/** One host request over the authenticated `/service-endpoint-host` route, as the signed-in owner
 *  or, for `name-bind`, as the operator on the loopback face. A decision reads the proposal first,
 *  with the name binding that read carries, and decides at those revisions, so a proposal or name
 *  that moved in between is a conflict the host reports, never a decision on something else. */
async function runServiceEndpoint(args: ParsedArgs, target: AuthTarget): Promise<void> {
  const [sub, subject, ...extra] = args.positionals;
  const values = args.values as { owner?: string; claim?: string; "caller-ceiling"?: string };
  const { dir, space } = actorState(target);
  const presentation = presentationOf(args.values);
  const request = <K extends ServiceHostOperation>(operation: K, input: ServiceHostInputs[K]): ServiceHostRouteRequest<K> =>
    ({ v: 1, kind: "service-endpoint-host", requestId: randomBytes(16).toString("hex"), operation, input });
  const post = (r: ServiceHostRouteRequest) => postServiceEndpointHost(dir, space, r, `service-endpoint ${sub}`);
  const usage = () => new CommandFailure("refused", "USAGE_INVALID", SERVICE_ENDPOINT_USAGE);
  await legibly(async () => {
    if (!sub || !subject || extra.length) throw usage();
    let answer: ServiceHostResult;
    switch (sub) {
      case "approve": case "refuse": {
        const read = await post(request("proposal-read", { proposalId: subject })) as ServiceHostResult & { record?: { value: { nameBinding: { revision: number } | null }; revision: number } };
        if (read.state !== "present" || read.record === undefined)
          throw new CommandFailure("refused", "TARGET_NOT_FOUND", `no proposal ${subject} is yours to decide on space "${space}"; nothing was decided`);
        const callerCeiling = (values["caller-ceiling"] ?? "").split(",").map((c) => c.trim()).filter(Boolean) as unknown as EpCapability[];
        answer = await post(request("decide", {
          proposalId: subject, expectedProposalRevision: read.record.revision,
          expectedNameRevision: read.record.value.nameBinding?.revision ?? 0,
          decision: sub, callerCeiling,
        }));
        break;
      }
      case "proposal": answer = await post(request("proposal-read", { proposalId: subject })); break;
      case "operation": answer = await post(request("operation-read", { operationId: subject })); break;
      case "name": answer = await post(request("name-read", { endpoint: subject })); break;
      case "name-bind": {
        if (!values.owner || !values.claim) throw usage();
        answer = await post(request("name-bind", { endpoint: subject, owner: values.owner, expectedRevision: 0, claimReference: values.claim }));
        break;
      }
      default: throw usage();
    }
    writeResult(presentation, { command: "service-endpoint", target: { space }, result: { kind: "service-endpoint-host", request: sub, subject, answer } }, (result) => ({
      space,
      sections: [{ title: `Service endpoint ${result.request}`, blocks: [
        { kind: "fields" as const, rows: [["Space", space], ["Subject", result.subject], ["State", String((result.answer as { state: string }).state)]] as [string, string][] },
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
      const items = loadActorLedger(dir).sort((a, b) => (a.owner + a.actor).localeCompare(b.owner + b.actor)).map(publicActor);
      writeResult(presentationOf(args.values), { command, target: { space }, result: { kind: "actor-grants", items } }, (result) => grantView(space, result.items));
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
      const result = { kind: "actor-grant", grant: publicActor({ ...row, kind: "interactive" }), fullOptionExplicit: values.full === true };
      writeResult(presentationOf(args.values), { command, target: { space, owner: row.owner, actor: row.actor }, result }, (data) => ({ sections: [
        { title: "Actor grant stored", blocks: [{ kind: "fields", rows: [["Principal", `${data.grant.owner}.${data.grant.actor}`], ["Space", space], ["Capabilities", data.grant.scope.join(", ") || "none"], ["May read", data.grant.allowSubscribe.join(", ") || "none"], ["May post", data.grant.allowPublish.join(", ") || "none"], ["Wide defaults requested", data.fullOptionExplicit ? "explicit --full" : "no"]] }, { kind: "lines", lines: [{ text: "The local authority stored this grant. No process was launched and no cached login was treated as a grant.", tone: "hint" }] }] },
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

/** Record one `agent-bearer` attempt in the manager-composed health file, 0o600 and never through a
 *  symlink ({@link writePrivateRecord}). */
export function writeAgentAuthHealth(path: string, state: "ok" | "failed", reason?: string): void {
  writePrivateRecord(path, JSON.stringify({ state, at: new Date().toISOString(), ...(reason ? { reason } : {}) } satisfies AgentAuthHealth));
}

/** `cotal agent-bearer` — the ONE thing a spawned user-mode agent execs to refresh its auth: read
 *  its spawn-time secret from the 0600 token file, exchange it at the space's auth service (agent
 *  grant type), print the fresh bearer to STDOUT, exit. Machine-facing: stdout carries the bearer
 *  and NOTHING else; every failure is a stderr sentence + exit 1 (the endpoint surfaces it as a
 *  loud "error" event and retries). The secret rides a file, never argv (ps-visible) or env. */
async function runAgentBearer(args: ParsedArgs): Promise<void> {
  const v = args.values as {
    dir?: string; space?: string; owner?: string; actor?: string;
    "token-file"?: string; "health-file"?: string; "exchange-url"?: string;
    "manager-call"?: boolean; "manager-instance"?: string;
  };
  const { dir, space, owner, actor } = v;
  const tokenFile = v["token-file"];
  if (!space || !owner || !actor || !tokenFile || (!dir && !v["exchange-url"]))
    throw new Error("usage: cotal agent-bearer [--dir <state-dir> | --exchange-url <https://base>] --space <s> --owner <u_…> --actor <a> --token-file <path> [--health-file <path>]");
  // Every attempt's outcome lands in the manager-composed health file (core's AgentAuthHealth) —
  // the `ps` window into a detached agent's bearer life. Best-effort: health reporting must never
  // turn a successful exchange into a failure.
  const managerCall = v["manager-call"] === true;
  if (v["manager-instance"] !== undefined && !managerCall)
    throw new Error("agent-bearer: --manager-instance requires --manager-call");
  const managerInstance = v["manager-instance"] === undefined
    ? undefined
    : assertLifecycleToken(v["manager-instance"], "manager instance");
  const health = (state: "ok" | "failed", reason?: string) => {
    if (managerCall) return;
    const path = v["health-file"];
    if (!path) return;
    try {
      writeAgentAuthHealth(path, state, reason);
    } catch { /* the exchange outcome still stands */ }
  };
  try {
    let actorToken: string;
    try {
      actorToken = readFileSync(tokenFile, "utf8").trim();
    } catch (e) {
      throw new Error(`agent-bearer: can't read the actor token file at ${tokenFile} (${e instanceof Error ? e.message : String(e)}) - respawn this agent to re-provision it`);
    }
    const remote = v["exchange-url"];
    let exchangeUrl: string;
    let headers: Record<string, string> = { "content-type": "application/json" };
    if (remote) {
      let u: URL;
      try { u = new URL(remote); }
      catch { throw new Error(`agent-bearer: --exchange-url is not a URL (got ${JSON.stringify(remote)})`); }
      // Match the remote-registration and enrollment transport rule: HTTPS, except a loopback HTTP
      // literal where the actor token never leaves this machine. Names such as localhost get no
      // exception because name resolution chooses where the credential goes.
      if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopbackLiteral(u.hostname)))
        throw new Error(`agent-bearer: --exchange-url must be https://, except for a loopback HTTP literal (got ${u.protocol}//) - the actor token must never cross plaintext off this machine`);
      u.pathname = `${u.pathname.replace(/\/$/, "")}/exchange`;
      u.search = "";
      u.hash = "";
      exchangeUrl = u.toString();
    } else {
      const info = loadAuthServiceInfo(dir!);
      // Proof required: only `alive` counts as running. The old two-state probe called EPERM dead, so
      // a service running as ANOTHER USER produced "not running - restart it with `cotal up`" about a
      // service that was up the whole time; the contract resolves EPERM to alive and fixes exactly
      // that. `unknown` still refuses, because telling an operator to talk to an endpoint whose
      // liveness cannot be established is worse than telling them to restart.
      const svc = info === undefined ? "absent" : probeLiveness(info.pid);
      if (svc === "unknown")
        throw new Error(
          `agent-bearer: the user-auth service for space "${space}" records pid ${info!.pid}, whose liveness cannot be determined - the kernel answered neither "running" nor "no such process" (a seccomp filter or LSM policy does this inside some sandboxes). Refusing rather than reporting it down: verify with \`ps -p ${info!.pid}\` before restarting anything.`,
        );
      if (svc !== "alive" || info === undefined)
        throw new Error(`agent-bearer: the user-auth service for space "${space}" is not running - restart it with \`cotal up\``);
      exchangeUrl = `${info.url}/exchange`;
      headers = { ...headers, authorization: `Bearer ${info.cap}` };
    }
    let res: Response;
    try {
      res = await fetch(exchangeUrl, {
        method: "POST",
        headers,
        redirect: "manual",
        body: JSON.stringify({
          owner,
          actor,
          actorToken,
          ...(managerCall ? { view: "manager-caller", ...(managerInstance !== undefined ? { managerInstanceId: managerInstance } : {}) } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new Error(
        remote
          ? `agent-bearer: the pinned exchange did not answer at ${exchangeUrl} (${e instanceof Error ? e.message : String(e)})`
          : `agent-bearer: the user-auth service did not answer at ${exchangeUrl.replace(/\/exchange$/, "")} (${e instanceof Error ? e.message : String(e)}) - restart it with \`cotal up\``,
      );
    }
    if (res.status >= 300 && res.status < 400)
      throw new Error(`agent-bearer: the pinned exchange answered ${res.status} with redirect Location ${JSON.stringify(res.headers.get("location") ?? "")} - redirects are refused so an HTTPS pin cannot walk the actor token onto plaintext or another host`);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(`agent-bearer: exchange refused: ${body.error ?? `HTTP ${res.status}`}`);
    }
    const out = (await res.json().catch(() => ({}))) as { token?: string };
    if (typeof out.token !== "string" || !out.token)
      throw new Error("agent-bearer: the auth service's exchange returned no token - its build may be stale; restart it with `cotal up`");
    health("ok");
    process.stdout.write(`${out.token}\n`);
  } catch (e) {
    health("failed", e instanceof Error ? e.message : String(e));
    throw e;
  }
}

const authCommands: Command[] = [
  {
    kind: "command",
    // The auth daemon `up` launches. `auth-service` is the same entry for persisted callers, plus the
    // deprecation warning; help and completion list neither.
    name: "__daemon-auth-service",
    hidden: true,
    group: "Manager",
    summary: "run the user-auth service daemon - NATS auth callout + token exchange/JWKS --space <s> --server <url> [--port <n>]",
    flags: [...authServiceFlags],
    prepareMeshTarget: false,
    run: (args) => legibly(() => runAuthService(args)),
  },
  {
    kind: "command",
    name: "actor",
    group: "Identity",
    summary: "manage the space's actor ledger - grant/revoke which (user, actor) pairs may run agents",
    usage: "actor <grant <actor> | revoke <actor> | list> [--sub <IdP subject>|--owner <u_…>] [--space <s>] [--full | --scope a,b --allow-subscribe a,b --allow-publish a,b] [--role r] [--label l]",
    positionals: "<grant <actor> | revoke <actor> | list>",
    flags: [
      { name: "space", type: "string", value: "<s>", description: "space whose ledger to manage (default: the resolved mesh, as for auth grants)" },
      { name: "sub", type: "string", value: "<subject>", description: "the IdP subject (shown by `cotal login`) the actor belongs to" },
      { name: "owner", type: "string", value: "<u_…>", description: "the derived owner token (alternative to --sub)" },
      { name: "full", type: "boolean", description: "grant: the full row - every ACL flag left off takes its wide default (all channels; scope spawn,role:default). Without it, grant needs --scope, --allow-subscribe and --allow-publish" },
      { name: "scope", type: "string", value: "<a,b>", description: "capability scope for the bearer (with --full: default spawn,role:default; '' = none; spawn = may run agents, role:<r> = may delegate role r)" },
      { name: "allow-subscribe", type: "string", value: "<a,b>", description: "channel read ACL (with --full: default > = all channels) - the user's envelope: their agents can never read beyond it" },
      { name: "allow-publish", type: "string", value: "<a,b>", description: "channel post ACL (with --full: default > = all channels) - also the envelope for their agents' posting" },
      { name: "role", type: "string", value: "<r>", description: "role (scopes the task-queue consumer)" },
      { name: "label", type: "string", value: "<l>", description: "display label for `actor list` (never the IdP subject)" },
      { name: "parent", type: "string", value: "<owner.actor>", description: "spawning principal audit link (operator grants are authority - this does not attenuate)" },
    ],
    validate: validateActorArguments,
    run: (args) => {
      validateActorArguments(args);
      return runActor(args, localAuthTarget(args.values as { space?: string }), "actor");
    },
  },
  {
    kind: "command",
    name: "agent-bearer",
    group: "Manager",
    summary: "print one fresh agent bearer for a spawned user-mode agent (machine-facing; exec'd by agent endpoints)",
    usage: "agent-bearer [--dir <state-dir> | --exchange-url <https://base>] --space <s> --owner <u_…> --actor <a> --token-file <path>",
    flags: [
      { name: "dir", type: "string", value: "<state-dir>", description: "local arm: the space's user-auth state dir" },
      { name: "exchange-url", type: "string", value: "<https://base>", description: "remote arm: pinned public exchange base URL (HTTPS required; no local capability)" },
      { name: "space", type: "string", value: "<s>", description: "the space the bearer is scoped to" },
      { name: "owner", type: "string", value: "<u_…>", description: "the agent's owner token" },
      { name: "actor", type: "string", value: "<a>", description: "the agent's actor token" },
      { name: "token-file", type: "string", value: "<path>", description: "0600 file holding the spawn-time agent secret" },
      { name: "health-file", type: "string", value: "<path>", description: "write each attempt's outcome here (read by the manager's ps)" },
      { name: "manager-call", type: "boolean", description: "mint a token bound to one manager instance" },
      { name: "manager-instance", type: "string", value: "<id>", description: "select the manager instance for --manager-call" },
    ],
    run: (args) => legibly(() => runAgentBearer(args)),
  },
  {
    kind: "command",
    name: "service-endpoint",
    group: "Identity",
    summary: "decide and inspect service endpoint registrations on this space's auth service - approve or refuse a proposal as its owner; bind a name as the operator",
    usage: "service-endpoint <approve <proposalId> | refuse <proposalId> | proposal <proposalId> | operation <operationId> | name <endpoint> | name-bind <endpoint> --owner <u_…> --claim <ref>> [--caller-ceiling a,b] [--space <s>] [--json|--plain]",
    positionals: "<approve <proposalId> | refuse <proposalId> | proposal <proposalId> | operation <operationId> | name <endpoint> | name-bind <endpoint>>",
    outputs: ["json", "plain"],
    flags: [
      jsonFlag, plainFlag, spaceFlag,
      { name: "owner", type: "string", value: "<u_…>", description: "name-bind: the derived owner token the name is bound to" },
      { name: "claim", type: "string", value: "<ref>", description: "name-bind: your claim reference for the namespace (the host verifies no domain control)" },
      { name: "caller-ceiling", type: "string", value: "<a,b>", description: "approve: the capability ceiling callers of this service may be granted (default: none)" },
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
    summary: "revoke the IdP session and clear the cached login --idp <auth base URL>",
    usage: "cotal logout [--idp <auth base URL>] [--json|--plain]",
    prepareMeshTarget: false,
    outputs: ["json", "plain"],
    validate: (args) => validateAccountArguments(args, "logout"),
    flags: [
      jsonFlag, plainFlag,
      { name: "idp", type: "string", value: "<auth base URL>", description: "Auth base URL, e.g. <origin>/api/auth" },
    ],
    run: runLogout,
  },
];

const actorCommand = authCommands.find((command) => command.name === "actor");
if (!actorCommand?.flags) throw new Error("the native actor command must declare its shared authority flags");
const authFlagSources = [...actorCommand.flags.filter((flag) => flag.name !== "space"), ...signerExportFlags, ...credentialMintFlags, { name: "yes", short: "y", type: "boolean" as const, description: "retire: explicit intent never bypasses the native caller/serve-gate requirement" }, spaceFlag, jsonFlag, plainFlag];
const authFlags = [...new Map(authFlagSources.map((flag) => [flag.name, flag])).values()] as readonly FlagSpec[];

function validateAuthArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  const [mode, actor, ...extra] = args.positionals;
  if (mode === "mint") { validateCredentialMintArguments({ ...args, positionals: args.positionals.slice(1) }); return; }
  if (mode === "retire") {
    if (!actor || extra.length || Object.keys(args.values).some((key) => !["space", "yes", "json", "plain", "no-color", "no-input"].includes(key))) throw new CommandFailure("refused", "USAGE_INVALID", "use auth retire <full-lifecycle-uid> [--space <space>] [--yes] without actor, credential or grant selectors");
    try { assertLifecycleToken(actor); } catch { throw new CommandFailure("refused", "USAGE_INVALID", "auth retire needs one exact native lifecycle UID; no alias or prefix was resolved"); }
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
 *  `actor list|grant|revoke`. It runs before any target or authority is read, so a usage error is
 *  never reported as a capability refusal or a failure, and one refusal names every missing input.
 *  A grant is an upsert of the WHOLE row, so every field must be chosen: either all three ACL flags
 *  are named, or `--full` opts in to the wide default for the ones left off. Omission alone never
 *  means "everything": a dropped flag on a narrow reader grant would otherwise mint a space-wide row
 *  with a success line. The user's agents are still attenuated from whatever the row says (the
 *  envelope rule). */
function validateGrantUsage(command: "auth" | "actor", mode: string | undefined, actor: string | undefined, extra: readonly string[], flags: ParsedArgs["values"]): void {
  const list = command === "auth" ? "grants" : "list";
  if (extra.length || (mode !== list && mode !== "grant" && mode !== "revoke") || (mode === list ? actor !== undefined : !actor))
    throw new CommandFailure("refused", "USAGE_INVALID", grantUsage(command));
  const allowed = [...GRANT_COMMON_FLAGS, ...(mode === list ? [] : ["sub", "owner"]), ...(mode === "grant" ? ["scope", "allow-subscribe", "allow-publish", "role", "label", "parent", "full"] : [])];
  if (Object.keys(flags).some((key) => !allowed.includes(key))) throw new CommandFailure("refused", "USAGE_INVALID", `a flag does not belong to this ${command} action`);
  if (mode === list) return;
  const values = flags as { owner?: string; sub?: string; role?: string; parent?: string; scope?: string; full?: boolean; "allow-subscribe"?: string; "allow-publish"?: string };
  const problems: string[] = [];
  const omitted = mode === "grant" && !values.full ? (["scope", "allow-subscribe", "allow-publish"] as const).filter((flag) => values[flag] === undefined) : [];
  if (omitted.length) problems.push(`with ${omitted.map((flag) => `--${flag}`).join(", ")} left off: an omitted flag would be the WIDE default (scope spawn,role:default, read '>', post '>')`);
  if (values.owner === undefined && values.sub === undefined) problems.push("with no --sub <IdP subject> (shown by `cotal login`) or --owner <u_…> to say whose actor it is");
  else if (values.owner !== undefined && values.sub !== undefined) problems.push("with both --sub and --owner: choose one explicit authority target");
  else if (values.owner === "" || values.sub === "") problems.push("with an empty --sub or --owner");
  if (problems.length)
    throw new CommandFailure("refused", "USAGE_INVALID", `refusing to ${mode} "${actor}" ${problems.join("; and ")}`, {
      remedy: mode === "grant" ? `say which grant you mean: ${grantForms(command)}` : `cotal ${command} revoke <actor> --sub <IdP subject>|--owner <u_…>`,
    });
  try {
    assertValidOwnerToken(actor!);
    if (values.owner !== undefined) assertDerivedOwnerToken(values.owner);
    if (values.role !== undefined) assertValidRole(values.role);
    if (values.parent !== undefined) {
      const parts = values.parent.split(".");
      if (parts.length !== 2) throw new Error();
      assertDerivedOwnerToken(parts[0]!); assertValidOwnerToken(parts[1]!);
    }
    for (const channel of [...csv(values["allow-subscribe"], []), ...csv(values["allow-publish"], [])]) assertValidChannel(channel);
    if (csv(values.scope, []).some((scope) => !/^[A-Za-z0-9_:-]+$/.test(scope))) throw new Error();
  } catch { throw new CommandFailure("refused", "USAGE_INVALID", "invalid actor, owner, parent, role, scope or channel-pattern input; no grant was changed"); }
}

/** The root and space a local auth command reads, and the space's auth mode when it is recorded or
 *  found on disk. A prepared space that has not started has no mode yet. */
interface AuthTarget { root: string; space: string; mode?: MeshTarget["mode"] }

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
  if (mode === "mint") {
    if (!registry.has("credential-action", "mint")) throw new CommandFailure("refused", "UNSUPPORTED", "this composition has no registered native credential mint action; no other implementation was substituted");
    const action = registry.resolve<CredentialAction>("credential-action", "mint");
    const request = { ...args, positionals: args.positionals.slice(1) };
    action.validate(request); return action.run(request);
  }
  if (mode === "retire") {
    const target = localAuthTarget(args.values as { space?: string });
    throw new CommandFailure("refused", "UNSUPPORTED", "registered auth retirement requires the caller's own current serve identity and gate; this standalone CLI has no supported retirement instrument, so no manager identity, signer-selected alias or loopback host door was substituted", {
      target: { space: target.space, lifecycleUid: args.positionals[1] },
      remedy: "inspect the registered auth endpoint's contract and restore its supported caller/serve-gate context; --yes is not an authority grant and no retirement request was sent",
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
  positionals: "[grants | grant <actor> | revoke <actor> | signer | mint <name> | handle inspect <file> | redeem <file> | retire <lifecycle-uid>]",
  summary: "inspect account metadata, manage actor grants and export a protected account signer",
  usage: "cotal auth [grants | grant <actor> | revoke <actor> | signer --out <private-file> | mint <name> | handle inspect <file> | redeem <file> | retire <lifecycle-uid>] [--space <s>] [--json|--plain]",
  flagNames: ["space", "json", "plain"],
  flags: authFlags, outputs: ["json", "plain"], reads: true, prepareMeshTarget: false,
  subcommands: ([
    { name: "mint", flagNames: credentialMintFlags.map((flag) => flag.name), summary: "write a fixed-profile or supported endpoint caller credential privately", usage: "cotal auth mint <name> [--profile agent|observer|admin] [--out <private-file>] | <name> --endpoint <class> --out <private-file> [--channels <a,b>]", prepareMeshTarget: false },
    { name: "handle", flagNames: ["space", "json", "plain"], summary: "inspect protected claims or static-registry signatures without conferring authority", usage: "cotal auth handle inspect <private-file> [--space <space>] [--json|--plain]", reads: true, prepareMeshTarget: false, subcommands: [{ name: "inspect", flagNames: ["space", "json", "plain"], summary: "offline metadata; --space checks native static signer/revocation records", usage: "cotal auth handle inspect <private-file> [--space <space>] [--json|--plain]", reads: true, prepareMeshTarget: false, outputs: ["json", "plain"] }] },
    { name: "retire", flagNames: ["space", "yes", "json", "plain"], summary: "retire one exact lifecycle only through a supported registered auth caller", usage: "cotal auth retire <full-lifecycle-uid> [--space <space>] [--yes]", prepareMeshTarget: false },
    { name: "redeem", flagNames: ["space", "json", "plain"], summary: "conferring-handle redemption requires a supported native auth path", usage: "cotal auth redeem <private-handle-file> [--space <space>]", prepareMeshTarget: false },
    { name: "signer", flagNames: ["space", "out", "force", "json", "plain"], summary: "export existing account-signing material to a protected private file", usage: "cotal auth signer --out <private-file> [--force]", prepareMeshTarget: false },
    { name: "grants", flagNames: ["space", "json", "plain"], summary: "read the authoritative local actor grants, not cached sign-in claims", reads: true, prepareMeshTarget: false },
    { name: "grant", flagNames: ["space", "sub", "owner", "scope", "allow-subscribe", "allow-publish", "role", "label", "parent", "full", "json", "plain"], summary: "store a deliberate operator grant through the existing authority path", usage: "cotal auth grant <actor>", prepareMeshTarget: false },
    { name: "revoke", flagNames: ["space", "sub", "owner", "json", "plain"], summary: "retire and revoke an interactive actor grant under its existing authority", usage: "cotal auth revoke <actor>", prepareMeshTarget: false },
  ] as const).map((sub) => ({ ...sub, outputs: ["json", "plain"] as const })),
  validate: validateAuthArguments, run: authGroup,
};

const daemonAuthService = authCommands.find((command) => command.name === "__daemon-auth-service")!;
registry.register(...authCommands, deprecatedDaemonEntry("auth-service", daemonAuthService), authCommand);
