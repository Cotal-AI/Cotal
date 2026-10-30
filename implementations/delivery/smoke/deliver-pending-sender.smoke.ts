/**
 * `cotal deliver pending` candidate attribution, live through the real CLI on an owned authenticated
 * broker. Each synthetic sender publishes a held DM on its own subject, which the broker binds to
 * its credential, while the card inside the message is whatever the sender wrote.
 *
 * A plain candidate line names the subject's sender principal as `from=` and prints the card only as
 * a trailing `label=`, sanitized: a healthy card, a card naming another principal, and a card that
 * carries control bytes and a line break. `--json` keeps its legacy candidate lines byte for byte.
 * No read changes the durable's pending or ack state, and the plain read opens no more consumers
 * than a `--json` read does.
 *
 * Run: pnpm smoke:deliver-pending-sender
 */
import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import {
  createSpaceAuth,
  CotalEndpoint,
  DEV_OWNER,
  dialerFor,
  dmDurable,
  dmStream,
  isReachable,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  provisionAgent,
  serverConfig,
  setupSpaceStreams,
  standaloneConnectOpts,
  unicastSubject,
  type EndpointRef,
} from "@cotal-ai/core";
import { freePort, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal, teardownPathOnSignal } from "@cotal-ai/smoke-kit";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const EXPECTED = 13;
let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
  }
};

const space = `pendingsender-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const port = process.env.PENDING_SENDER_BROKER_PORT ? Number(process.env.PENDING_SENDER_BROKER_PORT) : await freePort();
const servers = `nats://127.0.0.1:${port}`;
const storeDir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(
  join(storeDir, "server.conf"),
  serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(storeDir, "js") }),
);
const broker = spawn("nats-server", ["-c", join(storeDir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, storeDir);

const cli = fileURLToPath(new URL("../../../bin/cotal.ts", import.meta.url));
const tsx = fileURLToPath(import.meta.resolve("tsx"));
const home = mkdtempSync(join(tmpdir(), "cotal-pending-sender-"));
const releaseHome = teardownPathOnSignal(home);
mkdirSync(join(home, ".cotal"));
mkdirSync(join(home, "xdg"));
mkdirSync(join(home, "tmp"));
const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_")));
Object.assign(env, {
  HOME: home,
  USERPROFILE: home,
  TMPDIR: join(home, "tmp"),
  COTAL_HOME: join(home, ".cotal"),
  XDG_CONFIG_HOME: join(home, "xdg"),
  COTAL_SKIP_CONNECTOR_SEED: "1",
  NO_COLOR: "1",
});
const run = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(process.execPath, ["--import", tsx, cli, ...args], { cwd: join(home, "tmp"), env }, (err, stdout, stderr) =>
      resolve({ code: err && typeof err.code === "number" ? err.code : err ? 1 : 0, stdout, stderr }),
    );
  });

let provisioner: CotalEndpoint | undefined;
try {
  let ready = false;
  for (let i = 0; i < 50 && !ready; i++) {
    ready = await isReachable(servers);
    if (!ready) await wait(100);
  }
  check("the owned broker is ready", ready, servers);

  const provisionerCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers, space, creds: provisionerCreds });
  provisioner = new CotalEndpoint({ space, servers, creds: provisionerCreds, card: { name: "pending-provisioner", kind: "endpoint" }, consume: false, watchPresence: false, registerPresence: false });
  await provisioner.start();
  const provision = async (role: string) => {
    const identity = newIdentity();
    const lifecycleUid = mintLifecycleUid();
    const creds = await provisionAgent(provisioner!, auth, identity, { lifecycleUid, role, subscribe: [], allowSubscribe: [] });
    return { actor: identity.id, principal: `${DEV_OWNER}.${identity.id}`, lifecycleUid, creds };
  };
  const recipient = await provision("holder");
  const healthy = await provision("writer");
  const forger = await provision("writer");

  // Each sender publishes on its own subject; only the card it writes into the message can lie.
  const publish = async (sender: { actor: string; creds: string }, from: EndpointRef & { kind: string }) => {
    const nc = await dialerFor(servers)({ servers, ...standaloneConnectOpts({ creds: sender.creds, tls: false }), maxReconnectAttempts: 0 });
    const id = randomUUID();
    const ts = Date.now();
    try {
      const subject = unicastSubject(space, DEV_OWNER, recipient.actor, DEV_OWNER, sender.actor);
      const body = { id, space, from, to: recipient.principal, parts: [{ kind: "text", text: "held" }], ts };
      return { id, ts, seq: (await jetstream(nc).publish(subject, JSON.stringify(body))).seq };
    } finally {
      await nc.drain();
    }
  };
  const control = `ctl\u001b[31mred\u0007]\n  fake  from=local.forged  ts=1`;
  const ok = await publish(healthy, { id: healthy.principal, name: "healthy-sender", role: "writer", kind: "endpoint" });
  const claimed = await publish(forger, { id: healthy.principal, name: "healthy-sender", role: "writer", kind: "endpoint" });
  const escaped = await publish(forger, { id: healthy.principal, name: control, role: `r${String.fromCharCode(0x2028)}x`, kind: "endpoint" });
  check("the broker stored all three held DMs", ok.seq > 0 && claimed.seq > 0 && escaped.seq > 0);

  const adminCreds = join(home, "admin.creds");
  const adminText = await mintCreds(auth, newIdentity(), "admin");
  writeFileSync(adminCreds, adminText, { mode: 0o600 });
  const durable = dmDurable(DEV_OWNER, recipient.actor, recipient.lifecycleUid);
  const nc = await dialerFor(servers)({ servers, ...standaloneConnectOpts({ creds: adminText, tls: false }), maxReconnectAttempts: 0 });
  const jsm = await jetstreamManager(nc);
  const state = async () => {
    const info = await jsm.consumers.info(dmStream(space), durable);
    const consumers = (await jsm.streams.info(dmStream(space))).state.consumer_count;
    return { consumers, held: { pending: info.num_pending, ackPending: info.num_ack_pending, delivered: info.delivered.stream_seq, ackFloor: info.ack_floor.stream_seq } };
  };

  const args = ["deliver", "pending", "recipient", "--durable", durable, "--creds", adminCreds, "--space", space, "--server", servers];
  const s0 = await state();
  const jsonBefore = await run([...args, "--json"]);
  const s1 = await state();
  const plain = await run(args);
  const s2 = await state();
  const jsonAfter = await run([...args, "--json"]);
  const s3 = await state();
  await nc.drain();
  check("the plain read exits 0", plain.code === 0, plain.stderr);

  const line = (id: string) => plain.stdout.split("\n").find((l) => l.startsWith(`  ${id}  `));
  check(
    "a healthy card prints the subject principal, then its label",
    line(ok.id) === `  ${ok.id}  from=${healthy.principal}  ts=${ok.ts}  label=healthy-sender/writer`,
    line(ok.id),
  );
  check(
    "a card naming another principal prints the subject principal, never the claimed one",
    line(claimed.id) === `  ${claimed.id}  from=${forger.principal}  ts=${claimed.ts}  label=healthy-sender/writer`,
    line(claimed.id),
  );
  check(
    "a card with control bytes prints a sanitized label after the subject principal",
    line(escaped.id) === `  ${escaped.id}  from=${forger.principal}  ts=${escaped.ts}  label=ctl 31mred   fake  from=local.forged  ts=1/r x`,
    line(escaped.id),
  );
  check(
    "the plain output carries no control character or line separator, and no forged line",
    !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(plain.stdout.replaceAll("\n", "")) && plain.stdout.split("\n").length === 13,
    plain.stdout.split("\n").length,
  );

  check("the --json read exits 0", jsonBefore.code === 0 && jsonAfter.code === 0, [jsonBefore.stderr, jsonAfter.stderr]);
  const facts = JSON.parse(jsonBefore.stdout.split("\n")[0]) as unknown;
  const legacy = [
    JSON.stringify(facts),
    "recent candidate ids (from the ack floor; not proof of a hole)",
    ...[ok, claimed, escaped].map((m) => `  ${m.id}  from=[object Object]  ts=${m.ts}`),
    "",
  ].join("\n");
  check("--json prints the legacy candidate lines unchanged", jsonBefore.stdout === legacy, jsonBefore.stdout);
  check("--json output is identical before and after the plain read", jsonAfter.stdout === jsonBefore.stdout);
  check(
    "no read changes the durable's pending or ack state",
    [s0, s1, s2, s3].every((s) => JSON.stringify(s.held) === JSON.stringify({ pending: 3, ackPending: 0, delivered: 0, ackFloor: 0 })),
    [s0, s1, s2, s3],
  );
  check(
    "the plain read opens no more consumers than a --json read",
    s2.consumers - s1.consumers === s1.consumers - s0.consumers && s3.consumers - s2.consumers === s1.consumers - s0.consumers,
    [s0.consumers, s1.consumers, s2.consumers, s3.consumers],
  );
} finally {
  await provisioner?.stop().catch(() => {});
  await killAndAwaitExit(broker);
  check("the owned broker exits before its JetStream tree is removed", broker.exitCode !== null || broker.signalCode !== null);
  rmSync(storeDir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  releaseBroker();
  releaseHome();
}

check(`every cell ran (${EXPECTED} expected)`, pass + fail === EXPECTED, { pass, fail });
console.log(`\ndeliver pending sender smoke: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
