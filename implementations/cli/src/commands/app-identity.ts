import { existsSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  agentFilePath,
  CotalEndpoint,
  deprovisionAgent,
  isReachable,
  loadAgentFile,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  provisionAgent,
  resolveReadAcl,
  type FlagSpec,
  type FlagValues,
  type ParsedArgs,
} from "@cotal-ai/core";
import { defaultPersonaRef, resolveMeshTarget, type MeshTarget } from "@cotal-ai/workspace";
import { liveMeshNames } from "../lib/live-names.js";

/** Every credential directory provision makes is a fresh `mkdtemp` under the OS temp dir with this prefix. */
const CRED_DIR_PREFIX = "cotal-app-identity-";

/**
 * `cotal app-identity`: machine-facing plumbing for a Claude app conversation on a local mesh. The
 * Claude connector's local server runs it to open one conversation's own identity on the selected
 * mesh, and again to retire it. It prints one JSON line on stdout and nothing else there. The
 * credential is never in that line: it goes to a 0600 file whose path the env names.
 */
export const appIdentityFlags = [
  { name: "name", type: "string", value: "<name>", description: "provision: the agent name to open, exactly" },
  { name: "space", type: "string", value: "<space>", description: "the mesh to use; defaults as `cotal spawn` does" },
  { name: "id", type: "string", value: "<id>", description: "retire: the identity provision returned" },
  { name: "lifecycle-uid", type: "string", value: "<uid>", description: "retire: the lifecycle provision returned" },
  { name: "dir", type: "string", value: "<dir>", description: "retire: the credential directory provision returned" },
] as const satisfies readonly FlagSpec[];

/** What `provision` hands back for `retire`. */
export interface AppIdentityRetire {
  space: string;
  id: string;
  lifecycleUid: string;
  dir: string;
}

export type AppIdentityReply =
  | { ok: true; env: Record<string, string>; retire?: AppIdentityRetire }
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
    reply({ ok: false, error: "usage: cotal app-identity provision --name <name> | retire --space <s> --id <id> --lifecycle-uid <uid> --dir <dir>" });
  } catch (e) {
    reply({ ok: false, error: errorText(e) });
  }
}

/** The mesh the conversation joins, resolved the way a bare `cotal spawn` resolves it, from any
 *  directory: `--space`, then the `cotal use` mesh, then the only one running. */
function target(space: string | undefined): MeshTarget {
  return resolveMeshTarget(process.cwd(), space ? { space } : {});
}

async function provision(values: FlagValues<typeof appIdentityFlags>): Promise<AppIdentityReply> {
  const name = values.name?.trim();
  if (!name) return { ok: false, error: "provision needs --name <name>" };
  const t = target(values.space);
  if (t.mode === "user")
    return { ok: false, error: `the mesh "${t.space}" uses per-user sign-in, which a Claude app connection does not support yet. Use a mesh started with \`cotal up\`.` };
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
      return { ok: false, error: `no "${persona}" persona in ${t.personaRoot} for the mesh "${t.space}". Run \`cotal setup\` to seed one.` };
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
  const retireRef: AppIdentityRetire = { space: t.space, id: identity.id, lifecycleUid, dir };
  try {
    await prov.start();
    // The same durable footprint a foreground spawn provisions (DM and delivery durables, read-ACL
    // row), so a connection that blips misses nothing, and the same retirement removes it.
    const creds = await provisionAgent(prov, t.auth, identity, { ...channels, role: def.role, lifecycleUid });
    writeFileSync(join(dir, "agent.creds"), creds, { mode: 0o600 });
  } catch (e) {
    await prov.stop().catch(() => {});
    await retireIdentity(t, retireRef).catch(() => {});
    throw e;
  }
  await prov.stop();
  return { ok: true, env: { ...env, COTAL_CREDS: join(dir, "agent.creds"), COTAL_LIFECYCLE_UID: lifecycleUid }, retire: retireRef };
}

async function retire(values: FlagValues<typeof appIdentityFlags>): Promise<{ ok: true } | AppIdentityReply> {
  const { space, id, dir } = values;
  const lifecycleUid = values["lifecycle-uid"];
  if (!space || !id || !lifecycleUid || !dir) return { ok: false, error: "retire needs --space, --id, --lifecycle-uid and --dir" };
  await retireIdentity(target(space), { space, id, lifecycleUid, dir });
  return { ok: true };
}

/** Remove what provision made: the credential directory and, on an auth mesh, the identity's broker
 *  footprint, with a deprovisioner credential pinned to that one identity. The directory must be one
 *  provision's shape names, and only its credential file goes, so a wrong path removes nothing else. */
async function retireIdentity(t: MeshTarget, r: AppIdentityRetire): Promise<void> {
  const dir = resolve(r.dir);
  if (dirname(dir) !== resolve(tmpdir()) || !basename(dir).startsWith(CRED_DIR_PREFIX))
    throw new Error(`refusing to remove ${r.dir}: not a credential directory provision made`);
  rmSync(join(dir, "agent.creds"), { force: true });
  if (existsSync(dir)) rmdirSync(dir);
  if (!t.auth) return;
  if (!(await isReachable(t.server))) throw new Error(`the mesh "${t.space}" at ${t.server} is not answering, so ${r.id} keeps its broker footprint`);
  const creds = await mintCreds(t.auth, newIdentity(), "deprovisioner", { deprovisionTarget: { principal: r.id, lifecycleUid: r.lifecycleUid } });
  await deprovisionAgent({ servers: t.server, space: t.space, targetId: r.id, lifecycleUid: r.lifecycleUid, creds });
}
