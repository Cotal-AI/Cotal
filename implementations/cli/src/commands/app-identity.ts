import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  agentFilePath,
  checkConversationSelection,
  CotalEndpoint,
  deprovisionAgent,
  isReachable,
  loadAgentFile,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  provisionAgent,
  resolveReadAcl,
  type ConversationGrant,
  type FlagSpec,
  type FlagValues,
  type ParsedArgs,
} from "@cotal-ai/core";
import { defaultPersonaRef, resolveTargetOrThrow, type MeshTarget } from "@cotal-ai/workspace";
import { liveMeshNames } from "../lib/live-names.js";
import { defaultPersonaFix } from "../lib/default-persona.js";
import { isUserAppDir, provisionUserApp, retireUserApp } from "../lib/app-user-identity.js";

/** Every credential directory provision makes is a fresh `mkdtemp` under the OS temp dir with this prefix. */
const CRED_DIR_PREFIX = "cotal-app-identity-";
/** The file in that directory that says what to retire. It carries no secret. */
const RECORD = "identity.json";

/**
 * `cotal app-identity`: machine-facing plumbing for a Claude app conversation on a local mesh. The
 * Claude connector's local server runs it to open one conversation's own identity on the selected
 * mesh, and again to retire it. It prints one JSON line on stdout and nothing else there. The
 * credential is never in that line: it goes to a 0600 file whose path the env names. A record beside
 * it names the identity, the mesh and the process that asked, so retire needs only the directory,
 * and a later provision retires what a process that died without retiring left behind.
 */
export const appIdentityFlags = [
  { name: "name", type: "string", value: "<name>", description: "provision: the agent name to open, exactly" },
  { name: "space", type: "string", value: "<space>", description: "the mesh to use; defaults as `cotal spawn` does" },
  { name: "dir", type: "string", value: "<dir>", description: "retire: the credential directory provision returned" },
  { name: "session", type: "string", value: "<id>", description: "provision: the native conversation identity" },
  { name: "events", type: "boolean", description: "provision: a real native transcript source is bound" },
  { name: "selection", type: "string", value: "<json>", description: "provision: channels, role and capabilities to request within your own grant" },
] as const satisfies readonly FlagSpec[];

/** What the record in a credential directory says. `owner` is the process that ran provision. */
interface IdentityRecord {
  space: string;
  id: string;
  lifecycleUid: string;
  owner: number;
}

export type AppIdentityReply =
  | { ok: true; env: Record<string, string>; retire?: { dir: string }; grant?: ConversationGrant }
  | { ok: false; taken: true }
  | { ok: false; error: string };

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
    reply({ ok: false, error: "usage: cotal app-identity provision --name <name> [--space <space>] | retire --dir <dir>" });
  } catch (e) {
    reply({ ok: false, error: errorText(e) });
  }
}

/** The mesh the conversation joins, resolved as a bare `cotal spawn` resolves it: `--space`, then
 *  the `cotal use` mesh, then the working directory's project, then the only one running. Without
 *  `--space` it first sweeps the registry, so a recorded mesh whose broker is down does not count
 *  as running. */
function target(space: string | undefined): Promise<MeshTarget> {
  return resolveTargetOrThrow(space ? { space } : {});
}

/** What to run when the persona a bare spawn loads is missing. `up` in the root of a space this
 *  machine started writes the `default` one; another name comes from `COTAL_DEFAULT_PERSONA`. */
function missingPersonaNext(persona: string, t: MeshTarget): string {
  if (persona !== "default") return "Create it, or point COTAL_DEFAULT_PERSONA at a persona that exists.";
  const fix = defaultPersonaFix(t);
  return fix.cwd ? `Run \`${fix.command}\` in ${fix.cwd} to write it.` : `Create it with \`${fix.command}\`.`;
}

async function provision(values: FlagValues<typeof appIdentityFlags>): Promise<AppIdentityReply> {
  const name = values.name?.trim();
  if (!name) return { ok: false, error: "provision needs --name <name>" };
  const selection = values.selection === undefined ? undefined : checkConversationSelection(JSON.parse(values.selection));
  const t = await target(values.space);
  if (t.mode === "user")
    return { ok: true, ...await provisionUserApp(t, name, values.session, values.events === true, selection) };
  if (selection) return { ok: false, error: `the mesh "${t.space}" has no signed-in identities, so a conversation cannot request a selection on it` };
  const taken = await liveMeshNames(t);
  if (!taken) return { ok: false, error: `the mesh "${t.space}" at ${t.server} is not answering. Start it with \`cotal up\`.` };
  if (taken.has(name)) return { ok: false, taken: true };
  // Channels and role come from the persona a bare `cotal spawn` loads. Its capabilities do not:
  // the remote surface offers no seat authority, so the credential carries none.
  const persona = defaultPersonaRef();
  let def: ReturnType<typeof loadAgentFile>;
  try {
    def = loadAgentFile(agentFilePath(t.root, persona));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return { ok: false, error: `no "${persona}" persona in ${t.personaRoot} for the mesh "${t.space}". ${missingPersonaNext(persona, t)}` };
    throw e;
  }
  // Derived as a foreground spawn derives them, and handed to the connector too, so the session's
  // runtime read and post sets match what its credential allows.
  const subscribe = def.subscribe ?? [];
  const channels = { subscribe, allowSubscribe: resolveReadAcl(subscribe, def.allowSubscribe), allowPublish: def.allowPublish ?? [] };
  const env: Record<string, string> = {
    COTAL_SPACE: t.space,
    COTAL_SERVERS: t.server,
    COTAL_NAME: name,
    COTAL_SUBSCRIBE: channels.subscribe.join(","),
    COTAL_ALLOW_SUBSCRIBE: channels.allowSubscribe.join(","),
    COTAL_ALLOW_PUBLISH: channels.allowPublish.join(","),
    ...(def.role ? { COTAL_ROLE: def.role } : {}),
  };
  if (!t.auth) return { ok: true, env };

  await retireOrphans();
  const identity = newIdentity();
  const lifecycleUid = mintLifecycleUid();
  const prov = new CotalEndpoint({
    space: t.space,
    servers: t.server,
    creds: await mintCreds(t.auth, newIdentity(), "provisioner"),
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: false,
    watchChannels: false,
    card: { name: "app-provisioner", role: "provisioner", kind: "endpoint" },
  });
  // The awaited calls below own the verdict; the provisioner's own events would only reach stdout.
  prov.on("error", () => {});
  const ignoreProvisionerWarning = () => {};
  prov.on("warning", ignoreProvisionerWarning);
  const dir = mkdtempSync(join(tmpdir(), CRED_DIR_PREFIX));
  // Written before anything reaches the broker, so a provision killed partway still leaves a record.
  const record: IdentityRecord = { space: t.space, id: identity.id, lifecycleUid, owner: process.ppid };
  writeFileSync(join(dir, RECORD), JSON.stringify(record), { mode: 0o600 });
  try {
    await prov.start();
    // The same durable footprint a foreground spawn provisions (DM and delivery durables, read-ACL
    // row), so a connection that blips misses nothing, and the same retirement removes it.
    const creds = await provisionAgent(prov, t.auth, identity, { ...channels, role: def.role, lifecycleUid });
    writeFileSync(join(dir, "agent.creds"), creds, { mode: 0o600 });
  } catch (e) {
    await prov.stop().catch(() => {});
    await retireDir(dir).catch(() => {});
    throw e;
  }
  await prov.stop();
  return { ok: true, env: { ...env, COTAL_CREDS: join(dir, "agent.creds"), COTAL_LIFECYCLE_UID: lifecycleUid }, retire: { dir } };
}

async function retire(values: FlagValues<typeof appIdentityFlags>): Promise<{ ok: true } | AppIdentityReply> {
  if (!values.dir) return { ok: false, error: "retire needs --dir <dir>" };
  if (isUserAppDir(values.dir)) await retireUserApp(values.dir);
  else await retireDir(values.dir);
  return { ok: true };
}

/** Remove what provision made in `dirArg`: on an auth mesh the identity's broker footprint first,
 *  with a deprovisioner credential pinned to that one identity, then the credential, the record and
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
    const creds = await mintCreds(t.auth, newIdentity(), "deprovisioner", { deprovisionTarget: { principal: record.id, lifecycleUid: record.lifecycleUid } });
    await deprovisionAgent({ servers: t.server, space: t.space, targetId: record.id, lifecycleUid: record.lifecycleUid, creds });
  }
  rmSync(join(dir, "agent.creds"), { force: true });
  rmSync(join(dir, RECORD), { force: true });
  if (existsSync(dir)) rmdirSync(dir);
}

/** Retire every credential directory of this user's whose owning process is gone: a host killed
 *  before it could retire. One that cannot be retired now stays for the next provision. */
async function retireOrphans(): Promise<void> {
  const uid = process.getuid?.();
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(CRED_DIR_PREFIX)) continue;
    const dir = join(tmpdir(), name);
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) continue;
      const record = JSON.parse(readFileSync(join(dir, RECORD), "utf8")) as IdentityRecord;
      if (alive(record.owner)) continue;
      await retireDir(dir);
    } catch {
      // Unreadable, half-written or unreachable: left for a later provision.
    }
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
