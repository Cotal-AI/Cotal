/** Real static-auth observer credentials, shipped web child process and HTTP event backfill.
 * Metadata survives a denied payload read. Owner payload reads include full arguments and results.
 * Run: pnpm smoke:web-event-history-auth-live
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, createSpaceAuth, eventChannel, isReachable, mintCreds, newIdentity, serverConfig, setupSpaceStreams, type Part } from "@cotal-ai/core";
import { freePort, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const space = "eventhistoryauth";
const auth = await createSpaceAuth(space);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
const broker = spawn(process.env.NATS_SERVER_BIN ?? "nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const release = teardownOnSignal(broker, dir);
let child: ReturnType<typeof spawn> | undefined;
let agent: CotalEndpoint | undefined;
let log = "";
try {
  for (let i = 0; i < 80 && !await isReachable(servers); i++) await wait(100);
  const provisioner = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers, space, creds: provisioner });
  const identity = newIdentity();
  agent = new CotalEndpoint({ servers, space, creds: await mintCreds(auth, identity, "agent", { principal: { owner: "u_aaaaaaaaaaaaaaaaaaaaaaaaaa", actor: "fixture" }, allowPublish: ["events.u_aaaaaaaaaaaaaaaaaaaaaaaaaa.fixture"], lifecycleUid: "ee11ff22aa33bb4455cc66dd77" }), card: { owner: "u_aaaaaaaaaaaaaaaaaaaaaaaaaa", actor: "fixture", name: "fixture", kind: "agent" }, channels: [], consume: false, registerPresence: false });
  agent.on("error", (error) => console.log(`publisher: ${error.message}`));
  await agent.start();
  const channel = eventChannel(agent.principal);
  const frame = { kind: "ag-ui.frame", protocol: "ag-ui/0.0.57", threadId: "T1", runId: "R1", epoch: "E1", seq: 1, events: [{ type: "TOOL_CALL_START", toolCallId: "call1", toolCallName: "fixture" }, { type: "TOOL_CALL_END", toolCallId: "call1" }] };
  const metadata = await agent.multicast("", { channel, parts: [frame as unknown as Part] });
  const payloadId = "fixture-payload";
  await agent.publishEventPayload({ id: payloadId, expectedLastSubjectSeq: 0, parts: [{ ...frame, seq: 2, events: [{ type: "TOOL_CALL_ARGS", toolCallId: "call1", delta: '{"fixture":true}' }, { type: "TOOL_CALL_RESULT", toolCallId: "call1", content: "fixture-result" }] } as unknown as Part] });
  for (const owner of ["u_aaaaaaaaaaaaaaaaaaaaaaaaaa", "u_bbbbbbbbbbbbbbbbbbbbbbbbbb"]) {
  log = "";
  const observerPath = join(dir, "observer.creds");
  writeFileSync(observerPath, await mintCreds(auth, newIdentity(), "observer", { principal: { owner, actor: "observer" } }), { mode: 0o600 });
  const webPort = await freePort();
  child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./run-web.mts", import.meta.url)), "--space", space, "--server", servers, "--creds", observerPath, "--port", String(webPort), "--no-open"], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", (chunk: Buffer) => { log += chunk.toString(); });
  child.stderr!.on("data", (chunk: Buffer) => { log += chunk.toString(); });
  let launch: string | undefined;
  for (let i = 0; i < 200 && !launch; i++) { launch = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?k=[A-Za-z0-9_-]+/)?.[0]; await wait(100); }
  assert.ok(launch, `web launch failed: ${log}`);
  const exchange = await fetch(launch, { redirect: "manual" });
  const cookie = exchange.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, "web launch exchanged session cookie");
  const response = await fetch(`http://127.0.0.1:${webPort}/api/agents/${encodeURIComponent(agent.card.id)}/events?limit=200`, { headers: { cookie }, signal: AbortSignal.timeout(30000) });
  const body = await response.text();
  console.log(`events HTTP ${response.status}: ${body}`);
  console.log(`web process log: ${log}`);
  assert.ok(!log.includes(`Subscription to "cotal.${space}.evp.`), "payload tap uses only credential-covered subjects");
  assert.equal(response.status, 200);
  const result = JSON.parse(body) as { frames?: { id: string }[]; payloadRead?: { status: string; reason: string } };
  assert.ok(result.frames?.some((item) => item.id === metadata.id), "HTTP backfill retains completed call metadata");
  if (owner === agent.principal.owner) {
    assert.ok(result.frames?.some((item) => item.id === payloadId), "HTTP backfill includes stored tool payload");
    assert.ok(body.includes('fixture-result') && body.includes('TOOL_CALL_ARGS'), "HTTP payload preserves arguments and results");
    assert.equal(result.payloadRead, undefined, "successful payload read has no failure marker");
  } else {
    assert.equal(result.payloadRead?.status, "refused", "foreign observer gets typed payload refusal");
    assert.ok(result.payloadRead.reason.length > 0 && result.payloadRead.reason.length < 300, "refusal has a bounded safe explanation");
    assert.ok(!body.includes("fixture-result") && !body.includes("TOOL_CALL_ARGS"), "foreign observer receives no payload");
  }
  const exited = new Promise((resolve) => child!.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
  child = undefined;
  }
  console.log("COTAL_SMOKE_SENTINEL cells=10 passed=10 failed=0");
} finally {
  await agent?.stop();
  if (child && child.exitCode === null) { const exited = new Promise((resolve) => child!.once("exit", resolve)); child.kill("SIGTERM"); await exited; }
  release();
  if (broker.exitCode === null) { const exited = new Promise((resolve) => broker.once("exit", resolve)); broker.kill("SIGTERM"); await exited; }
  rmSync(dir, { recursive: true, force: true });
}
