import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  acquireLock, assertLifecycleToken, canonicalJson, checkConversationApprovalPending, checkConversationPendingAnswer,
  checkConversationSelection, conversationApprovalRefusal, conversationGrant, deprovisionAgent, mintCreds, mkSecretDir, newIdentity,
  principalKey, provisionAgentDurables, processStartToken, registry, resolveAuthProvider, writeSecretFileAtomic, type AuthProvider,
  type ConversationApprovalPending, type ConversationApprovalRefusal, type ConversationGrant, type ConversationPending, type ConversationSelection,
} from "@cotal-ai/core";
import { checkDiscoveryDocument, checkIdpUrl, discoveryDocumentUrl, pinnedFetch, getSpaceAuth, homeCotalDir, oneLine, resolveTargetOrThrow, userAuthStateDir, workspaceSecretStore, type ConversationAccount, type ConversationSignOut, type MeshTarget, type UnconfirmedConversation } from "@cotal-ai/workspace";
import { CONVERSATION_RESUME_PREFIX, type ConversationResumeProof } from "@cotal-ai/workspace/conversation-resume";
import {
  agentCapRefusal, checkConversationMaterial, conversationRetirementPhase, discoverConversationAuthority, legacyAgentCapRefusal, legacyNameTakenRefusal, nameTakenRefusal, selectionRefusal, signedInSpace,
  type ConversationAuthority, type ConversationMaterial,
} from "./conversation-identity.js";
import { withProvisioner } from "./provisioner.js";
import { confirmConversationResume, ConversationRequestError, createResumeProof, matchesResumeBinding, resumeToken } from "./conversation-resume.js";

type RetirementTarget = Pick<MeshTarget, "space" | "root" | "server" | "tlsRequired" | "userAuth">;

interface SavedIdentity {
  v: 1;
  space: string;
  root: string;
  trust: string;
  /** Original registration pins, used only to retire at the authority that issued this request. */
  retirementTarget?: RetirementTarget;
  session: string;
  requestId: string;
  label: string;
  token: string;
  /** When present, token is the exchange secret's hash, not the secret itself. */
  proof?: ConversationResumeProof;
  /** Opaque key for the approving IdP account. An unbound saved proof cannot resume. */
  accountKey?: string;
  state: "creating" | "ready" | "retiring";
  consumer: { pid: number; start?: string };
  /** What the identity was requested with beyond its own event channel. Fixed at creation. */
  selection?: ConversationSelection;
  /** `approval` marks a request under connection approval: always one made by this version, and one
   *  saved before with no issued identity from before it is sent again. Its issued answer must
   *  carry the person's decision. */
  remote?: { url: string; idpUrl: string; material?: ConversationMaterial; approval?: { pending?: ConversationApprovalPending } };
  /** Issued before connection approval. A new local identity is refused: no human approval exists here. */
  local?: { owner: string; actor: string; lifecycleUid: string; sentinelCreds?: string };
}

const RECORD = "identity.json";
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const identityRoot = (): string => join(homeCotalDir(), "app-identities");
const trust = (t: RetirementTarget): string => hash(JSON.stringify({ space: t.space, root: t.root, server: t.server, tlsRequired: t.tlsRequired, userAuth: t.userAuth }));

function syncFile(path: string, flags: "r" | "r+" = "r"): void {
  const fd = openSync(path, flags);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function save(dir: string, record: SavedIdentity): void {
  const file = join(dir, RECORD);
  writeSecretFileAtomic(file, JSON.stringify(record));
  // Windows requires write access to flush a file. Directory handles stay read-only on POSIX.
  syncFile(file, "r+");
  if (process.platform !== "win32") syncFile(dir);
}

function privateDir(dir: string): void {
  const st = lstatSync(dir);
  if (!st.isDirectory() || (process.getuid && (st.uid !== process.getuid() || (st.mode & 0o077) !== 0)))
    throw new Error("conversation identity state is not an owner-private directory");
}

function read(dir: string): SavedIdentity {
  privateDir(dir);
  const file = join(dir, RECORD);
  const st = lstatSync(file);
  if (!st.isFile() || (process.getuid && (st.uid !== process.getuid() || (st.mode & 0o077) !== 0)))
    throw new Error("conversation identity record is not an owner-private regular file");
  const record = JSON.parse(readFileSync(file, "utf8")) as SavedIdentity;
  if (record.v !== 1 || typeof record.space !== "string" || typeof record.root !== "string" ||
      typeof record.session !== "string" || !/^[A-Za-z0-9_-]{22,64}$/.test(record.requestId) ||
      !(record.proof ? /^[a-f0-9]{64}$/ : /^[A-Za-z0-9_-]{43}$/).test(record.token) || !["creating", "ready", "retiring"].includes(record.state) ||
      !record.consumer || !Number.isInteger(record.consumer.pid) || record.consumer.pid <= 0 ||
      Boolean(record.remote) === Boolean(record.local))
    throw new Error("conversation identity recovery record is invalid; it was retained");
  if (record.retirementTarget && Object.keys(record.retirementTarget).some((key) =>
      !["space", "root", "server", "tlsRequired", "userAuth"].includes(key)))
    throw new Error("conversation retirement pins contain unexpected fields; recovery state was retained");
  if (record.proof && !record.remote) throw new Error("conversation resume proof does not name a signed-in identity");
  if (record.accountKey !== undefined && (typeof record.accountKey !== "string" || !/^[a-f0-9]{64}$/.test(record.accountKey)))
    throw new Error("conversation approval account is invalid; the saved record was retained");
  if (record.selection !== undefined) checkConversationSelection(record.selection);
  const pending = record.remote?.approval?.pending;
  if (pending !== undefined) checkConversationApprovalPending(pending, new URL(record.remote!.url).origin);
  return record;
}

/** Only the kernel's "no such process" proves a consumer gone, before its identity is reissued or
 *  retired. A live pid whose start token reads differently is not proof: macOS reads that token
 *  through `ps` in the reader's locale and time zone. */
function consumerGone(consumer: SavedIdentity["consumer"]): boolean {
  try { process.kill(consumer.pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** The creation body. A replay sends the same one, so its digest names the same request. */
function creationBody(record: SavedIdentity) {
  return { v: 1 as const, requestId: record.requestId, tokenHash: record.proof ? record.token : hash(record.token), label: record.label,
    ...(record.selection ? { selection: record.selection } : {}) };
}

/** An issued answer must carry the person's decision on the approval the request saw. Only the exact
 *  replay of an identity saved as issued before connection approval may carry none. */
function approvalExpectation(remote: NonNullable<SavedIdentity["remote"]>): { required: true; id?: string } | undefined {
  if (remote.material && !remote.approval) return undefined;
  return { required: true, ...(remote.approval?.pending ? { id: remote.approval.pending.id } : {}) };
}

/** Mark a request with no issued identity as under approval before it is sent, so every answer to it
 *  from then on, including one replayed after a crash, needs the person's decision. */
function markUnderApproval(dir: string, record: SavedIdentity): void {
  if (record.remote!.material || record.remote!.approval) return;
  record.remote!.approval = {};
  save(dir, record);
}

/** The authority recorded that nothing was issued for this request, and the saved request is gone.
 *  `decision` says why in a form a host can act on: the person's denial, the approval's expiry, or
 *  a refusal of the proposed selection. */
export class ConversationRefusal extends Error {
  constructor(readonly decision: ConversationApprovalRefusal | "refused", message: string) {
    super(message);
    this.name = "ConversationRefusal";
  }
}

export { ConversationRequestError } from "./conversation-resume.js";

/** What one creation answer proves. A selection refusal, a recorded denial, expiry or cap refusal,
 *  and a pending approval each prove that nothing was issued. Any other answer than an exact issued identity
 *  leaves the outcome unknown, so it throws and the request stays saved. */
function creationOutcome(
  record: SavedIdentity, authority: ConversationAuthority, response: { status: number; body: unknown }, what: "creation" | "recovery",
): { refused: string; decision: ConversationRefusal["decision"] } | { pending: ConversationPending } | { material: ConversationMaterial } {
  const remote = record.remote!;
  if (!remote.material) {
    const nameTaken = nameTakenRefusal(response.status, response.body, record.requestId);
    if (nameTaken) return { refused: nameTaken, decision: "refused" };
    const cap = agentCapRefusal(response.status, response.body, authority, record.requestId);
    if (cap) return { refused: cap, decision: "refused" };
    const refusal = selectionRefusal(response.status, response.body);
    if (refusal) return { refused: `${refusal}; no identity was issued`, decision: "refused" };
    const decided = conversationApprovalRefusal(response.status, response.body);
    if (decided === "denied") return { refused: "the person denied this connection; no identity was issued", decision: "denied" };
    if (decided === "expired") return { refused: "the approval expired before this connection was issued; no identity was issued. Connect again to ask again", decision: "expired" };
    if (response.status === 202) {
      const pending = checkConversationPendingAnswer(response.body,
        { requestId: record.requestId, authorityOrigin: new URL(authority.url).origin, proposed: record.selection ?? null });
      if (remote.approval?.pending && canonicalJson(remote.approval.pending) !== canonicalJson(pending.approval))
        throw new Error("conversation identity approval changed while it was pending; its request was retained");
      return { pending };
    }
  }
  if (response.status !== 200 && response.status !== 201)
    throw new ConversationRequestError(legacyNameTakenRefusal(response.status, response.body) ?? legacyAgentCapRefusal(response.status, response.body) ??
      `conversation identity ${what} answered HTTP ${response.status}; its original request was retained`,
      response.status >= 500 || [408, 425, 429].includes(response.status));
  return { material: checkConversationMaterial(response.body, authority, record.requestId, record.selection, approvalExpectation(remote)) };
}

function request(provider: AuthProvider): NonNullable<AuthProvider["requestConversationIdentity"]> {
  if (!provider.requestConversationIdentity) throw new Error("the auth provider does not support conversation identity authority");
  return provider.requestConversationIdentity.bind(provider);
}

function account(provider = resolveAuthProvider()): ConversationAccount | undefined {
  return registry.all<ConversationAccount>("conversation-account").find((extension) => extension.name === provider.name);
}

function requestForRecord(provider: AuthProvider, record: SavedIdentity): ReturnType<typeof request> {
  if (!record.accountKey) return request(provider);
  const binding = account(provider);
  if (!binding) throw new Error("the auth provider cannot check the saved approval's account; nothing was sent");
  return (input) => binding.request(record.accountKey!, input);
}

/** A connected conversation identity: its environment, where to retire it, and its exact grant. */
export interface UserAppConnection {
  env: Record<string, string>;
  retire: { dir: string };
  grant: ConversationGrant;
}

type UserAppResult = UserAppConnection | { pending: ConversationPending; reason?: string };

/** The refusal for an app that supplies no native session, such as Claude Desktop chat: it names
 *  the hosted connector the space advertises, the path such an app joins through. */
async function noNativeSession(target: MeshTarget): Promise<string> {
  const s = await signedInSpace(target);
  const next = s.hostedConnector ? `connect this app through the hosted connector of "${s.space}" instead: ${s.hostedConnector}`
    : s.unread ? `the hosted connector of "${s.space}" could not be read (${s.unread})`
    : `"${s.space}" advertises no hosted connector`;
  return `a signed-in conversation needs its native session identity before connecting, and this app supplies none; ${next}`;
}

/** The session key is supplied by the native host, not guessed from a parent pid or an open inbox.
 *  A new request waits for a person's approval: until it is decided this returns `pending`, and
 *  connecting again replays the same saved request and secret. */
export async function provisionUserApp(
  target: MeshTarget, name: string, session: string | undefined, events: boolean, selection?: ConversationSelection,
): Promise<UserAppResult> {
  if (!session || !/^[A-Za-z0-9_-]{1,128}$/.test(session)) throw new Error(await noNativeSession(target));
  const root = identityRoot();
  mkSecretDir(root);
  privateDir(root);
  // Space-specific records remain the recovery authority. Serialize across spaces as well so two
  // hosts cannot open different identities for the same native conversation at the same time.
  const sessionLock = acquireLock(join(root, `session-${hash(session)}.lock`), { waitMs: 0 });
  try {
    for (const entry of readdirSync(root)) {
      const dir = join(root, entry);
      if (!isUserAppDir(dir) || !existsSync(join(dir, RECORD))) continue;
      const previous = read(dir);
      if (previous.session !== session || previous.space === target.space) continue;
      if (previous.proof && !matchesResumeBinding(previous, previous.proof)) continue;
      if (previous.consumer.pid !== process.ppid && !consumerGone(previous.consumer))
        throw new Error("this native conversation still has a live consumer on another space; disconnect it before choosing another");
      // A pending request or a dead consumer must finish its exact retirement before a new target
      // receives a request. Failure keeps the old record and sends nothing to the new authority.
      await retireUserApp(dir);
    }
    return await provisionOnSpace(target, name, session, events, selection);
  } finally { sessionLock.release(); }
}

async function provisionOnSpace(
  target: MeshTarget, name: string, session: string, events: boolean, selection?: ConversationSelection,
): Promise<UserAppResult> {
  const store = workspaceSecretStore(target.root);
  const infra = target.userAuth?.remote === true ? undefined : await getSpaceAuth(store, target.space);
  const dir = join(identityRoot(), hash(`${target.space}\0${session}`));
  const saved = existsSync(join(dir, RECORD)) ? read(dir) : undefined;
  if (saved?.proof && saved.session === session && matchesResumeBinding(saved, saved.proof)) {
    requireResumeLogin(saved);
    if (saved.state === "ready" && saved.trust !== trust(target)) throw new Error(RESUME_UNAVAILABLE);
  }
  const authority = infra ? undefined : await discoverConversationAuthority(target).catch((error: unknown) => {
    if (saved?.proof && saved.state === "ready")
      throw new Error(`Conversation identity discovery did not confirm the saved authority. The saved identity was retained. ${oneLine((error as Error).message)}`, { cause: error });
    throw error;
  });
  const policy = authority?.bundle.policy ?? target.policy;
  if (policy?.events === "required" && !events)
    throw new Error("this mesh requires a real native conversation event source; no identity was requested");
  const provider = resolveAuthProvider();
  if (authority) request(provider);
  if (selection && authority && !authority.selection)
    throw new Error("the selected mesh does not offer selection for conversation identities; no identity was requested");
  const root = identityRoot();
  mkSecretDir(root);
  privateDir(root);
  const { reason, resumed } = await prepareSavedIdentity(dir, { name, session, trust: trust(target), selection }, authority);
  // A reconnect first finishes the previous explicit departure, or preserves an older record
  // whose original registration is unavailable before releasing its session key.
  if (existsSync(join(dir, RECORD)) && read(dir).state === "retiring") {
    try { await retireUserApp(dir); }
    catch (error) {
      const message = `this conversation's previous identity is still retiring: ${(error as Error).message}. Connect again to retry it`;
      throw error instanceof ConversationRequestError ? new ConversationRequestError(message, error.retryable) : new Error(message);
    }
  }
  const lock = acquireLock(`${dir}.lock`, { waitMs: 0 });
  try {
    let record: SavedIdentity;
    if (existsSync(join(dir, RECORD))) {
      record = read(dir);
      if (record.session !== session || record.trust !== trust(target) || record.label !== name)
        throw new Error("this conversation has a saved identity under different mesh pins or a different name; disconnect it before connecting again");
      if (canonicalJson(record.selection ?? null) !== canonicalJson(selection ?? null))
        throw new Error("this conversation has a saved identity with a different selection; connect with that selection to resume it, then disconnect before choosing another");
      if (record.state === "retiring") throw new Error("this conversation's prior identity is still retiring; retry disconnect before connecting again");
      if (record.consumer.pid !== process.ppid && !consumerGone(record.consumer))
        throw new Error("this native conversation still has a live inbox consumer; no identity was reissued");
      record.consumer = { pid: process.ppid, start: processStartToken(process.ppid) };
      save(dir, record);
    } else {
      // A new identity needs a person's approval. Nothing local can give one, and a remote authority
      // must advertise connection approval before anything authenticated is sent.
      if (!authority) throw new Error("this mesh has no human approval for a new conversation identity, so none was requested");
      if (!authority.approval) throw new Error("the selected mesh does not advertise connection approval v1; no identity was requested");
      mkSecretDir(dir);
      privateDir(dir);
      if (readdirSync(dir).length) throw new Error("conversation identity state is incomplete; it was retained for recovery");
      const token = randomBytes(32).toString("base64url");
      record = {
        v: 1, space: target.space, root: target.root, trust: trust(target), retirementTarget: { space: target.space, root: target.root, server: target.server,
          tlsRequired: target.tlsRequired, userAuth: target.userAuth }, session,
        requestId: randomBytes(24).toString("base64url"), label: name, token, state: "creating",
        consumer: { pid: process.ppid, start: processStartToken(process.ppid) }, ...(selection ? { selection } : {}),
        remote: { url: authority.url, idpUrl: target.userAuth!.idp.url, approval: {} },
      };
      attachResumeProof(record, authority, provider);
      save(dir, record);
      if (process.platform !== "win32") { syncFile(root); syncFile(dirname(root)); }
    }
    if (record.remote && resumed !== record.requestId) {
      if (!authority || record.remote.url !== authority.url || record.remote.idpUrl !== target.userAuth?.idp.url)
        throw new Error("conversation identity authority changed; the saved identity was retained");
      // Only an exact replay of an issued identity may go to an authority without approval.
      if (!record.remote.material && !authority.approval)
        throw new Error("the selected mesh does not advertise connection approval v1; the saved request was retained and not sent");
      markUnderApproval(dir, record);
      const response = await requestForRecord(provider, record)({ url: authority.url, idpUrl: record.remote.idpUrl, method: "POST", body: creationBody(record) });
      const outcome = creationOutcome(record, authority, response, "creation");
      if ("refused" in outcome) {
        discard(dir);
        throw new ConversationRefusal(outcome.decision, outcome.refused);
      }
      if ("pending" in outcome) {
        record.remote.approval = { pending: outcome.pending.approval };
        save(dir, record);
        return { pending: outcome.pending, ...(reason ? { reason } : {}) };
      }
      if (record.remote.material && JSON.stringify(record.remote.material) !== JSON.stringify(outcome.material))
        throw new Error("conversation identity replay changed its saved lifecycle or grant");
      record.remote.material = outcome.material;
    } else if (!record.remote) {
      // An identity granted here before connection approval resumes exactly. One without a
      // confirmed grant is not issued now: no human approval exists on this path.
      const local = record.local!;
      if (!local.sentinelCreds)
        throw new Error("this mesh has no human approval for a new conversation identity, so this unfinished one was not issued; disconnect it to remove its saved request");
      const grant = conversationGrant(local, record.selection);
      await withProvisioner({ space: target.space, servers: target.server, auth: infra! }, "app-provisioner", (provisioner) =>
        provisionAgentDurables(provisioner, local, { subscribe: [], allowSubscribe: grant.allowSubscribe, ...(grant.role ? { role: grant.role } : {}) }));
    }
    record.state = "ready";
    save(dir, record);
    const material = record.remote?.material ?? record.local!;
    const grant = record.remote?.material?.grant ?? conversationGrant(record.local!, record.selection);
    writeSecretFileAtomic(join(dir, "actor.token"), record.proof ? CONVERSATION_RESUME_PREFIX + JSON.stringify(record.proof) : record.token);
    writeSecretFileAtomic(join(dir, "sentinel.creds"), material.sentinelCreds!);
    const bearer = [process.execPath, ...process.execArgv, process.argv[1]!, provider.agentBearerCommand,
      ...(record.remote ? ["--exchange-url", record.remote.material!.exchangeUrl] : ["--dir", userAuthStateDir(target.root, target.space)]),
      "--space", target.space, "--owner", material.owner, "--actor", material.actor, "--token-file", join(dir, "actor.token")];
    return { env: {
      COTAL_SPACE: target.space, COTAL_SERVERS: target.server, COTAL_NAME: name, COTAL_TLS: target.tlsRequired ? "1" : "0",
      COTAL_OWNER: material.owner, COTAL_ACTOR: material.actor, COTAL_LIFECYCLE_UID: material.lifecycleUid,
      COTAL_SENTINEL_CREDS: join(dir, "sentinel.creds"), COTAL_BEARER_CMD: JSON.stringify(bearer),
      COTAL_SUBSCRIBE: "", COTAL_ALLOW_SUBSCRIBE: grant.allowSubscribe.join(","), COTAL_ALLOW_PUBLISH: grant.allowPublish.join(","),
      ...(grant.role ? { COTAL_ROLE: grant.role } : {}), ...(grant.scope.length ? { COTAL_CAPABILITIES: grant.scope.join(",") } : {}),
      COTAL_WORKSPACE_ROOT: homeCotalDir(), ...(events ? { COTAL_EVENTS: "1" } : {}),
      ...(record.proof ? { COTAL_CONVERSATION_APPROVAL: resumed === record.requestId ? "resumed" : "resumable" } : {}),
      ...(policy?.events === "required" ? { COTAL_EVENTS_REQUIRED: "1" } : {}),
    }, retire: { dir }, grant };
  } finally { lock.release(); }
}

function attachResumeProof(record: SavedIdentity, authority: ConversationAuthority, provider: AuthProvider): void {
  if (!authority.resume) return;
  const binding = account(provider);
  let accountKey: string | undefined;
  try { accountKey = binding?.key(record.remote!.idpUrl); }
  catch { return; } // A legacy login without a subject still uses ordinary approval.
  if (!accountKey) return;
  const resume = createResumeProof(record);
  if (resume) Object.assign(record, { accountKey, proof: resume.proof, token: resume.tokenHash });
}

async function prepareSavedIdentity(dir: string, expected: {
  name: string; session: string; trust: string; selection?: ConversationSelection;
}, authority: ConversationAuthority | undefined): Promise<{ reason?: string; resumed?: string }> {
  if (!existsSync(join(dir, RECORD))) return {};
  const previous = read(dir);
  if (previous.state === "retiring") return {};
  const changed = previous.label !== expected.name || canonicalJson(previous.selection ?? null) !== canonicalJson(expected.selection ?? null);
  if (previous.proof) {
    if (matchesResumeBinding(previous, previous.proof) && previous.trust !== expected.trust) throw new Error(RESUME_UNAVAILABLE);
    if (previous.consumer.pid !== process.ppid && !consumerGone(previous.consumer))
      throw new Error("this native conversation still has a live inbox consumer; no identity was reissued");
    if (previous.session !== expected.session || !matchesResumeBinding(previous, previous.proof)) {
      const lock = acquireLock(`${dir}.lock`, { waitMs: 0 });
      try {
        const current = read(dir);
        if (current.requestId !== previous.requestId || current.state === "retiring") return {};
        setAside(dir, current, `-${randomBytes(8).toString("hex")}`);
      } finally { lock.release(); }
      return { reason: "The saved approval could not be used on this computer." };
    }
    if (!previous.accountKey) {
      await retireUserApp(dir);
      return { reason: "The saved approval does not identify its approving account. Fresh approval is required." };
    }
    if (previous.state === "ready") requireResumeAuthority(previous, authority);
    if (!resumeToken({ ...previous, proof: previous.proof })) {
      try { await retireUserApp(dir); }
      catch (error) { throw new Error(`The saved approval could not be used on this computer, and retirement is not confirmed. ${oneLine((error as Error).message)}`); }
      return { reason: "The saved approval could not be used on this computer." };
    }
    if (previous.state === "ready") {
      if (changed) {
        await retireUserApp(dir);
        return { reason: "The saved approval does not cover this name or selection." };
      }
      const lock = acquireLock(`${dir}.lock`, { waitMs: 0 });
      try {
        const current = read(dir);
        if (current.state !== "ready" || current.requestId !== previous.requestId) return {};
        if (await resumeSavedIdentity(current, authority)) return { resumed: current.requestId };
        current.state = "retiring";
        save(dir, current);
      } finally { lock.release(); }
      await retireUserApp(dir);
      return { reason: "The authority did not accept the saved approval." };
    }
  }
  if (previous.session !== expected.session || previous.trust !== expected.trust) return {};
  // Resolve the old request before replacing it. If approval raced us, retire the exact identity.
  if (changed && previous.state === "creating" && previous.remote && !previous.remote.material) {
    if (previous.consumer.pid !== process.ppid && !consumerGone(previous.consumer))
      throw new Error("this native conversation still has a live inbox consumer; its pending request was not replaced");
    await retireUserApp(dir);
  }
  return {};
}

const RESUME_UNAVAILABLE = "The space does not currently offer resume at the saved authority and trust pins. The saved identity was retained.";

function requireResumeLogin(record: SavedIdentity): void {
  let key: string;
  try {
    const binding = account();
    if (!binding) throw new Error("login check unavailable");
    key = binding.key(record.remote!.idpUrl);
  } catch (error) {
    throw new Error("Sign in again with `cotal login` before reconnecting this conversation. The saved identity was retained.", { cause: error });
  }
  if (record.accountKey && record.accountKey !== key)
    throw new Error("This conversation was approved by another account. Sign in with the original account or connect a different conversation for fresh approval. The saved identity was retained.");
}

function requireResumeAuthority(record: SavedIdentity, authority: ConversationAuthority | undefined): ConversationAuthority {
  if (!authority?.resume || record.remote?.url !== authority.url || record.remote.idpUrl !== authority.bundle.userAuth.idp.url)
    throw new Error(RESUME_UNAVAILABLE);
  return authority;
}

async function resumeSavedIdentity(record: SavedIdentity, discovered: ConversationAuthority | undefined): Promise<boolean> {
  if (!record.accountKey) throw new Error("The saved approval does not identify its approving account. Fresh approval is required.");
  requireResumeLogin(record);
  const authority = requireResumeAuthority(record, discovered);
  const remote = record.remote!;
  if (!remote.material) throw new Error("The saved approval has no issued identity. The saved record was retained.");
  const material = checkConversationMaterial(remote.material, authority, record.requestId, record.selection, approvalExpectation(remote));
  const token = record.proof && resumeToken({ ...record, proof: record.proof });
  return !!token && !!material.approval && await confirmConversationResume(material, token);
}

/** Remove a creation record the authority refused before writing anything. */
function discard(dir: string): void {
  if (readdirSync(dir).some((name) => name !== RECORD)) throw new Error("conversation identity directory contains unrecognized files; recovery state was retained");
  unlinkSync(join(dir, RECORD));
  rmdirSync(dir);
  if (process.platform !== "win32") syncFile(identityRoot());
}

export function isUserAppDir(dir: string): boolean {
  return dirname(resolve(dir)) === resolve(identityRoot()) && /^[a-f0-9]{64}$/.test(basename(dir));
}

/** Retain the record and secret until exact cleanup is observed, or preserve an older record
 *  separately when its original registration is no longer available. */
export function retireUserApp(dir: string): Promise<void> {
  return retire(dir);
}

function idpKey(url: string): string | undefined {
  const checked = checkIdpUrl(url);
  return checked.ok ? checked.url.origin + checked.url.pathname.replace(/\/+$/, "") : undefined;
}

export const conversationSignOut: ConversationSignOut = {
  kind: "conversation-sign-out", name: "native",
  async retire({ dir: home, idp, accountKey }) {
    const root = join(home, "app-identities");
    if (!existsSync(root)) return [];
    privateDir(root);
    const failures: UnconfirmedConversation[] = [];
    for (const entry of readdirSync(root)) {
      const dir = join(root, entry);
      const setAside = isUnconfirmedDirectory(entry);
      if ((!/^[a-f0-9]{64}$/.test(entry) && !setAside) || !existsSync(join(dir, RECORD))) continue;
      let failure: UnconfirmedConversation = {};
      try {
        const matches = (r: SavedIdentity) => !!r.remote && idpKey(r.remote.idpUrl) === idp &&
          (!r.accountKey || !accountKey || r.accountKey === accountKey) && (setAside ? matchesUnconfirmed(entry, r) : !!r.proof) &&
          (!r.proof || matchesResumeBinding(r, r.proof));
        const record = read(dir);
        if (!matches(record)) continue;
        failure = { label: oneLine(record.label), space: oneLine(record.space) };
        await retire(dir, matches, home, true);
      } catch {
        failures.push(failure);
      }
    }
    return failures;
  },
  count({ dir: home, idp, accountKey }) {
    const root = join(home, "app-identities");
    if (!existsSync(root)) return 0;
    try { privateDir(root); } catch { return 0; }
    let total = 0;
    for (const entry of readdirSync(root)) {
      const setAside = isUnconfirmedDirectory(entry);
      if (!/^[a-f0-9]{64}$/.test(entry) && !setAside) continue;
      const dir = join(root, entry);
      if (!existsSync(join(dir, RECORD))) continue;
      try {
        const r = read(dir);
        if (r.remote?.material && idpKey(r.remote.idpUrl) === idp && r.accountKey === accountKey && r.proof &&
            matchesResumeBinding(r, r.proof) && (!setAside || matchesUnconfirmed(entry, r)))
          total++;
      } catch { /* unreadable entry does not block sign-in */ }
    }
    return total;
  },
};

function isUnconfirmedDirectory(entry: string): boolean {
  return /^unconfirmed-[A-Za-z0-9_-]{22,81}$/.test(entry);
}

function matchesUnconfirmed(entry: string, record: SavedIdentity): boolean {
  const prefix = `unconfirmed-${record.requestId}`;
  return record.state === "retiring" && (entry === prefix || (entry.startsWith(prefix) && /^-[a-f0-9]{16}$/.test(entry.slice(prefix.length))));
}

/** Clean up dead consumers in this mesh. Resumable approvals stay saved unless retirement is
 *  underway. A live or unknown consumer keeps its identity and is never locked. */
export async function retireDeadUserApps(target: MeshTarget): Promise<void> {
  const root = identityRoot();
  if (!existsSync(root)) return;
  const dead = (record: SavedIdentity) => record.trust === trust(target) && consumerGone(record.consumer) &&
    !(record.proof && record.state === "ready");
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    try { if (isUserAppDir(dir) && existsSync(join(dir, RECORD)) && dead(read(dir))) await retire(dir, dead); }
    catch { /* retained for a later run */ }
  }
}

/** Preserve unconfirmed credentials without reserving the conversation's active session key. */
function setAside(dir: string, record: SavedIdentity, suffix = ""): void {
  record.state = "retiring";
  save(dir, record);
  renameSync(dir, join(identityRoot(), `unconfirmed-${record.requestId}${suffix}`));
  if (process.platform !== "win32") syncFile(identityRoot());
}

/** `when` is decided under the record's lock, so a consumer that reissued it in between keeps it. */
async function retire(dir: string, when?: (record: SavedIdentity) => boolean, home = homeCotalDir(), signOut = false): Promise<void> {
  if (dirname(resolve(dir)) !== resolve(home, "app-identities") || !(/^[a-f0-9]{64}$/.test(basename(dir)) || (signOut && isUnconfirmedDirectory(basename(dir)))))
    throw new Error("not a saved conversation identity directory");
  const lock = acquireLock(`${dir}.lock`, { waitMs: 0 });
  try {
    const record = read(dir);
    if (when && !when(record)) return;
    const current = signOut && record.retirementTarget ? undefined : await resolveTargetOrThrow({ space: record.space });
    let target = record.retirementTarget ?? current!;
    if (!record.retirementTarget && record.remote?.material && trust(target) !== record.trust) {
      try {
        const address = new URL(record.remote.material.exchangeUrl);
        const response = await pinnedFetch(discoveryDocumentUrl(address).href, "the original conversation registration");
        if (response.ok) {
          const checked = await checkDiscoveryDocument(response);
          if (checked.ok) {
            const { space, server, tlsRequired, userAuth } = checked.value;
            const sentinelCandidates: (string | undefined)[] = [];
            if (target.userAuth?.sentinelCredsPath) {
              const leaf = basename(target.userAuth.sentinelCredsPath);
              try { sentinelCandidates.push(join(userAuthStateDir(record.root, space, { readOnly: true }), leaf)); } catch {}
              try { sentinelCandidates.push(join(userAuthStateDir(record.root, space, { readOnly: true }), "sentinel.creds")); } catch {}
              if (target.root) {
                try { sentinelCandidates.push(resolve(record.root, relative(target.root, target.userAuth.sentinelCredsPath))); } catch {}
              }
              const custody = (target as { catalogRoot?: string }).catalogRoot;
              if (custody) {
                try { sentinelCandidates.push(resolve(record.root, relative(custody, target.userAuth.sentinelCredsPath))); } catch {}
              }
              sentinelCandidates.push(target.userAuth.sentinelCredsPath);
            } else {
              try { sentinelCandidates.push(join(userAuthStateDir(record.root, space, { readOnly: true }), "sentinel.creds")); } catch {}
            }
            sentinelCandidates.push(undefined);

            for (const sentinelPath of new Set(sentinelCandidates)) {
              const candidateUserAuth = { ...target.userAuth, ...userAuth };
              if (sentinelPath !== undefined) candidateUserAuth.sentinelCredsPath = sentinelPath;
              else delete candidateUserAuth.sentinelCredsPath;
              const original = { ...target, root: record.root, space, server, tlsRequired, userAuth: candidateUserAuth };
              if (trust(original) === record.trust) {
                target = original;
                break;
              }
            }
          }
        }
      } catch { /* Unavailable original pins leave the record set aside, without authenticated recovery. */ }
    }
    if (record.retirementTarget && trust(target) !== record.trust)
      throw new Error("conversation identity retirement pins do not match its saved trust; retirement was not sent");
    if (trust(target) !== record.trust) {
      if (signOut || record.proof) throw new Error("the original conversation registration could not be confirmed");
      // Older records could not recover matching original pins. Preserve their recovery state
      // outside the active session key without authenticating at the replacement registration.
      setAside(dir, record);
      return;
    }
    const provider = resolveAuthProvider();
    record.state = "retiring";
    save(dir, record);
    if (record.remote) {
      let unavailable = false;
      const originalRequest = async (args: Parameters<ReturnType<typeof request>>[0]) => {
        try {
          const response = await requestForRecord(provider, record)(args);
          if ([401, 403].includes(response.status)) unavailable = true;
          return response;
        } catch (error) { unavailable = true; throw error; }
      };
      try {
        let authority: ConversationAuthority;
        try { authority = await discoverConversationAuthority(target); }
        catch (error) { unavailable = true; throw error; }
        if (authority.url !== record.remote.url || record.remote.idpUrl !== target.userAuth?.idp.url)
          throw new Error("conversation identity authority changed; recovery was not sent");
        let material = record.remote.material;
        if (!material) {
          if (record.selection && !authority.selection)
            throw new Error("the selected mesh no longer offers selection for conversation identities; recovery was not sent");
          if (!authority.approval)
            throw new Error("the selected mesh does not advertise connection approval v1; recovery was not sent");
          markUnderApproval(dir, record);
          const replay = await originalRequest({ url: authority.url, idpUrl: record.remote.idpUrl, method: "POST", body: creationBody(record) });
          const outcome = creationOutcome(record, authority, replay, "recovery");
          // Refused, or still pending: the authority issued nothing, so there is nothing to retire.
          if (!("material" in outcome)) {
            discard(dir);
            return;
          }
          material = outcome.material;
          record.remote.material = material;
          save(dir, record);
        }
        material = checkConversationMaterial(material, authority, record.requestId, record.selection, approvalExpectation(record.remote));
        const expected = new URL(`${authority.url}/${material.actor}`);
        expected.searchParams.set("lifecycleUid", assertLifecycleToken(material.lifecycleUid));
        if (material.retire.url !== expected.href) throw new Error("saved retirement URL does not name the exact lifecycle");
        const response = await originalRequest({ url: expected.href, idpUrl: record.remote.idpUrl, method: "DELETE" });
        const phase = conversationRetirementPhase(response.status, response.body, material);
        if (phase !== "terminal")
          throw new Error(`conversation identity retirement is pending at phase ${JSON.stringify(phase)}; its saved lifecycle was retained for an exact retry`);
      } catch (error) {
        if (signOut || record.proof || !unavailable || !current || trust(current) === record.trust) throw error;
        setAside(dir, record);
        return;
      }
    } else {
      const local = record.local!;
      const store = workspaceSecretStore(target.root);
      const infra = await getSpaceAuth(store, target.space);
      if (!infra) throw new Error("local conversation retirement has no space authority");
      const stateDir = userAuthStateDir(target.root, target.space);
      const revoked = await provider.revokeAgent({ dir: stateDir, owner: local.owner, actor: local.actor,
        lifecycleUid: local.lifecycleUid, expectCustody: { kind: "foreground" },
        ...(local.sentinelCreds ? { actorToken: record.token } : {}) });
      if (!revoked && await provider.actorScope({ dir: stateDir, owner: local.owner, actor: local.actor }) !== undefined)
        throw new Error("the saved local conversation no longer matches its live grant; no broker footprint was removed");
      const creds = await mintCreds(infra, newIdentity(), "deprovisioner", { deprovisionTarget: {
        principal: principalKey(local.owner, local.actor).key, lifecycleUid: local.lifecycleUid } });
      await deprovisionAgent({ servers: target.server, space: target.space, targetId: principalKey(local.owner, local.actor).key,
        lifecycleUid: local.lifecycleUid, creds });
    }
    removeSavedIdentity(dir);
  } finally { lock.release(); }
}

function removeSavedIdentity(dir: string): void {
  const files = ["actor.token", "sentinel.creds", RECORD];
  if (readdirSync(dir).some((name) => !files.includes(name)))
    throw new Error("conversation identity directory contains unrecognized files; recovery state was retained");
  for (const file of files) {
    const path = join(dir, file);
    if (existsSync(path)) unlinkSync(path);
  }
  rmdirSync(dir);
  if (process.platform !== "win32") syncFile(dirname(dir));
}
