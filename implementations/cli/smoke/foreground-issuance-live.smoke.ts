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
 *   C. its clean exit revokes its issuance and retires its gate, so the evidence no longer resolves.
 *   D. `--expires-at` sets the generation's horizon and the credential's expiry.
 *   E. the expiry flags are refused for a managed launch.
 *   F. a persona's endpoint commands are minted on the seat's credential, and an instance-pinned
 *      entry is minted on that instance's rail alone, with that instance's describe.
 *
 *   G. default payload publishing and foreground flag/persona withholding reach the credential,
 *      sealed launch material, recorder config and a real emitter against the broker. Tool records
 *      are synthetic, not output from a native connector session.
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
  const { materialEnv, configFromEnv } = await import("../../../extensions/connector-core/dist/index.js");
  registry.register({
    kind: "connector", name: "foreground-issuance-fixture", requires: [], eventChannel,
    buildLaunch: (options: import("@cotal-ai/core").LaunchOpts) => {
      const artifacts: string[] = [];
      const config = configFromEnv({ ...materialEnv(options, artifacts), COTAL_NAME: options.name, COTAL_SPACE: options.space, COTAL_LIFECYCLE_UID: options.lifecycleUid, COTAL_ACCEPTED_TOKEN: options.acceptedToken });
      return {
        command: process.execPath,
        args: ["-e", "console.log('FIXTURE_SEAT '+JSON.stringify({token:process.env.FIXTURE_TOKEN,creds:process.env.FIXTURE_CREDS,uid:process.env.FIXTURE_UID,id:process.env.FIXTURE_ID,endpoints:process.env.FIXTURE_ENDPOINTS,withheld:process.env.FIXTURE_WITHHELD==='true'}));process.stdin.on('data',()=>process.exit(0));process.stdin.resume();"],
        env: { FIXTURE_TOKEN: options.acceptedToken ?? "", FIXTURE_CREDS: options.creds ?? "", FIXTURE_UID: options.lifecycleUid ?? "", FIXTURE_ID: options.id ?? "", FIXTURE_ENDPOINTS: JSON.stringify(options.endpoints ?? null), FIXTURE_WITHHELD: String(config.eventPayloadsWithheld) },
        artifacts,
      };
    },
  } as import("@cotal-ai/core").Connector);
  await runCli(registry, ["spawn", ...process.argv.slice(3)]);
  process.exit(process.exitCode ?? 0);
}

const home = mkdtempSync(join(tmpdir(), "cotal-fg-issuance-home-"));
const root = mkdtempSync(join(tmpdir(), "cotal-fg-issuance-root-"));
process.env.COTAL_HOME = home;
const { createSpaceAuth, credsClaims, dialerFor, epAuthBucket, issuedHorizon, issuedSpawnerStanding, mintCreds, newIdentity, readAcceptedRow, setupSpaceStreams, standaloneConnectOpts, withIssuerSession, DEV_OWNER } =
  await import("@cotal-ai/core");
const { authDir, recordMesh, saveSpaceAuth, TERMINAL_SEAT_HORIZON_SEC } = await import("../../../packages/workspace/dist/index.js");
const { bootBroker } = await import("../../manager/smoke/_boot-broker.js");
const { validateSpawnArguments } = await import("../src/commands/spawn.js");
const { CotalEndpoint, eventPayloadStream, eventChannel, principalKey } = await import("@cotal-ai/core");
const { jetstreamManager } = await import("@nats-io/jetstream");
const { memorySubjectFrontier } = await import("@cotal-ai/smoke-kit");
const { AguiEmitter, EventWal, JsonlFileSource, runStarted, toolCallStart, toolCallArgs, toolCallEnd, toolCallResult } = await import("../../../extensions/connector-core/dist/index.js");

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
writeFileSync(join(root, ".cotal", "agents", "ep.md"), "---\nname: ep\nagent: foreground-issuance-fixture\nsubscribe: []\nendpoints:\n  - endpoint: com.example.orders\n    commands: [list]\n---\nFixture only.\n");
writeFileSync(join(root, ".cotal", "agents", "ep-pin.md"), "---\nname: eppin\nagent: foreground-issuance-fixture\nsubscribe: []\nendpoints:\n  - endpoint: com.example.orders\n    commands: [list]\n    instanceId: i0000000000000000000000000a\n---\nFixture only.\n");
writeFileSync(join(root, ".cotal", "agents", "withheld.md"), "---\nname: withheld\nagent: foreground-issuance-fixture\neventPayloads: false\nallowSubscribe: [review]\nallowPublish: [review]\n---\nFixture only.\n");
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: join(home, "home"), COTAL_HOME: home,
  XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), XDG_DATA_HOME: join(home, "data"),
  COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_PROMPT: "1", NO_COLOR: "1", DO_NOT_TRACK: "1", COTAL_TELEMETRY: "off",
};
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"]) mkdirSync(env[key]!, { recursive: true });

type Seat = { token: string; creds: string; uid: string; id: string; endpoints: string; withheld: boolean };
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

/** Synthetic native record, real emitter and broker using the credential the CLI minted.
 * This is not a native connector session. It checks the launch-to-recorder boundary. */
async function recordTool(seat: Seat): Promise<{ payloads: number; metadata: boolean }> {
  const admin = await dialerFor(broker.servers)({ servers: broker.servers, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "admin"), tls: false }), maxReconnectAttempts: 0 });
  const ep = new CotalEndpoint({ space, servers: broker.servers, creds: readFileSync(seat.creds, "utf8"), lifecycleUid: seat.uid, acceptedToken: seat.token, card: { name: "fixture", kind: "agent", id: seat.id }, consume: false, registerPresence: true, watchPresence: false });
  ep.on("error", () => {});
  try {
    const jsm = await jetstreamManager(admin);
    const before = (await jsm.streams.info(eventPayloadStream(space))).state.messages;
    const metadataSubject = `cotal.${space}.chat.${DEV_OWNER}.${seat.id}.${eventChannel({ owner: DEV_OWNER, actor: seat.id })}`;
    const metadataFrames: string[] = [];
    const sub = admin.subscribe(metadataSubject, { callback: (error, message) => { if (!error) metadataFrames.push(message.string()); } });
    await admin.flush();
    await ep.start();
    const dir = mkdtempSync(join(root, "record-"));
    const source = join(dir, "source.jsonl");
    writeFileSync(source, "");
    const wal = await EventWal.open(join(dir, "wal.json"), { space, threadId: "fixture", principal: principalKey(DEV_OWNER, seat.id).key, subjectMayExist: false });
    const emitter = await AguiEmitter.start({ endpoint: ep, withholdPayloads: seat.withheld, wal, subjectFrontier: memorySubjectFrontier(), source: new JsonlFileSource(source), map: () => ({ runId: "run", events: [runStarted({ threadId: "fixture", runId: "run", timestamp: 1 }), toolCallStart({ toolCallId: "call", toolCallName: "bash", timestamp: 2 }), toolCallArgs({ toolCallId: "call", delta: '{"command":"payload-input-canary"}', timestamp: 2 }), toolCallEnd({ toolCallId: "call", timestamp: 3 }), toolCallResult({ messageId: "result", toolCallId: "call", content: "payload-output-canary", timestamp: 3 })] }) });
    await emitter.pump();
    writeFileSync(source, "{}\n");
    await emitter.pump();
    await admin.flush();
    const metadata = metadataFrames.join("\n");
    sub.unsubscribe();
    return { payloads: (await jsm.streams.info(eventPayloadStream(space))).state.messages - before, metadata: metadata.includes("TOOL_CALL_START") && metadata.includes("bash") && metadata.includes("timestamp") && !metadata.includes("payload-input-canary") && !metadata.includes("payload-output-canary") };
  } finally { await ep.stop(); await admin.close(); }
}

let ok = false;
try {
  console.log("A. issued under its own lifecycle");
  const w = launch([]);
  const seat = await w.seat;
  check("the foreground seat is handed an accepted token", seat !== undefined && /^[0-9a-f]{32}$/.test(seat.token), w.output);
  check("a persona that names no endpoint commands hands the session an empty list", seat?.endpoints === "[]", seat?.endpoints);
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
  check("its issuance is revoked once the seat leaves, so its evidence no longer resolves", after.error !== undefined && /is revoked; only an active issuance authorizes/.test(after.error), after);
  const gate = await outcome(() => withIssuerSession({ servers: broker.servers, space, auth, tls: false }, (s) =>
    s.sourceIsLive({ space, bucket: epAuthBucket(space), key: `cred.${seat?.uid}` })));
  check("and its lifecycle's gate is retired", gate.value === false, gate);

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

  console.log("F. a persona's endpoint commands");
  const we = launch(["ep"]);
  const seatE = await we.seat;
  const pubE = seatE ? (credsClaims(readFileSync(seatE.creds, "utf8")) as { nats?: { pub?: { allow?: string[] } } } | undefined)?.nats?.pub?.allow ?? [] : [];
  // An issued row carries the generation after the caller triple, so match the rail and the seat's uid.
  const listRow = seatE ? new RegExp(`^cotal\\.${space}\\.ep\\.v1\\.one\\.com_example_orders\\.list\\.local\\.[A-Z0-9]+\\.${seatE.uid}\\.`) : /$^/;
  check("the seat's credential carries the request row for each command its persona names",
    pubE.some((r) => listRow.test(r)), pubE.filter((r) => r.includes("orders")));
  check("and no row for a command it does not name", !pubE.some((r) => r.includes(".com_example_orders.create.")), pubE.filter((r) => r.includes("orders")));
  check("and the session is handed the list it minted, not a later read of the file",
    seatE?.endpoints === JSON.stringify([{ endpoint: "com.example.orders", commands: ["list"] }]), seatE?.endpoints);
  await stop(we);
  const wp = launch(["ep-pin"]);
  const seatP = await wp.seat;
  const pubP = seatP ? (credsClaims(readFileSync(seatP.creds, "utf8")) as { nats?: { pub?: { allow?: string[] } } } | undefined)?.nats?.pub?.allow ?? [] : [];
  const instRow = (command: string) => seatP ? new RegExp(`^cotal\\.${space}\\.ep\\.v1\\.inst\\.com_example_orders\\.i0000000000000000000000000a\\.${command}\\.local\\.[A-Z0-9]+\\.${seatP.uid}\\.`) : /$^/;
  check("an instance-pinned entry mints the command and the describe on that instance's rail",
    pubP.some((r) => instRow("list").test(r)) && pubP.some((r) => instRow("describe").test(r)), pubP.filter((r) => r.includes("orders")));
  check("and no class row for that endpoint", !pubP.some((r) => r.includes(".one.com_example_orders.")), pubP.filter((r) => r.includes("orders")));
  await stop(wp);
  console.log("G. foreground event payload withholding");
  for (const cell of [{ name: "default", argv: [], withheld: false }, { name: "--no-event-payloads", argv: ["--no-event-payloads"], withheld: true }, { name: "persona eventPayloads:false", argv: ["withheld"], withheld: true }]) {
    const worker = launch(cell.argv);
    const seat = await worker.seat;
    check(`${cell.name}: real CLI reaches fixture`, seat !== undefined, worker.output);
    if (seat) {
      const pub = (credsClaims(readFileSync(seat.creds, "utf8")) as { nats?: { pub?: { allow?: string[] } } }).nats?.pub?.allow ?? [];
      check(`${cell.name}: EVP publish grant matches policy`, pub.some((subject) => subject.startsWith(`cotal.${space}.evp.`)) === !cell.withheld, pub);
      check(`${cell.name}: production recorder config matches policy`, seat.withheld === cell.withheld, seat.withheld);
      const recorded = await recordTool(seat);
      check(`${cell.name}: tool record publishes only permitted payloads`, recorded.payloads === (cell.withheld ? 0 : 1), recorded);
      check(`${cell.name}: names and times still publish`, recorded.metadata, recorded);
    }
    await stop(worker);
  }
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
