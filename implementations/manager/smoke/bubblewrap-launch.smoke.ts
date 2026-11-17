// REAL Manager, REAL JWT broker and REAL agent processes.
// Delegated enrollment -> native Bubblewrap -> shipped foreground CLI -> connector peer.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CotalEndpoint, mintCreds, newIdentity, mintLifecycleUid, registry, setupSpaceStreams, type Connector, type RuntimeProvider } from "@cotal-ai/core";
import { recordMesh } from "@cotal-ai/workspace";
import { deriveOwnerForIdpSubject, grantActor, loadOwnerSecret, startAuthService } from "@cotal-ai/auth";
import { BubblewrapRuntime } from "@cotal-ai/bubblewrap";
import { createSuite, skipSuite } from "@cotal-ai/smoke-kit";
import { startHostedAuthFixture } from "../../auth/smoke/_hosted-auth-fixture.js";
import { bootDeliveryDaemon } from "./_boot-delivery.js";
import { nativeRemoteManager } from "./_native-remote-manager.js";

if (process.platform !== "linux") skipSuite("Bubblewrap requires Linux");
const suite = createSuite();
const scratch = mkdtempSync(join(tmpdir(), "cotal-bubblewrap-manager-"));
const root = join(scratch, "participant"), image = join(scratch, "image"), home = join(scratch, "home"), xdg = join(scratch, "xdg");
for (const dir of [root, home, xdg, join(scratch, "runtime")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const savedEnv = { ...process.env };
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
Object.assign(process.env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, XDG_RUNTIME_DIR: join(scratch, "runtime"), COTAL_HOME: home, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", DO_NOT_TRACK: "1" });
const repo = resolve(import.meta.dirname, "../../..");
mkdirSync(image, { mode: 0o755 });
chmodSync(image, 0o755);
for (const dir of ["usr/bin", "proc", "dev", "home", "run", "tmp", "scratch", "workspace", "etc", "app"]) mkdirSync(join(image, dir), { recursive: true });
copyFileSync(process.execPath, join(image, "usr/bin/node"));
mkdirSync(join(image, "bin"));
copyFileSync("/bin/sh", join(image, "bin/sh"));
const libs = spawnSync("ldd", [process.execPath], { encoding: "utf8" });
assert.equal(libs.status, 0);
for (const line of libs.stdout.split("\n")) {
  const path = line.match(/(?:=>\s*)?(\/[^\s]+)\s+\(/)?.[1];
  if (path) { mkdirSync(dirname(join(image, path)), { recursive: true }); copyFileSync(path, join(image, path)); }
}
writeFileSync(join(image, "etc/passwd"), `seat:x:${process.getuid!()}:${process.getgid!()}:Seat:/home/seat:/bin/sh\n`);
cpSync(join(repo, "node_modules"), join(image, "app/node_modules"), { recursive: true, verbatimSymlinks: true });
for (const group of ["packages", "extensions", "implementations"]) for (const item of readdirSync(join(repo, group))) {
  const source = join(repo, group, item), dest = join(image, "app", group, item);
  if (!existsSync(join(source, "dist")) || !existsSync(join(source, "package.json"))) continue;
  mkdirSync(dest, { recursive: true });
  copyFileSync(join(source, "package.json"), join(dest, "package.json"));
  cpSync(join(source, "dist"), join(dest, "dist"), { recursive: true, verbatimSymlinks: true });
  if (existsSync(join(source, "node_modules"))) cpSync(join(source, "node_modules"), join(dest, "node_modules"), { recursive: true, verbatimSymlinks: true });
}
writeFileSync(join(image, "app/package.json"), '{"name":"cotal-ai","version":"0.165.4","type":"module","bin":{"cotal":"bin/cotal"}}');
for (const file of ["cli.mjs", "seat.mjs"]) copyFileSync(join(import.meta.dirname, "bubblewrap-fixtures", file), join(image, "app", file));
writeFileSync(join(image, "app/forbidden-path.txt"), root);
writeFileSync(join(image, "usr/package.json"), '{"name":"cotal-ai","version":"0.165.4","type":"module","bin":{"cotal":"bin/cotal"}}');
writeFileSync(join(image, "usr/bin/cotal"), '#!/usr/bin/node\nimport("/app/cli.mjs");\n');
chmodSync(join(image, "usr/bin/cotal"), 0o755);
process.env.COTAL_BUBBLEWRAP_ROOTFS = image;
registry.unregister("runtime", "bubblewrap");
let handle: ReturnType<BubblewrapRuntime["spawnDelegated"]> | undefined;
const runtime = new BubblewrapRuntime({ rootfs: image });
const provider: RuntimeProvider = { kind: "runtime", name: "bubblewrap", available: () => true, create: () => ({
  kind: runtime.kind, streamsTerminal: false, spawn: runtime.spawn.bind(runtime),
  spawnDelegated: (launch, handoff) => { handle = runtime.spawnDelegated(launch, handoff); return handle; },
}) };
registry.register(provider);
const connector: Connector = { kind: "connector", name: "bubblewrap-fixture", requires: ["node"], buildLaunch: () => { throw new Error("manager must delegate without building a local launch"); } };
registry.register(connector);
const { SignJWT, generateKeyPair, exportJWK } = createRequire(new URL("../../auth/package.json", import.meta.url))("jose");
const pair = await generateKeyPair("EdDSA", { extractable: true });
const jwk = { ...await exportJWK(pair.publicKey), kid: "isolation", alg: "EdDSA", use: "sig" };
const idp = createServer((q, s) => { if (q.url !== "/api/auth/jwks") { s.writeHead(404); s.end(); return; } s.setHeader("content-type", "application/json"); s.end(JSON.stringify({ keys: [jwk] })); });
await new Promise<void>(resolve => idp.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(idp.address() as import("node:net").AddressInfo).port}`;
const fx = await startHostedAuthFixture("isolated-launch", 1, { keepFiles: true });
const a = fx.accounts[0]!;
writeFileSync(join(a.stateDir, "idp.json"), JSON.stringify({ ver: 1, url: `${origin}/api/auth`, issuer: origin, audience: origin, jwksUri: `${origin}/api/auth/jwks` }), { mode: 0o600 });
const owner = deriveOwnerForIdpSubject((await loadOwnerSecret(a.store, a.space))!, origin, "operator");
grantActor(a.stateDir, { owner, actor: "cli", lifecycleUid: mintLifecycleUid(), scope: ["supervise"], allowSubscribe: ["review6237"], allowPublish: ["review6237"] });
const savedArgv = [...process.argv], savedExecArgv = [...process.execArgv];
// Manager bearer preflight must run the shipped CLI, never recursively re-enter this suite.
process.argv[1] = join(repo, "bin/dist/cotal.js");
process.execArgv = [];
let service: Awaited<ReturnType<typeof startAuthService>> | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
let observer: CotalEndpoint | undefined;
let participant: Awaited<ReturnType<typeof nativeRemoteManager>> | undefined;
try {
  await setupSpaceStreams({ space: a.space, servers: fx.servers, creds: await mintCreds(a.auth, newIdentity(), "provisioner") });
  delivery = await bootDeliveryDaemon({ space: a.space, servers: fx.servers, auth: a.auth, reloadStoreIdentity: a.store.identity });
  service = await startAuthService({ context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() }, space: a.space, servers: fx.servers, stateDir: a.stateDir, store: a.store, storeIdentity: a.store.identity, publicFace: { port: 0, trustedProxy: false } });
  const token = await new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: "isolation" }).setIssuer(origin).setAudience(origin).setSubject("operator").setIssuedAt().setExpirationTime("10m").sign(pair.privateKey);
  const call = async (request: unknown) => {
    const response = await fetch(`${service!.publicUrl}/manager-service-authority`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idpToken: token, request }) });
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(`manager authority refused: ${String(body.error)}`);
    return body;
  };
  recordMesh({ space: a.space, server: fx.servers, root, mode: "user", policy: { eventPayloads: "withheld" }, ts: new Date().toISOString(), origin: "manual", userAuth: { provider: "cotal", idp: { url: `${origin}/api/auth`, issuer: origin, audience: origin }, endpoints: { url: service.publicUrl! }, remote: true } });
  mkdirSync(join(root, ".cotal/agents"), { recursive: true });
  writeFileSync(join(root, ".cotal/agents/isolated.md"), "---\nname: isolated\nagent: bubblewrap-fixture\nsubscribe: []\nallowSubscribe: [review6237]\nallowPublish: [review6237]\n---\n");
  const observerId = newIdentity();
  observer = new CotalEndpoint({ space: a.space, servers: fx.servers, creds: await mintCreds(a.auth, observerId, "observer"), card: { id: observerId.id, name: "isolation-observer", kind: "endpoint" }, lifecycleUid: mintLifecycleUid(), channels: [], consume: false, registerPresence: false });
  observer.on("error", () => {});
  await observer.start();
  participant = await nativeRemoteManager({ space: a.space, servers: fx.servers, root, exchangeUrl: service.publicUrl!, execution: "runtime", runtime: "bubblewrap", call });
  const result = await participant.manager.startAgent({ name: "isolated", agent: "bubblewrap-fixture", events: false });
  writeFileSync(join(scratch, "launch-result.json"), JSON.stringify(result, null, 2));
  suite.check("real manager delegates and the shipped CLI joins as the enrolled lifecycle", result.ok, result);
  assert.ok(result.ok, "isolated launch failed");
  let observed = false;
  let lastActivity: string | undefined;
  for (let i = 0; i < 100 && !observed; i++) {
    const roster = observer.getRoster();
    lastActivity = roster.find(row => row.card.id === `${owner}.isolated`)?.activity ?? lastActivity;
    observed = roster.some(row => row.card.name === "isolated" && row.card.id === `${owner}.isolated` && row.activity?.includes("isolation verified"));
    if (!observed) await new Promise(resolve => setTimeout(resolve, 100));
  }
  suite.check("isolated child proves hidden operator roots and classified bare CLI refusal before positive control", observed, lastActivity);
  assert.ok(observed, "child isolation checks did not report success");
  const history = await observer.channelHistory("review6237", { limit: 10 });
  suite.check("real history contains only the scoped seat positive control, never the operator attempt",
    history.length === 1 && history[0]!.from.id === `${owner}.isolated`
      && history[0]!.parts.some(part => part.kind === "text" && part.text === "isolated-seat-positive-control"));
} finally {
  if (handle) { handle.stop({ graceful: false }); await handle.waitForExit!(); suite.check("owned sandbox is proved exited before manager cleanup", handle.status() === "exited"); }
  await participant?.manager.stop({ withAgents: true });
  await observer?.stop();
  await delivery?.stop();
  await service?.close();
  await fx.close();
  await new Promise<void>(resolve => idp.close(() => resolve()));
  process.argv = savedArgv;
  process.execArgv = savedExecArgv;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  console.log(`Retained isolated manager fixture: ${scratch}`);
}
suite.finish();
