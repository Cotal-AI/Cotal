/** Real broker/auth proof for the exact generated user-mode update seat. No native service. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, mintCreds, mintLifecycleUid, newIdentity, provisionAgentDurables, setupSpaceStreams } from "@cotal-ai/core";
import { deriveOwnerForIdpSubject, grantActor, grantManagedActor, loadOwnerSecret, newActorToken, startAuthService } from "../src/index.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";
import { bootDeliveryDaemon } from "../../manager/smoke/_boot-delivery.js";

const fx = await startHostedAuthFixture("upgrade-seat", 1), account = fx.accounts[0]!;
let auth: Awaited<ReturnType<typeof startAuthService>> | undefined, delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
let observer: CotalEndpoint | undefined, provisioner: CotalEndpoint | undefined, child: ChildProcess | undefined;
const actor = "upgrade_proof_worker", uid = mintLifecycleUid();
const owner = deriveOwnerForIdpSubject((await loadOwnerSecret(account.store, account.space))!, "http://127.0.0.1:1", "upgrade-seat");
let output = "";
try {
  const creds = await mintCreds(account.auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: fx.servers, space: account.space, creds });
  grantActor(account.stateDir, { owner, actor: "cli", scope: ["spawn"], allowSubscribe: [">"], allowPublish: [">"], lifecycleUid: mintLifecycleUid() });
  const token = newActorToken();
  grantManagedActor(account.stateDir, { custody: { kind: "foreground" }, owner, actor, scope: [], allowSubscribe: [], allowPublish: [], parent: `${owner}.cli`, tokenHash: token.tokenHash, lifecycleUid: uid });
  auth = await startAuthService({ context: { accountPublicKey: account.accountPublicKey, lifecycleUid: mintLifecycleUid() }, space: account.space, servers: fx.servers, stateDir: account.stateDir, store: account.store, storeIdentity: account.store.identity, publicFace: { port: 0, trustedProxy: false } });
  delivery = await bootDeliveryDaemon({ space: account.space, servers: fx.servers, auth: account.auth, reloadStoreIdentity: account.store.identity });
  observer = new CotalEndpoint({ space: account.space, servers: fx.servers, creds: await mintCreds(account.auth, newIdentity(), "admin"), card: { name: "observer", kind: "endpoint" }, channels: [], consume: false, registerPresence: false });
  observer.on("error", () => {}); await observer.start();
  provisioner = new CotalEndpoint({ space: account.space, servers: fx.servers, creds, card: { name: "provisioner", kind: "endpoint" }, channels: [], consume: false, registerPresence: false, watchPresence: false });
  provisioner.on("error", () => {}); await provisioner.start();
  await provisionAgentDurables(provisioner, { owner, actor, lifecycleUid: uid }, { subscribe: [], allowSubscribe: [] });
  const root = join(fx.dir, "generated-seat"); mkdirSync(root, { mode: 0o700 });
  const tokenFile = join(root, "actor-token"), sentinel = join(root, "sentinel.creds");
  writeFileSync(tokenFile, token.actorToken, { mode: 0o600 }); writeFileSync(sentinel, account.sentinelCreds, { mode: 0o600 });
  const source = readFileSync(new URL("../../../scripts/automatic-update-platform-baseline.mjs", import.meta.url), "utf8");
  const expression = source.match(/writeFileSync\(seat, daemonHostedManager\s*\? (`[^\n]+`)/)?.[1];
  assert(expression, "read the actual hosted seat generator");
  const core = new URL("../../../packages/core/dist/index.js", import.meta.url).href;
  const generated = new Function("core", `return ${expression}`)(core) as string;
  const seat = join(root, "seat.mjs"); writeFileSync(seat, generated, { mode: 0o600 });
  const bearerCmd = [process.execPath, fileURLToPath(new URL("../../../bin/dist/cotal.js", import.meta.url)), "agent-bearer", "--exchange-url", auth.publicUrl!, "--space", account.space, "--owner", owner, "--actor", actor, "--token-file", tokenFile];
  const env = { ...process.env, COTAL_SPACE: account.space, COTAL_SERVERS: fx.servers, COTAL_NAME: actor, COTAL_OWNER: owner, COTAL_ACTOR: actor, COTAL_LIFECYCLE_UID: uid, COTAL_SENTINEL_CREDS: sentinel, COTAL_BEARER_CMD: JSON.stringify(bearerCmd) };
  delete (env as Record<string, string | undefined>).COTAL_CREDS; delete (env as Record<string, string | undefined>).COTAL_ID;
  child = spawn(process.execPath, [seat], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", b => { output += String(b); }); child.stderr!.on("data", b => { output += String(b); });
  const deadline = Date.now() + 20000; let joined = false;
  while (Date.now() < deadline && child.exitCode === null) {
    joined = observer.getRoster().some(row => row.card.owner === owner && row.card.actor === actor && row.lifecycleUid === uid);
    if (joined) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(joined, `actual generated user-auth seat joined with sentinel+bearer: ${output}`);
  const exited = new Promise<number | null>(resolve => child!.once("close", resolve)); child.kill("SIGTERM");
  assert.equal(await exited, 0, `generated seat drains cleanly: ${output}`); child = undefined;
  assert(!output.includes("open 'undefined'"));
  console.log("UPDATE SEAT USER AUTH PASS: actual generated endpoint joins real callout through supplied sentinel and bearer argv, then exits0");
} finally {
  if (child && child.exitCode === null) { const ended = new Promise(resolve => child!.once("close", resolve)); child.kill("SIGKILL"); await ended; }
  try { await provisioner?.stop(); } finally { try { await observer?.stop(); } finally { try { await auth?.close(); } finally { try { await delivery?.stop(); } finally { await fx.close(); } } } }
}
