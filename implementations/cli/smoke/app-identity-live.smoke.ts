/**
 * `cotal app-identity`: the plumbing the Claude and Codex plugins run to open one native
 * conversation's own identity, and to retire it. On a static-credential mesh this computer runs, the
 * space's own signing authority issues a terminal seat scoped to the default persona's grant; on an
 * open mesh nothing is issued. Either way the identity belongs to the native session the host names,
 * and a later provision retires what a host that died left behind. A signed-in mesh still needs a
 * person's approval; conversation-approval-live covers that.
 *
 * Live: throwaway JWT-auth and open brokers on OS-assigned ports, meshes registered in a temp
 * COTAL_HOME, and the command run in-process with its stdout captured, because stdout is the whole
 * contract: one JSON line, never the credential.
 *
 * Needs `nats-server` on PATH, as the rest of smoke:ci does.
 * Run: pnpm smoke:app-identity:live
 */
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { SMOKE_BROKER_TOKEN, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

if (process.argv[2] === "--fixture-provision") {
  const { appIdentity } = await import("../src/commands/app-identity.js");
  await appIdentity({ positionals: ["provision"], values: JSON.parse(process.argv[3]!), raw: [] });
  process.exit(Number(process.exitCode ?? 0));
}

const home = mkdtempSync(join(tmpdir(), "cotal-appid-smoke-home-"));
process.env.COTAL_HOME = home;
process.env.COTAL_NO_PROMPT = "1";
delete process.env.COTAL_DEFAULT_PERSONA;

const {
  conversationSelection, createSpaceAuth, deprovisionAgent, dialerFor, epAuthBucket, epCallerGrantRows, eventChannel, isReachable, mintCreds, mintLifecycleUid,
  newIdentity, provisionAgent, readAcceptedRow, seedChannelRegistry, setupSpaceStreams, spawnCallerCapabilities, standaloneConnectOpts, withIssuerSession, CotalEndpoint, DEV_OWNER,
} = await import("@cotal-ai/core");
const { authDir, recordMesh, saveSpaceAuth } = await import("@cotal-ai/workspace");
const { meshes } = await import("../src/commands/meshes.js");
const { appIdentity } = await import("../src/commands/app-identity.js");
const { bootBroker } = await import("../../manager/smoke/_boot-broker.js");

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (test: () => boolean | Promise<boolean>, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await wait(100)) if (await test()) return true;
  return false;
};

/** Run `cotal app-identity …` in-process and return what it wrote to stdout and its exit code. */
async function run(positionals: string[], values: Record<string, unknown>): Promise<{ out: string; code: number; reply: any }> {
  const chunks: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => (chunks.push(String(chunk)), true)) as typeof process.stdout.write;
  try {
    await appIdentity({ positionals, values, raw: [] } as never);
  } finally {
    process.stdout.write = write;
  }
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  const out = chunks.join("");
  let reply: any;
  try {
    reply = JSON.parse(out);
  } catch {
    reply = undefined;
  }
  return { out, code, reply };
}

/** Separate CLI processes compete for the same native conversation, not a shared JS invocation. */
function provisionChild(values: Record<string, unknown>): Promise<{ ok: boolean; retire?: { dir: string } }> {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_")));
    const child = spawn(process.execPath, [...process.execArgv, import.meta.filename, "--fixture-provision", JSON.stringify(values)], {
      env: { ...env, COTAL_HOME: home, COTAL_NO_PROMPT: "1" }, stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.on("error", reject);
    child.on("close", () => {
      try { resolve(JSON.parse(output)); } catch { reject(new Error("fixture provision returned no JSON result")); }
    });
  });
}

/** `cotal meshes …` in-process; it reports through console and process.exit. */
class ExitSignal extends Error {}
async function runMeshes(positionals: string[], values: Record<string, unknown>): Promise<number> {
  const [log, err, exit] = [console.log, console.error, process.exit];
  let code = 0;
  console.log = () => {};
  console.error = () => {};
  process.exit = ((c?: number) => { code = c ?? 0; throw new ExitSignal(); }) as never;
  try {
    await meshes({ positionals, values, raw: [] } as never);
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
  } finally {
    console.log = log; console.error = err; process.exit = exit;
  }
  return code;
}

interface Held { dir: string; space: string; id: string; lifecycleUid: string; owner: number; session?: string; alias?: string }
/** This suite's identity directories on `space`, with their records. */
const records = (space: string): Held[] => readdirSync(tmpdir()).filter((n) => n.startsWith("cotal-app-identity-")).flatMap((n) => {
  try {
    const record = JSON.parse(readFileSync(join(tmpdir(), n, "identity.json"), "utf8")) as Omit<Held, "dir">;
    return record.space === space ? [{ dir: join(tmpdir(), n), ...record }] : [];
  } catch { return []; }
});
const record = (dir: string): Held => ({ dir, ...JSON.parse(readFileSync(join(dir, "identity.json"), "utf8")) });
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;
const secretShaped = /BEGIN NATS|NKEY SEED|-----BEGIN|\bSU[A-Z2-7]{50,}/;

const SPACE = `appmesh${process.pid}`;
const OPEN = `appopen${process.pid}`;
const NOAUTH = `appnoauth${process.pid}`;
// The persona a bare `cotal spawn` loads: it reads wider than it posts.
const PERSONA = "---\nname: default\nrole: default\nsubscribe: [general]\nallowSubscribe: [general, team.>]\nallowPublish: [general]\ncapabilities: [spawn, run]\n---\n\nA personal conversation.\n";
const root = mkdtempSync(join(tmpdir(), "cotal-appid-smoke-root-"));
const openRoot = mkdtempSync(join(tmpdir(), "cotal-appid-smoke-open-"));
const noAuthRoot = mkdtempSync(join(tmpdir(), "cotal-appid-smoke-noauth-"));
for (const r of [root, openRoot, noAuthRoot]) {
  mkdirSync(join(r, ".cotal", "agents"), { recursive: true });
  writeFileSync(join(r, ".cotal", "agents", "default.md"), PERSONA);
}
const userRoot = mkdtempSync(join(tmpdir(), "cotal-appid-smoke-user-"));
const auth = await createSpaceAuth(SPACE);
const broker = await bootBroker(auth);
const openServers = `nats://127.0.0.1:${await freePort()}`;
const openStore = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const openBroker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", openServers.split(":").at(-1)!, "-sd", join(openStore, "js")], { stdio: "ignore" });
const releaseOpenBroker = teardownOnSignal(openBroker, openStore);
const cleanup: Array<() => Promise<void> | void> = [];
let brokerUp = true;

try {
  saveSpaceAuth(authDir(root), auth);
  const provisioner = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: broker.servers, space: SPACE, creds: provisioner });
  await seedChannelRegistry({ servers: broker.servers, space: SPACE, creds: provisioner, file: { channels: { general: {} } } });
  check("the static mesh registers", (await runMeshes(["add", SPACE], { server: broker.servers, root })) === 0);
  check("an open broker is up", await until(() => isReachable(openServers)));
  await setupSpaceStreams({ servers: openServers, space: OPEN });
  recordMesh({ space: OPEN, server: openServers, root: openRoot, mode: "open", origin: "manual", ts: new Date().toISOString() });
  const supervisor = new CotalEndpoint({
    space: SPACE, servers: broker.servers, creds: provisioner, card: { name: "prov", kind: "endpoint" },
    consume: false, watchPresence: false, registerPresence: false,
  });
  await supervisor.start();
  cleanup.push(() => supervisor.stop());

  /** An identity as a static-mesh provision made one before native sessions: a fresh `mkdtemp`
   *  directory with its record and credential, and the broker footprint of a foreground spawn. */
  const earlier = async (owner: number) => {
    const identity = newIdentity(), lifecycleUid = mintLifecycleUid();
    const dir = mkdtempSync(join(tmpdir(), "cotal-app-identity-"));
    writeFileSync(join(dir, "identity.json"), JSON.stringify({ space: SPACE, id: identity.id, lifecycleUid, owner }), { mode: 0o600 });
    const creds = await provisionAgent(supervisor, auth, identity,
      { subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"], role: "default", lifecycleUid });
    writeFileSync(join(dir, "agent.creds"), creds, { mode: 0o600 });
    return { dir, id: identity.id, lifecycleUid };
  };
  const footprintGone = async (who: { id: string; lifecycleUid: string }) => {
    const again = await deprovisionAgent({
      servers: broker.servers, space: SPACE, targetId: who.id, lifecycleUid: who.lifecycleUid,
      creds: await mintCreds(auth, newIdentity(), "deprovisioner", { deprovisionTarget: { principal: who.id, lifecycleUid: who.lifecycleUid } }),
    });
    return again.acls.absent === 1 && again.consumers.absent === 2 && again.deleted === 0;
  };
  /** The seat's issued reference, read the way its endpoint reads it: under its own credential. */
  const refOf = async (env: Record<string, string>) => {
    const nc = await dialerFor(broker.servers)({ servers: broker.servers, ...standaloneConnectOpts({ creds: readFileSync(env.COTAL_CREDS!, "utf8"), tls: false }), maxReconnectAttempts: 0 });
    try { return await readAcceptedRow(nc, SPACE, env.COTAL_ACCEPTED_TOKEN!); } finally { await nc.close(); }
  };
  const spawnPermission = async (env: Record<string, string>) => {
    const jwt = readFileSync(env.COTAL_CREDS!, "utf8").split("\n").find((line) => line.startsWith("eyJ"))!;
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")) as { nats: { pub: { allow: string[] } } };
    const caller = await refOf(env);
    const rows = epCallerGrantRows(SPACE, spawnCallerCapabilities(DEV_OWNER).filter((cap) => cap.command === "spawn"), caller).pub;
    assert.ok(rows.length > 0);
    return rows.every((row) => claims.nats.pub.allow.includes(row));
  };
  const issuer = <T>(fn: Parameters<typeof withIssuerSession<T>>[1]) => withIssuerSession({ servers: broker.servers, space: SPACE, auth, tls: false }, fn);
  const gateLive = (lifecycleUid: string) => issuer((s) => s.sourceIsLive({ space: SPACE, bucket: epAuthBucket(SPACE), key: `cred.${lifecycleUid}` }));
  const resolution = async (ref: Awaited<ReturnType<typeof refOf>>) => {
    try { return { evidence: (await issuer((s) => s.store.resolve(ref, s.sourceIsLive))).evidence }; }
    catch (e) { return { error: (e as Error).message }; }
  };
  /** Connect as `name` with what provision printed, reading the credential file as the plugin's agent does. */
  const connect = async (env: Record<string, string>, servers: string, space: string) => {
    const ep = new CotalEndpoint({
      space, servers, lifecycleUid: env.COTAL_LIFECYCLE_UID, channels: [],
      ...(env.COTAL_CREDS ? { creds: async () => readFileSync(env.COTAL_CREDS!, "utf8"), acceptedToken: env.COTAL_ACCEPTED_TOKEN } : {}),
      card: { name: env.COTAL_NAME!, id: env.COTAL_ID, role: env.COTAL_ROLE, kind: "agent" },
    });
    ep.on("error", () => {});
    ep.on("warning", () => {});
    await ep.start();
    cleanup.push(() => ep.stop());
    return ep;
  };
  const overflow: string[] = [];
  process.on("warning", (w) => { if (w.name === "TimeoutOverflowWarning") overflow.push(w.message); });

  // ── a static mesh: the space's own authority issues a scoped terminal seat ──────────────────
  const usage = await run(["open"], {});
  check("an unknown verb answers its usage as one JSON line", usage.code === 1 && usage.reply?.ok === false && /usage/.test(usage.reply.error), usage.out);
  const nameless = await run(["provision"], { space: SPACE });
  check("provision without a name is refused", nameless.code === 1 && /--name/.test(nameless.reply?.error), nameless.out);
  const bare = await run(["provision"], { space: SPACE, name: "claude_app" });
  check("a caller with no native session opens nothing", bare.code === 1 && /needs its native session identity/.test(bare.reply?.error) && records(SPACE).length === 0, bare.out);

  const competing = await Promise.all(["race_a", "race_b"].map((name) => provisionChild({ space: SPACE, name, session: "same-native-session" })));
  const issued = competing.filter((result) => result.ok);
  for (const result of issued) await run(["retire"], { dir: result.retire!.dir });
  check("concurrent processes cannot issue two names for one native session", issued.length === 1, { issued: issued.length });

  const a = await run(["provision"], { space: SPACE, name: "claude_app", session: "session-a", events: true });
  check("a native conversation opens its own identity, as one JSON line", a.code === 0 && a.reply?.ok === true && a.out.trim().split("\n").length === 1, a.out);
  const envA = a.reply.env as Record<string, string>;
  const heldA = record(a.reply.retire.dir);
  const jwtA = readFileSync(envA.COTAL_CREDS!, "utf8").split("\n").find((l) => l.startsWith("eyJ"))!;
  check("  its credential is a private file the env names, never in the reply",
    envA.COTAL_CREDS === join(heldA.dir, "agent.creds") && (statSync(envA.COTAL_CREDS!).mode & 0o077) === 0 && !secretShaped.test(a.out) && !a.out.includes(jwtA));
  check("  its record names the native session, the host process and the seat, and holds no secret",
    heldA.session === "session-a" && heldA.owner === process.ppid && heldA.alias === "claude_app" && heldA.id === envA.COTAL_ID &&
    heldA.lifecycleUid === envA.COTAL_LIFECYCLE_UID && !secretShaped.test(readFileSync(join(heldA.dir, "identity.json"), "utf8")), heldA);
  const ownA = eventChannel({ owner: DEV_OWNER, actor: heldA.id });
  check("  its grant retains the default persona's channels, role and capabilities plus its own event channel",
    isDeepStrictEqual(a.reply.grant, { scope: ["spawn", "run"], role: "default", allowSubscribe: ["general", "team.>"], allowPublish: [ownA, "general"], subscribe: [] }) &&
    envA.COTAL_SUBSCRIBE === "general" && envA.COTAL_ROLE === "default" && envA.COTAL_EVENTS === "1" && envA.COTAL_CAPABILITIES === "spawn,run", a.reply.grant);
  check("  the broker credential carries its default spawn permission", await spawnPermission(envA));
  const refA = await refOf(envA);
  const issuedA = await resolution(refA);
  check("  it is issued as a terminal seat under its own lifecycle",
    refA.owner === DEV_OWNER && refA.actor === heldA.id && refA.uid === heldA.lifecycleUid &&
    issuedA.evidence?.sources.length === 1 && issuedA.evidence.sources[0]!.key === `cred.${heldA.lifecycleUid}`, issuedA);
  const epA = await connect(envA, broker.servers, SPACE);
  await wait(1_500);
  check("  and it connects through a renewal source over its file, with no timer overflow", overflow.length === 0, overflow.slice(0, 2));

  const twice = await run(["provision"], { space: SPACE, name: "claude_other", session: "session-a" });
  check("a native conversation with a live identity cannot open a second one", twice.code === 1 && /already has a live identity/.test(twice.reply?.error) && records(SPACE).length === 1, twice.out);
  check("a live name is reported taken, so the host picks the next one",
    await until(async () => isDeepStrictEqual((await run(["provision"], { space: SPACE, name: "claude_app", session: "session-b" })).reply, { ok: false, taken: true })) && records(SPACE).length === 1);

  // ── a selection only narrows the persona's channels, role and capabilities ─────────────────
  const select = (selection: ReturnType<typeof conversationSelection>) =>
    run(["provision"], { space: SPACE, name: "claude_b", session: "session-b", selection: JSON.stringify(selection) });
  const outside = await select(conversationSelection({ channels: [{ channel: "secret", access: "read" }] }));
  check("a channel outside the persona's read grant is refused", outside.code === 1 && /"secret" \(read\) is not within/.test(outside.reply?.error), outside.out);
  const posting = await select(conversationSelection({ channels: [{ channel: "team.x", access: "read-post" }] }));
  check("posting where the persona only reads is refused", posting.code === 1 && /"team\.x" \(read-post\) is not within/.test(posting.reply?.error), posting.out);
  const role = await select(conversationSelection({ role: "lead" }));
  check("another role is refused", role.code === 1 && /role "lead" is not within/.test(role.reply?.error), role.out);
  writeFileSync(join(root, ".cotal/agents/default.md"), PERSONA.replace("capabilities: [spawn, run]", "capabilities: []"));
  try {
    for (const capability of ["spawn", "run"] as const) {
      const seat = await select(conversationSelection({ capabilities: [capability] }));
      check(`${capability} authority outside the persona is refused`, seat.code === 1 && /not within/.test(seat.reply?.error), seat.reply?.error);
    }
  } finally { writeFileSync(join(root, ".cotal/agents/default.md"), PERSONA); }
  check("  and no refused selection opened anything", records(SPACE).length === 1);
  const seat = await select(conversationSelection({ capabilities: ["spawn"] }));
  check("a granted capability can be selected without inheriting the other capabilities", seat.code === 0 &&
    isDeepStrictEqual(seat.reply.grant.scope, ["spawn"]) && seat.reply.env.COTAL_CAPABILITIES === "spawn", seat.reply.grant);
  check("  the selected capability is present in the broker credential", await spawnPermission(seat.reply.env));
  await run(["retire"], { dir: seat.reply.retire.dir });
  const b = await select(conversationSelection({ role: "default", channels: [{ channel: "general", access: "read-post" }, { channel: "team.x", access: "read" }] }));
  check("a selection within the persona opens exactly that grant", b.code === 0 && isDeepStrictEqual(b.reply.grant,
    { scope: ["role:default"], role: "default", subscribe: [], endpoints: [], allowSubscribe: ["general", "team.x"], allowPublish: ["general"] }), b.reply.grant);
  const envB = b.reply.env as Record<string, string>;
  check("  a channel-only selection carries no spawn broker permission", !(await spawnPermission(envB)));
  check("  with distinct identity, lifecycle and credential", envB.COTAL_ID !== envA.COTAL_ID && envB.COTAL_LIFECYCLE_UID !== envA.COTAL_LIFECYCLE_UID && envB.COTAL_CREDS !== envA.COTAL_CREDS);
  const epB = await connect(envB, broker.servers, SPACE);
  await epB.multicast("SELECTED_POST", { channel: "general" });
  check("  the broker lets it post where the selection allows", true);
  const beyond = await epB.multicast("BEYOND", { channel: "team.x" }).then(() => "sent", (e: Error) => e.message);
  check("  and refuses a post where it only reads", beyond !== "sent", beyond);

  // ── retire removes the seat's issuance, its broker footprint and its files ──────────────────
  await epA.stop();
  const retiredA = await run(["retire"], { dir: heldA.dir });
  check("an identity retires", retiredA.code === 0 && retiredA.reply?.ok === true && retiredA.out.trim().split("\n").length === 1, retiredA.out);
  check("  its directory is gone", !existsSync(heldA.dir));
  check("  so is its broker footprint", await footprintGone(heldA));
  const after = await resolution(refA);
  check("  its issuance is revoked", after.error !== undefined && /is revoked/.test(after.error), after);
  check("  and its lifecycle's gate is retired", (await gateLive(heldA.lifecycleUid)) === false);
  await epB.stop();
  const heldB = record(b.reply.retire.dir);
  check("the selected identity retires too", (await run(["retire"], { dir: heldB.dir })).code === 0 && !existsSync(heldB.dir) && await footprintGone(heldB));

  // ── a host that died without retiring ───────────────────────────────────────────────────────
  const c = await run(["provision"], { space: SPACE, name: "claude_c", session: "session-c" });
  const heldC = record(c.reply.retire.dir);
  writeFileSync(join(heldC.dir, "identity.json"), JSON.stringify({ ...heldC, dir: undefined, owner: deadPid() }), { mode: 0o600 });
  const d = await run(["provision"], { space: SPACE, name: "claude_d", session: "session-c" });
  check("a later provision retires an identity whose host is gone, and the session opens again", d.code === 0 && !existsSync(heldC.dir), d.out);
  check("  with the gone host's broker footprint and gate", await footprintGone(heldC) && (await gateLive(heldC.lifecycleUid)) === false);
  check("  and the reopened one is distinct", d.reply.env.COTAL_ID !== heldC.id);
  await run(["retire"], { dir: d.reply.retire.dir });

  // ── a static mesh this account holds no signing authority for ───────────────────────────────
  recordMesh({ space: NOAUTH, server: broker.servers, root: noAuthRoot, mode: "auth", origin: "manual", ts: new Date().toISOString() });
  const noAuth = await run(["provision"], { space: NOAUTH, name: "claude_app", session: "session-n" });
  check("a static mesh whose signing authority this account lacks opens nothing", noAuth.code === 1 &&
    /takes static credentials, and this account holds no signing authority for it/.test(noAuth.reply?.error) && noAuth.reply.env === undefined && records(NOAUTH).length === 0, noAuth.out);

  // ── an open mesh: nothing is issued, and the identity still belongs to its session ──────────
  const o = await run(["provision"], { space: OPEN, name: "claude_open", session: "session-o", events: true });
  const envO = o.reply?.env as Record<string, string>;
  check("an open mesh opens a native conversation's identity", o.code === 0 && o.reply.ok === true && envO.COTAL_SPACE === OPEN, o.out);
  const heldO = record(o.reply.retire.dir);
  check("  with no credential", envO.COTAL_CREDS === undefined && envO.COTAL_ACCEPTED_TOKEN === undefined && readdirSync(heldO.dir).join() === "identity.json");
  check("  recorded with its session and no seat", heldO.session === "session-o" && heldO.alias === undefined && heldO.id === envO.COTAL_ID);
  check("  and the persona's grant plus its own event channel", isDeepStrictEqual(o.reply.grant,
    { scope: ["spawn", "run"], role: "default", allowSubscribe: ["general", "team.>"], allowPublish: [eventChannel({ owner: DEV_OWNER, actor: heldO.id }), "general"], subscribe: [] }), o.reply.grant);
  const epO = await connect(envO, openServers, OPEN);
  check("  it connects, and its live name is taken for the next conversation",
    await until(async () => isDeepStrictEqual((await run(["provision"], { space: OPEN, name: "claude_open", session: "session-o2" })).reply, { ok: false, taken: true })));
  const sameO = await run(["provision"], { space: OPEN, name: "claude_open_2", session: "session-o" });
  check("  and its session cannot open a second one", sameO.code === 1 && /already has a live identity on/.test(sameO.reply?.error), sameO.out);
  await epO.stop();
  check("  it retires", (await run(["retire"], { dir: heldO.dir })).code === 0 && !existsSync(heldO.dir));

  // ── a signed-in mesh still refuses a caller with no native session ──────────────────────────
  // A per-user sign-in mesh, recorded the way `cotal meshes add` records one. It is refused before
  // anything dials its broker or provisioning; only its public discovery document is read, for the
  // hosted connector that an app without a native session joins through.
  let hosted: unknown = { version: 1, url: "https://cloud.example/mcp" };
  const discovery = createServer((req, res) => {
    res.writeHead(req.url === "/agents/.well-known/cotal-mesh" ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify({ space: "usermesh", cloudCapabilities: hosted === undefined ? {} : { hostedConnector: hosted } }));
  });
  await new Promise<void>((resolve) => discovery.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => discovery.close(() => resolve())));
  const exchange = `http://127.0.0.1:${(discovery.address() as AddressInfo).port}/agents`;
  recordMesh({ space: "usermesh", server: "nats://127.0.0.1:9", root: userRoot, mode: "user", origin: "manual", userAuth: {
    provider: "cotal", idp: { url: "https://idp.example/api/auth", issuer: "https://idp.example", audience: "https://idp.example" },
    endpoints: { url: exchange, agentProvisioningUrl: exchange }, remote: true,
  }, ts: new Date().toISOString() } as never);
  const userMesh = await run(["provision"], { space: "usermesh", name: "claude_app" });
  check(
    "a signed-in mesh refuses a missing native session before provisioning",
    userMesh.code === 1 && /native session identity before connecting/.test(userMesh.reply?.error),
    userMesh.out,
  );
  check("  and names the hosted connector the space advertises", userMesh.reply?.error.endsWith('the hosted connector of "usermesh" instead: https://cloud.example/mcp'), userMesh.out);
  hosted = undefined;
  const noHosted = await run(["provision"], { space: "usermesh", name: "claude_app" });
  check("  or says the space advertises none", noHosted.code === 1 && noHosted.reply?.error.endsWith('"usermesh" advertises no hosted connector'), noHosted.out);
  hosted = { version: 1, url: "http://cloud.example/mcp" };
  const plain = await run(["provision"], { space: "usermesh", name: "claude_app" });
  check("  and takes no hosted connector without HTTPS", plain.code === 1 && /hosted connector of "usermesh" could not be read/.test(plain.reply?.error) && !plain.out.includes("http://cloud.example"), plain.out);

  // ── an identity opened before native sessions still retires, with its broker footprint ──────
  const live = await earlier(process.ppid);
  const retired = await run(["retire"], { dir: live.dir });
  check("an earlier identity retires", retired.code === 0 && retired.reply?.ok === true && retired.out.trim().split("\n").length === 1, retired.out);
  check("  and its credential directory is gone", !existsSync(live.dir));
  check("  and so is its broker footprint", await footprintGone(live));

  const orphan = await earlier(deadPid());
  const kept = await earlier(process.ppid);
  const next = await run(["provision"], { space: SPACE, name: "claude_app_3" });
  check("a provision refused for want of a session still retires an earlier identity whose host is gone", /native session/.test(next.reply?.error) && !existsSync(orphan.dir));
  check("  with its broker footprint", await footprintGone(orphan));
  check("  and keeps the one whose host is alive", existsSync(join(kept.dir, "agent.creds")));

  // ── retire removes only what provision made ─────────────────────────────────────────────────
  const foreign = mkdtempSync(join(tmpdir(), "not-an-app-identity-"));
  cleanup.push(() => rmSync(foreign, { recursive: true, force: true }));
  const notOurs = await run(["retire"], { dir: foreign });
  check("retire refuses a directory provision did not make", notOurs.code === 1 && /refusing to remove/.test(notOurs.reply?.error), notOurs.out);
  check("  and leaves it in place", existsSync(foreign));
  // Raw, as a caller could pass it: `join` would normalize the climb away before retire saw it.
  const climbing = `${tmpdir()}/cotal-app-identity-/../${basename(foreign)}`;
  const climbed = await run(["retire"], { dir: climbing });
  check("retire refuses a path that climbs out of a credential directory", climbed.code === 1 && /refusing to remove/.test(climbed.reply?.error), climbed.out);
  check("  and leaves what it names in place", existsSync(foreign));
  rmSync(foreign, { recursive: true, force: true });
  const elsewhere = join(root, "cotal-app-identity-elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "agent.creds"), "not provision's");
  // A readable record naming the live mesh, so only the directory checks stand between retire and the file.
  writeFileSync(join(elsewhere, "identity.json"), JSON.stringify({ space: SPACE, id: newIdentity().id, lifecycleUid: mintLifecycleUid(), owner: process.pid }));
  const misplaced = await run(["retire"], { dir: elsewhere });
  check("retire refuses a credential-named directory outside the temp directory", misplaced.code === 1 && /refusing to remove/.test(misplaced.reply?.error), misplaced.out);
  check("  and leaves its file in place", existsSync(join(elsewhere, "agent.creds")));
  const link = join(tmpdir(), `cotal-app-identity-link-${process.pid}`);
  symlinkSync(elsewhere, link);
  const linked = await run(["retire"], { dir: link });
  check("retire refuses a credential-named link to another directory", linked.code === 1 && /refusing to remove/.test(linked.reply?.error), linked.out);
  check("  and leaves the file it points at", existsSync(join(elsewhere, "agent.creds")));
  rmSync(link, { force: true });
  const missing = await run(["retire"], {});
  check("retire without a directory is refused", missing.code === 1 && /--dir/.test(missing.reply?.error), missing.out);

  // ── a mesh that does not answer ──────────────────────────────────────────────────────────────
  for (const stop of cleanup.splice(0).reverse()) await stop();
  await broker.stop();
  brokerUp = false;
  const beforeDown = records(SPACE).length;
  const down = await run(["provision"], { space: SPACE, name: "claude_app", session: "session-down" });
  check("a mesh that is not answering opens nothing", down.code === 1 && /is not answering/.test(down.reply?.error) && records(SPACE).length === beforeDown, down.out);
  const downRetire = await run(["retire"], { dir: kept.dir });
  check("retire on a mesh that is not answering is refused", downRetire.code === 1 && /not answering/.test(downRetire.reply?.error), downRetire.out);
  check("  and keeps what a later retire needs", existsSync(join(kept.dir, "agent.creds")) && existsSync(join(kept.dir, "identity.json")));
  rmSync(kept.dir, { recursive: true, force: true });
} finally {
  for (const stop of cleanup.reverse()) await Promise.resolve(stop()).catch(() => {});
  if (brokerUp) await broker.stop();
  await killAndAwaitExit(openBroker);
  releaseOpenBroker();
  for (const space of [SPACE, OPEN, NOAUTH]) for (const held of records(space)) rmSync(held.dir, { recursive: true, force: true });
  for (const dir of [root, openRoot, noAuthRoot, userRoot, home, openStore]) rmSync(dir, { recursive: true, force: true });
}

console.log(`\nAPP IDENTITY TESTS PASSED ✅  (${pass} checks)`);
process.exit(0);
