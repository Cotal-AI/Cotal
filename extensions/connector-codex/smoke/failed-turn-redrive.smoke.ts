import nodeAssert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, seedChannelRegistry, isReachable, dmDurable, dmStream, parsePrincipalKey } from "@cotal-ai/core";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { awaitBrokerReady, countedAssert, freePort, skipSuite, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;

if (process.platform === "win32") skipSuite("managed Codex agents are POSIX-only");
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];

const mode = process.argv[2];
if (mode !== undefined && mode !== "fail" && mode !== "ok") {
  throw new Error("failed-turn-redrive.smoke.ts accepts only fail or ok, or no argument to run both");
}
async function runMode(mode: "fail" | "ok"): Promise<void> {
const marker = mode === "fail" ? "FAILFOREVER" : "COMPLETEONCE";
const maxTurns = 3;

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const space = `codex-failed-turn-${mode}`;
const peer = "codexpeer";
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const outDir = join(dir, "evidence");
mkdirSync(outDir, { recursive: true });
const fake = join(repo, "extensions/connector-codex/smoke/failed-turn-app-server.mjs");
const bin = join(dir, "fake-codex");
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
chmodSync(bin, 0o755);
const log = join(dir, "fake.log.jsonl");

const nats = spawn("nats-server", ["-js", "-p", String(port), "-sd", join(dir, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(nats, dir);
const operator = new CotalEndpoint({
  space,
  servers,
  card: { name: "operator", kind: "agent", id: "operator" },
  channels: ["team"],
});
operator.on("error", () => {});
let host: ChildProcess | undefined;
let observer: NatsConnection | undefined;
const hostErr: string[] = [];
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 200 });
  await seedChannelRegistry({ servers, space, file: { defaults: { replay: false }, channels: { team: { replay: false } } } });
  await operator.start();
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) if (key.startsWith("COTAL_")) delete clean[key];
  const tsx = join(repo, "node_modules/.bin/tsx");
  const hostEntry = join(repo, "extensions/connector-codex/src/host-main.ts");
  const spawnHost = () => {
    const child = spawn(tsx, [hostEntry], {
      cwd: repo,
      env: {
        ...clean,
        COTAL_SPACE: space,
        COTAL_NAME: peer,
        COTAL_ID: peer,
        COTAL_SERVERS: servers,
        COTAL_SUBSCRIBE: "team",
        COTAL_ROLE: "coder",
        COTAL_CODEX_BIN: bin,
        COTAL_CODEX_HOME: dir,
        FAKE_CODEX_LOG: log,
        COTAL_MODEL: "fake-model",
        COTAL_CODEX_TUI: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => hostErr.push(String(chunk)));
    child.stderr.on("data", (chunk) => hostErr.push(String(chunk)));
    return child;
  };
  host = spawnHost();
  const deadline = Date.now() + 20_000;
  let online = false;
  while (Date.now() < deadline) {
    online = operator.getRoster().some((p) => p.card.name === peer);
    if (online) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!online) {
    writeFileSync(join(outDir, `${mode}-host.log`), hostErr.join(""));
    throw new Error(`peer did not join\n${hostErr.join("").slice(-4000)}`);
  }
  const id = operator.getRoster().find((p) => p.card.name === peer)?.card.id;
  const presence = operator.getRoster().find(p => p.card.name === peer);
  assert.ok(id && presence?.lifecycleUid, "managed peer has a live lifecycle");
  const principal = parsePrincipalKey(id);
  assert.ok(principal, "managed peer has a canonical principal");
  const durable = dmDurable(principal.owner, principal.actor, presence.lifecycleUid);
  const nc = observer = await connect({ servers });
  const consumer = async () => (await nc.request(`$JS.API.CONSUMER.INFO.${dmStream(space)}.${durable}`, "")).json<{ num_ack_pending: number; num_redelivered: number }>();
  const sent = await operator.unicast(id, marker);
  const stopAt = Date.now() + 70_000;
  let turns = [];
  while (Date.now() < stopAt) {
    const raw = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    turns = raw.filter((entry) => entry.ev === "turn" && String(entry.text).includes(marker));
    await new Promise((r) => setTimeout(r, 250));
  }
  const raw = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  turns = raw.filter((entry) => entry.ev === "turn" && String(entry.text).includes(marker));
  const result = {
    mode,
    marker,
    dir,
    turns: turns.map((entry) => ({
      status: entry.status,
      delivery: (String(entry.text).match(/delivery (\d+)/) ?? [])[1] ?? null,
      redelivery: String(entry.text).includes("broker redelivery"),
    })),
    hostFeed: hostErr.join("").split("\n").filter((line) => line.includes("turn ") || line.includes("DM from")),
    messageId: sent.id,
    presence: operator.getRoster().find(p => p.card.name === peer),
    consumer: await consumer(),
  };
  writeFileSync(join(outDir, `${mode}.json`), JSON.stringify(result, null, 2));
  writeFileSync(join(outDir, `${mode}-host.log`), hostErr.join(""));
  console.log(JSON.stringify(result, null, 2));
  if (mode === "fail") {
    assert.equal(turns.length, maxTurns, "one failed message is driven at most three times, including broker redelivery");
    assert.ok(result.presence?.condition?.message?.includes(sent.id), "paused condition names the retained message id");
    assert.ok(result.presence?.condition?.message?.includes("cotal_inbox"), "paused condition names the inbox read route");
    assert.ok(hostErr.join("").includes("paused after 3 turns"), "host log reports the capped batch");
    assert.equal(result.consumer.num_ack_pending, 1, "paused valid message remains unacknowledged on its native consumer");
    assert.ok(result.consumer.num_redelivered >= 1, "the broker redelivered the paused message without resetting its turn budget");
    await operator.unicast(id, "COMPLETEONCE fresh work");
    const until = Date.now() + 10_000;
    let completed;
    while (Date.now() < until) {
      const entries = readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
      completed = entries.find(entry => entry.ev === "turn" && String(entry.text).includes("COMPLETEONCE fresh work"));
      if (completed) {
        assert.ok(!String(completed.text).includes(marker), "fresh work excludes the paused batch");
        assert.equal(completed.status, "completed");
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(completed, "fresh work can still complete while the failed batch stays paused");
    const latest = await consumer();
    assert.equal(latest.num_ack_pending, 1, "fresh completion does not acknowledge the unrelated paused message");
  } else {
    assert.equal(turns.length, 1, "completed control is not reinjected during broker acknowledgement window");
    assert.equal(turns[0].status, "completed");
    assert.equal(result.consumer.num_ack_pending, 0, "completed control advances its native consumer acknowledgement");
  }
} finally {
  if (host && host.exitCode === null && host.signalCode === null) {
    const child = host;
    await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill("SIGTERM"); });
  }
  await observer?.drain();
  await operator.stop().catch(() => {});
  await releaseBroker();
}
}
if (mode === undefined) { await runMode("fail"); await runMode("ok"); }
else await runMode(mode);
console.log(`COTAL_SMOKE_SENTINEL cells=${cells()} passed=${cells()} failed=0`);
