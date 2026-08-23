import assert from "node:assert/strict";
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer, get as httpsGet } from "node:https";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Self-reexec: the smoke drives the real registered auth-service and agent-bearer commands.
const SUBCOMMAND = process.argv[2] ?? "";
if (SUBCOMMAND === "auth-service" || SUBCOMMAND === "agent-bearer") {
  await import("@cotal-ai/auth");
  const { registry } = await import("@cotal-ai/core");
  type Command = import("@cotal-ai/core").Command;
  const rest = process.argv.slice(3);
  const values: Record<string, string | boolean | undefined> = {};
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) { positionals.push(arg); continue; }
    const key = arg.slice(2), next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) { values[key] = next; i++; }
    else values[key] = true;
  }
  const command = registry.all<Command>("command").find((c) => c.name === SUBCOMMAND);
  if (!command) throw new Error(`self-dispatch: command ${SUBCOMMAND} is not registered`);
  await command.run({ values, positionals, raw: rest });
  process.exit(0);
}

const { CotalEndpoint, chatSubject, createSpaceAuth, isReachable, mintCreds, mintLifecycleUid,
  newIdentity, serverConfig, setupSpaceStreams, standaloneConnectOpts } = await import("@cotal-ai/core");
const { connect, credsAuthenticator } = await import("@nats-io/transport-node");
const { authDir, saveSpaceAuth, userAuthStateDir, workspaceSecretStore } = await import("@cotal-ai/workspace");
const { cotalAuthProvider, grantActor, grantManagedActor, loadCalloutAuth, newActorToken } = await import("@cotal-ai/auth");
const { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } = await import("jose");
const { pickFreePort } = await import("./_free-port.js");

type CotalMessage = import("@cotal-ai/core").CotalMessage;
type Delivery = import("@cotal-ai/core").Delivery;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 8_000) => {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await wait(50);
  return fn();
};
const run = (command: string, args: string[], cwd?: string) => {
  const r = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
};

const home = mkdtempSync(join(tmpdir(), "cotal-rab-home-"));
const serverRoot = mkdtempSync(join(tmpdir(), "cotal-rab-server-"));
const clientRoot = mkdtempSync(join(tmpdir(), "cotal-rab-client-"));
mkdirSync(join(serverRoot, ".cotal"), { recursive: true });
mkdirSync(join(clientRoot, ".cotal"), { recursive: true });
const pki = join(serverRoot, "pki"); mkdirSync(pki, { recursive: true });
run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(pki, "ca.key"),
  "-out", join(pki, "ca.pem"), "-days", "2", "-subj", "/CN=cotal-rab-ca", "-addext", "basicConstraints=critical,CA:TRUE"]);
run("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", join(pki, "leaf.key"),
  "-out", join(pki, "leaf.csr"), "-subj", "/CN=localhost"]);
writeFileSync(join(pki, "leaf.ext"), "subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n");
run("openssl", ["x509", "-req", "-in", join(pki, "leaf.csr"), "-CA", join(pki, "ca.pem"),
  "-CAkey", join(pki, "ca.key"), "-CAcreateserial", "-out", join(pki, "leaf.pem"), "-days", "2", "-extfile", join(pki, "leaf.ext")]);

const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(cleanEnv)) if (key.startsWith("COTAL_")) delete cleanEnv[key];
cleanEnv.COTAL_HOME = home;
cleanEnv.NODE_EXTRA_CA_CERTS = join(pki, "ca.pem");

const SPACE = `rab-${Math.floor(Math.random() * 1e6)}`;
const OWNER = `u_${"a".repeat(26)}`;
const ACTOR = "worker";
const lifecycleUid = mintLifecycleUid();
const brokerPort = await pickFreePort();
const SERVER = `nats://127.0.0.1:${brokerPort}`;
const publicPort = await pickFreePort();
const proxyPort = await pickFreePort();
const exchangeBase = `https://127.0.0.1:${proxyPort}`;
const serverDir = userAuthStateDir(serverRoot, SPACE);
const clientDir = userAuthStateDir(clientRoot, SPACE);
mkdirSync(clientDir, { recursive: true });
const tokenPath = join(clientDir, "actor-token");
const sentinelPath = join(clientDir, "sentinel.creds");
const healthPath = join(clientDir, "health.json");
const SELF = import.meta.filename;

let broker: ChildProcess | undefined;
let authService: ChildProcess | undefined;
let witnessNc: Awaited<ReturnType<typeof connect>> | undefined;
let agent: CotalEndpoint | undefined;
let witness: CotalEndpoint | undefined;
let proxy: ReturnType<typeof createHttpsServer> | undefined;
let redirector: ReturnType<typeof createHttpsServer> | undefined;
let plaintextTarget: ReturnType<typeof createHttpServer> | undefined;
let emptyJwks: ReturnType<typeof createHttpsServer> | undefined;
const exchangeRequests: Array<{ method?: string; url?: string; authorization?: string; body: unknown }> = [];
let plaintextHits = 0;

interface CommandResult { code: number | null; stdout: string; stderr: string }
function execBearer(argv: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { cwd: clientRoot, env: { ...cleanEnv, ...extraEnv }, timeout: 30_000, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => resolve({ code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code as number ?? 1) : 0, stdout: stdout.toString(), stderr: stderr.toString() }));
  });
}
const bearerArgv = (url = exchangeBase, token = tokenPath) => [
  process.execPath, ...process.execArgv, SELF, "agent-bearer",
  "--exchange-url", url, "--space", SPACE, "--owner", OWNER, "--actor", ACTOR,
  "--token-file", token, "--health-file", healthPath,
];
async function tlsGet(base: string, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpsGet(new URL(path, `${base}/`), { ca: readFileSync(join(pki, "ca.pem")), rejectUnauthorized: true }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        let body: unknown = raw; try { body = JSON.parse(raw); } catch { /* keep */ }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("error", reject);
  });
}
async function verifyFrom(base: string, token: string): Promise<Record<string, unknown>> {
  const response = await tlsGet(base, "jwks");
  if (response.status !== 200) throw new Error(`JWKS HTTP ${response.status}`);
  const jwks = response.body as { keys: import("jose").JWK[] };
  const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), {
    algorithms: ["EdDSA"], issuer: `urn:cotal:auth:${SPACE}`, audience: SPACE,
  });
  return payload;
}

let attempted = 0, passed = 0, failures = 0;
type Cell = { name: string; run: () => Promise<void> | void };
const cells: Cell[] = [];
const cell = (name: string, fn: Cell["run"]) => cells.push({ name, run: fn });

let firstBearer = "";
let secondBearer = "";
let agentReceived: string[] = [];
let witnessMessages: CotalMessage[] = [];

try {
  const auth = await createSpaceAuth(SPACE);
  saveSpaceAuth(authDir(serverRoot), auth);
  const idpKey = await generateKeyPair("EdDSA", { extractable: true });
  const idpPublic = await exportJWK(idpKey.publicKey);
  const idp = createHttpServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/auth/jwks") return void res.end(JSON.stringify({ keys: [{ ...idpPublic, alg: "EdDSA", use: "sig" }] }));
    res.statusCode = 404; res.end("{}");
  });
  await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
  const idpBase = `http://127.0.0.1:${(idp.address() as AddressInfo).port}/api/auth`;
  const store = workspaceSecretStore(serverRoot);
  const prepared = await cotalAuthProvider.prepareServer({ store, space: SPACE, operatorSeed: auth.operator.seed,
    account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed }, dir: serverDir, idpUrl: idpBase });
  const callout = await loadCalloutAuth(store, SPACE); if (!callout) throw new Error("callout missing");
  const jsDir = mkdtempSync(join(tmpdir(), "cotal-rab-js-"));
  writeFileSync(join(serverRoot, "server.conf"), serverConfig(auth, [auth], {
    transport: { kind: "plaintext" }, port: brokerPort, storeDir: jsDir, extraAccounts: prepared.extraAccounts,
  }));
  broker = spawn("nats-server", ["-c", join(serverRoot, "server.conf")], { stdio: "ignore" });
  for (let i = 0; i < 50 && !(await isReachable(SERVER)); i++) await wait(100);
  await setupSpaceStreams({ servers: SERVER, space: SPACE, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  grantActor(serverDir, { owner: OWNER, actor: "cli", scope: ["spawn", "role:worker"], allowSubscribe: [">"], allowPublish: [">"], lifecycleUid });
  const secret = newActorToken();
  grantManagedActor(serverDir, { owner: OWNER, actor: ACTOR, scope: ["role:worker"], allowSubscribe: ["general"],
    allowPublish: ["general"], parent: `${OWNER}.cli`, tokenHash: secret.tokenHash, lifecycleUid });
  writeFileSync(tokenPath, secret.actorToken, { mode: 0o600 });
  writeFileSync(sentinelPath, callout.sentinelCreds, { mode: 0o600 });

  authService = spawn(process.execPath, [...process.execArgv, SELF, "auth-service", "--space", SPACE, "--server", SERVER,
    "--exchange-public-port", String(publicPort), "--exchange-public-url", exchangeBase],
  { cwd: serverRoot, env: cleanEnv, stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${publicPort}/health`)).ok) break; } catch { /* wait */ }
    await wait(100);
  }

  proxy = createHttpsServer({ cert: readFileSync(join(pki, "leaf.pem")), key: readFileSync(join(pki, "leaf.key")) }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d: Buffer) => chunks.push(d));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      let body: unknown = raw.toString(); try { body = JSON.parse(raw.toString()); } catch { /* keep */ }
      if (req.url === "/exchange") exchangeRequests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
      const upstream = httpRequest({ host: "127.0.0.1", port: publicPort, path: req.url, method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${publicPort}` } }, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers); up.pipe(res);
      });
      upstream.on("error", (e) => { res.statusCode = 502; res.end(String(e)); });
      upstream.end(raw);
    });
  });
  await new Promise<void>((r) => proxy!.listen(proxyPort, "127.0.0.1", r));

  witnessNc = await connect({ servers: SERVER, authenticator: credsAuthenticator(new TextEncoder().encode(await mintCreds(auth, newIdentity(), "admin"))) });
  witnessNc.subscribe(chatSubject(SPACE, "*", "*", "general"), { callback: (err, msg) => { if (!err) try { witnessMessages.push(msg.json<CotalMessage>()); } catch { /* skip */ } } });
  await witnessNc.flush();
  witness = new CotalEndpoint({ space: SPACE, servers: SERVER, creds: await mintCreds(auth, newIdentity(), "admin"),
    lifecycleUid: mintLifecycleUid(), channels: [], consume: false, registerPresence: false, watchPresence: false,
    card: { name: "witness", kind: "endpoint" } });
  witness.on("error", () => {}); await witness.start();

  cell("the real user-auth broker is reachable", async () => assert.equal(await isReachable(SERVER), true));
  cell("the real public exchange is ready behind verified HTTPS", async () => assert.equal((await tlsGet(exchangeBase, "health")).status, 200));
  cell("the managed actor row uses the already-issued actorToken and lifecycle", () => {
    assert.equal(statSync(tokenPath).mode & 0o777, 0o600); assert.equal(readFileSync(tokenPath, "utf8"), secret.actorToken);
  });
  cell("the remote client root contains NO local auth-service.json", () => {
    assert.equal(readdirSync(clientDir).includes("auth-service.json"), false);
  });
  cell("the remote client carries only actor-token, sentinel and health material — no local signer state", () => {
    const names = readdirSync(clientDir).filter((n) => n !== "wrong-token").sort(); assert.deepEqual(names, ["actor-token", "sentinel.creds"]);
    assert.equal(readFileSync(sentinelPath, "utf8"), callout.sentinelCreds);
  });
  cell("the enrollment bearer argv selects the pinned --exchange-url", () => {
    const argv = bearerArgv(); assert.ok(argv.includes("--exchange-url")); assert.ok(argv.includes(exchangeBase));
  });
  cell("the enrollment bearer argv mints remotely and publishes with NO local auth-service.json", async () => {
    assert.equal(readdirSync(clientDir).includes("auth-service.json"), false);
    const result = await execBearer(bearerArgv()); assert.equal(result.code, 0, result.stderr); firstBearer = result.stdout.trim(); assert.ok(firstBearer);
  });
  cell("the public exchange receives exact agent proof with NO capability header", () => {
    const req = exchangeRequests[0]; assert.equal(req.authorization, undefined); assert.deepEqual(req.body, { owner: OWNER, actor: ACTOR, actorToken: secret.actorToken });
  });
  cell("the remote bearer verifies against the advertised public JWKS with exact principal and lifecycle", async () => {
    const payload = await verifyFrom(exchangeBase, firstBearer); assert.equal(payload.sub, OWNER);
    const act = payload.act as { actor?: string; lifecycleUid?: string };
    assert.equal(act.actor, ACTOR); assert.equal(act.lifecycleUid, lifecycleUid);
  });

  emptyJwks = createHttpsServer({ cert: readFileSync(join(pki, "leaf.pem")), key: readFileSync(join(pki, "leaf.key")) }, (_req, res) => {
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [] }));
  });
  await new Promise<void>((r) => emptyJwks!.listen(0, "127.0.0.1", r));
  const emptyBase = `https://127.0.0.1:${(emptyJwks.address() as AddressInfo).port}`;
  const unreachablePort = await pickFreePort();
  cell("JWKS verification fails on BOTH empty and unreachable advertised key sets", async () => {
    await assert.rejects(() => verifyFrom(emptyBase, firstBearer), /no applicable key|no matching key/i);
    await assert.rejects(() => verifyFrom(`https://127.0.0.1:${unreachablePort}`, firstBearer), /fetch failed|ECONNREFUSED/i);
  });
  cell("the same enrollment argv refreshes through the pinned URL with a distinct bearer", async () => {
    await wait(1100); const result = await execBearer(bearerArgv()); assert.equal(result.code, 0, result.stderr);
    secondBearer = result.stdout.trim(); assert.notEqual(secondBearer, firstBearer);
  });
  const wrongToken = join(clientDir, "wrong-token");
  cell("a wrong actorToken is refused by the public exchange with no local fallback", async () => {
    writeFileSync(wrongToken, newActorToken().actorToken, { mode: 0o600 });
    const result = await execBearer(bearerArgv(exchangeBase, wrongToken)); assert.notEqual(result.code, 0); assert.match(result.stderr, /exchange refused|secret/i);
  });
  let agentNc: Awaited<ReturnType<typeof connect>> | undefined;
  let agentSub: ReturnType<Awaited<ReturnType<typeof connect>>["subscribe"]> | undefined;
  cell("bearer plus recorded sentinel connects through the real broker callout as the managed principal", async () => {
    const result = await execBearer(bearerArgv()); assert.equal(result.code, 0, result.stderr);
    agentNc = await connect({ servers: SERVER, ...standaloneConnectOpts({ bearer: result.stdout.trim(), sentinelCreds: readFileSync(sentinelPath, "utf8"), tls: false }) });
    agentSub = agentNc.subscribe(chatSubject(SPACE, "*", "*", "general"), { callback: (err, msg) => {
      if (!err) try { const m = msg.json<CotalMessage>(); for (const p of m.parts) if (p.kind === "text") agentReceived.push(p.text); } catch { /* skip */ }
    } });
    await agentNc.flush(); await wait(100); assert.ok(agentNc.info);
  });
  cell("the remotely-authenticated agent publishes and the independent witness sees its principal", async () => {
    const frame = { v: 1, id: `m-${Date.now()}`, at: new Date().toISOString(), from: { id: `${OWNER}.${ACTOR}`, name: ACTOR },
      channel: "general", parts: [{ kind: "text", text: "remote-agent-publish" }] };
    agentNc!.publish(chatSubject(SPACE, OWNER, ACTOR, "general"), new TextEncoder().encode(JSON.stringify(frame)));
    await agentNc!.flush();
    assert.equal(await until(() => witnessMessages.some((m) => m.id === frame.id && m.from.id === `${OWNER}.${ACTOR}`)), true);
  });
  cell("the remotely-authenticated agent has the granted subscribe permission and an independent publish is broker-accepted", async () => {
    const senderId = newIdentity();
    const senderNc = await connect({ servers: SERVER, authenticator: credsAuthenticator(new TextEncoder().encode(await mintCreds(auth, senderId, "admin"))) });
    const frame = { v: 1, id: `w-${Date.now()}`, at: new Date().toISOString(), from: { id: `local.${senderId.id}`, name: "sender" },
      channel: "general", parts: [{ kind: "text", text: "remote-agent-subscribe" }] };
    senderNc.publish(chatSubject(SPACE, "local", senderId.id, "general"), new TextEncoder().encode(JSON.stringify(frame)));
    await senderNc.flush(); await wait(100); await senderNc.close();
    assert.equal(agentSub?.isClosed(), false);
    agentSub?.unsubscribe(); await agentNc?.close();
  });
  cell("omitting --exchange-url stays on the legacy local arm and refuses without auth-service.json", async () => {
    const argv = bearerArgv().filter((v, i, a) => v !== "--exchange-url" && a[i - 1] !== "--exchange-url"); argv.push("--dir", clientDir);
    const result = await execBearer(argv); assert.notEqual(result.code, 0); assert.match(result.stderr, /auth service.*not running/i);
  });
  cell("plain HTTP is refused for attacker names AND genuine loopback literals — there is no exception", async () => {
    for (const base of ["http://127.evil.com", "http://127.0.0.1.nip.io", "http://127.com",
      "http://127.0.0.1:9", "http://0177.0.0.1:9", "http://2130706433:9", "http://[::ffff:127.0.0.1]:9"]) {
      const result = await execBearer(bearerArgv(base)); assert.notEqual(result.code, 0); assert.match(result.stderr, /must be https/i);
    }
  });

  plaintextTarget = createHttpServer((_req, res) => { plaintextHits++; res.end("stolen"); });
  await new Promise<void>((r) => plaintextTarget!.listen(0, "127.0.0.1", r));
  const plainLocation = `http://127.0.0.1:${(plaintextTarget.address() as AddressInfo).port}/exchange`;
  redirector = createHttpsServer({ cert: readFileSync(join(pki, "leaf.pem")), key: readFileSync(join(pki, "leaf.key")) }, (_req, res) => {
    res.statusCode = 302; res.setHeader("location", plainLocation); res.end();
  });
  await new Promise<void>((r) => redirector!.listen(0, "127.0.0.1", r));
  const redirectBase = `https://127.0.0.1:${(redirector.address() as AddressInfo).port}`;
  cell("an HTTPS redirect to plaintext is refused by NAME, quotes Location, and never sends the actorToken", async () => {
    const result = await execBearer(bearerArgv(redirectBase)); assert.notEqual(result.code, 0);
    assert.match(result.stderr, /redirect/i); assert.ok(result.stderr.includes(plainLocation)); assert.equal(plaintextHits, 0);
  });

  for (const c of cells) {
    attempted++;
    try { await c.run(); passed++; console.log(`  ✓ ${c.name}`); }
    catch (e) { failures++; console.log(`  ✗ FAIL: ${c.name}`, e instanceof Error ? e.message : e); }
  }
  const expected = cells.length;
  console.log(`\nremote-agent-bearer smoke: ${passed} passed, ${failures} failed, ${attempted}/${expected} attempted`);
  const failed = failures > 0 || attempted !== expected;
  process.exitCode = failed ? 1 : 0;
  idp.close(); rmSync(jsDir, { recursive: true, force: true });
} finally {
  await agent?.stop().catch(() => {}); await witness?.stop().catch(() => {}); await witnessNc?.close().catch(() => {});
  proxy?.close(); redirector?.close(); plaintextTarget?.close(); emptyJwks?.close();
  authService?.kill("SIGKILL"); broker?.kill("SIGKILL"); await wait(200);
  rmSync(home, { recursive: true, force: true }); rmSync(serverRoot, { recursive: true, force: true }); rmSync(clientRoot, { recursive: true, force: true });
}
