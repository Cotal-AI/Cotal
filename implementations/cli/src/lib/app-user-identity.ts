import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  CotalEndpoint, acquireLock, assertLifecycleToken, deprovisionAgent, eventChannel,
  mintCreds, mintLifecycleUid, mkSecretDir, newIdentity, principalKey, provisionAgentDurables,
  processStartToken, resolveAuthProvider, writeSecretFileAtomic, type AuthProvider,
} from "@cotal-ai/core";
import { getSpaceAuth, homeCotalDir, resolveTargetOrThrow, userAuthStateDir, workspaceSecretStore, type MeshTarget } from "@cotal-ai/workspace";
import { checkConversationMaterial, conversationRetired, discoverConversationAuthority, type ConversationMaterial } from "./conversation-identity.js";

interface SavedIdentity {
  v: 1;
  space: string;
  root: string;
  trust: string;
  session: string;
  requestId: string;
  label: string;
  token: string;
  state: "creating" | "ready" | "retiring";
  consumer: { pid: number; start?: string };
  remote?: { url: string; idpUrl: string; material?: ConversationMaterial };
  local?: { owner: string; actor: string; lifecycleUid: string; sentinelCreds?: string };
}

const RECORD = "identity.json";
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const identityRoot = (): string => join(homeCotalDir(), "app-identities");
const trust = (t: MeshTarget): string => hash(JSON.stringify({ space: t.space, root: t.root, server: t.server, tlsRequired: t.tlsRequired, userAuth: t.userAuth }));

function syncFile(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function save(dir: string, record: SavedIdentity): void {
  writeSecretFileAtomic(join(dir, RECORD), JSON.stringify(record));
  syncFile(join(dir, RECORD));
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
      !/^[A-Za-z0-9_-]{43}$/.test(record.token) || !["creating", "ready", "retiring"].includes(record.state) ||
      !record.consumer || !Number.isInteger(record.consumer.pid) || record.consumer.pid <= 0 ||
      Boolean(record.remote) === Boolean(record.local))
    throw new Error("conversation identity recovery record is invalid; it was retained");
  return record;
}

function consumerAlive(consumer: SavedIdentity["consumer"]): boolean {
  try { process.kill(consumer.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  const start = processStartToken(consumer.pid);
  return !consumer.start || !start || start === consumer.start;
}

function request(provider: AuthProvider): NonNullable<AuthProvider["requestConversationIdentity"]> {
  if (!provider.requestConversationIdentity) throw new Error("the auth provider does not support conversation identity authority");
  return provider.requestConversationIdentity.bind(provider);
}

/** The session key is supplied by the native host, not guessed from a parent pid or an open inbox. */
export async function provisionUserApp(target: MeshTarget, name: string, session: string | undefined, events: boolean): Promise<{ env: Record<string, string>; retire: { dir: string } }> {
  if (!session || !/^[A-Za-z0-9_-]{1,128}$/.test(session))
    throw new Error("a signed-in conversation needs its native session identity before connecting");
  const store = workspaceSecretStore(target.root);
  const infra = target.userAuth?.remote === true ? undefined : await getSpaceAuth(store, target.space);
  const authority = infra ? undefined : await discoverConversationAuthority(target);
  const policy = authority?.bundle.policy ?? target.policy;
  if (policy?.events === "required" && !events)
    throw new Error("this mesh requires a real native conversation event source; no identity was requested");
  const provider = resolveAuthProvider();
  if (authority) request(provider);
  const root = identityRoot();
  mkSecretDir(root);
  privateDir(root);
  const dir = join(root, hash(`${target.space}\0${session}`));
  // A reconnect first finishes the previous explicit departure. Only a confirmed terminal
  // retirement can release this session key for a new request and a new secret.
  if (existsSync(join(dir, RECORD)) && read(dir).state === "retiring") await retireUserApp(dir);
  const lock = acquireLock(`${dir}.lock`, { waitMs: 0 });
  try {
    let record: SavedIdentity;
    if (existsSync(join(dir, RECORD))) {
      record = read(dir);
      if (record.session !== session || record.trust !== trust(target) || record.label !== name)
        throw new Error("this conversation has a saved identity under different mesh pins or a different name; disconnect it before connecting again");
      if (record.state === "retiring") throw new Error("this conversation's prior identity is still retiring; retry disconnect before connecting again");
      if (record.consumer.pid !== process.ppid && consumerAlive(record.consumer))
        throw new Error("this native conversation still has a live inbox consumer; no identity was reissued");
      record.consumer = { pid: process.ppid, start: processStartToken(process.ppid) };
      save(dir, record);
    } else {
      mkSecretDir(dir);
      privateDir(dir);
      if (readdirSync(dir).length) throw new Error("conversation identity state is incomplete; it was retained for recovery");
      const token = randomBytes(32).toString("base64url");
      record = {
        v: 1, space: target.space, root: target.root, trust: trust(target), session,
        requestId: randomBytes(24).toString("base64url"), label: name, token, state: "creating",
        consumer: { pid: process.ppid, start: processStartToken(process.ppid) },
        ...(authority ? { remote: { url: authority.url, idpUrl: target.userAuth!.idp.url } }
          : { local: { owner: await provider.ownerForLogin({ store, dir: userAuthStateDir(target.root, target.space), space: target.space }),
              actor: `pa_${randomBytes(16).toString("hex")}`, lifecycleUid: mintLifecycleUid() } }),
      };
      save(dir, record);
      if (process.platform !== "win32") { syncFile(root); syncFile(dirname(root)); }
    }
    if (record.remote) {
      if (!authority || record.remote.url !== authority.url || record.remote.idpUrl !== target.userAuth?.idp.url)
        throw new Error("conversation identity authority changed; the saved identity was retained");
      const response = await request(provider)({
        url: authority.url, idpUrl: record.remote.idpUrl, method: "POST",
        body: { v: 1, requestId: record.requestId, tokenHash: hash(record.token), label: record.label },
      });
      if (response.status !== 200 && response.status !== 201)
        throw new Error(`conversation identity creation answered HTTP ${response.status}; its original request was retained for recovery`);
      const material = checkConversationMaterial(response.body, authority, record.requestId);
      if (record.remote.material && JSON.stringify(record.remote.material) !== JSON.stringify(material))
        throw new Error("conversation identity replay changed its saved lifecycle or grant");
      record.remote.material = material;
    } else {
      const local = record.local!;
      const stateDir = userAuthStateDir(target.root, target.space);
      if (!local.sentinelCreds) {
        if (await provider.actorScope({ dir: stateDir, owner: local.owner, actor: local.actor }) !== undefined)
          throw new Error("a local conversation grant has an unconfirmed secret; disconnect its saved lifecycle before connecting again");
        const grant = await provider.grantAgent({ store, dir: stateDir, space: target.space, owner: local.owner, actor: local.actor,
          fresh: true, lifecycleUid: local.lifecycleUid, custody: { kind: "foreground" }, scope: [], allowSubscribe: [],
          allowPublish: [eventChannel(local)], parent: `${local.owner}.cli`, label: name });
        record.token = grant.actorToken;
        local.sentinelCreds = grant.sentinelCreds;
        save(dir, record);
      }
      const provisioner = new CotalEndpoint({ space: target.space, servers: target.server,
        creds: await mintCreds(infra!, newIdentity(), "provisioner"), channels: [], consume: false,
        registerPresence: false, watchPresence: false, watchChannels: false,
        card: { name: "app-provisioner", kind: "endpoint" } });
      provisioner.on("error", () => {});
      provisioner.on("warning", () => {});
      try {
        await provisioner.start();
        await provisionAgentDurables(provisioner, local, { subscribe: [], allowSubscribe: [] });
      } finally { await provisioner.stop(); }
    }
    record.state = "ready";
    save(dir, record);
    const material = record.remote?.material ?? record.local!;
    writeSecretFileAtomic(join(dir, "actor.token"), record.token);
    writeSecretFileAtomic(join(dir, "sentinel.creds"), material.sentinelCreds!);
    const bearer = [process.execPath, ...process.execArgv, process.argv[1]!, provider.agentBearerCommand,
      ...(record.remote ? ["--exchange-url", record.remote.material!.exchangeUrl] : ["--dir", userAuthStateDir(target.root, target.space)]),
      "--space", target.space, "--owner", material.owner, "--actor", material.actor, "--token-file", join(dir, "actor.token")];
    return { env: {
      COTAL_SPACE: target.space, COTAL_SERVERS: target.server, COTAL_NAME: name, COTAL_TLS: target.tlsRequired ? "1" : "0",
      COTAL_OWNER: material.owner, COTAL_ACTOR: material.actor, COTAL_LIFECYCLE_UID: material.lifecycleUid,
      COTAL_SENTINEL_CREDS: join(dir, "sentinel.creds"), COTAL_BEARER_CMD: JSON.stringify(bearer),
      COTAL_SUBSCRIBE: "", COTAL_ALLOW_SUBSCRIBE: "", COTAL_ALLOW_PUBLISH: eventChannel(material),
      COTAL_WORKSPACE_ROOT: homeCotalDir(), ...(events ? { COTAL_EVENTS: "1" } : {}),
      ...(policy?.events === "required" ? { COTAL_EVENTS_REQUIRED: "1" } : {}),
    }, retire: { dir } };
  } finally { lock.release(); }
}

export function isUserAppDir(dir: string): boolean {
  return dirname(resolve(dir)) === resolve(identityRoot()) && /^[a-f0-9]{64}$/.test(basename(dir));
}

/** Retain the record and secret until exact lifecycle revocation and footprint cleanup are observed. */
export async function retireUserApp(dir: string): Promise<void> {
  if (!isUserAppDir(dir)) throw new Error("not a saved conversation identity directory");
  const lock = acquireLock(`${dir}.lock`, { waitMs: 0 });
  try {
    const record = read(dir);
    const target = await resolveTargetOrThrow({ space: record.space });
    if (trust(target) !== record.trust) throw new Error("conversation identity mesh trust changed; retirement was not sent");
    const provider = resolveAuthProvider();
    record.state = "retiring";
    save(dir, record);
    if (record.remote) {
      const authority = await discoverConversationAuthority(target);
      if (authority.url !== record.remote.url || record.remote.idpUrl !== target.userAuth?.idp.url)
        throw new Error("conversation identity authority changed; recovery was not sent");
      let material = record.remote.material;
      if (!material) {
        const replay = await request(provider)({ url: authority.url, idpUrl: record.remote.idpUrl, method: "POST",
          body: { v: 1, requestId: record.requestId, tokenHash: hash(record.token), label: record.label } });
        if (replay.status !== 200 && replay.status !== 201)
          throw new Error(`conversation identity recovery answered HTTP ${replay.status}; its original request was retained`);
        material = checkConversationMaterial(replay.body, authority, record.requestId);
        record.remote.material = material;
        save(dir, record);
      }
      material = checkConversationMaterial(material, authority, record.requestId);
      const expected = new URL(`${authority.url}/${material.actor}`);
      expected.searchParams.set("lifecycleUid", assertLifecycleToken(material.lifecycleUid));
      if (material.retire.url !== expected.href) throw new Error("saved retirement URL does not name the exact lifecycle");
      const response = await request(provider)({ url: expected.href, idpUrl: record.remote.idpUrl, method: "DELETE" });
      if (!conversationRetired(response.status, response.body, material))
        throw new Error("conversation identity retirement is pending; retry disconnect for this saved lifecycle");
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
    const files = ["actor.token", "sentinel.creds", RECORD];
    if (readdirSync(dir).some((name) => !files.includes(name)))
      throw new Error("conversation identity directory contains unrecognized files; recovery state was retained");
    for (const file of files) {
      const path = join(dir, file);
      if (existsSync(path)) unlinkSync(path);
    }
    rmdirSync(dir);
    if (process.platform !== "win32") syncFile(identityRoot());
  } finally { lock.release(); }
}
