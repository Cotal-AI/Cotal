/**
 * A manager stop that retires many seats at once (#4965), against the real `Manager` (pty runtime,
 * static auth), the shipped delivery daemon (`_boot-delivery.ts`) and a JWT broker.
 *
 * The stop used to start every seat's retirement together. Each one dials fresh broker connections and
 * sends an eviction and then a membership inventory to the daemon, all against fixed deadlines, and a
 * mass stop lost many of them: dials past the broker's 2 s auth timeout, inventories past 5 s behind
 * the other seats' evictions. A lost retirement keeps the seat's membership rows. This suite counts:
 *   - with one eviction held open on the daemon, exactly RETIREMENT_CONCURRENCY (8) evictions are
 *     requested: the rest wait for a slot;
 *   - every seat's inventory is requested only after its own eviction returned
 *     (static-lifecycle.ts: `evictAndAudit` is awaited before `cleanupStaticSlotOnce`), so no row of
 *     that lifecycle can be written after the inventory's pass begins;
 *   - after the stop, 0 membership rows of the retired lifecycles remain on the broker, including the
 *     ones on a wildcard-granted channel only the inventory can name, and no retirement reports its
 *     inventory as incomplete.
 *
 * The seats are stubs: a pty child that hands its launch env to a seat host in this process, which
 * runs the seat's `MeshAgent` (presence, durable joins) and closes it when the child exits, as a
 * connector's connection ends with its process.
 *
 * Run: pnpm smoke:manager-mass-stop (needs nats-server on PATH)
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTROL_DELIVERY_ADMIN, controlServiceSubject, createSpaceAuth, liveKvEntries, mintCreds, newIdentity, openMembersRegistry,
  parseMemberKey, registry, setupSpaceStreams, type Connector, type ControlReply, type ControlRequest, type LaunchOpts, type LaunchSpec,
} from "@cotal-ai/core";
import { MeshAgent, configFromEnv } from "@cotal-ai/connector-core";
import { authDir, saveSpaceAuth, workspaceSecretStore } from "@cotal-ai/workspace";
import { createSuite } from "@cotal-ai/smoke-kit";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { Manager } from "../src/manager.js";
import { bootBroker } from "./_boot-broker.js";
import { bootDeliveryDaemon } from "./_boot-delivery.js";

const { check, finish } = createSuite();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SEATS = 20;
const BOUND = 8;
const CONNECTOR = "mass-stop-stub";

for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
const token = String(Date.now() % 1_000_000).padStart(6, "0");
const space = `massstop-${Math.random().toString(36).slice(2, 8)}`;
const dir = mkdtempSync(join(tmpdir(), "mass-stop-"));
const workspaceRoot = join(dir, "ws"), seatDir = join(dir, "seats");
for (const d of [join(workspaceRoot, ".cotal", "agents"), seatDir, join(dir, "home")]) mkdirSync(d, { recursive: true });
process.env.COTAL_HOME = join(dir, "home");
process.env.COTAL_SEAT_ROOT = mkdtempSync(join(tmpdir(), "s"));
process.env.DO_NOT_TRACK = "1";
// Each seat reads `general` (a concrete launch channel) and `lane.a` under `lane.>`: the `lane.a` row is
// outside the launch's concrete channels, so only the inventory names it to the teardown.
for (let i = 0; i < SEATS; i++)
  writeFileSync(join(workspaceRoot, ".cotal", "agents", `seat${i}.md`), `---\nname: seat${i}\nrole: default\nsubscribe: [general, lane.a]\nallowSubscribe: [general, "lane.>"]\nallowPublish: [general]\n---\n`);

const auth = await createSpaceAuth(space);
saveSpaceAuth(authDir(workspaceRoot), auth);
const broker = await bootBroker(auth);
let daemon: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
let manager: Manager | undefined;
const seats = new Map<string, { agent: MeshAgent; pid: number }>();
let seatPoll: ReturnType<typeof setInterval> | undefined;
let observer: Awaited<ReturnType<typeof connect>> | undefined;
try {
  await setupSpaceStreams({ servers: broker.servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  // Hold the first eviction of the stop open, once armed.
  let evictionHeld: { entered: () => void; release: Promise<void> } | undefined;
  daemon = await bootDeliveryDaemon({
    space, servers: broker.servers, auth, reloadStoreIdentity: workspaceSecretStore(workspaceRoot).identity,
    onEvict: async () => {
      const held = evictionHeld;
      evictionHeld = undefined;
      if (held) { held.entered(); await held.release; }
    },
  });
  // When each eviction returned, by principal.
  const evictedAt = new Map<string, number>();
  const d = daemon.ep as unknown as { handleDeliveryAdmin(req: ControlRequest): Promise<ControlReply> };
  const handle = d.handleDeliveryAdmin.bind(d);
  d.handleDeliveryAdmin = async (req) => {
    const reply = await handle(req);
    if (req.op === "evictPrincipal" && reply.ok) evictedAt.set(String(req.args?.principal), Date.now());
    return reply;
  };
  // Every request the stop sends on the daemon's admin rail, as it is published.
  const observerId = newIdentity();
  observer = await connect({ servers: broker.servers, inboxPrefix: `_INBOX_${observerId.id}`, authenticator: credsAuthenticator(new TextEncoder().encode(await mintCreds(auth, observerId, "delivery"))) });
  const published: { op: string; principal: string; at: number }[] = [];
  const rail = observer.subscribe(controlServiceSubject(space, CONTROL_DELIVERY_ADMIN, "*", "*"));
  void (async () => {
    for await (const m of rail) {
      try { const req = m.json<ControlRequest>(); published.push({ op: req.op, principal: String(req.args?.principal), at: Date.now() }); } catch { /* not a request */ }
    }
  })();

  // The seat host: one MeshAgent per stub child, closed when the child exits.
  seatPoll = setInterval(() => {
    for (const f of readdirSync(seatDir)) {
      if (!f.endsWith(".seat")) continue;
      const path = join(seatDir, f);
      const env: NodeJS.ProcessEnv = {};
      for (const line of readFileSync(path, "utf8").split("\n")) { const eq = line.indexOf("="); if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1); }
      renameSync(path, `${path}.taken`);
      const agent = new MeshAgent(configFromEnv(env), env, { withholdProcessCwd: true });
      agent.on("error", () => {});
      seats.set(f, { agent, pid: Number(env.SEAT_PID) });
      void agent.start().catch(() => {});
    }
    for (const [f, s] of seats) {
      try { process.kill(s.pid, 0); } catch { seats.delete(f); void s.agent.stop().catch(() => {}); }
    }
  }, 100);
  const stub: Connector = {
    kind: "connector", name: CONNECTOR, requires: ["sh"],
    buildLaunch: (o: LaunchOpts): LaunchSpec => ({
      command: "sh",
      args: ["-c", `umask 077; f="$SEAT_HOST_DIR/$COTAL_ID"; { env | grep '^COTAL_'; echo "SEAT_PID=$$"; } > "$f.tmp" && mv "$f.tmp" "$f.seat"; exec sleep 99999.${token}`],
      env: {
        PATH: process.env.PATH ?? "", SEAT_HOST_DIR: seatDir, HOME: process.env.HOME ?? "",
        COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers), COTAL_NAME: o.name,
        ...(o.id ? { COTAL_ID: o.id } : {}), ...(o.role ? { COTAL_ROLE: o.role } : {}),
        ...(o.creds ? { COTAL_CREDS: o.creds } : {}), ...(o.lifecycleUid ? { COTAL_LIFECYCLE_UID: o.lifecycleUid } : {}),
        ...(o.acceptedToken ? { COTAL_ACCEPTED_TOKEN: o.acceptedToken } : {}),
        ...(o.subscribe ? { COTAL_SUBSCRIBE: o.subscribe.join(",") } : {}),
        ...(o.allowSubscribe ? { COTAL_ALLOW_SUBSCRIBE: o.allowSubscribe.join(",") } : {}),
        ...(o.allowPublish ? { COTAL_ALLOW_PUBLISH: o.allowPublish.join(",") } : {}),
      },
    }),
  };
  registry.register(stub);
  manager = new Manager({ space, servers: broker.servers, runtime: "pty", workspaceRoot });
  await manager.start();
  let spawned = 0;
  for (let i = 0; i < SEATS; i++) if ((await manager.startAgent({ name: `seat${i}`, agent: CONNECTOR, cwd: workspaceRoot, events: false })).ok) spawned++;
  check(`${SEATS} stub seats spawned`, spawned === SEATS, { spawned });

  // The rows on the broker, by lifecycle.
  const kv = await openMembersRegistry(observer, space);
  const rows = async () => (await liveKvEntries(kv)).map((e) => parseMemberKey(e.key)).filter((p) => p !== null);
  let before = await rows();
  for (let i = 0; i < 300 && before.length < SEATS * 2; i++) { await wait(200); before = await rows(); }
  const uids = new Set(before.map((r) => r.lifecycleUid));
  check(`every seat holds its two membership rows before the stop (${SEATS * 2})`,
    before.length === SEATS * 2 && uids.size === SEATS && before.filter((r) => r.channel === "lane.a").length === SEATS, { rows: before.length, lifecycles: uids.size });

  // Stop with the first eviction held open on the daemon.
  const lines: string[] = [];
  const log = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); log(...a); };
  let releaseEviction!: () => void;
  const entered = new Promise<void>((resolve) => { evictionHeld = { entered: resolve, release: new Promise((r) => { releaseEviction = r; }) }; });
  const railStart = published.length;
  const stopping = manager.stop();
  let held = false;
  await Promise.race([entered.then(() => { held = true; }), wait(120_000)]);
  check("the stop's first eviction reached the daemon and was held there", held);
  const evictions = () => published.slice(railStart).filter((p) => p.op === "evictPrincipal").length;
  for (let i = 0; i < 300 && evictions() < BOUND; i++) await wait(100);
  await wait(3000);
  const inFlight = evictions();
  releaseEviction();
  let stopError: string | undefined;
  await stopping.catch((e: Error) => { stopError = e.message; });
  console.error = log;
  check(`with one eviction held open, ${BOUND} evictions were requested and the other ${SEATS - BOUND} retirements waited`, inFlight === BOUND, { inFlight });
  check("the stop completed", stopError === undefined, stopError);

  const sent = published.slice(railStart);
  const evictionsSent = sent.filter((p) => p.op === "evictPrincipal");
  const inventories = sent.filter((p) => p.op === "lifecycleMemberships");
  check(`every seat's retirement requested one eviction and one inventory (${SEATS} each)`,
    evictionsSent.length === SEATS && inventories.length === SEATS && new Set(inventories.map((p) => p.principal)).size === SEATS,
    { evictions: evictionsSent.length, inventories: inventories.length });
  const early = inventories.filter((p) => !(evictedAt.get(p.principal)! <= p.at));
  check("each seat's inventory was requested only after its own eviction returned", early.length === 0 && inventories.length === SEATS, early);

  const after = (await rows()).filter((r) => uids.has(r.lifecycleUid));
  check("0 membership rows of the retired lifecycles remain on the broker", after.length === 0, after);
  const incomplete = lines.filter((l) => l.includes("membership inventory incomplete"));
  check("no retirement reported its membership inventory as incomplete", incomplete.length === 0, incomplete.slice(0, 3));
} catch (e) {
  check(`suite ran without throwing: ${(e as Error).stack ?? (e as Error).message}`, false);
} finally {
  if (seatPoll) clearInterval(seatPoll);
  await manager?.stop().catch(() => {});
  await Promise.all([...seats.values()].map((s) => s.agent.stop().catch(() => {})));
  try { execFileSync("pkill", ["-f", `sleep 99999.${token}`]); } catch { /* none left */ }
  await observer?.close().catch(() => {});
  await daemon?.stop().catch(() => {});
  await broker.stop();
  rmSync(dir, { recursive: true, force: true });
  rmSync(process.env.COTAL_SEAT_ROOT!, { recursive: true, force: true });
}
finish();
process.exit(process.exitCode ?? 0);
