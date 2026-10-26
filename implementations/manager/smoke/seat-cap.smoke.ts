/**
 * PER-OWNER SEAT CAP smoke. Run: pnpm smoke:seat-cap   (build first; it drives bin/cotal.ts, which
 * imports dist, and it boots its own broker and real seat processes.)
 *
 * A manager bounds the HOST with MAX_AGENTS, and nothing bounded ONE OWNER'S share of it. Measured
 * on this tree at 43a3e79e4 against a private stack: four `cotal spawn -d` for one owner, each
 * `exit 0 outcome=ok`, with a fourth admitted after a stop. On a manager hosting several owners
 * that lets the first one to ask take every slot, and the owners that arrive later read the host
 * ceiling's refusal, which tells them to despawn a seat they do not own.
 *
 * The cap closes that: live seats this manager supervises for one owner, refused at accept with
 * the owner's count, the cap and a remedy that names what THAT owner can do.
 *
 * WHAT THIS GRADES, against a real broker, a real Manager and real seat processes:
 *   1  THE FIXTURE. The default admits more than any cap below, so every refusal here is the cap
 *      and not the host ceiling, and a single-owner mesh keeps the slots it had.
 *   2  THE CEILING. Two launches land, the third refuses `resource-exhausted` carrying
 *      {owner, seats, cap} and `not-executed`.
 *   3  NOTHING LEFT BEHIND. The refusal reserves no name and the owner's count is unchanged.
 *   4  THE LIVE SEATS ARE UNTOUCHED. A spawn already running is never affected by a later refusal.
 *   5  RECOVERABLE. Stopping one of that owner's seats admits the next.
 *   6  A RESERVATION, NOT A READ. A concurrent burst past the cap still lands at most `cap`.
 *   7  PER OWNER. Seats held for another owner do not count against this one, and the same N+1th
 *      launch succeeds on a manager whose cap is higher — so the cap is the cause, not a
 *      coincidence of the fixture.
 *   8  THE CLI. The real binary exits 2 with the manager's sentence and a remedy, and `--json`
 *      carries CONFLICT, the native code and the three numbers.
 *   9  THE CONNECTOR. `cotal_spawn` renders the manager's own refusal reply as the same sentence.
 *  10  THE RECORD. A cap set at one start is what the next start reads back, `unlimited` round
 *      trips, and a value that is neither is a usage refusal.
 *
 * WHAT IT CANNOT SEE, said first. Every live seat here belongs to the mesh's one owner, because a
 * static mesh has exactly one; the second owner in cell 7 is PLANTED into the same `agents` map
 * the counter reads, with `userOwner` as the only discriminating field. That grades the count's
 * owner split and the refusal it produces, not a user-auth mesh's provisioning path. Cell 9 drives
 * the connector tool over the manager's OWN reply rather than over the wire, so it grades the
 * relay, not the bearer exchange underneath it.
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isReachable, registry, seatCapFrom, serverConfig, setupSpaceStreams, mintCreds, newIdentity, createSpaceAuth, DEV_OWNER,
  type Connector, type ControlReply, type LaunchOpts, type LaunchSpec,
} from "@cotal-ai/core";
import {
  authDir, parseSeatCapFlag, readManagerSeatCap, recordManagerSeatCap, recordMesh, saveSpaceAuth,
  SEAT_CAP_UNLIMITED, isCommandFailure,
} from "@cotal-ai/workspace";
import { launchEnv } from "@cotal-ai/connector-core";
// Dev-only smoke import of the sibling package's source, as the auth suites do: the tool spec
// is not on connector-core's published surface, and the point of the cell is the shipped renderer.
import { cotalToolSpecs } from "../../../extensions/connector-core/src/tool-specs.js";
import type { AgentConfig } from "../../../extensions/connector-core/src/config.js";
import { Manager } from "../src/manager.js";
import { SMOKE_BROKER_TOKEN, freePort, makeSeatRoot, teardownOnSignal } from "@cotal-ai/smoke-kit";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const CAP = 2;
const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
// The same live-broker guard the sibling CLI suite uses, and for the same reason: this one spawns
// the real binary, which resolves a mesh from the environment before it reads a flag.
const LIVE_HOST = "broker.cotal.ai";
for (const k of ["COTAL_SERVERS", "COTAL_SERVER", "COTAL_CREDS", "COTAL_SPACE"]) delete process.env[k];
for (const [k, v] of Object.entries(process.env))
  if (typeof v === "string" && v.includes(LIVE_HOST)) throw new Error(`refusing to run: ${k} points at the live broker (${v})`);
if (!/^nats:\/\/127\.0\.0\.1:\d+$/.test(SERVERS)) throw new Error(`this suite only runs against an ephemeral loopback broker; got ${SERVERS}`);

const space = `seatcap-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}seatcap-`));
const home = join(dir, "home");
mkdirSync(home, { recursive: true, mode: 0o700 });
process.env.COTAL_HOME = home;
// A disposable custody root for this run's seats, read by the pty runtime at construction, so the
// suite's own reap can never reach a seat under the operator's shared `~/.cotal/seats`.
process.env.COTAL_SEAT_ROOT = makeSeatRoot("seatcap-seats-");
// Per-manager name sets. A seat's alias is mesh-wide and its static slot is per-space, so reusing
// one set across the managers below would collide on the alias and the slot, which is not the cap
// under test and would read as one.
const UNCAPPED = ["u1", "u2", "u3"];
const CAPPED = ["c1", "c2", "c3", "c4", "c5"];
const BURST = ["b1", "b2", "b3"];
const ROOMY = ["r1", "r2", "r3"];
const PERSONAS = [...UNCAPPED, ...CAPPED, ...BURST, ...ROOMY, "cli1"];
/** One workspace root per manager. Two managers of one space sharing a root re-register the same
 *  logical instance, and the second one's startup then tries to verify-evict the first's serve
 *  family through a delivery daemon this suite does not run. Separate roots keep each manager its
 *  own instance, which is also what a multi-manager space looks like. */
const mkRoot = (tag: string): string => {
  const r = join(dir, tag);
  mkdirSync(join(r, ".cotal", "agents"), { recursive: true });
  for (const n of PERSONAS) writeFileSync(join(r, ".cotal", "agents", `${n}.md`), `---\nname: ${n}\nrole: worker\n---\nbody\n`);
  saveSpaceAuth(authDir(r), auth);
  recordMesh({ space, server: SERVERS, root: r, mode: "auth", ts: new Date().toISOString() });
  return r;
};
const root = join(dir, "cap");
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));

const broker = spawnProc("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);

// A seat that really joins presence under its manager-assigned id, so a launch settles `started`
// on a real mesh join and the manager holds a real child process for it.
const coreDist = join(import.meta.dirname, "..", "..", "..", "packages", "core", "dist", "index.js");
const JOIN_CHILD = [
  "const{pathToFileURL}=require('node:url');",
  "import(pathToFileURL(process.env.CORE_DIST).href).then(async({CotalEndpoint})=>{",
  "const ep=new CotalEndpoint({space:process.env.COTAL_SPACE,servers:process.env.COTAL_SERVERS,creds:require('node:fs').readFileSync(process.env.COTAL_CREDS,'utf8'),lifecycleUid:process.env.COTAL_LIFECYCLE_UID||undefined,channels:[],consume:false,registerPresence:true,watchPresence:false,card:{id:process.env.COTAL_ID||undefined,name:process.env.COTAL_NAME,kind:'agent'}});",
  "ep.on('error',()=>{});await ep.start();setInterval(()=>{},1<<30);});",
].join("");
const joiner: Connector = {
  kind: "connector", name: "joiner", requires: ["node"],
  buildLaunch: (o: LaunchOpts): LaunchSpec => ({
    command: process.execPath, args: ["-e", JOIN_CHILD],
    env: {
      ...launchEnv(), CORE_DIST: coreDist, COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? SERVERS),
      COTAL_CREDS: o.creds ?? "", COTAL_ID: o.id ?? "", COTAL_LIFECYCLE_UID: o.lifecycleUid ?? "", COTAL_NAME: o.name,
    },
  }),
};
registry.register(joiner);

const TSX = join(import.meta.dirname, "..", "..", "..", "node_modules", ".bin", "tsx");
const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "cotal.ts");
type Run = { status: number | null; stdout: string; out: string; timedOut: boolean; signal: NodeJS.Signals | null; launchError?: string };
function cotal(args: string[], timeoutMs = 120_000): Promise<Run> {
  return new Promise((res) => {
    const child = spawnProc(TSX, [BIN, ...args], {
      cwd: root, env: { ...process.env, COTAL_HOME: home, COTAL_SKIP_CONNECTOR_SEED: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", out = "", timedOut = false, settled = false;
    let status: number | null = null, signal: NodeJS.Signals | null = null;
    const done = (r: Run) => { if (settled) return; settled = true; clearTimeout(t); res(r); };
    const t = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.on("error", (e) => done({ status: null, stdout, out, timedOut, signal: null, launchError: e.message }));
    child.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); out += d.toString(); });
    child.stderr!.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("exit", (s, sg) => { status = s; signal = sg; });
    child.on("close", (s, sg) => done({ status: s ?? status, stdout, out, timedOut, signal: sg ?? signal }));
  });
}
/** Refuse to grade anything but a self-terminated child: every other shape fakes the refusal shape. */
function mustHaveRun(r: Run, what: string): void {
  const why = r.launchError ? `never launched (${r.launchError})`
    : r.timedOut ? "was SIGKILLed by this suite's timeout"
    : r.signal ? `was killed by ${r.signal} from outside this suite`
    : r.status === null ? "ended with neither an exit code nor a signal" : null;
  if (why === null) return;
  process.exitCode = 1;
  throw new Error(`FIXTURE FAILURE, not a product defect: ${what} ${why}.\n${r.out.slice(-800)}`);
}
type Envelope = { outcome: string; error?: { code: string; message: string; remedy?: string; cause?: { code?: string; outcome?: string; detail?: unknown } } };
const envelopeOf = (r: Run): Envelope | undefined => {
  const lines = r.stdout.split("\n").filter(Boolean);
  try { return JSON.parse(lines[lines.length - 1]!) as Envelope; } catch { return undefined; }
};

/** The manager internals this suite reads: the count under test, the refusal it builds, and the
 *  two maps a refused launch must not touch. */
type MgrPriv = {
  managerInstanceId: string;
  agents: Map<string, { name: string; userOwner?: string }>;
  reserved: Map<string, string>;
  ownerSeats(owner: string): number;
  startAgent(opts: { name: string; agent?: string; events?: boolean }): Promise<ControlReply>;
  opStop(args: Record<string, unknown>, caller: string, admin: boolean): Promise<ControlReply>;
};
const managers: InstanceType<typeof Manager>[] = [];
async function bootManager(workspaceRoot: string, seatCap?: number | typeof SEAT_CAP_UNLIMITED): Promise<InstanceType<typeof Manager>> {
  const mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot, ...(seatCap !== undefined ? { seatCap } : {}) });
  await mgr.start();
  managers.push(mgr);
  return mgr;
}
const priv = (m: InstanceType<typeof Manager>): MgrPriv => m as unknown as MgrPriv;
const spawnSeat = (m: InstanceType<typeof Manager>, name: string): Promise<ControlReply> =>
  priv(m).startAgent({ name, agent: "joiner", events: false });

try {
  let up = false;
  for (let i = 0; i < 80; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  // ---- 1. THE FIXTURE ------------------------------------------------------------------------
  // Without this, every refusal below could be the host ceiling in disguise and the suite would
  // read the same. An uncapped manager must admit MORE than the cap under test.
  console.log("1. an uncapped manager admits more than the cap under test");
  const open = await bootManager(mkRoot("uncapped"));
  const admitted: ControlReply[] = [];
  for (const n of UNCAPPED) admitted.push(await spawnSeat(open, n));
  check(`the default admits ${CAP + 1} seats for one owner, so nothing below is the host ceiling`,
    admitted.every((r) => r.ok), admitted.map((r) => ({ ok: r.ok, error: r.error })));
  check("and the mesh's one owner is what holds them",
    priv(open).ownerSeats(DEV_OWNER) === 3, priv(open).ownerSeats(DEV_OWNER));
  await open.stop();
  managers.splice(managers.indexOf(open), 1);

  // ---- 2. THE CEILING ------------------------------------------------------------------------
  console.log(`\n2. a manager with --seat-cap ${CAP} admits ${CAP} and refuses the next`);
  mkRoot("cap");
  const mgr = await bootManager(root, CAP);
  const M = priv(mgr);
  const first = await spawnSeat(mgr, CAPPED[0]!);
  const second = await spawnSeat(mgr, CAPPED[1]!);
  check(`the first ${CAP} launches land`, first.ok && second.ok, { first: first.error, second: second.error });
  const refused = await spawnSeat(mgr, CAPPED[2]!);
  check("the next one is refused", refused.ok === false, refused);
  check("under the resource-exhausted code, not the generic precondition", refused.code === "resource-exhausted", refused.code);
  const facts = seatCapFrom(refused);
  check("carrying the seat-cap marker with the owner, its count and the cap",
    facts?.owner === DEV_OWNER && facts?.seats === CAP && facts?.cap === CAP, facts);
  check("and a sentence that states all three and names the remedy",
    typeof refused.error === "string"
      && refused.error.includes(`holds ${CAP} of the ${CAP} seats`)
      && refused.error.includes(DEV_OWNER)
      && refused.error.includes("stop one of that owner's seats")
      && refused.error.includes("higher seat cap"), refused.error);

  // ---- 3. THE REFUSAL LEFT NOTHING BEHIND ----------------------------------------------------
  console.log("\n3. the refusal is not a half-launch");
  check("no name was reserved for it", !M.reserved.has(CAPPED[2]!), [...M.reserved.keys()]);
  check("no seat was added", !M.agents.has(CAPPED[2]!), [...M.agents.keys()]);
  check("and the owner's count is what it was before the attempt", M.ownerSeats(DEV_OWNER) === CAP, M.ownerSeats(DEV_OWNER));

  // ---- 4. THE LIVE SEATS ---------------------------------------------------------------------
  console.log("\n4. a spawn already running is never affected");
  const live = [...M.agents.keys()].sort();
  check("both admitted seats are still supervised after the refusal", live.join(",") === `${CAPPED[0]},${CAPPED[1]}`, live);

  // ---- 5. RECOVERABLE ------------------------------------------------------------------------
  console.log("\n5. stopping one of that owner's seats admits the next");
  const stopped = await M.opStop({ name: CAPPED[0]! }, `${DEV_OWNER}.smoke`, true);
  check("the stop is accepted", stopped.ok !== false, stopped);
  for (let i = 0; i < 100 && M.ownerSeats(DEV_OWNER) >= CAP; i++) await wait(50);
  const readmitted = await spawnSeat(mgr, CAPPED[3]!);
  check("and the launch that was refused a moment ago now lands", readmitted.ok === true, readmitted.error);

  // ---- 6. A RESERVATION, NOT A CHECK-THEN-ACT READ -------------------------------------------
  // The count a launch reads must be the one its reservation lands against. Issued together, these
  // all read before any of the others could place a seat; only a reservation-shaped gate bounds them.
  console.log("\n6. a concurrent burst past the cap still lands at most the cap");
  const burstMgr = await bootManager(mkRoot("burst"), CAP);
  const B = priv(burstMgr);
  const burst = await Promise.all(BURST.map((n) => spawnSeat(burstMgr, n)));
  const landed = burst.filter((r) => r.ok).length;
  check(`at most ${CAP} of 3 concurrent launches landed`, landed <= CAP, { landed, errors: burst.map((r) => r.error) });
  check("and every refusal among them is the seat cap, not a name collision",
    burst.filter((r) => !r.ok).every((r) => seatCapFrom(r) !== undefined), burst.filter((r) => !r.ok).map((r) => r.error));
  check("the owner holds no more seats than the cap", B.ownerSeats(DEV_OWNER) <= CAP, B.ownerSeats(DEV_OWNER));
  await burstMgr.stop();
  managers.splice(managers.indexOf(burstMgr), 1);

  // ---- 7. PER OWNER, NOT GLOBAL ---------------------------------------------------------------
  // A static mesh has one owner, so the second one is PLANTED into the same `agents` map the count
  // reads, with `userOwner` as the only field that differs. If the count ignored it, the refusal
  // below would name the planted seats in its total and this cell would go red.
  console.log("\n7. the cap counts one owner's seats, not the manager's");
  const OTHER = "u_zzzzzzzzzzzzzzzzzzzzzzzzzz";
  const before = M.ownerSeats(DEV_OWNER);
  for (const n of ["planted_1", "planted_2", "planted_3"]) M.agents.set(n, { name: n, userOwner: OTHER });
  check("another owner's seats do not move this owner's count", M.ownerSeats(DEV_OWNER) === before, { before, now: M.ownerSeats(DEV_OWNER) });
  check("they are counted against the owner that holds them", M.ownerSeats(OTHER) === 3, M.ownerSeats(OTHER));
  const stillRefused = await spawnSeat(mgr, CAPPED[4]!);
  const stillFacts = seatCapFrom(stillRefused);
  check("and this owner's refusal names its own count, not the manager's total",
    stillRefused.ok === false && stillFacts?.seats === before && stillFacts?.cap === CAP, { reply: stillRefused.error, stillFacts });
  for (const n of ["planted_1", "planted_2", "planted_3"]) M.agents.delete(n);
  // The cap is the CAUSE: the same N+1th launch, on a manager that admits more, succeeds.
  const higher = await bootManager(mkRoot("roomy"), CAP + 2);
  const roomyReplies: ControlReply[] = [];
  for (const n of ROOMY) roomyReplies.push(await spawnSeat(higher, n));
  check(`the launch this cap refused lands on a manager whose cap is ${CAP + 2}`,
    roomyReplies.every((r) => r.ok), roomyReplies.map((r) => r.error));
  await higher.stop();
  managers.splice(managers.indexOf(higher), 1);

  // ---- 8. THE CLI ------------------------------------------------------------------------------
  // The real binary against the real manager: the chain from the reply's marker to the exit code,
  // the sentence and the numbers a script reads is only covered by running it.
  console.log("\n8. `cotal spawn -d` over the cap");
  const cli = await cotal(["spawn", "-d", "cli1", "--agent", "joiner", "--no-events", "--on", M.managerInstanceId, "--space", space, "--json"]);
  mustHaveRun(cli, "the over-cap `cotal spawn -d`");
  check("it exits 2, a refusal at a known boundary before any effect", cli.status === 2, { status: cli.status, tail: cli.out.slice(-400) });
  const env = envelopeOf(cli);
  check("its outcome is refused and its code is CONFLICT", env?.outcome === "refused" && env?.error?.code === "CONFLICT", env?.error);
  check("the sentence is the manager's own, with all three facts",
    env?.error?.message.includes(`holds ${CAP} of the ${CAP} seats`) === true && env?.error?.message.includes(DEV_OWNER) === true, env?.error?.message);
  check("and a remedy naming what this owner can do and what the operator can do",
    env?.error?.remedy?.includes("cotal stop --name") === true && env?.error?.remedy?.includes("--seat-cap") === true, env?.error?.remedy);
  check("--json carries the native code and the three numbers",
    env?.error?.cause?.code === "resource-exhausted" && env?.error?.cause?.outcome === "not-executed"
      && JSON.stringify(env?.error?.cause?.detail) === JSON.stringify({ owner: DEV_OWNER, seats: CAP, cap: CAP }),
    env?.error?.cause);

  // ---- 9. THE CONNECTOR ------------------------------------------------------------------------
  // The tool renders the manager's OWN reply, captured above, so the input to this cell comes from
  // the real producer rather than from a reply this suite wrote to match.
  console.log("\n9. cotal_spawn surfaces the same sentence");
  // An open-mesh caller config: `cotal_spawn` is advertised to an authed agent only when it holds
  // the `spawn` capability, which is the wire boundary this mirrors, not the subject of this cell.
  const toolConfig: AgentConfig = {
    space, name: "smoke-caller", servers: SERVERS, kind: "agent", tls: false,
    subscribe: [], allowSubscribe: [], allowPublish: [],
  };
  const spawnTool = cotalToolSpecs(toolConfig, "smoke").find((t) => t.name === "cotal_spawn");
  check("the cotal_spawn tool exists to render it", spawnTool !== undefined);
  const rendered = await spawnTool!.run({ spawn: async () => refused } as never, toolConfig, { name: CAPPED[2]! });
  check("it reports an error rather than a launch", rendered.isError === true, rendered);
  check("and its text carries the manager's sentence verbatim", rendered.text.includes(refused.error!), rendered.text);

  // ---- 10. THE RECORD ---------------------------------------------------------------------------
  // A cap an operator set is a decision, not a derivable fact: a bare restart, a repair or a
  // `spawn -f` that relaunches the manager must not silently reopen the host to one owner.
  console.log("\n10. the cap a start records is what the next start reads");
  const ctx = { root: join(dir, "recorded"), space };
  mkdirSync(join(ctx.root, ".cotal"), { recursive: true });
  check("nothing recorded yet reads as undefined, so the default stands", readManagerSeatCap(ctx) === undefined);
  recordManagerSeatCap(ctx, 7);
  check("a number round trips", readManagerSeatCap(ctx) === 7, readManagerSeatCap(ctx));
  recordManagerSeatCap(ctx, SEAT_CAP_UNLIMITED);
  check("and so does unlimited", readManagerSeatCap(ctx) === SEAT_CAP_UNLIMITED, readManagerSeatCap(ctx));
  check("the flag parses a positive integer", parseSeatCapFlag("--seat-cap", "4") === 4);
  check("the flag parses unlimited", parseSeatCapFlag("--seat-cap", "unlimited") === SEAT_CAP_UNLIMITED);
  check("an absent flag stays undefined so the recorded value applies", parseSeatCapFlag("--seat-cap", undefined) === undefined);
  for (const bad of ["0", "-1", "abc", "2.5", ""]) {
    let refusal: unknown;
    try { parseSeatCapFlag("--seat-cap", bad); } catch (e) { refusal = e; }
    check(`--seat-cap ${JSON.stringify(bad)} is a usage refusal, never a silent ceiling`,
      isCommandFailure(refusal) && refusal.code === "USAGE_INVALID", refusal);
  }
} finally {
  for (const m of managers) { try { await m.stop(); } catch { /* teardown */ } }
  releaseBroker();
  broker.kill("SIGKILL");
}

console.log(`\n${fail === 0 ? "✓" : "✗"} seat-cap: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
