/**
 * A seat started by foreground `cotal spawn` on a static mesh is issued (SPEC 13.15), so it holds
 * evidence its helpers' spawns are bounded by. Real argv through `runCli` against a real broker on
 * an OS-assigned port: the CLI activates the seat's own lifecycle, issues its credential against the
 * lifecycle's gate and hands the seat its accepted token. A fixture connector runs a real child that
 * prints what it was handed and exits on a line from stdin, which is the seat's clean exit.
 *
 *   A. the seat is handed an accepted token, its credential reads its accepted row, and the evidence
 *      resolves with the seat's own gate as its one source and the furthest horizon as its expiry.
 *   B. the seat stands bounded, as an agent, never as an operator instrument.
 *   C. its clean exit retires the gate, so the evidence no longer resolves.
 *   D. `--expires-at` sets the generation's horizon and the credential's expiry.
 *   E. the expiry flags are refused for a managed launch.
 *
 * Needs `nats-server` on PATH. Run: pnpm smoke:foreground-issuance:live
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitSentinel } from "@cotal-ai/smoke-kit";

if (process.argv[2] === "worker") {
  await import("../src/index.js");
  const { runCli } = await import("../src/command.js");
  const { registry, eventChannel } = await import("@cotal-ai/core");
  registry.register({
    kind: "connector", name: "foreground-issuance-fixture", requires: [], eventChannel,
    buildLaunch: (options: import("@cotal-ai/core").LaunchOpts) => ({
      command: process.execPath,
      args: ["-e", "console.log('FIXTURE_SEAT '+JSON.stringify({token:process.env.FIXTURE_TOKEN,creds:process.env.FIXTURE_CREDS,uid:process.env.FIXTURE_UID,id:process.env.FIXTURE_ID}));process.stdin.on('data',()=>process.exit(0));process.stdin.resume();"],
      env: { FIXTURE_TOKEN: options.acceptedToken ?? "", FIXTURE_CREDS: options.creds ?? "", FIXTURE_UID: options.lifecycleUid ?? "", FIXTURE_ID: options.id ?? "" },
    }),
  } as import("@cotal-ai/core").Connector);
  await runCli(registry, ["spawn", ...process.argv.slice(3)]);
  process.exit(process.exitCode ?? 0);
}

const home = mkdtempSync(join(tmpdir(), "cotal-fg-issuance-home-"));
const root = mkdtempSync(join(tmpdir(), "cotal-fg-issuance-root-"));
process.env.COTAL_HOME = home;
const { createSpaceAuth, credsClaims, dialerFor, issuedHorizon, issuedSpawnerStanding, mintCreds, newIdentity, readAcceptedRow, setupSpaceStreams, standaloneConnectOpts, withIssuerSession, DEV_OWNER } =
  await import("@cotal-ai/core");
const { authDir, recordMesh, saveSpaceAuth, TERMINAL_SEAT_HORIZON_SEC } = await import("@cotal-ai/workspace");
const { bootBroker } = await import("../../manager/smoke/_boot-broker.js");
const { validateSpawnArguments } = await import("../src/commands/spawn.js");

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}${extra !== undefined ? ` — ${typeof extra === "string" ? extra : JSON.stringify(extra)}` : ""}`); }
};

const space = "fgissuance";
const auth = await createSpaceAuth(space);
const broker = await bootBroker(auth);
saveSpaceAuth(authDir(root), auth);
await setupSpaceStreams({ servers: broker.servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
recordMesh({ space, server: broker.servers, root, mode: "auth", origin: "manual", ts: new Date().toISOString() });
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
writeFileSync(join(root, ".cotal", "agents", "default.md"), "---\nname: issued\nagent: foreground-issuance-fixture\nallowSubscribe: [review]\nallowPublish: [review]\ncapabilities: [spawn]\n---\nFixture only.\n");
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: join(home, "home"), COTAL_HOME: home,
  XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), XDG_DATA_HOME: join(home, "data"),
  COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_PROMPT: "1", NO_COLOR: "1", DO_NOT_TRACK: "1", COTAL_TELEMETRY: "off",
};
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"]) mkdirSync(env[key]!, { recursive: true });

type Seat = { token: string; creds: string; uid: string; id: string };
type Worker = { child: ChildProcessWithoutNullStreams; output: string; seat: Promise<Seat | undefined>; closed: Promise<number | null>; exited: boolean };
const workers: Worker[] = [];
function launch(extra: string[]): Worker {
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, "worker", "--foreground", "--space", space, ...extra], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  let settle!: (seat: Seat | undefined) => void;
  const worker: Worker = { child, output: "", seat: new Promise((resolve) => { settle = resolve; }), closed: Promise.resolve(null), exited: false };
  const timer = setTimeout(() => settle(undefined), 20_000);
  const collect = (chunk: Buffer) => {
    worker.output += chunk.toString();
    const m = /^FIXTURE_SEAT (.+)$/m.exec(worker.output);
    if (m) { clearTimeout(timer); settle(JSON.parse(m[1]!) as Seat); }
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  worker.closed = new Promise((resolve) => {
    child.once("close", (code) => { clearTimeout(timer); settle(undefined); worker.exited = true; resolve(code); });
  });
  workers.push(worker);
  return worker;
}
async function stop(worker: Worker): Promise<void> {
  if (worker.exited) return;
  worker.child.stdin.write("stop\n");
  const timer = setTimeout(() => { if (!worker.exited) try { process.kill(-worker.child.pid!, "SIGKILL"); } catch { /* already gone */ } }, 10_000);
  await worker.closed;
  clearTimeout(timer);
}
/** The seat's issued reference, read the way its endpoint reads it: under its own credential. */
async function refOf(seat: Seat) {
  const nc = await dialerFor(broker.servers)({ servers: broker.servers, ...standaloneConnectOpts({ creds: readFileSync(seat.creds, "utf8"), tls: false }), maxReconnectAttempts: 0 });
  try { return await readAcceptedRow(nc, space, seat.token); } finally { await nc.close(); }
}
const resolveRef = (ref: Awaited<ReturnType<typeof refOf>>) =>
  withIssuerSession({ servers: broker.servers, space, auth, tls: false }, (s) => s.store.resolve(ref, s.sourceIsLive));
const outcome = async <T>(fn: () => Promise<T>): Promise<{ value?: T; error?: string }> => {
  try { return { value: await fn() }; } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
};

let ok = false;
try {
  console.log("A. issued under its own lifecycle");
  const w = launch([]);
  const seat = await w.seat;
  check("the foreground seat is handed an accepted token", seat !== undefined && /^[0-9a-f]{32}$/.test(seat.token), w.output);
  const ref = seat ? await outcome(() => refOf(seat)) : { error: "no seat" };
  check("its own credential reads its accepted row", ref.value?.owner === DEV_OWNER && ref.value.actor === seat?.id && ref.value.uid === seat?.uid, ref);
  const resolved = ref.value ? await outcome(() => resolveRef(ref.value!)) : { error: "no ref" };
  const ev = resolved.value?.evidence;
  check("its evidence names the seat's own gate as its one source", ev !== undefined && ev.sources.length === 1 && ev.sources[0]!.key === `cred.${seat?.uid}`, resolved);
  check("and has the furthest horizon, since no expiry was set", ref.value !== undefined && issuedHorizon(ref.value.generation) === TERMINAL_SEAT_HORIZON_SEC, ref.value);

  console.log("B. bounded as an agent");
  check("the seat stands bounded, never as an instrument", ev !== undefined && issuedSpawnerStanding(ev) === "bounded", ev && issuedSpawnerStanding(ev));

  console.log("C. a clean exit retires it");
  await stop(w);
  check("control: the seat left cleanly and its creds were retired", /retired creds for issued/.test(w.output), w.output);
  const after = ref.value ? await outcome(() => resolveRef(ref.value!)) : { error: "no ref" };
  check("its evidence no longer resolves once its gate is retired", after.error !== undefined && /no longer live|retired/.test(after.error), after);

  console.log("D. an expiry the person sets");
  const at = Math.floor(Date.now() / 1000) + 7200;
  const wx = launch(["--expires-at", String(at)]);
  const seatX = await wx.seat;
  const refX = seatX ? await outcome(() => refOf(seatX)) : { error: "no seat" };
  check("--expires-at is the generation's horizon", refX.value !== undefined && issuedHorizon(refX.value.generation) === at, refX);
  const claims = seatX ? credsClaims(readFileSync(seatX.creds, "utf8")) : undefined;
  check("and the credential's expiry", claims?.exp === at, claims);
  await stop(wx);

  console.log("E. not for a managed launch");
  const refused = await outcome(async () => validateSpawnArguments({ values: { detach: true, "expires-in": "60" }, positionals: [], raw: [] } as never));
  check("the expiry flags are refused with -d", refused.error !== undefined && /a manager renews its own seats' credentials/.test(refused.error), refused);
  ok = true;
} finally {
  for (const worker of workers) await stop(worker);
  await broker.stop();
  if (ok && workers.every((worker) => worker.exited)) {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}
console.log(`\nFOREGROUND-ISSUANCE ${pass} passed, ${fail} failed`);
emitSentinel({ passed: pass, failed: fail });
process.exit(fail ? 1 : 0);
