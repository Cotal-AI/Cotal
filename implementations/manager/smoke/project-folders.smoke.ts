import * as core from "../../../packages/core/dist/index.js";
import * as auth from "../../auth/dist/index.js";
// A launcher starts a project on a Manager's host in a new empty folder (make-dir) or in a clone
// (clone), through a person's spawn-scoped manager-caller view minted by the real auth service and
// enforced by the broker. The clone source is a real HTTPS git server on loopback with a throwaway
// certificate, so the shipped git invocation, its protocol allowlist, the host credential helper,
// the deadline and the staging cleanup all run for real. Every cell runs and is counted.
const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
const { createServer } = await import("node:http");
const { createServer: createHttpsServer } = await import("node:https");
const { createRequire } = await import("node:module");
const { execFileSync } = await import("node:child_process");
const { mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, symlinkSync, existsSync, statSync, chmodSync } = await import("node:fs");
const { join, normalize, sep } = await import("node:path");
const { SignJWT, generateKeyPair, exportJWK, decodeJwt } = createRequire(new URL("../../auth/package.json", import.meta.url))("jose") as any;
const { mintLifecycleUid, mintCreds, newIdentity, setupSpaceStreams, registry, standaloneConnectOpts, issuedUserCaller, resolveService, invokeCommand, permissionsFor } = core;
const { connect } = await import("@nats-io/transport-node");
const { startAuthService, grantActor, loadOwnerSecret, deriveOwnerForIdpSubject } = auth;
const { startHostedAuthFixture } = await import("../../auth/smoke/_hosted-auth-fixture.js");
const { bootDeliveryDaemon } = await import("./_boot-delivery.js");
const { nativeRemoteManager } = await import("./_native-remote-manager.js");
const { emitSentinel } = await import("@cotal-ai/smoke-kit");
// A Manager runs as the cotal binary, and this suite must never be the entry a seat re-runs.
process.argv[1] = new URL("../../../bin/cotal.ts", import.meta.url).pathname;

let passed = 0, failed = 0;
const cell = (name: string, ok: boolean, seen?: unknown) => {
  if (ok) { passed++; console.log("PASS " + name); return; }
  failed++; console.log("FAIL " + name + (seen === undefined ? "" : " - " + JSON.stringify(seen)));
};
const FOLDER_COMMANDS = ["make-dir", "clone"];
const managerRows = (rows: string[]) => rows.flatMap((row) => {
  const m = /\.ep\.(one|all|inst)\.manager\.(.+)$/.exec(row);
  if (!m) return [];
  const rest = m[2]!.split(".");
  return [m[1] === "inst" ? { route: "inst", instanceId: rest[0], command: rest[1] } : { route: m[1], instanceId: undefined, command: rest[0] }];
});
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const pair = await generateKeyPair("EdDSA", { extractable: true });
const jwk = { ...await exportJWK(pair.publicKey), kid: "folders-idp", alg: "EdDSA", use: "sig" };
const idp = createServer((q, s) => { if (q.url !== "/api/auth/jwks") { s.writeHead(404); s.end(); return; } s.setHeader("content-type", "application/json"); s.end(JSON.stringify({ keys: [jwk] })); });
await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
const origin = "http://127.0.0.1:" + (idp.address() as import("node:net").AddressInfo).port;
const jwt = (sub: string) => new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: jwk.kid }).setIssuer(origin).setAudience(origin).setSubject(sub).setIssuedAt().setExpirationTime("10m").sign(pair.privateKey);
const fx = await startHostedAuthFixture("folders-probe", 1); const a = fx.accounts[0]!;
writeFileSync(join(a.stateDir, "idp.json"), JSON.stringify({ ver: 1, url: origin + "/api/auth", issuer: origin, audience: origin, jwksUri: origin + "/api/auth/jwks" }), { mode: 0o600 });
const root = join(fx.dir, "participant"), delegatedRoot = join(fx.dir, "delegated");
mkdirSync(join(root, ".cotal"), { recursive: true }); mkdirSync(delegatedRoot);
const ownerSecret = (await loadOwnerSecret(a.store, a.space))!;
const owner = deriveOwnerForIdpSubject(ownerSecret, origin, "owner"), otherOwner = deriveOwnerForIdpSubject(ownerSecret, origin, "other");
grantActor(a.stateDir, { owner, actor: "cli", lifecycleUid: mintLifecycleUid(), scope: ["supervise"], allowSubscribe: [], allowPublish: [] });
grantActor(a.stateDir, { owner, actor: "launcher", lifecycleUid: mintLifecycleUid(), scope: ["spawn"], allowSubscribe: [], allowPublish: [] });
grantActor(a.stateDir, { owner, actor: "reader", lifecycleUid: mintLifecycleUid(), scope: [], allowSubscribe: [], allowPublish: [] });
grantActor(a.stateDir, { owner: otherOwner, actor: "launcher", lifecycleUid: mintLifecycleUid(), scope: ["spawn"], allowSubscribe: [], allowPublish: [] });
grantActor(a.stateDir, { owner: otherOwner, actor: "cli", lifecycleUid: mintLifecycleUid(), scope: ["supervise"], allowSubscribe: [], allowPublish: [] });
const token = await jwt("owner"), otherToken = await jwt("other");
registry.register({ kind: "connector", name: "folders-probe", requires: ["node"], buildLaunch: () => { throw new Error("project-folders: nothing is launched"); } } as import("@cotal-ai/core").Connector);
const neverSpawn = (): never => { throw new Error("project-folders: nothing is launched"); };
registry.register({ kind: "runtime", name: "folders-delegated", available: () => true,
  create: () => ({ kind: "folders-delegated", streamsTerminal: false, spawn: neverSpawn, spawnDelegated: neverSpawn }) } as import("@cotal-ai/core").RuntimeProvider);

// The git source: bare repositories served over HTTPS with git's dumb protocol. "private" and
// "locked" need a password; only "private" has one in the host's credential helper below.
const gitRoot = join(fx.dir, "git-source"), pki = join(fx.dir, "pki");
mkdirSync(pki);
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(pki, "key.pem"), "-out", join(pki, "cert.pem"), "-days", "1",
  "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
const work = join(gitRoot, "work"), bare = join(gitRoot, "demo.git"), other = join(gitRoot, "other.git");
mkdirSync(work, { recursive: true });
git(work, "init", "-q", "-b", "main");
writeFileSync(join(work, "README.md"), "first\n");
git(work, "add", "."); git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "first");
git(work, "tag", "v1");
const tagged = git(work, "rev-parse", "HEAD");
writeFileSync(join(work, "README.md"), "second\n");
git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "second");
const head = git(work, "rev-parse", "HEAD");
git(gitRoot, "clone", "-q", "--bare", work, bare); git(bare, "update-server-info");
git(gitRoot, "clone", "-q", "--bare", work, other); git(other, "update-server-info");
let requests = 0;
const stalled: import("node:http").ServerResponse[] = [];
const basic = "Basic " + Buffer.from("host-user:host-secret").toString("base64");
const gitServer = createHttpsServer({ key: readFileSync(join(pki, "key.pem")), cert: readFileSync(join(pki, "cert.pem")) }, (q, s) => {
  requests++;
  const [area, ...rest] = (q.url ?? "/").split("?")[0]!.split("/").filter(Boolean);
  if (area === "stall") { stalled.push(s); return; }
  if ((area === "private" || area === "locked") && q.headers.authorization !== basic) {
    s.writeHead(401, { "www-authenticate": "Basic realm=\"git\"" }); s.end(); return;
  }
  if (area === "broken" && rest[1] === "objects" && rest[2] !== "info") { s.writeHead(500); s.end(); return; }
  const file = normalize(join(gitRoot, ...rest));
  if (!file.startsWith(gitRoot + sep) || !existsSync(file) || !statSync(file).isFile()) { s.writeHead(404); s.end(); return; }
  s.writeHead(200, { "content-type": "application/octet-stream" }); s.end(readFileSync(file));
});
await new Promise<void>((r) => gitServer.listen(0, "127.0.0.1", r));
const base = "https://127.0.0.1:" + (gitServer.address() as import("node:net").AddressInfo).port;
// The Manager runs in this process, so this is the host's own git setup: the CA it trusts, a
// credential helper for one path, a rewrite of one https URL to a local path, and its ssh.
const fakeSsh = join(fx.dir, "fake-ssh.sh"), sshMarker = join(fx.dir, "ssh-ran");
writeFileSync(fakeSsh, "#!/bin/sh\necho \"$@\" > '" + sshMarker + "'\nexit 1\n"); chmodSync(fakeSsh, 0o700);
Object.assign(process.env, {
  GIT_SSL_CAINFO: join(pki, "cert.pem"), GIT_SSH_COMMAND: fakeSsh, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "credential." + base + "/private.helper", GIT_CONFIG_VALUE_0: "!f() { echo username=host-user; echo password=host-secret; }; f",
  GIT_CONFIG_KEY_1: "url.file://" + bare + ".insteadOf", GIT_CONFIG_VALUE_1: base + "/rewritten/demo.git",
});
delete process.env.GIT_ASKPASS; delete process.env.SSH_ASKPASS;

let service: Awaited<ReturnType<typeof startAuthService>> | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
let participant: Awaited<ReturnType<typeof nativeRemoteManager>> | undefined;
let delegated: Awaited<ReturnType<typeof nativeRemoteManager>> | undefined;
const callers: Awaited<ReturnType<typeof connect>>[] = [];
try {
  await setupSpaceStreams({ space: a.space, servers: fx.servers, creds: await mintCreds(a.auth, newIdentity(), "provisioner") });
  delivery = await bootDeliveryDaemon({ space: a.space, servers: fx.servers, auth: a.auth, reloadStoreIdentity: a.store.identity });
  service = await startAuthService({ context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() }, space: a.space, servers: fx.servers, stateDir: a.stateDir, store: a.store, storeIdentity: a.store.identity, publicFace: { port: 0, trustedProxy: false } });
  const humanCall = (idpToken: string) => async (request: any) => { const response = await fetch(service!.publicUrl + "/manager-service-authority", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idpToken, request }) }); const body = await response.json() as any; if (!response.ok) throw new Error("authority refused " + request.kind + ": " + body.error); return body; };
  participant = await nativeRemoteManager({ space: a.space, servers: fx.servers, root, exchangeUrl: service.publicUrl!, execution: "runtime", call: humanCall(token) });
  delegated = await nativeRemoteManager({ space: a.space, servers: fx.servers, root: delegatedRoot, exchangeUrl: service.publicUrl!, execution: "runtime", runtime: "folders-delegated", call: humanCall(otherToken) });
  const iid = participant.state.instanceId;

  const minted = (profile: "manager-caller" | "agent", scope: readonly string[]) => {
    const uid = mintLifecycleUid();
    const perms = permissionsFor(profile, a.space, { owner, actor: "census", connId: "foldersconn00000000", lifecycleUid: uid } as never,
      (profile === "manager-caller" ? { capabilities: [...scope], lifecycleUid: uid, managerInstanceId: iid } : { capabilities: [...scope], lifecycleUid: uid }) as never) as { pub?: { allow?: string[] } };
    return managerRows(perms.pub?.allow ?? []);
  };
  const spawnRows = minted("manager-caller", ["spawn"]).filter((r) => FOLDER_COMMANDS.includes(r.command!));
  cell("mint: a spawn view carries make-dir and clone, each on the pinned instance only",
    spawnRows.length === 2 && FOLDER_COMMANDS.every((c) => spawnRows.some((r) => r.command === c && r.route === "inst" && r.instanceId === iid)), spawnRows);
  for (const scope of [["run"], [], ["supervise"]])
    cell("mint: a " + JSON.stringify(scope) + " view carries neither", !minted("manager-caller", scope).some((r) => FOLDER_COMMANDS.includes(r.command!)));
  cell("mint: a standing spawn-capable agent credential carries neither",
    !minted("agent", ["spawn", "run"]).some((r) => FOLDER_COMMANDS.includes(r.command!)));

  const open = async (actor: string, instanceId = iid, idpToken = token, callerOwner = owner) => {
    const response = await fetch(service!.publicUrl + "/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idpToken, actor, view: "manager-caller", managerInstanceId: instanceId }) });
    const body = await response.json() as any;
    assert.equal(response.status, 200, "exchange " + actor + ": " + body.error);
    const options = standaloneConnectOpts({ bearer: body.token, sentinelCreds: a.sentinelCreds, tls: false });
    const nc = await connect({ servers: fx.servers, ...options }); callers.push(nc);
    const issued = await issuedUserCaller(nc, a.space, String(options.name), { owner: callerOwner, actor, uid: (decodeJwt(body.token) as any).act.lifecycleUid });
    return { nc, instanceId, service: await resolveService(nc, a.space, "manager", issued, { instanceId }) };
  };
  type Outcome = { kind: "answered"; data: any } | { kind: "manager-refused"; code: string; error: any } | { kind: "broker-refused" } | { kind: "error"; message: string };
  const call = async (c: Awaited<ReturnType<typeof open>>, command: string, args?: Record<string, unknown>, deadlineMs = 20000): Promise<Outcome> => {
    try {
      const r = await invokeCommand(c.nc, a.space, c.service, command, args, { deadlineMs });
      return r.reply.ok ? { kind: "answered", data: r.reply.data } : { kind: "manager-refused", code: String(r.reply.error?.code), error: r.reply.error };
    } catch (error) {
      const message = (error as Error).message;
      return /REFUSED BY THE BROKER/.test(message) ? { kind: "broker-refused" } : { kind: "error", message };
    }
  };
  const refused = (o: Outcome, code: string, text?: RegExp) => o.kind === "manager-refused" && o.code === code && (text === undefined || text.test(JSON.stringify(o.error)));
  const launcher = await open("launcher");

  const projects = join(fx.dir, "projects"), alias = join(fx.dir, "projects-alias");
  mkdirSync(projects); symlinkSync(projects, alias);
  const made = await call(launcher, "make-dir", { parent: alias, name: "fresh" });
  cell("make-dir: creates an empty folder and answers its canonical path",
    made.kind === "answered" && made.data.path === join(realpathSync(projects), "fresh") && readdirSync(made.data.path).length === 0, made);
  writeFileSync(join(projects, "fresh", "kept.txt"), "kept");
  const again = await call(launcher, "make-dir", { parent: projects, name: "fresh" });
  cell("make-dir: an existing name is already-exists, not-executed, and the folder is untouched",
    refused(again, "already-exists") && again.kind === "manager-refused" && again.error.outcome === "not-executed" && readFileSync(join(projects, "fresh", "kept.txt"), "utf8") === "kept", again);
  for (const name of [".", "..", "a/b", "a\\b", ""]) {
    const result = await call(launcher, "make-dir", { parent: projects, name });
    cell("make-dir: name " + JSON.stringify(name) + " is not one folder name and is refused", result.kind === "error" || refused(result, "bad-request"), result);
  }
  cell("make-dir: the refused names created nothing", JSON.stringify(readdirSync(projects)) === JSON.stringify(["fresh"]), readdirSync(projects));
  cell("make-dir: a relative parent is refused as a spawn's cwd is",
    refused(await call(launcher, "make-dir", { parent: "relative", name: "x" }), "failed-precondition", /absolute path/));
  cell("make-dir: a missing parent is refused and not created",
    refused(await call(launcher, "make-dir", { parent: join(fx.dir, "missing"), name: "x" }), "failed-precondition") && !existsSync(join(fx.dir, "missing")));

  const clones = join(fx.dir, "clones"); mkdirSync(clones);
  const listing = () => readdirSync(clones).sort();
  const cloned = await call(launcher, "clone", { url: base + "/public/demo.git", parent: clones });
  cell("clone: an https repository lands under its own name at the default branch",
    cloned.kind === "answered" && JSON.stringify(cloned.data) === JSON.stringify({ path: join(realpathSync(clones), "demo"), head, ref: "main", existing: false })
      && readFileSync(join(clones, "demo", "README.md"), "utf8") === "second\n", cloned);
  writeFileSync(join(clones, "demo", "local.txt"), "local work");
  const reused = await call(launcher, "clone", { url: base + "/public/demo.git", parent: clones });
  cell("clone: the same URL again reuses the clone and leaves its work in place",
    reused.kind === "answered" && JSON.stringify(reused.data) === JSON.stringify({ path: join(realpathSync(clones), "demo"), head, ref: "main", existing: true })
      && readFileSync(join(clones, "demo", "local.txt"), "utf8") === "local work", reused);
  const atTag = await call(launcher, "clone", { url: base + "/public/demo.git", parent: clones, name: "pinned", ref: "v1" });
  cell("clone: a tag ref checks out that commit, detached",
    atTag.kind === "answered" && atTag.data.head === tagged && atTag.data.ref === null && atTag.data.existing === false
      && readFileSync(join(clones, "pinned", "README.md"), "utf8") === "first\n", atTag);
  const tagAgain = await call(launcher, "clone", { url: base + "/public/demo.git", parent: clones, name: "pinned", ref: "v1" });
  cell("clone: the same tag again reuses the clone", tagAgain.kind === "answered" && tagAgain.data.existing === true, tagAgain);
  cell("clone: an existing clone at another ref is already-exists",
    refused(await call(launcher, "clone", { url: base + "/public/demo.git", parent: clones, name: "pinned", ref: "main" }), "already-exists"));
  cell("clone: another origin under an existing name is already-exists",
    refused(await call(launcher, "clone", { url: base + "/public/other.git", parent: clones, name: "demo" }), "already-exists", /demo/));
  mkdirSync(join(clones, "demo", "plain"));
  cell("clone: a plain folder inside a clone of the same URL is not taken for that clone",
    refused(await call(launcher, "clone", { url: base + "/public/demo.git", parent: join(clones, "demo"), name: "plain" }), "already-exists"));

  const before = listing();
  const denied = await call(launcher, "clone", { url: base + "/locked/demo.git", parent: clones, name: "denied" });
  cell("clone: a repository the host cannot read says so and leaves nothing",
    refused(denied, "failed-precondition", /ai\.cotal\.manager\.git-access-refused/) && JSON.stringify(listing()) === JSON.stringify(before), { denied, listing: listing() });
  const withHelper = await call(launcher, "clone", { url: base + "/private/demo.git", parent: clones, name: "private" });
  cell("clone: the host's own credential helper reads a private repository, and the request carries no credential",
    withHelper.kind === "answered" && withHelper.data.head === head && withHelper.data.existing === false, withHelper);
  const after = [...before, "private"].sort();

  const count = requests;
  for (const url of ["file:///etc", gitRoot, "ext::sh -c touch% /tmp/x", "http://127.0.0.1/x.git", "git://127.0.0.1/x.git", "-oProxyCommand=x",
    "https://host-user:host-secret@127.0.0.1/private/demo.git", "fd::17", "C:\\repo", "ssh://-oProxyCommand=x/repo", "-u@host:repo"]) {
    const result = await call(launcher, "clone", { url, parent: clones, name: "refused" });
    cell("clone: " + JSON.stringify(url) + " is refused before git runs", refused(result, "bad-request") && result.kind === "manager-refused" && result.error.outcome === "not-executed", result);
  }
  cell("clone: refused URLs reached no server and created nothing", requests === count && JSON.stringify(listing()) === JSON.stringify(after), { requests, count });
  const rewritten = await call(launcher, "clone", { url: base + "/rewritten/demo.git", parent: clones, name: "rewritten" });
  cell("clone: a host rewrite to a local path is still refused by the protocol allowlist", refused(rewritten, "failed-precondition", /transport 'file' not allowed/) && !existsSync(join(clones, "rewritten")), rewritten);
  const viaSsh = await call(launcher, "clone", { url: "git@127.0.0.1:owner/demo.git", parent: clones, name: "ssh" });
  cell("clone: user@host:path runs over the host's ssh, and its failure leaves nothing",
    refused(viaSsh, "failed-precondition") && existsSync(sshMarker) && /git@127\.0\.0\.1/.test(readFileSync(sshMarker, "utf8")) && !existsSync(join(clones, "ssh")), viaSsh);
  const broken = await call(launcher, "clone", { url: base + "/broken/demo.git", parent: clones, name: "broken" });
  cell("clone: a clone that fails part way removes its partial copy", refused(broken, "failed-precondition", /Cannot obtain needed object/) && JSON.stringify(listing()) === JSON.stringify(after), { broken, listing: listing() });
  const started = performance.now();
  const late = await call(launcher, "clone", { url: base + "/stall/demo.git", parent: clones, name: "late" }, 4000);
  cell("clone: the caller's deadline ends the clone with deadline-exceeded before the caller gives up",
    refused(late, "deadline-exceeded") && performance.now() - started < 4000, late);
  cell("clone: after the deadline, no staging copy remains", JSON.stringify(listing()) === JSON.stringify(after), listing());
  const [first, second] = await Promise.all([1, 2].map(() => call(launcher, "clone", { url: base + "/public/other.git", parent: clones, name: "raced" })));
  cell("clone: two clones racing for one name both answer the same clone, and exactly one made it",
    first!.kind === "answered" && second!.kind === "answered" && first!.data.path === second!.data.path && [first!.data.existing, second!.data.existing].filter((e) => !e).length === 1, [first, second]);
  cell("clone: the race left one clone and no staging copy", JSON.stringify(listing()) === JSON.stringify([...after, "raced"].sort()), listing());

  const reader = await open("reader");
  cell("reader: make-dir is broker-refused", (await call(reader, "make-dir", { parent: clones, name: "x" })).kind === "broker-refused");
  cell("reader: clone is broker-refused", (await call(reader, "clone", { parent: clones, url: base + "/public/demo.git" })).kind === "broker-refused");
  const delegatedCaller = await open("launcher", delegated.state.instanceId, otherToken, otherOwner);
  const elsewhere = join(fx.dir, "elsewhere"); mkdirSync(elsewhere);
  const delegatedRefusals = [
    await call(delegatedCaller, "list-dir", { path: elsewhere }),
    await call(delegatedCaller, "make-dir", { parent: elsewhere, name: "x" }),
    await call(delegatedCaller, "clone", { url: base + "/public/demo.git", parent: elsewhere }),
  ];
  cell("delegated: make-dir and clone are refused before any host lookup, as list-dir is",
    delegatedRefusals.every((o) => refused(o, "failed-precondition", /starts seats outside this host/)) && new Set(delegatedRefusals.map((o) => JSON.stringify(o))).size === 1 && readdirSync(elsewhere).length === 0, delegatedRefusals);
} catch (error) {
  failed++; console.log("FAIL fixture: " + (error as Error).stack);
} finally {
  for (const s of stalled) s.destroy();
  for (const nc of callers) await nc.close().catch(() => {});
  await participant?.manager.stop({ withAgents: true });
  await delegated?.manager.stop({ withAgents: true });
  gitServer.closeAllConnections(); await new Promise<void>((r) => gitServer.close(() => r()));
  try { await service?.close(); } finally { await delivery?.stop(); await fx.close(); await new Promise<void>((r) => idp.close(() => r())); }
}
console.log("project folders: " + passed + " passed, " + failed + " failed");
emitSentinel({ passed, failed });
if (failed) process.exitCode = 1;
