/** Native sealed manager goal-index scanner behavior and confinement. */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kvm } from "@nats-io/kv";
import { JetStreamApiCodes, JetStreamApiError, jetstreamManager } from "@nats-io/jetstream";
import { createEndpointStreams, createSpaceAuth, isReachable, meetsBrokerFloor, mintLifecycleUid, newIdentity, recordAtomicKey, RECORD_KINDS, recordsBucket, recordsKvStreamName, serverConfig } from "@cotal-ai/core";
import { openAuthorityClient } from "../src/authority-client.js";
import { openRecordsScannerCandidate } from "../src/records-scanner.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { stopOwnedChild } from "./_owned-child-cleanup.js";

const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const space = `manager-goalidx-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
const server = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const release = teardownOnSignal(server, dir);
const owner = `u_${"a".repeat(26)}`;
const foreignOwner = `u_${"b".repeat(26)}`;
const enc = new TextEncoder();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let fixture: Awaited<ReturnType<typeof openAuthorityClient>> | undefined;
let candidate: Awaited<ReturnType<typeof openRecordsScannerCandidate>> | undefined;

let passed = 0;
let failed = 0;
const check = (name: string, condition: unknown, detail?: unknown) => {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL: ${name}`, detail ?? ""); }
};

try {
  for (let i = 0; i < 50 && !(await isReachable(servers)); i++) await wait(100);
  fixture = await openAuthorityClient({ server: servers, space, dataAccount: auth.account, label: "fixture", grants: () => ({ publish: [">"], subscribe: [">"] }), log: () => {} });
  const brokerVersion = fixture.nc.info?.version;
  const brokerSupported = typeof brokerVersion === "string" && meetsBrokerFloor(brokerVersion);
  check(`connected broker version ${brokerVersion ?? "<missing>"} meets required floor`, brokerSupported);
  if (!brokerSupported) throw new Error(`native scanner refuses connected broker version ${brokerVersion ?? "<missing>"}; required floor is 2.12`);
  const jsm = await jetstreamManager(fixture.nc);
  await createEndpointStreams(jsm, new Kvm(fixture.nc), space);
  const kv = await new Kvm(fixture.nc).open(recordsBucket(space));
  const row = (rowOwner: string, goalId = `goal${mintLifecycleUid()}`) => ({
    v: 1 as const, endpoint: "manager", owner: rowOwner, actor: "cli", uid: mintLifecycleUid(), goalId, iid: mintLifecycleUid(),
  });
  const key = (r: ReturnType<typeof row>) => recordAtomicKey(RECORD_KINDS.goalidx, [r.endpoint, r.owner, r.actor, r.uid, r.goalId]);
  const own = row(owner);
  const foreign = row(foreignOwner);
  await kv.create(key(own), enc.encode(JSON.stringify(own)));
  await kv.create(key(foreign), enc.encode(JSON.stringify(foreign)));
  const malformedForeignKey = recordAtomicKey(RECORD_KINDS.goalidx, ["manager", foreignOwner, "cli", mintLifecycleUid(), `goal${mintLifecycleUid()}`]);
  await kv.create(malformedForeignKey, enc.encode("not-json"));

  let guardChecks = 0;
  let shapeObserved = false;
  candidate = await openRecordsScannerCandidate({
    server: servers, space, dataAccount: auth.account, log: () => {},
    probe: { afterManagerGoalIndexCreate: async () => {
      const info = await jsm.consumers.info(recordsKvStreamName(space), "cotal-manager-goalidx-scan");
      shapeObserved = info.config.filter_subject === `$KV.${recordsBucket(space)}.goalidx.manager.${owner}.>` &&
        info.config.deliver_subject === undefined && info.config.durable_name === undefined &&
        info.config.ack_policy === "none" && info.config.deliver_policy === "last_per_subject";
    } },
  });
  const scanner = candidate.activate({ assertHeld: async () => { guardChecks++; } });
  let got: unknown;
  let ownError: unknown;
  try { got = await scanner.scanManagerGoalIndex(owner); } catch (error) { ownError = error; }
  check("own scan succeeds despite valid and malformed foreign owners", ownError === undefined && JSON.stringify(got) === JSON.stringify([own]), ownError ?? got);
  check("forced consumer is owner-filtered pull ephemeral LastPerSubject", shapeObserved);
  check("plane guard runs before and after the host scan", guardChecks === 2, guardChecks);
  let cleaned = false;
  try { await jsm.consumers.info(recordsKvStreamName(space), "cotal-manager-goalidx-scan"); }
  catch (error) { cleaned = error instanceof JetStreamApiError && error.code === JetStreamApiCodes.ConsumerNotFound; }
  check("host scan consumer is cleaned after the scan", cleaned);

  const mismatchedRow = row(owner);
  const mismatchKey = recordAtomicKey(RECORD_KINDS.goalidx, ["manager", owner, mismatchedRow.actor, mismatchedRow.uid, `goal${mintLifecycleUid()}`]);
  await kv.create(mismatchKey, enc.encode(JSON.stringify(mismatchedRow)));
  let mismatchMessage = "";
  try { await scanner.scanManagerGoalIndex(owner); } catch (error) { mismatchMessage = (error as Error).message; }
  check("own key/body mismatch fails named", /body qualifiers .* do not match key/.test(mismatchMessage), mismatchMessage);
  await kv.delete(mismatchKey);
  let marker = "";
  try { await scanner.scanManagerGoalIndex(owner); } catch (error) { marker = (error as Error).message; }
  check("own DEL marker fails named", /carries a DEL marker/.test(marker), marker);

  await scanner.close();
  check("every native scanner cell ran", passed + failed === 7, { passed, failed });
  console.log(`manager goal-index scanner native: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
} finally {
  await candidate?.close().catch(() => {});
  await fixture?.close().catch(() => {});
  await stopOwnedChild(server);
  rmSync(dir, { recursive: true, force: true });
  release();
}
