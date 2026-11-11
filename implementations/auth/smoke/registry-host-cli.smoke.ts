/** Compiled builtin auth-service preset: default-off and registry opt-in, real user-auth listing.
 * Generated fixture authority only. Native service stop owns child teardown; an unknown stop
 * retains the private fixture directory instead of deleting custody. Run after cotal-ai build. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  CotalEndpoint, createSpaceAuth, isReachable, mintCreds, newIdentity, serverConfig, setupSpaceStreams,
} from "@cotal-ai/core";
import {
  authDir, assertUserAuthInfo, recordMesh, saveSpaceAuth, userAuthStateDir, workspaceSecretStore,
} from "@cotal-ai/workspace";
import { createSuite, freePort, SMOKE_BROKER_TOKEN, teardownOnSignal, killAndAwaitExit } from "@cotal-ai/smoke-kit";
import { cotalAuthProvider, deriveOwnerForIdpSubject, grantActor, loadOwnerSecret } from "../src/index.js";
import { loadAuthServiceInfo, loadCalloutAuth } from "../src/store.js";

const suite = createSuite();
const bin = join(import.meta.dirname, "../../../bin/dist/cotal.js");
assert.ok(existsSync(bin), "build the compiled CLI closure first");
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const root = join(dir, "root"), home = join(dir, "home");
mkdirSync(join(root, ".cotal"), { recursive: true, mode: 0o700 });
const privateEnv: Record<string, string> = { HOME: home, USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state"), XDG_DATA_HOME: join(home, "data"),
  XDG_CACHE_HOME: join(home, "cache"), COTAL_HOME: join(home, "cotal"), TMPDIR: join(dir, "tmp") };
for (const p of Object.values(privateEnv)) mkdirSync(p, { recursive: true, mode: 0o700 });
// Both fixture helpers and the child resolve only this private workspace registry.
Object.assign(process.env, privateEnv);
process.env.COTAL_HOME = privateEnv.COTAL_HOME;
const env = { ...privateEnv, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", NO_COLOR: "1", LANG: "C.UTF-8" };
const space = `registry-cli-${process.pid}`, servers = `nats://127.0.0.1:${await freePort()}`;
const stateDir = userAuthStateDir(root, space), store = workspaceSecretStore(root);
const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const jwk = { ...await exportJWK(publicKey), kid: "registry-cli", alg: "EdDSA" };
const idp = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [jwk] })); });
await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (test: () => boolean | Promise<boolean>, ms = 60_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await test()) return true; await wait(100); }
  return test();
};
function launch(args: string[]) {
  const child = spawn(process.execPath, [bin, ...args, "--no-input"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (b: Buffer) => { output = (output + b.toString()).slice(-32768); });
  child.stderr.on("data", (b: Buffer) => { output = (output + b.toString()).slice(-32768); });
  const ended = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  return { child, ended, output: () => output };
}
async function command(args: string[]) {
  const call = launch(args);
  const timer = setTimeout(() => { void killAndAwaitExit(call.child, "SIGTERM"); }, 70_000);
  try { return { code: await call.ended, output: call.output() }; }
  finally { clearTimeout(timer); }
}
let broker: ChildProcess | undefined, release: (() => void) | undefined;
let controller: ReturnType<typeof launch> | undefined;
let started = false, completed = false;
const endpoints: CotalEndpoint[] = [];
try {
  const auth = await createSpaceAuth(space);
  saveSpaceAuth(authDir(root), auth);
  const prepared = await cotalAuthProvider.prepareServer({ space, operatorSeed: auth.operator.seed,
    account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed }, store, dir: stateDir, idpUrl: `${origin}/api/auth` });
  const config = join(dir, "server.conf");
  writeFileSync(config, serverConfig(auth, [auth], { transport: { kind: "plaintext" }, host: "127.0.0.1",
    port: Number(new URL(servers).port), storeDir: join(dir, "js"), extraAccounts: prepared.extraAccounts }), { mode: 0o600 });
  broker = spawn("nats-server", ["-c", config], { env, stdio: "ignore" });
  release = teardownOnSignal(broker, dir);
  assert.ok(await until(() => isReachable(servers)), "fixture broker did not bind");
  await setupSpaceStreams({ space, servers, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  recordMesh({ space, server: servers, root, mode: "user", policy: { events: "required" }, userAuth: assertUserAuthInfo(prepared.publicAuth), ts: new Date().toISOString() });
  const owner = deriveOwnerForIdpSubject((await loadOwnerSecret(store, space))!, origin, "fixture-human");
  const row = grantActor(stateDir, { owner, actor: "lister", scope: [], allowSubscribe: [], allowPublish: [] });
  const sentinelCreds = (await loadCalloutAuth(store, space))!.sentinelCreds;
  for (const enabled of [false, true]) {
    controller = launch(["service", "start", "auth-service", "--space", space, "--root", root,
      "--foreground", "--plain", ...(enabled ? ["--registry"] : [])]);
    started = true;
    assert.ok(await until(() => loadAuthServiceInfo(stateDir) !== undefined || controller!.child.exitCode !== null), "native preset did not reach readiness");
    const info = loadAuthServiceInfo(stateDir);
    if (!info) { writeFileSync(join(dir, "startup-failure.log"), controller.output(), { mode: 0o600 }); throw new Error("native preset exited before auth readiness; private fixture log retained"); }
    suite.check("compiled builtin preset opens its actual auth child", info.pid !== controller.child.pid && controller.child.exitCode === null);
    const token = await new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: jwk.kid }).setSubject("fixture-human")
      .setIssuer(origin).setAudience(origin).setIssuedAt().setExpirationTime("10m").sign(privateKey);
    const response = await fetch(`${info.url}/exchange`, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${info.cap}` }, body: JSON.stringify({ idpToken: token, actor: "lister" }) });
    const body = await response.json() as { token?: unknown };
    assert.equal(response.status, 200, "native child exchange succeeds"); assert.equal(typeof body.token, "string");
    const ep = new CotalEndpoint({ space, servers, bearer: body.token as string, sentinelCreds, lifecycleUid: row.lifecycleUid!,
      channels: [], consume: false, watchPresence: false, registerPresence: false, watchChannels: false,
      card: { owner, actor: "lister", name: "lister", kind: "agent" } });
    endpoints.push(ep); ep.on("error", () => {}); ep.on("warning", () => {}); await ep.start();
    if (enabled) {
      const result = await ep.listEndpoints({});
      suite.check("public preset registry flag reaches native registration and real user-auth listing", !result.unbound && result.page?.rows.length === 1
        && result.page.rows[0]!.endpoint === "registry" && result.page.rows[0]!.commands[0]?.name === "endpoints");
    } else {
      await assert.rejects(() => ep.listEndpoints({}));
      suite.check("compiled preset keeps registry disabled by default", true);
    }
    await ep.stop();
    const stop = await command(["service", "stop", "auth-service", "--space", space, "--yes", "--json"]);
    assert.equal(stop.code, 0, "native named stop must confirm before another start"); started = false;
    assert.ok(await until(() => controller!.child.exitCode !== null || controller!.child.signalCode !== null), "controller did not exit after named stop");
    suite.check("native stop ends the controller and removes auth discovery", loadAuthServiceInfo(stateDir) === undefined);
    const inventory = await command(["service", "--space", space, "--json"]);
    assert.equal(inventory.code, 0, "inspect native cleanup before the next start");
    const records = JSON.parse(inventory.output) as { result: { instances: unknown[]; definitions: unknown[]; attempts: unknown[] } };
    suite.check("foreground preset leaves no saved instance, definition or pending attempt", records.result.instances.length === 0
      && records.result.definitions.length === 0 && records.result.attempts.length === 0);
  }
  completed = true;
} catch (error) {
  suite.check("compiled registry preset acceptance completes", false, error instanceof Error ? error.message : String(error));
} finally {
  for (const ep of endpoints) await ep.stop();
  if (started) {
    const stop = await command(["service", "stop", "auth-service", "--space", space, "--yes", "--json"]);
    started = stop.code !== 0;
  }
  if (controller && !started) await killAndAwaitExit(controller.child, "SIGTERM");
  if (broker) await killAndAwaitExit(broker, "SIGTERM");
  release?.();
  await new Promise<void>((r) => idp.close(() => r()));
  if (completed && !started) rmSync(dir, { recursive: true });
  else console.log(`private fixture retained: ${dir}; unresolved service custody=${started}`);
}
suite.finish();
