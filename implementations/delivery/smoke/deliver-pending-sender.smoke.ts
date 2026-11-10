/**
 * `cotal deliver pending` and `cotal pending` candidate attribution, live through the real CLI on an
 * owned authenticated broker. Each synthetic sender publishes a held DM on its own subject, which the
 * broker binds to its credential, while the card inside the message is whatever the sender wrote.
 *
 * A plain candidate line names the subject's sender principal as `from=` and prints the card only as
 * a trailing `label=`, sanitized: a healthy card, a card naming another principal, and a card that
 * carries control bytes and a line break. `--json` returns one receipt, including candidate IDs
 * or a not-found refusal, through the same reader as `cotal pending`.
 * `cotal pending` names the same subject principal as each candidate's `from` in `--json` and
 * `--plain`, within `--limit`. A confirmed bounded read received every message it requested and exits 0 with no cleanup warning. No read changes the durable's
 * pending or ack state. JSON reads and `cotal pending` delete only the named reader they created.
 * The retained plain spelling leaves its ordered consumer.
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
const EXPECTED = 28;
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
  NO_COLOR: "1",
});
const run = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(process.execPath, ["--import", tsx, cli, ...args], { cwd: join(home, "tmp"), env }, (err, stdout, stderr) =>
      resolve({ code: err && typeof err.code === "number" ? err.code : err ? 1 : 0, stdout, stderr }),
    );
  });

let provisioner: CotalEndpoint | undefined;
let holder: CotalEndpoint | undefined;
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
  holder = new CotalEndpoint({ space, servers, creds: recipient.creds, lifecycleUid: recipient.lifecycleUid,
    card: { name: "recipient", role: "holder", kind: "endpoint" }, consume: false, watchPresence: false });
  await holder.start();
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
  const modern = args.slice(1);
  const modernJson = await run([...modern, "--json"]);
  const s4 = await state();
  const modernPlain = await run([...modern, "--plain"]);
  const s5 = await state();
  const modernLimited = await run([...modern, "--limit", "2", "--json"]);
  const s6 = await state();
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
  const parse = (r: { stdout: string }) => {
    try { return JSON.parse(r.stdout); } catch { return undefined; }
  };
  const subjectRows = [[ok, healthy], [claimed, forger], [escaped, forger]] as const;
  const expectedCandidates = subjectRows.map(([m, s]) => ({ id: m.id, from: s.principal, ts: m.ts }));
  const legacyJson = parse(jsonBefore);
  check("deliver pending --json prints one receipt with broker facts and subject-attributed candidates",
    legacyJson?.outcome === "ok" && legacyJson?.result?.durable === durable && legacyJson?.result?.pending === 3 &&
      JSON.stringify(legacyJson?.result?.candidates) === JSON.stringify(expectedCandidates), jsonBefore);
  check("--json result is identical before and after the plain read",
    JSON.stringify(parse(jsonAfter)?.result) === JSON.stringify(legacyJson?.result));
  const doc = (r: { stdout: string }) => JSON.parse(r.stdout) as { completeness?: string; warnings: Array<{ code: string }>; result: { candidates: unknown[]; candidateRead: string; candidateLimit: number } };
  const [full, limited] = [doc(modernJson), doc(modernLimited)];
  check(
    "pending reads finish the bounded candidate read and add no candidate warning",
    [modernJson, modernPlain, modernLimited].every((r) => r.code === 0) &&
      [full, limited].every((d) => d.completeness === "complete" && d.result.candidateRead === "bounded-from-ack-floor" && d.warnings.length === 0) &&
      !modernPlain.stderr.includes("could not be decoded") && !modernPlain.stderr.includes("✗"),
    [modernJson.code, modernPlain.code, modernLimited.code, full.warnings, modernPlain.stderr],
  );
  check(
    "pending --json names each candidate by its subject principal, never the claimed one",
    JSON.stringify(full.result.candidates) === JSON.stringify(subjectRows.map(([m, s]) => ({ id: m.id, from: s.principal, ts: m.ts }))),
    full.result.candidates,
  );
  check(
    "pending --plain names each candidate by its subject principal, never the claimed one",
    subjectRows.every(([m, s]) => modernPlain.stdout.split("\n").includes(`  ${m.id}  from=${s.principal}  ts=${m.ts}`)) &&
      !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(modernPlain.stdout.replaceAll("\n", "")),
    modernPlain.stdout,
  );
  check(
    "pending --limit 2 reads the first two candidates by subject principal",
    limited.result.candidateLimit === 2 &&
      JSON.stringify(limited.result.candidates) === JSON.stringify(subjectRows.slice(0, 2).map(([m, s]) => ({ id: m.id, from: s.principal, ts: m.ts }))),
    limited.result,
  );
  const states = [s0, s1, s2, s3, s4, s5, s6];
  check(
    "no read changes the durable's pending or ack state",
    states.every((s) => JSON.stringify(s.held) === JSON.stringify({ pending: 3, ackPending: 0, delivered: 0, ackFloor: 0 })),
    states,
  );
  check(
    "JSON reads and cotal pending delete their readers; the retained plain spelling leaves its ordered consumer",
    s4.consumers === s3.consumers && s5.consumers === s4.consumers && s6.consumers === s5.consumers &&
      s1.consumers === s0.consumers && s2.consumers - s1.consumers === 1 && s3.consumers === s2.consumers,
    states.map((s) => s.consumers),
  );
  const namedArgs = args.filter((_, i) => i !== 3 && i !== 4);
  const named = await run([...namedArgs, "--json"]);
  const namedControl = await run([...namedArgs.slice(1), "--json"]);
  check("deliver pending --json resolves a live name to one document with the held IDs",
    named.code === 0 && JSON.stringify(parse(named)?.result?.candidates) === JSON.stringify(expectedCandidates), named);
  check("pending --json is the positive control for the same live name",
    namedControl.code === 0 && JSON.stringify(parse(namedControl)?.result?.candidates) === JSON.stringify(expectedCandidates), namedControl);
  const limitedLegacy = await run([...args, "--limit", "2", "--json"]);
  check("deliver pending --json respects the candidate limit in its one document",
    limitedLegacy.code === 0 && JSON.stringify(parse(limitedLegacy)?.result?.candidates) === JSON.stringify(expectedCandidates.slice(0, 2)), limitedLegacy);
  const absentName = await run(["deliver", "pending", "nobody-6007", ...namedArgs.slice(3), "--json"]);
  check("an absent name returns one refused JSON document with no inferred empty durable",
    absentName.code === 2 && parse(absentName)?.outcome === "refused" && parse(absentName)?.error?.code === "TARGET_NOT_FOUND", absentName);
  const absentDurable = await run([...args.map((arg) => arg === durable ? dmDurable(DEV_OWNER, "absent", recipient.lifecycleUid) : arg), "--json"]);
  check("an absent lifecycle durable returns one refused JSON document",
    absentDurable.code === 2 && parse(absentDurable)?.outcome === "refused" && parse(absentDurable)?.error?.code === "TARGET_NOT_FOUND", absentDurable);
  check("success and not-found receipts name the invoked command, without a connector seed bypass",
    [jsonBefore, jsonAfter, named, limitedLegacy, absentName, absentDurable].every((r) => parse(r)?.command === "deliver") &&
      parse(namedControl)?.command === "pending");
  const invalidLimit = await run(["deliver", ...namedArgs.slice(3), "pending", "recipient", "--limit", "101", "--json"]);
  check("a validated usage refusal keeps the deliver command identity",
    invalidLimit.code === 1 && parse(invalidLimit)?.command === "deliver" && parse(invalidLimit)?.error?.code === "USAGE_INVALID", invalidLimit);
  const unknown = await run(["deliver", ...namedArgs.slice(3), "pending", "recipient", "--unknown-flag", "--json"]);
  check("an unknown flag after value-taking options still returns one JSON refusal",
    unknown.code === 1 && parse(unknown)?.command === "deliver" && parse(unknown)?.error?.code === "USAGE_INVALID", unknown);
  const unknownEquals = await run(["deliver", `--space=${space}`, `--server=${servers}`, `--creds=${adminCreds}`, "pending", "recipient", "--unknown-flag", "-j"]);
  check("inline option values and -j select the structured pending parser refusal",
    unknownEquals.code === 1 && parse(unknownEquals)?.command === "deliver" && parse(unknownEquals)?.error?.code === "USAGE_INVALID", unknownEquals);
  const daemonUnknown = await run(["deliver", "--space", "pending", "--unknown-flag", "--json"]);
  check("a daemon option value named pending does not enable structured daemon output",
    daemonUnknown.code === 1 && daemonUnknown.stdout === "" && daemonUnknown.stderr.includes("Unknown option"), daemonUnknown);
  const malformedSender = await dialerFor(servers)({ servers, ...standaloneConnectOpts({ creds: healthy.creds, tls: false }), maxReconnectAttempts: 0 });
  try {
    await jetstream(malformedSender).publish(unicastSubject(space, DEV_OWNER, recipient.actor, DEV_OWNER, healthy.actor), new Uint8Array([0xff]));
  } finally { await malformedSender.drain(); }
  const partial = await run([...args, "--json"]);
  check("a partial candidate receipt keeps the same deliver command identity and withholds unreadable data",
    partial.code === 4 && parse(partial)?.command === "deliver" && parse(partial)?.outcome === "partial" &&
      parse(partial)?.warnings?.some((warning: { code: string }) => warning.code === "CANDIDATE_UNREADABLE") &&
      JSON.stringify(parse(partial)?.result?.candidates) === JSON.stringify(expectedCandidates), partial);
} finally {
  await holder?.stop().catch(() => {});
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
