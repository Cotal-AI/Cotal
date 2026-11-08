/**
 * Issue 5740, through the shipped doors.
 *
 * A space is created, then its connection-evictor credential is removed, which is the shape a space
 * created before live eviction keeps. The shipped delivery lane starts without that file. A real
 * manager seats one agent, a second connection stays open under the seat's own minted credential
 * after the process is gone, and the manager's stop is refused: the name stays reserved. The
 * shipped `cotal mint-evictor` then writes only that file. The same stop, retried, frees the name,
 * and the same name seats again. The broker process is the one booted here, untouched.
 *
 * Run: tsx implementations/manager/smoke/mint-evictor-live.smoke.ts
 */
import { spawn as spawnProc } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  createSpaceAuth, isReachable, mintCreds, newIdentity, serverConfig, setupSpaceStreams,
  type Connector, type LaunchOpts, type LaunchSpec,
} from "@cotal-ai/core";
import { registry } from "@cotal-ai/core";
import { openDeliveryLane } from "@cotal-ai/delivery";
import { Manager } from "../src/manager.js";
import {
  authDir, connectionEvictorCredsKey, deliveryCredsKey, membershipObserverCredsKey,
  retainSystemSigningSeed, saveSpaceAuth, workspaceSecretStore,
} from "@cotal-ai/workspace";
import { mintMembershipObserverCreds, credsClaims } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, teardownOnSignal, killAndAwaitExit, freePort } from "@cotal-ai/smoke-kit";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const repoRoot = new URL("../../..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const home = join(dir, "home");
const root = join(dir, "ws");
process.env.COTAL_HOME = home;
mkdirSync(home, { recursive: true });
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });

const space = "mint5740";
const NAME = "helper";
const auth = await createSpaceAuth(space);
const store = workspaceSecretStore(root);
saveSpaceAuth(authDir(root), auth);
await retainSystemSigningSeed(store, auth);
const composition = { injected: false as const, root };
await store.put(membershipObserverCredsKey(space, composition), await mintMembershipObserverCreds(auth, newIdentity()));
await store.put(deliveryCredsKey(space, composition), await mintCreds(auth, newIdentity(), "delivery"));
const evictorKey = connectionEvictorCredsKey(space, composition);
const evictorBefore = await store.get(evictorKey);
if (evictorBefore !== undefined) throw new Error("fixture: the evictor file exists before the proof");

const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
const broker = spawnProc("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);
const brokerPid = broker.pid;

writeFileSync(join(root, ".cotal", "agents", `${NAME}.md`), `---\nname: ${NAME}\nrole: worker\n---\n`);
const coreDist = join(repoRoot, "packages", "core", "dist", "index.js");
const CHILD = [
  "const{pathToFileURL}=require('node:url');",
  "import(pathToFileURL(process.env.CORE_DIST).href).then(async({CotalEndpoint})=>{",
  "const ep=new CotalEndpoint({space:process.env.COTAL_SPACE,servers:process.env.COTAL_SERVERS,creds:require('node:fs').readFileSync(process.env.COTAL_CREDS,'utf8'),lifecycleUid:process.env.COTAL_LIFECYCLE_UID||undefined,channels:[],consume:false,registerPresence:true,watchPresence:false,card:{id:process.env.COTAL_ID||undefined,name:process.env.COTAL_NAME,kind:'agent'}});",
  "ep.on('error',()=>{});await ep.start();console.log('SEAT_JOINED');setInterval(()=>{},1<<30);});",
].join("");
const joiner: Connector = {
  kind: "connector", name: "joiner", requires: ["node"],
  buildLaunch: (o: LaunchOpts): LaunchSpec => ({
    command: process.execPath, args: ["-e", CHILD],
    env: { PATH: process.env.PATH ?? "", CORE_DIST: coreDist, COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? servers), COTAL_CREDS: o.creds ?? "", COTAL_ID: o.id ?? "", COTAL_LIFECYCLE_UID: o.lifecycleUid ?? "", COTAL_NAME: o.name },
  }),
};
registry.register(joiner);

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, extra ?? ""); }
};

const laneLog: string[] = [];
let lane: Awaited<ReturnType<typeof openDeliveryLane>> | undefined;
let manager: Manager | undefined;
let holder: Awaited<ReturnType<typeof connect>> | undefined;
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = broker.exitCode === null && await isReachable(servers); if (!up) await wait(200); }
  if (!up) throw new Error(`broker did not come up on ${port}`);
  await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  lane = await openDeliveryLane({ space, server: servers, root, rootNamed: true, tls: false, log: { out: (l) => laneLog.push(l), err: (l) => laneLog.push(l) } });
  check("the shipped lane starts with no connection-evictor credential", laneLog.some((l) => l.includes("delivery lane up")), laneLog);

  manager = new Manager({ space, servers, runtime: "pty", workspaceRoot: root });
  await manager.start();
  const first = await manager.startAgent({ name: NAME, agent: "joiner", cwd: repoRoot, events: false });
  check("the seat starts", first.ok === true, first);
  const agents = (manager as unknown as { agents: Map<string, { id: string; lifecycleUid: string; secretPaths?: { creds?: string } }> }).agents;
  const seated = agents.get(NAME);
  const credsPath = seated?.secretPaths?.creds;
  if (!seated || !credsPath || !existsSync(credsPath)) throw new Error("fixture: the seat has no minted credential");
  const seatPid = (manager as unknown as { agents: Map<string, { handle: { pid?: number } }> }).agents.get(NAME)?.handle.pid;
  holder = await connect({ servers, authenticator: credsAuthenticator(new TextEncoder().encode(readFileSync(credsPath, "utf8"))), reconnect: false, maxReconnectAttempts: 0 });
  check("a second connection holds the seat credential", !holder.isClosed());

  const stop = (name: string) => (manager as unknown as { opStop(a: Record<string, unknown>, c: string, admin: boolean): Promise<{ ok: boolean; error?: string }> }).opStop({ name, graceful: false }, "proof", true);
  const held = await stop(NAME);
  check("the stop is acknowledged", held.ok === true, held);
  const retiring = () => (manager as unknown as { retiring: Map<string, { lastError?: string }> }).retiring;
  await until(async () => /missing connection-evictor\.creds/.test(retiring().get(NAME)?.lastError ?? ""), 20000);
  const heldError = retiring().get(NAME)?.lastError ?? "";
  check("the retirement is refused while the evictor file is absent", /missing connection-evictor\.creds/.test(heldError), heldError);
  check("the refusal names mint-evictor", /mint-evictor/.test(heldError), heldError);
  await until(async () => seatPid === undefined || !alive(seatPid), 8000);
  check("the seat process is gone while the name stays reserved", seatPid !== undefined && !alive(seatPid) && agents.has(NAME) === false && (manager as unknown as { retiring: Map<string, unknown> }).retiring.has(NAME), { seatPid });
  const blocked = await manager.startAgent({ name: NAME, agent: "joiner", cwd: repoRoot, events: false });
  check("a same-name spawn is reserved pending retirement", blocked.ok === false && /reserved pending retirement/.test((blocked as { error?: string }).error ?? ""), blocked);

  const minted = await cotal(["mint-evictor", "--json"]);
  const envelope = lastJson(minted.stdout);
  check("cotal mint-evictor writes the missing file", minted.status === 0 && envelope?.outcome === "ok" && envelope?.result?.minted === true, minted.out.slice(-800));
  const written = await store.get(evictorKey);
  check("the file is signed by the system account the broker already loads", typeof written === "string" && credsClaims(written).iss === auth.sys.pub, written === undefined);
  check("the broker process was not replaced", broker.pid === brokerPid && broker.exitCode === null, { before: brokerPid, after: broker.pid, exit: broker.exitCode });
  const flights = () => (manager as unknown as { deprovisioningFlight: Map<string, Promise<unknown>> }).deprovisioningFlight;
  await until(async () => flights().size === 0, 20000);
  check("the refused retirement has settled before the retry", flights().size === 0, [...flights().keys()]);

  const nudged = await manager.startAgent({ name: NAME, agent: "joiner", cwd: repoRoot, events: false });
  check("the first retry re-drives the retirement and is still reserved", nudged.ok === false && /reserved pending retirement/.test((nudged as { error?: string }).error ?? ""), nudged);
  await until(async () => flights().size === 0 && !(manager as unknown as { retiring: Map<string, unknown> }).retiring.has(NAME), 30000);
  const again = await manager.startAgent({ name: NAME, agent: "joiner", cwd: repoRoot, events: false });
  check("the retried same-name spawn completes the retirement and seats", again.ok === true, again);
  check("the name is no longer reserved", !(manager as unknown as { retiring: Map<string, unknown> }).retiring.has(NAME));
} finally {
  try { await holder?.close(); } catch { /* the kick may have closed it */ }
  try { await manager?.stop({ withAgents: true }); } catch { /* teardown */ }
  try { await lane?.close(); } catch { /* teardown */ }
  try { await killAndAwaitExit(broker); } catch { /* teardown */ }
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function until(f: () => Promise<boolean>, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await f()) return; await wait(200); }
}
function lastJson(stdout: string): { outcome?: string; result?: { minted?: boolean } } | undefined {
  for (const line of stdout.split("\n").reverse()) { if (!line.trim()) continue; try { return JSON.parse(line) as { outcome?: string; result?: { minted?: boolean } }; } catch { return undefined; } }
  return undefined;
}
function cotal(args: string[]): Promise<{ status: number | null; stdout: string; out: string }> {
  return new Promise((res, rej) => {
    const child = spawnProc(join(repoRoot, "node_modules", ".bin", "tsx"), [join(repoRoot, "bin", "cotal.ts"), ...args], {
      cwd: root, env: { ...process.env, HOME: home, COTAL_HOME: home, COTAL_SKIP_CONNECTOR_SEED: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", out = "";
    const t = setTimeout(() => { child.kill("SIGKILL"); rej(new Error(`mint-evictor timed out\n${out.slice(-800)}`)); }, 60_000);
    child.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); out += d.toString(); });
    child.stderr!.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("close", (status) => { clearTimeout(t); res({ status, stdout, out }); });
  });
}
