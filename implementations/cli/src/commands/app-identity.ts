import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  acquireLock,
  agentFilePath,
  checkConversationSelection,
  DEV_OWNER,
  deprovisionAgent,
  eventChannel,
  isReachable,
  loadAgentFile,
  mintCreds,
  mintLifecycleUid,
  mkSecretDir,
  newIdentity,
  patternInAllow,
  provisionAgent,
  resolveReadAcl,
  type AgentDef,
  type ConversationGrant,
  type ConversationPending,
  type ConversationSelection,
  type FlagSpec,
  type FlagValues,
  type ParsedArgs,
} from "@cotal-ai/core";
import { activateTerminalSeat, defaultPersonaRef, homeCotalDir, issueTerminalSeat, resolveTargetOrThrow, retireTerminalSeat, type MeshTarget } from "@cotal-ai/workspace";
import { withProvisioner } from "../lib/provisioner.js";
import { defaultPersonaFix } from "../lib/default-persona.js";
import { liveMeshNames } from "../lib/live-names.js";
import { ConversationRefusal, ConversationRequestError, isUserAppDir, provisionUserApp, retireDeadUserApps, retireUserApp } from "../lib/app-user-identity.js";

/** Every conversation identity on an open or static mesh has a fresh `mkdtemp` directory under the
 *  OS temp dir with this prefix, which retire removes. */
const CRED_DIR_PREFIX = "cotal-app-identity-";
/** The file in that directory that says what to retire. It carries no secret. */
const RECORD = "identity.json";
/** A native conversation identity, as the hosts pass it. */
const SESSION = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * `cotal app-identity`: machine-facing plumbing for a personal app conversation. The local server
 * of the Claude or Codex plugin runs it to open one conversation's own identity on the selected
 * mesh, and again to retire it. It prints one JSON line on stdout and nothing else there. The credential is
 * never in that line: it goes to a 0600 file whose path the env names. Every identity belongs to the
 * native conversation the host names. On a signed-in mesh a new one opens only after a person
 * approves it at the mesh's authority. On an open or static mesh this computer runs, it opens with
 * the grant a bare `cotal spawn` gets there, and a static mesh's own signing authority issues it.
 */
export const appIdentityFlags = [
  { name: "name", type: "string", value: "<name>", description: "provision: the agent name to open, exactly" },
  { name: "space", type: "string", value: "<space>", description: "the mesh to use; defaults as `cotal spawn` does" },
  { name: "dir", type: "string", value: "<dir>", description: "retire: the credential directory provision returned" },
  { name: "session", type: "string", value: "<id>", description: "provision: the native conversation identity, required" },
  { name: "events", type: "boolean", description: "provision: a real native transcript source is bound" },
  { name: "selection", type: "string", value: "<json>", description: "provision: channels, role and capabilities to request within your own grant" },
  // Every provision on a signed-in mesh needs a person's approval, with or without this flag. A caller
  // passes it so that an earlier CLI, which opened signed-in identities without approval, refuses
  // the unknown flag first.
  { name: "require-approval", type: "boolean", description: "provision: on a signed-in mesh, the caller accepts only an identity a person approved" },
] as const satisfies readonly FlagSpec[];

/** What the record in a credential directory says. `owner` is the process that ran provision and
 *  `session` the native conversation it serves. `alias` marks an identity issued as a terminal seat
 *  on a static mesh. A record from before native sessions carries neither. */
interface IdentityRecord {
  space: string;
  id: string;
  lifecycleUid: string;
  owner: number;
  session?: string;
  alias?: string;
}

/** `pending` names the request a person has not decided yet and the page where they decide it. It
 *  carries no credential, secret or path. Provisioning again replays that same request. `refused`
 *  says the authority recorded a decision that issued nothing and the saved request is gone; any
 *  other error leaves the request saved for the next replay. `retryable: false` stops automatic
 *  polling without asserting that the identity was never issued. */
export type AppIdentityReply =
  | { ok: true; env: Record<string, string>; retire?: { dir: string }; grant?: ConversationGrant }
  | ({ ok: false; pending: true } & ConversationPending)
  | { ok: false; taken: true }
  | { ok: false; error: string; refused?: ConversationRefusal["decision"]; retryable?: boolean };

function reply(r: AppIdentityReply | { ok: true }): void {
  process.stdout.write(`${JSON.stringify(r)}\n`);
  process.exitCode = r.ok ? 0 : 1;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function appIdentity(args: ParsedArgs): Promise<void> {
  const values = args.values as FlagValues<typeof appIdentityFlags>;
  const verb = args.positionals[0];
  try {
    if (verb === "provision" && args.positionals.length === 1) return reply(await provision(values));
    if (verb === "retire" && args.positionals.length === 1) return reply(await retire(values));
    if (verb === "reap" && args.positionals.length === 1) return reply(await reap(values));
    reply({ ok: false, error: "usage: cotal app-identity provision --name <name> [--space <space>] | retire --dir <dir> | reap [--space <space>]" });
  } catch (e) {
    reply({ ok: false, error: errorText(e), ...(e instanceof ConversationRefusal ? { refused: e.decision } : {}),
      ...(e instanceof ConversationRequestError ? { retryable: e.retryable } : {}) });
  }
}

/** The mesh the conversation joins, resolved as a bare `cotal spawn` resolves it: `--space`, then
 *  the `cotal use` mesh, then the working directory's project, then the only one running. Without
 *  `--space` it first sweeps the registry, so a recorded mesh whose broker is down does not count
 *  as running. A present `--space` that is blank is not a default: it names no mesh. */
function target(space: string | undefined): Promise<MeshTarget> {
  if (space !== undefined && !space.trim()) throw new Error("--space needs a space name; a blank name selects no mesh");
  return resolveTargetOrThrow(space !== undefined ? { space } : {});
}

async function provision(values: FlagValues<typeof appIdentityFlags>): Promise<AppIdentityReply> {
  const name = values.name?.trim();
  if (!name) return { ok: false, error: "provision needs --name <name>" };
  const selection = values.selection === undefined ? undefined : checkConversationSelection(JSON.parse(values.selection));
  const t = await target(values.space);
  if (t.mode === "user") {
    const connection = await provisionUserApp(t, name, values.session, values.events === true, selection);
    return "pending" in connection ? { ok: false, pending: true, ...connection.pending } : { ok: true, ...connection };
  }
  // What a host that died without retiring left behind is retired first.
  await retireOrphans();
  return provisionLocal(t, name, values.session, values.events === true, selection);
}

/** What to run when the persona a bare spawn loads is missing. `up` in the root of a space this
 *  machine started writes the `default` one; another name comes from `COTAL_DEFAULT_PERSONA`. */
function missingPersonaNext(persona: string, t: MeshTarget): string {
  if (persona !== "default") return "Create it, or point COTAL_DEFAULT_PERSONA at a persona that exists.";
  const fix = defaultPersonaFix(t);
  return fix.cwd ? `Run \`${fix.command}\` in ${fix.cwd} to write it.` : `Create it with \`${fix.command}\`.`;
}

/** The grant a conversation gets on an open or static mesh: the channels, role and capabilities of
 *  the persona a bare `cotal spawn` loads there, or the part of them a selection names. A selection
 *  only narrows, and an item the persona does not hold refuses the whole request. */
function localGrant(def: AgentDef, selection?: ConversationSelection): { subscribe: string[]; grant: ConversationGrant } {
  const subscribe = def.subscribe ?? [];
  const allowSubscribe = resolveReadAcl(subscribe, def.allowSubscribe);
  const allowPublish = def.allowPublish ?? [];
  const role = def.role ?? null;
  const scope = def.capabilities ?? [];
  if (!selection) return { subscribe, grant: { scope, role, allowSubscribe, allowPublish, subscribe: [] } };
  for (const capability of selection.capabilities.filter((c) => !c.startsWith("role:")))
    if (!scope.includes(capability)) throw new Error(`capability "${capability}" is not within what this mesh's default persona grants; nothing was opened`);
  if (selection.role !== null && selection.role !== role)
    throw new Error(`the role "${selection.role}" is not within what this mesh's default persona grants; nothing was opened`);
  for (const { channel, access } of selection.channels)
    if (!patternInAllow(allowSubscribe, channel) || (access === "read-post" && !patternInAllow(allowPublish, channel)))
      throw new Error(`channel "${channel}" (${access}) is not within what this mesh's default persona grants; nothing was opened`);
  return { subscribe: [], grant: {
    scope: [...selection.capabilities], role: selection.role, subscribe: [], endpoints: [],
    allowSubscribe: selection.channels.map((c) => c.channel),
    allowPublish: selection.channels.filter((c) => c.access === "read-post").map((c) => c.channel),
  } };
}

/** Open one native conversation's identity on an open or static mesh this computer runs. A static
 *  mesh's own signing authority issues it as a terminal seat (SPEC 13.15) scoped to its grant, with
 *  the durable footprint of a foreground spawn; the credential stays in this account's private
 *  files. An open mesh takes no credential. Either way a record names the conversation, so the
 *  conversation holds one identity at a time and what its host leaves behind is retired. */
async function provisionLocal(t: MeshTarget, name: string, session: string | undefined, events: boolean, selection?: ConversationSelection): Promise<AppIdentityReply> {
  if (!session || !SESSION.test(session))
    return { ok: false, error: `a conversation needs its native session identity before connecting, and this app supplies none; nothing was opened on "${t.space}"` };
  const root = join(homeCotalDir(), "app-identities");
  mkSecretDir(root);
  const lock = acquireLock(join(root, `session-${createHash("sha256").update(session).digest("hex")}.lock`), { waitMs: 0 });
  try { return await provisionLocalLocked(t, name, session, events, selection); }
  finally { lock.release(); }
}

async function provisionLocalLocked(t: MeshTarget, name: string, session: string, events: boolean, selection?: ConversationSelection): Promise<AppIdentityReply> {
  if (t.mode === "auth" && !t.auth)
    return { ok: false, error: `the mesh "${t.space}" takes static credentials, and this account holds no signing authority for it in ${t.root}, so no identity was opened` };
  if (t.policy?.events === "required" && !events)
    return { ok: false, error: "this mesh requires a real native conversation event source; no identity was opened" };
  const held = localRecords().find(({ record }) => record.session === session && alive(record.owner));
  if (held) return { ok: false, error: `this native conversation already has a live identity on "${held.record.space}"; disconnect it before connecting again` };
  const taken = await liveMeshNames(t);
  if (!taken) return { ok: false, error: `the mesh "${t.space}" at ${t.server} is not answering. Start it with \`cotal up\`.` };
  if (taken.has(name)) return { ok: false, taken: true };
  const persona = defaultPersonaRef();
  let def: AgentDef;
  try {
    def = loadAgentFile(agentFilePath(t.root, persona));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return { ok: false, error: `no "${persona}" persona in ${t.personaRoot} for the mesh "${t.space}". ${missingPersonaNext(persona, t)}` };
    throw e;
  }
  const { subscribe, grant } = localGrant(def, selection);
  const identity = newIdentity();
  const lifecycleUid = mintLifecycleUid();
  // The conversation publishes its own activity on its own event channel, as a spawned seat does.
  const allowPublish = events ? [eventChannel({ owner: DEV_OWNER, actor: identity.id }), ...grant.allowPublish] : grant.allowPublish;
  const env: Record<string, string> = {
    COTAL_SPACE: t.space, COTAL_SERVERS: t.server, COTAL_NAME: name, COTAL_TLS: t.tlsRequired ? "1" : "0",
    COTAL_ID: identity.id, COTAL_LIFECYCLE_UID: lifecycleUid, COTAL_CAPABILITIES: grant.scope.join(","),
    COTAL_SUBSCRIBE: subscribe.join(","), COTAL_ALLOW_SUBSCRIBE: grant.allowSubscribe.join(","), COTAL_ALLOW_PUBLISH: allowPublish.join(","),
    ...(grant.role ? { COTAL_ROLE: grant.role } : {}), COTAL_WORKSPACE_ROOT: homeCotalDir(), ...(events ? { COTAL_EVENTS: "1" } : {}),
    ...(t.policy?.events === "required" ? { COTAL_EVENTS_REQUIRED: "1" } : {}),
  };
  const dir = mkdtempSync(join(tmpdir(), CRED_DIR_PREFIX));
  // Written before anything reaches the broker, so a provision killed partway still leaves a record.
  const record: IdentityRecord = { space: t.space, id: identity.id, lifecycleUid, owner: process.ppid, session, ...(t.auth ? { alias: name } : {}) };
  writeFileSync(join(dir, RECORD), JSON.stringify(record), { mode: 0o600 });
  const reply = { ok: true as const, env, retire: { dir }, grant: { ...grant, allowPublish } };
  if (!t.auth) return reply;
  const auth = t.auth;
  const seatTarget = { server: t.server, space: t.space, tlsRequired: t.tlsRequired, auth };
  const seat = { actor: identity.id, alias: name, lifecycleUid };
  let acceptedToken: string;
  try {
    const creds = await withProvisioner({ space: t.space, servers: t.server, tls: t.tlsRequired, auth }, "app-provisioner", async (prov) => {
      await activateTerminalSeat(seatTarget, seat);
      return issueTerminalSeat(seatTarget, seat, undefined, (issue) => {
        acceptedToken = issue.issued.acceptedToken;
        return provisionAgent(prov, auth, identity, {
          subscribe, allowSubscribe: grant.allowSubscribe, allowPublish, ...(grant.role ? { role: grant.role } : {}), capabilities: grant.scope,
          lifecycleUid, expiresAt: issue.expiresAt, issued: issue.issued, issuance: issue.issuance,
        });
      });
    });
    writeFileSync(join(dir, "agent.creds"), creds, { mode: 0o600 });
  } catch (e) {
    await retireDir(dir).catch(() => {});
    throw e;
  }
  return { ...reply, env: { ...env, COTAL_CREDS: join(dir, "agent.creds"), COTAL_ACCEPTED_TOKEN: acceptedToken! } };
}

async function retire(values: FlagValues<typeof appIdentityFlags>): Promise<{ ok: true } | AppIdentityReply> {
  if (!values.dir) return { ok: false, error: "retire needs --dir <dir>" };
  if (isUserAppDir(values.dir)) await retireUserApp(values.dir);
  else await retireDir(values.dir);
  return { ok: true };
}

/** On a signed-in mesh, retire the saved conversations whose server process has exited. The
 *  connector runs this after a connection, so the connection never waits for that cleanup. */
async function reap(values: FlagValues<typeof appIdentityFlags>): Promise<{ ok: true }> {
  const t = await target(values.space);
  if (t.mode === "user") await retireDeadUserApps(t);
  return { ok: true };
}

/** Remove what provision made in `dirArg`: on an auth mesh the identity's issuance gate and broker
 *  footprint first, with credentials pinned to that one identity, then the credential, the record and
 *  the directory. The directory must have provision's shape, and only those two files go, so a wrong
 *  path removes nothing else. When the broker footprint cannot be removed the files stay, so a
 *  later attempt still knows what to retire. */
async function retireDir(dirArg: string): Promise<void> {
  const dir = resolve(dirArg);
  if (dirname(dir) !== resolve(tmpdir()) || !basename(dir).startsWith(CRED_DIR_PREFIX) || !lstatSync(dir, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`refusing to remove ${dirArg}: not a credential directory provision made`);
  const record = JSON.parse(readFileSync(join(dir, RECORD), "utf8")) as IdentityRecord;
  const t = await target(record.space);
  if (t.auth) {
    if (!(await isReachable(t.server))) throw new Error(`the mesh "${t.space}" at ${t.server} is not answering, so ${record.id} keeps its broker footprint`);
    if (record.alias)
      await retireTerminalSeat({ server: t.server, space: t.space, tlsRequired: t.tlsRequired, auth: t.auth },
        { actor: record.id, alias: record.alias, lifecycleUid: record.lifecycleUid });
    const creds = await mintCreds(t.auth, newIdentity(), "deprovisioner", { deprovisionTarget: { principal: record.id, lifecycleUid: record.lifecycleUid } });
    await deprovisionAgent({ servers: t.server, space: t.space, targetId: record.id, lifecycleUid: record.lifecycleUid, creds });
  }
  rmSync(join(dir, "agent.creds"), { force: true });
  rmSync(join(dir, RECORD), { force: true });
  if (existsSync(dir)) rmdirSync(dir);
}

/** This user's credential directories with a readable record. Unreadable or half-written ones are
 *  left for a later provision. */
function localRecords(): Array<{ dir: string; record: IdentityRecord }> {
  const uid = process.getuid?.();
  return readdirSync(tmpdir()).flatMap((name) => {
    if (!name.startsWith(CRED_DIR_PREFIX)) return [];
    const dir = join(tmpdir(), name);
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) return [];
      return [{ dir, record: JSON.parse(readFileSync(join(dir, RECORD), "utf8")) as IdentityRecord }];
    } catch {
      return [];
    }
  });
}

/** Retire every credential directory of this user's whose owning process is gone: a host killed
 *  before it could retire. One that cannot be retired now stays for the next provision. */
async function retireOrphans(): Promise<void> {
  for (const { dir, record } of localRecords()) {
    if (alive(record.owner)) continue;
    await retireDir(dir).catch(() => {});
  }
}

/** Whether `pid` names a running process. A reused pid reads as alive, so its directory is kept. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
