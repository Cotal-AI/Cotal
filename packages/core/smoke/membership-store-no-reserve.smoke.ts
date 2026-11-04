/**
 * The derived membership KV RESERVES NOTHING, proved against a real broker file-store cap and the
 * broker's own `/jsz` accounting. A positive stream `max_bytes` is reserved at create time even when
 * the stream is empty, so the former 64 MiB membership cap admitted only three complete spaces under
 * this 256 MiB store: space four consumed the last reservation and its following stream failed with
 * JetStream 10047. Eight spaces fit once membership uses per-key history and value-size bounds only.
 *
 * Run: pnpm smoke:membership-store-no-reserve   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { connect } from "@nats-io/transport-node";
import {
  composeSpaceAuth,
  createBrokerAuth,
  createSpaceAccountAuth,
  isReachable,
  LEGACY_MEMBERSHIP_MAX_BYTES,
  membershipBucket,
  MEMBERSHIP_MAX_VALUE_SIZE,
  mintCreds,
  newIdentity,
  serverConfig,
  setupSpaceStreams,
  standaloneConnectOpts,
  type SpaceAccountAuth,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

const FILE_STORE_CAP = 256 * 1024 * 1024;
const SPACES = 8;
const LEGACY_SPACE = "legacydensity";
const DRIFT_SPACE = "driftdensity";
const DRIFT_CAP = 32 * 1024 * 1024;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let ok = 0, fail = 0;
const check = (name: string, pass: boolean, extra?: unknown) => {
  if (pass) { ok++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};

interface Jsz {
  reserved_storage?: number;
}
interface MembershipLimits {
  maxBytes: number;
  history: number;
  maxValueSize: number;
}

const port = await pickFreePort();
const monitor = await pickFreePort();
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const servers = `nats://127.0.0.1:${port}`;
const brokerAuth = await createBrokerAuth("membership-density");
const spaces: SpaceAccountAuth[] = [];
for (let i = 0; i < SPACES; i++) spaces.push(await createSpaceAccountAuth(brokerAuth, `density${i}`));
for (const space of [LEGACY_SPACE, DRIFT_SPACE]) spaces.push(await createSpaceAccountAuth(brokerAuth, space));
const conf = join(dir, "server.conf");
writeFileSync(conf, serverConfig(brokerAuth, spaces, {
  port,
  host: "127.0.0.1",
  storeDir: join(dir, "js"),
  maxFileStore: FILE_STORE_CAP,
  transport: { kind: "plaintext" },
}) + `\nhttp: 127.0.0.1:${monitor}\n`);
const child = spawn("nats-server", ["-c", conf], { stdio: "ignore" });
const release = teardownOnSignal(child, dir);

try {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { up = await isReachable(servers); if (!up) await wait(100); }
  if (!up) throw new Error(`broker never came up on ${port}`);

  let provisioned = 0;
  let refusalCode: number | undefined;
  const reservedAfter: number[] = [];
  for (const account of spaces.slice(0, SPACES)) {
    const auth = composeSpaceAuth(brokerAuth, account);
    try {
      await setupSpaceStreams({ servers, space: account.space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
      provisioned++;
    } catch (error) {
      refusalCode = (error as { code?: number }).code;
    }
    const response = await fetch(`http://127.0.0.1:${monitor}/jsz`);
    reservedAfter.push((await response.json() as Jsz).reserved_storage ?? Number.NaN);
    if (refusalCode !== undefined) break;
  }

  const perSpace = reservedAfter.map((reserved, index) => reserved - (reservedAfter[index - 1] ?? 0));
  const reserved = reservedAfter.at(-1);

  check(`${SPACES} spaces provision under a 256 MiB file store`, provisioned === SPACES,
    { provisioned, expected: SPACES, refusalCode });
  check("/jsz reports a zero reserved_storage increase for every space",
    perSpace.length === SPACES && perSpace.every((delta) => delta === 0), perSpace);
  check("/jsz reports zero reserved storage broker-wide", reserved === 0, reserved);

  const first = spaces[0]!;
  const firstAuth = composeSpaceAuth(brokerAuth, first);
  const writerCreds = await mintCreds(firstAuth, newIdentity(), "membership-rw");
  const writer = await connect({ servers, ...standaloneConnectOpts({ creds: writerCreds, tls: false }) });
  const firstStream = `KV_${membershipBucket(first.space)}`;
  const firstInfo = await (await jetstreamManager(writer)).streams.info(firstStream);
  const limits: MembershipLimits = {
    maxBytes: firstInfo.config.max_bytes,
    history: firstInfo.config.max_msgs_per_subject,
    maxValueSize: firstInfo.config.max_msg_size,
  };
  check("the membership stream is bounded by history 1 and a native value ceiling, not max_bytes",
    limits.maxBytes === -1 && limits.history === 1 && limits.maxValueSize === MEMBERSHIP_MAX_VALUE_SIZE, limits);
  let oversized = "";
  try { await (await new Kvm(writer).open(membershipBucket(first.space))).put("oversized.agent", new Uint8Array(MEMBERSHIP_MAX_VALUE_SIZE + 1)); }
  catch (error) { oversized = (error as Error).message; }
  await writer.drain();
  check("the broker refuses a membership value above the native ceiling", oversized !== "", oversized);

  const byName = (name: string) => spaces.find((space) => space.space === name)!;
  const provisioner = async (name: string) => {
    const account = byName(name);
    const auth = composeSpaceAuth(brokerAuth, account);
    return { account, creds: await mintCreds(auth, newIdentity(), "provisioner") };
  };
  const plant = async (name: string, maxBytes: number) => {
    const { creds } = await provisioner(name);
    const nc = await connect({ servers, ...standaloneConnectOpts({ creds, tls: false }) });
    try { await new Kvm(nc).create(membershipBucket(name), { history: 1, max_bytes: maxBytes }); }
    finally { await nc.drain(); }
    return creds;
  };
  const maxBytes = async (name: string, creds: string) => {
    const nc = await connect({ servers, ...standaloneConnectOpts({ creds, tls: false }) });
    try { return (await (await jetstreamManager(nc)).streams.info(`KV_${membershipBucket(name)}`)).config.max_bytes; }
    finally { await nc.drain(); }
  };

  const legacyCreds = await plant(LEGACY_SPACE, LEGACY_MEMBERSHIP_MAX_BYTES);
  const beforeLegacy = (await (await fetch(`http://127.0.0.1:${monitor}/jsz`)).json() as Jsz).reserved_storage;
  await setupSpaceStreams({ servers, space: LEGACY_SPACE, creds: legacyCreds });
  const afterLegacy = (await (await fetch(`http://127.0.0.1:${monitor}/jsz`)).json() as Jsz).reserved_storage;
  check("setup reconciles exactly the legacy 64 MiB membership cap to -1",
    await maxBytes(LEGACY_SPACE, legacyCreds) === -1, await maxBytes(LEGACY_SPACE, legacyCreds));
  check("/jsz shows that the legacy reconcile released its 64 MiB reservation",
    beforeLegacy === LEGACY_MEMBERSHIP_MAX_BYTES && afterLegacy === 0, { beforeLegacy, afterLegacy });

  const driftCreds = await plant(DRIFT_SPACE, DRIFT_CAP);
  let drift = "";
  try { await setupSpaceStreams({ servers, space: DRIFT_SPACE, creds: driftCreds }); }
  catch (error) { drift = (error as Error).message; }
  check("any other positive membership max_bytes is named as drift",
    drift.includes(`membership store KV_${membershipBucket(DRIFT_SPACE)} has drifted`) &&
      drift.includes(`max_bytes is ${DRIFT_CAP}`), drift);
  check("setup leaves a deliberate positive membership cap untouched",
    await maxBytes(DRIFT_SPACE, driftCreds) === DRIFT_CAP, await maxBytes(DRIFT_SPACE, driftCreds));
} finally {
  await killAndAwaitExit(child, "SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  release();
}

console.log(`\n${ok} passed, ${fail} failed`);
if (fail) process.exit(1);
