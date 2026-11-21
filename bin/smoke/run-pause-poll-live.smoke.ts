/** The shipped run CLI against a REAL Manager and REAL JWT broker, with no agent seats. */
import strictAssert from "node:assert/strict";
import { execFile, type PromiseWithChild } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { jetstreamManager, type JetStreamManager, type NextMsgRequest } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import {
  checkpointSettleSubject, createSpaceAuth, epfStreamName, eptStreamName, isConsumerNotFound, mintCreds, nativeNkeySigner,
  newIdentity, setupSpaceStreams, standaloneConnectOpts, startTimerWriter, wfjStreamName, wfjSubject,
  type RunStatusView, type SpaceAuth,
} from "@cotal-ai/core";
import { Manager } from "@cotal-ai/manager";
import "@cotal-ai/runtime";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { authDir, recordMesh, saveSpaceAuth, workspaceSecretStore } from "@cotal-ai/workspace";
import { bootBroker } from "../../implementations/manager/smoke/_boot-broker.js";
import { bootDeliveryDaemon } from "../../implementations/manager/smoke/_boot-delivery.js";

const space = "pause-poll-live";
const auditSubject = "$JS.EVENT.ADVISORY.API";
const cli = fileURLToPath(new URL("../dist/cotal.js", import.meta.url));
const exec = promisify(execFile);
const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert;

type RunCli = (...args: string[]) => PromiseWithChild<{ stdout: string; stderr: string }>;

async function auditCreds(auth: SpaceAuth): Promise<string> {
  const require = createRequire(import.meta.resolve("@cotal-ai/core"));
  const { encodeUser, fmtCreds } = require("@nats-io/jwt");
  const { fromPublic, fromSeed } = require("@nats-io/nkeys");
  const id = newIdentity();
  const bytes = new TextEncoder();
  const jwt = await encodeUser("pause-poll-audit", fromPublic(id.id), fromPublic(auth.account.pub), {
    pub: { allow: [
      `$JS.API.STREAM.MSG.GET.${eptStreamName(space)}`, `$JS.API.STREAM.MSG.GET.${epfStreamName(space)}`,
      `$JS.API.CONSUMER.INFO.${wfjStreamName(space)}.*`, `$JS.API.CONSUMER.DELETE.${wfjStreamName(space)}.*`,
      `$JS.API.STREAM.PURGE.${wfjStreamName(space)}`,
    ] },
    sub: { allow: [auditSubject, `_INBOX_${id.id}.>`] },
  }, { signer: nativeNkeySigner(bytes.encode(auth.account.signingSeed)), exp: Math.floor(Date.now() / 1000) + 120 });
  return new TextDecoder().decode(fmtCreds(jwt, fromSeed(bytes.encode(id.seed))));
}

interface ApiCall {
  subject: string;
  request?: string;
  response?: string;
}

function timerReads(calls: ApiCall[], stream: string, topic: string, code: number): number {
  return calls.filter(call => call.subject === `$JS.API.STREAM.MSG.GET.${stream}`
    && JSON.parse(call.request ?? "{}").last_by_subj === topic
    && JSON.parse(call.response ?? "{}").error?.err_code === code).length;
}

function journalCreates(calls: ApiCall[], run: string): ApiCall[] {
  return calls.filter(call => call.subject.startsWith(`$JS.API.CONSUMER.CREATE.${wfjStreamName(space)}.wfj_${run}_`));
}

async function waitForCursor(calls: ApiCall[], run: string, jsm: JetStreamManager, after?: string) {
  const stream = wfjStreamName(space);
  const expires = Date.now() + 6_000;
  let seen: string | undefined;
  while (Date.now() < expires) {
    const durable = journalCreates(calls, run)[0]?.subject.split(".")[5];
    if (durable !== undefined) {
      const info = await jsm.consumers.info(stream, durable).catch((error: unknown) => {
        if (isConsumerNotFound(error)) return undefined;
        throw error;
      });
      if (info?.num_ack_pending === 1 && info.num_pending === 0 && info.created !== after) {
        if (seen === info.created) return info;
        seen = info.created;
      } else seen = undefined;
    }
    await wait(50);
  }
  throw new Error(`run ${run} did not install its journal cursor`);
}

function fireSubject(calls: ApiCall[]): string | undefined {
  return calls.filter(call => call.subject === `$JS.API.STREAM.MSG.GET.${eptStreamName(space)}`)
    .map(call => JSON.parse(call.request ?? "{}").last_by_subj as string | undefined)
    .find(subject => subject?.endsWith(".fire"));
}

function settleSubject(fire: string): string {
  return checkpointSettleSubject(space, { endpoint: "manager", token: fire.split(".").at(-2)! });
}

async function verifyWaiting(start: (duration: string) => Promise<string>, show: (run: string) => Promise<RunStatusView>, calls: ApiCall[], jsm: JetStreamManager) {
  const firstCall = calls.length;
  const run = await start("30s");
  const pollBy = Date.now() + 5_000;
  let fire = fireSubject(calls.slice(firstCall));
  while (fire === undefined && Date.now() < pollBy) {
    await wait(25);
    fire = fireSubject(calls.slice(firstCall));
  }
  assert.ok(fire, "the hosted sleep started polling its timer");
  // Measure only after the cursor has its anchor, without run show touching this run.
  const cursor = await waitForCursor(calls, run, jsm);
  assert.equal(cursor.config.filter_subject, wfjSubject(space, run));
  const from = calls.length;
  await wait(5_000);
  const window = calls.slice(from);
  const stats = {
    fireMisses: timerReads(window, eptStreamName(space), fire, 10037),
    settleMisses: timerReads(window, epfStreamName(space), settleSubject(fire), 10037),
    journalReplays: journalCreates(window, run).length,
  };
  assert.ok(stats.fireMisses >= 2 && stats.settleMisses >= 2, `the pause was actively polled without a fire: ${JSON.stringify(stats)}`);
  assert.equal(stats.journalReplays, 0, "an empty fire or settle poll must not replay the workflow journal");
  console.log(`waiting hosted sleep: ${JSON.stringify(stats)}`);
  // Traffic on a second run must not invalidate the first run's cursor.
  const foreign = await start("1s");
  await wait(3_000);
  assert.equal((await show(foreign)).status?.state, "completed");
  assert.equal((await jsm.consumers.info(wfjStreamName(space), cursor.name)).created, cursor.created,
    "the cursor survives unrelated journal writes and empty polls");
  const pending = await show(run);
  assert.equal(pending.status?.state, "running");
  assert.ok(pending.journal.some(row => row.kind === "step" && row.step === "/sleep#0" && row.state === "pending"));
  const deletedAt = calls.length;
  assert.equal(await jsm.consumers.delete(wfjStreamName(space), cursor.name), true);
  const recovered = await waitForCursor(calls, run, jsm, cursor.created);
  assert.notEqual(recovered.created, cursor.created, "a deleted cursor is recreated after a fresh replay");
  assert.ok(journalCreates(calls.slice(deletedAt), run).length > 0);
  return { run, durable: recovered.name };
}

async function verifyTakeover(run: string, runCli: RunCli, show: (run: string) => Promise<RunStatusView>): Promise<void> {
  const log = console.error;
  const released: string[] = [];
  console.error = (...args) => {
    const line = String(args[0]);
    if (line.startsWith(`run ${run}: released - `)) released.push(line);
    log(...args);
  };
  const successor = runCli("resume", run, "--local");
  const done = successor.then(() => undefined, () => undefined);
  try {
    const activationBy = Date.now() + 5_000;
    let view = await show(run);
    while ((view.status?.epoch ?? 0) < 2 && Date.now() < activationBy) {
      await wait(100);
      view = await show(run);
    }
    assert.equal(view.status?.epoch, 2, "the local successor activated");
    const activatedAt = Date.now();
    const releaseBy = activatedAt + 7_000;
    while (released.length === 0 && Date.now() < releaseBy) await wait(100);
    assert.ok(released.length > 0, "the superseded manager released its attempt before the pause deadline");
    assert.equal((await show(run)).status?.state, "running", "the successor still owns a waiting run");
    console.log(`takeover control: the old manager released within ${Date.now() - activatedAt} ms of observing the successor`);
  } finally {
    console.error = log;
    successor.child.kill();
    await done;
  }
}

async function verifyPurged(start: (duration: string) => Promise<string>, calls: ApiCall[], jsm: JetStreamManager): Promise<void> {
  const run = await start("40s");
  const cursor = await waitForCursor(calls, run, jsm);
  const stream = wfjStreamName(space);
  const purgeAt = calls.length;
  const purged = await jsm.streams.purge(stream, { filter: wfjSubject(space, run) });
  assert.ok(purged.purged > 0);
  const expires = Date.now() + 6_000;
  while (Date.now() < expires) {
    try { await jsm.consumers.info(stream, cursor.name); } catch (error) {
      if (!isConsumerNotFound(error)) throw error;
      if (journalCreates(calls.slice(purgeAt), run).length > 0) return;
    }
    await wait(100);
  }
  throw new Error(`run ${run} did not discard its cursor after journal purge`);
}

async function verifyPolling(root: string, runCli: RunCli, calls: ApiCall[], jsm: JetStreamManager): Promise<void> {
  const start = async (duration: string): Promise<string> => {
    const file = join(root, `${duration}.cotal.js`);
    writeFileSync(file, `await sleep(${JSON.stringify(duration)});\n`);
    const { result } = JSON.parse((await runCli("start", "--file", file)).stdout);
    assert.match(result.result.runId, /^run-/);
    return result.result.runId;
  };
  const show = async (run: string): Promise<RunStatusView> => JSON.parse((await runCli("show", run)).stdout).result.view;
  const controlStart = calls.length;
  const control = await start("2s");
  const completeBy = Date.now() + 10_000;
  let completed: RunStatusView;
  do {
    await wait(250);
    completed = await show(control);
  } while (completed.status?.state === "running" && Date.now() < completeBy);
  assert.equal(completed.status?.state, "completed");
  assert.equal(completed.journal.filter(row => row.kind === "step" && row.step === "/sleep#0" && row.state === "settled" && row.outcome === "ok").length, 1);
  const fire = fireSubject(calls.slice(controlStart));
  assert.ok(fire, "the short hosted sleep polled for a fire");
  assert.ok(await jsm.streams.getMessage(eptStreamName(space), { last_by_subj: fire }), "the broker timer fired");
  const firstRequest = { next_by_subj: settleSubject(fire), seq: 1 } satisfies NextMsgRequest;
  const first = await jsm.streams.getMessage(epfStreamName(space), firstRequest);
  const fact = await jsm.streams.getMessage(epfStreamName(space), { last_by_subj: settleSubject(fire) });
  assert.ok(first && fact, "the short hosted sleep wrote a settlement fact");
  assert.equal(fact.json<{ settle: string }>().settle, "expired");
  assert.equal(first.seq, fact.seq, "the short sleep wrote just one settlement fact");
  console.log("positive control: the broker fired and the short hosted sleep settled once with outcome ok");
  const { run, durable } = await verifyWaiting(start, show, calls, jsm);
  await verifyTakeover(run, runCli, show);
  await assert.rejects(jsm.consumers.info(wfjStreamName(space), durable), isConsumerNotFound);
  await verifyPurged(start, calls, jsm);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "cotal-pause-poll-"));
  const home = join(root, "home");
  const xdg = join(root, "xdg");
  const runtime = join(root, "runtime");
  const cotalHome = join(root, "cotal-home");
  for (const path of [home, xdg, runtime, cotalHome]) mkdirSync(path, { mode: 0o700 });
  for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
  Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: xdg, XDG_RUNTIME_DIR: runtime, COTAL_HOME: cotalHome, COTAL_SKIP_CONNECTOR_SEED: "1" });
  const auth = await createSpaceAuth(space);
  const broker = await bootBroker(auth);
  const { servers } = broker;
  const open = (creds: string) => connect({ servers, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  try {
    await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
    saveSpaceAuth(authDir(root), auth);
    recordMesh({ space, server: servers, root, mode: "auth", ts: new Date().toISOString() });
    const delivery = await bootDeliveryDaemon({ space, servers, auth, reloadStoreIdentity: workspaceSecretStore(root).identity });
    try {
      const manager = new Manager({ space, servers, runtime: "pty", workspaceRoot: root });
      const timerNc = await open(await mintCreds(auth, newIdentity(), "delivery"));
      try {
        const timer = await startTimerWriter(timerNc, space);
        void timer.done.catch(() => {});
        await manager.start();
        const audit = await open(await auditCreds(auth));
        try {
          const calls: ApiCall[] = [];
          audit.subscribe(auditSubject, { callback: (error, msg) => { if (error) throw error; calls.push(msg.json<ApiCall>()); } });
          await audit.flush();
          const runCli: RunCli = (...args) => exec(process.execPath,
            [cli, "run", ...args, "--space", space, "--server", servers, ...(args.includes("--local") ? [] : ["--json"])],
            { cwd: root, encoding: "utf8", timeout: 20_000 });
          await verifyPolling(root, runCli, calls, await jetstreamManager(audit, { checkAPI: false }));
        } finally { await audit.close(); }
      } finally {
        try { await manager.stop({ withAgents: true }); } finally { await timerNc.close(); }
      }
    } finally { await delivery.stop(); }
  } finally { await broker.stop(); }
}

await main();
emitSentinel({ passed: counted.cells(), failed: 0 });
