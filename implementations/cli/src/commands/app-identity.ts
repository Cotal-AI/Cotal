import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  checkConversationSelection,
  deprovisionAgent,
  isReachable,
  mintCreds,
  newIdentity,
  type ConversationGrant,
  type ConversationPending,
  type FlagSpec,
  type FlagValues,
  type ParsedArgs,
} from "@cotal-ai/core";
import { resolveTargetOrThrow, type MeshTarget } from "@cotal-ai/workspace";
import { isUserAppDir, provisionUserApp, retireDeadUserApps, retireUserApp } from "../lib/app-user-identity.js";

/** Every credential directory an earlier static-mesh provision made was a fresh `mkdtemp` under the
 *  OS temp dir with this prefix. Provision makes none now; retire still removes them. */
const CRED_DIR_PREFIX = "cotal-app-identity-";
/** The file in that directory that says what to retire. It carries no secret. */
const RECORD = "identity.json";

/**
 * `cotal app-identity`: machine-facing plumbing for a Claude app conversation. The Claude
 * connector's local server runs it to open one conversation's own identity on the selected mesh,
 * and again to retire it. It prints one JSON line on stdout and nothing else there. The credential is
 * never in that line: it goes to a 0600 file whose path the env names. A new identity opens only
 * after a person approves it at the mesh's authority, so a mesh without one opens none.
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

/** `pending` names the request a person has not decided yet and the page where they decide it. It
 *  carries no credential, secret or path. Provisioning again replays that same request. */
export type AppIdentityReply =
  | { ok: true; env: Record<string, string>; retire?: { dir: string }; grant?: ConversationGrant }
  | ({ ok: false; pending: true } & ConversationPending)
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
    if (verb === "reap" && args.positionals.length === 1) return reply(await reap(values));
    reply({ ok: false, error: "usage: cotal app-identity provision --name <name> [--space <space>] | retire --dir <dir> | reap [--space <space>]" });
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

async function provision(values: FlagValues<typeof appIdentityFlags>): Promise<AppIdentityReply> {
  const name = values.name?.trim();
  if (!name) return { ok: false, error: "provision needs --name <name>" };
  const selection = values.selection === undefined ? undefined : checkConversationSelection(JSON.parse(values.selection));
  const t = await target(values.space);
  if (t.mode === "user") {
    const connection = await provisionUserApp(t, name, values.session, values.events === true, selection);
    return "pending" in connection ? { ok: false, pending: true, ...connection.pending } : { ok: true, ...connection };
  }
  // A static or open mesh has no authority where a person approves a connection, so it opens none.
  // What a host that died without retiring left behind is still retired here.
  await retireOrphans();
  return { ok: false, error: `the mesh "${t.space}" has no human approval for app conversations, so no identity was opened; connect through a signed-in mesh whose authority offers connection approval` };
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
