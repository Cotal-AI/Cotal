/** The shipped run CLI against a REAL Manager and REAL JWT broker, with no agent seats. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
  checkpointSettleSubject, createSpaceAuth, epfStreamName, eptStreamName, mintCreds, nativeNkeySigner,
  newIdentity, setupSpaceStreams, standaloneConnectOpts, startTimerWriter, wfjStreamName,
  type RunStatusView, type SpaceAuth,
} from "@cotal-ai/core";
import { Manager } from "@cotal-ai/manager";
import "@cotal-ai/runtime";
import { authDir, recordMesh, saveSpaceAuth, workspaceSecretStore } from "@cotal-ai/workspace";
import { bootBroker } from "../../implementations/manager/smoke/_boot-broker.js";
import { bootDeliveryDaemon } from "../../implementations/manager/smoke/_boot-delivery.js";

const space = "pause-poll-live";
const auditSubject = "$JS.EVENT.ADVISORY.API";
const cli = fileURLToPath(new URL("../dist/cotal.js", import.meta.url));
const exec = promisify(execFile);

async function auditCreds(auth: SpaceAuth): Promise<string> {
  const require = createRequire(import.meta.resolve("@cotal-ai/core"));
  const { encodeUser, fmtCreds } = require("@nats-io/jwt");
  const { fromPublic, fromSeed } = require("@nats-io/nkeys");
  const id = newIdentity();
  const bytes = new TextEncoder();
  const jwt = await encodeUser("pause-poll-audit", fromPublic(id.id), fromPublic(auth.account.pub), {
    pub: { allow: [`$JS.API.STREAM.MSG.GET.${eptStreamName(space)}`, `$JS.API.STREAM.MSG.GET.${epfStreamName(space)}`] },
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

function journalCreates(calls: ApiCall[], run: string): number {
  return calls.filter(call => call.subject.startsWith(`$JS.API.CONSUMER.CREATE.${wfjStreamName(space)}.wfj_${run}_`)).length;
}

function fireSubject(calls: ApiCall[]): string | undefined {
  return calls.filter(call => call.subject === `$JS.API.STREAM.MSG.GET.${eptStreamName(space)}`)
    .map(call => JSON.parse(call.request ?? "{}").last_by_subj as string | undefined)
    .find(subject => subject?.endsWith(".fire"));
}

function settleSubject(fire: string): string {
  return checkpointSettleSubject(space, { endpoint: "manager", token: fire.split(".").at(-2)! });
}

async function verifyWaiting(start: (duration: string) => Promise<string>, show: (run: string) => Promise<RunStatusView>, calls: ApiCall[]) {
  const firstCall = calls.length;
  const run = await start("30s");
  const pollBy = Date.now() + 5_000;
  let fire = fireSubject(calls.slice(firstCall));
  while (fire === undefined && Date.now() < pollBy) {
    await wait(25);
    fire = fireSubject(calls.slice(firstCall));
  }
  assert.ok(fire, "the hosted sleep started polling its timer");
  // The initial authorization can overlap the arm. Measure only subsequent polls, without run show.
  await wait(500);
  const from = calls.length;
  await wait(5_000);
  const window = calls.slice(from);
  const stats = {
    fireMisses: timerReads(window, eptStreamName(space), fire, 10037),
    settleMisses: timerReads(window, epfStreamName(space), settleSubject(fire), 10037),
    journalReplays: journalCreates(window, run),
  };
  assert.ok(stats.fireMisses >= 2 && stats.settleMisses >= 2, `the pause was actively polled without a fire: ${JSON.stringify(stats)}`);
  const pending = await show(run);
  assert.equal(pending.status?.state, "running");
  assert.ok(pending.journal.some(row => row.kind === "step" && row.step === "/sleep#0" && row.state === "pending"));
  console.log(`waiting hosted sleep: ${JSON.stringify(stats)}`);
  return stats.journalReplays;
}

async function verifyPolling(root: string, runCli: (...args: string[]) => Promise<string>, calls: ApiCall[], jsm: JetStreamManager): Promise<void> {
  const start = async (duration: string): Promise<string> => {
    const file = join(root, `${duration}.cotal.js`);
    writeFileSync(file, `await sleep(${JSON.stringify(duration)});\n`);
    const { result } = JSON.parse(await runCli("start", "--file", file));
    assert.match(result.result.runId, /^run-/);
    return result.result.runId;
  };
  const show = async (run: string): Promise<RunStatusView> => JSON.parse(await runCli("show", run)).result.view;
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
  assert.equal(await verifyWaiting(start, show, calls), 0, "an empty fire or settle poll must not replay the workflow journal");
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
          const runCli = async (...args: string[]) => (await exec(process.execPath,
            [cli, "run", ...args, "--space", space, "--server", servers, "--json"], { cwd: root, timeout: 20_000 })).stdout;
          await verifyPolling(root, runCli, calls, await jetstreamManager(audit, { checkAPI: false }));
        } finally { await audit.close(); }
      } finally {
        try { await manager.stop({ withAgents: true }); } finally { await timerNc.close(); }
      }
    } finally { await delivery.stop(); }
  } finally { await broker.stop(); }
}

await main();
