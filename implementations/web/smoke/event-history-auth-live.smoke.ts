/** Real static-auth observer credentials, shipped web child process and HTTP event backfill.
 * Metadata survives a denied payload read. Owner payload reads include full arguments and results.
 * Run: pnpm smoke:web-event-history-auth-live
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, createSpaceAuth, eventChannel, isReachable, mintCreds, newIdentity, PLUGIN_CHANNEL_ROOT, serverConfig, setupSpaceStreams, type CotalMessage, type Part } from "@cotal-ai/core";
import { freePort, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string) {
  const end = Date.now() + 10_000;
  while (!check() && Date.now() < end) await wait(25);
  assert.ok(check(), label);
}

type FeedEvent = { event: string; data: { feed?: string; channel?: string; msg?: CotalMessage; asOf?: number } };
function openFeed(base: string, cookie: string) {
  const events: FeedEvent[] = [];
  let failure: unknown;
  const request = get(`${base}/feed`, { headers: { cookie } }, (response) => {
    if (response.statusCode !== 200) {
      failure = new Error(`SSE returned HTTP ${response.statusCode}`);
      response.resume();
      return;
    }
    let pending = "";
    response.setEncoding("utf8").on("data", (chunk: string) => {
      pending += chunk;
      for (let end = pending.indexOf("\n\n"); end >= 0; end = pending.indexOf("\n\n")) {
        const block = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const match = /^event: ([^\n]+)\ndata: ([^\n]+)$/.exec(block);
        if (!match) continue;
        try { events.push({ event: match[1], data: JSON.parse(match[2]) as FeedEvent["data"] }); }
        catch (error) { failure = error; }
      }
    });
  });
  request.on("error", (error) => { failure = error; });
  return {
    events,
    async ready() {
      await until(() => failure !== undefined || events.some(({ event }) => event === "hello"), "SSE hello arrived");
      if (failure) throw failure;
      return events.find(({ event }) => event === "hello")!.data.feed!;
    },
    close: () => request.destroy(),
  };
}

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const space = "eventhistoryauth";
const legacyChannel = `${PLUGIN_CHANNEL_ROOT}.linear.legacy-inbox`;
const legacyText = "ordinary chat in a space with plugin channels off";
const sharedViewNotice = "Plugin channels are not shown in this shared view.";
const auth = await createSpaceAuth(space);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
const broker = spawn(process.env.NATS_SERVER_BIN ?? "nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const release = teardownOnSignal(broker, dir);
let child: ReturnType<typeof spawn> | undefined;
let agent: CotalEndpoint | undefined;

async function launchDashboard(endpoint: { servers: string; space: string; credsPath: string }) {
  const webPort = await freePort();
  const base = `http://127.0.0.1:${webPort}`;
  const proc = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./run-web.mts", import.meta.url)), "--space", endpoint.space, "--server", endpoint.servers, "--creds", endpoint.credsPath, "--port", String(webPort), "--no-open"], { stdio: ["ignore", "pipe", "pipe"] });
  child = proc;
  let log = "";
  const collect = (chunk: Buffer) => { log = (log + chunk.toString()).slice(-16_384); };
  proc.stdout!.on("data", collect);
  proc.stderr!.on("data", collect);
  let launch: string | undefined;
  for (let i = 0; i < 200 && !launch && proc.exitCode === null; i++) {
    launch = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?k=[A-Za-z0-9_-]+/)?.[0];
    if (!launch) await wait(100);
  }
  assert.ok(launch, `web launch failed: ${log.replace(/\?k=[A-Za-z0-9_-]+/g, "?k=[redacted]")}`);
  const exchange = await fetch(launch, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  const cookie = exchange.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie && exchange.status === 302, "web launch exchanged session cookie");
  return { base, cookie, log: () => log };
}

async function stopDashboard(): Promise<void> {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child!.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
  child = undefined;
}

async function checkLegacyChannel(base: string, cookie: string, messageId: string): Promise<void> {
  const read = (path: string) => fetch(`${base}${path}`, { headers: { cookie }, signal: AbortSignal.timeout(30_000) });
  const list = await read("/api/channels");
  assert.equal(list.status, 200);
  assert.ok((await list.json() as { channel: string }[]).some(({ channel }) => channel === legacyChannel), "off-space channel list retains plugin-shaped ordinary chat");
  const history = await read(`/api/channels/${encodeURIComponent(legacyChannel)}/history`);
  assert.equal(history.status, 200);
  const historyRows = await history.json() as { id: string; parts: { kind: string; text?: string }[] }[];
  assert.ok(historyRows.some((row) => row.id === messageId && row.parts.some((part) => part.kind === "text" && part.text === legacyText)), "off-space named history retains plugin-shaped ordinary chat");
  const activity = await read("/api/activity");
  assert.equal(activity.status, 200);
  assert.ok((await activity.json() as { entries: { mode: string; channel: string; msg: { id: string } }[] }).entries.some((row) => row.mode === "chat" && row.channel === legacyChannel && row.msg.id === messageId), "off-space activity retains the chat mode and destination");
  const page = await read("/");
  assert.equal(page.status, 200);
  assert.ok(!(await page.text()).includes(sharedViewNotice), "off-space dashboard does not show the shared-view notice");
}

interface SharedViewCase {
  channel: string;
  ordinaryChannel: string;
  retained: CotalMessage;
  publishVerified(): Promise<CotalMessage>;
}

async function readSharedView(base: string, cookie: string, cell: SharedViewCase): Promise<void> {
  const read = async (path: string) => {
    const response = await fetch(`${base}${path}`, { headers: { cookie }, signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200, path);
    return response.text();
  };
  assert.ok((await read("/")).includes(sharedViewNotice), "the authenticated page confirms the isolated shared view");
  const list = JSON.parse(await read("/api/channels")) as { channel: string }[];
  assert.ok(list.some(({ channel }) => channel === cell.ordinaryChannel) && !list.some(({ channel }) => channel === cell.channel), "shared list includes ordinary chat but not the plugin channel");
  assert.deepEqual(JSON.parse(await read(`/api/channels/${encodeURIComponent(cell.channel)}/history`)), [], "named plugin history is empty in a shared view");
  const activity = await read("/api/activity");
  assert.ok(!activity.includes(cell.channel) && !activity.includes(cell.retained.id), "activity has neither the plugin channel nor its retained post");
  const membership = JSON.parse(await read("/api/membership")) as { asOf?: number; members: { live: string[]; durable: string[] }[] };
  assert.ok(membership.asOf !== undefined && membership.members.some(({ live, durable }) => [...live, ...durable].includes(cell.ordinaryChannel)), "the real membership snapshot includes ordinary chat");
  assert.ok(!JSON.stringify(membership).includes(cell.channel), "shared membership has no plugin channel name");
  assert.ok(!(await read("/api/roster")).includes(cell.channel), "shared roster has no plugin attention channel name");
}

function hasMessage(events: FeedEvent[], event: string, id: string, channel?: string): boolean {
  return events.some((row) => row.event === event && row.data.msg?.id === id && (channel === undefined || row.data.channel === channel));
}

async function checkViewerFeeds(base: string, cookie: string, sender: CotalEndpoint, frame: Part, enabled?: SharedViewCase): Promise<void> {
  const watching = openFeed(base, cookie);
  const other = openFeed(base, cookie);
  try {
    const [first, second] = await Promise.all([watching.ready(), other.ready()]);
    assert.ok(first && second && first !== second, "each viewer has its own feed");
    const watchUrl = `${base}/api/agents/${encodeURIComponent(sender.card.id)}/watch?feed=${encodeURIComponent(first)}`;
    const watch = await fetch(watchUrl, { method: "POST", headers: { cookie }, signal: AbortSignal.timeout(10_000) });
    assert.equal(watch.status, 204);
    const plugin = enabled && await enabled.publishVerified();
    const metadata = await sender.multicast("", { channel: eventChannel(sender.principal), parts: [frame] });
    // The private frame and marker share the publisher and the observing CHAT tap.
    const markerChannel = enabled?.ordinaryChannel ?? legacyChannel;
    const marker = await sender.multicast("viewer barrier", { channel: markerChannel });
    const viewers = [watching, other];
    await until(() => viewers.every(({ events }) => hasMessage(events, "message", marker.id, markerChannel)), "both viewers see the ordinary live post");
    assert.ok(hasMessage(watching.events, "agent-frame", metadata.id), "the watching viewer receives the private frame");
    assert.ok(!other.events.some(({ data }) => data.msg?.id === metadata.id) && !hasMessage(watching.events, "message", metadata.id), "the frame does not reach the other viewer or the generic feed");
    if (enabled) {
      assert.ok(plugin && plugin.channel === enabled.channel, "the fixture verifies publication on the plugin rail");
      await until(() => viewers.every(({ events }) => events.some(({ event, data }) => event === "membership" && data.asOf !== undefined)), "both viewers receive real membership snapshots");
      for (const { events } of viewers) {
        assert.ok(!JSON.stringify(events).includes(enabled.channel) && !events.some(({ data }) => data.msg?.id === plugin.id), "neither shared feed names the plugin channel or receives the plugin post");
        await readSharedView(base, cookie, enabled);
      }
    }
  } finally {
    watching.close();
    other.close();
  }
}

try {
  for (let i = 0; i < 80 && !await isReachable(servers); i++) await wait(100);
  const provisioner = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers, space, creds: provisioner });
  const identity = newIdentity();
  agent = new CotalEndpoint({ servers, space, creds: await mintCreds(auth, identity, "agent", { principal: { owner: "u_aaaaaaaaaaaaaaaaaaaaaaaaaa", actor: "fixture" }, allowPublish: ["events.u_aaaaaaaaaaaaaaaaaaaaaaaaaa.fixture", legacyChannel], lifecycleUid: "ee11ff22aa33bb4455cc66dd77" }), card: { owner: "u_aaaaaaaaaaaaaaaaaaaaaaaaaa", actor: "fixture", name: "fixture", kind: "agent" }, channels: [], consume: false, registerPresence: false });
  agent.on("error", (error) => console.log(`publisher: ${error.message}`));
  await agent.start();
  const channel = eventChannel(agent.principal);
  const legacy = await agent.multicast(legacyText, { channel: legacyChannel });
  const frame = { kind: "ag-ui.frame", protocol: "ag-ui/0.0.57", threadId: "T1", runId: "R1", epoch: "E1", seq: 1, events: [{ type: "TOOL_CALL_START", toolCallId: "call1", toolCallName: "fixture" }, { type: "TOOL_CALL_END", toolCallId: "call1" }] };
  const metadata = await agent.multicast("", { channel, parts: [frame as unknown as Part] });
  const payloadId = "fixture-payload";
  await agent.publishEventPayload({ id: payloadId, expectedLastSubjectSeq: 0, parts: [{ ...frame, seq: 2, events: [{ type: "TOOL_CALL_ARGS", toolCallId: "call1", delta: '{"fixture":true}' }, { type: "TOOL_CALL_RESULT", toolCallId: "call1", content: "fixture-result" }] } as unknown as Part] });
  for (const owner of ["u_aaaaaaaaaaaaaaaaaaaaaaaaaa", "u_bbbbbbbbbbbbbbbbbbbbbbbbbb"]) {
    const observerPath = join(dir, "observer.creds");
    writeFileSync(observerPath, await mintCreds(auth, newIdentity(), "observer", { principal: { owner, actor: "observer" } }), { mode: 0o600 });
    const { base, cookie, log } = await launchDashboard({ servers, space, credsPath: observerPath });
    await checkLegacyChannel(base, cookie, legacy.id);
    const response = await fetch(`${base}/api/agents/${encodeURIComponent(agent.card.id)}/events?limit=200`, { headers: { cookie }, signal: AbortSignal.timeout(30_000) });
    const body = await response.text();
    assert.ok(!log().includes(`Subscription to "cotal.${space}.evp.`), "payload tap uses only credential-covered subjects");
    assert.equal(response.status, 200);
    const result = JSON.parse(body) as { frames?: { id: string }[]; payloadRead?: { status: string; reason: string } };
    assert.ok(result.frames?.some((item) => item.id === metadata.id), "HTTP backfill retains completed call metadata");
    if (owner === agent.principal.owner) {
      assert.ok(result.frames?.some((item) => item.id === payloadId), "HTTP backfill includes stored tool payload");
      assert.ok(body.includes("fixture-result") && body.includes("TOOL_CALL_ARGS"), "HTTP payload preserves arguments and results");
      assert.equal(result.payloadRead, undefined, "successful payload read has no failure marker");
      await checkViewerFeeds(base, cookie, agent, frame as unknown as Part);
    } else {
      assert.equal(result.payloadRead?.status, "refused", "foreign observer gets typed payload refusal");
      assert.ok(result.payloadRead.reason.length > 0 && result.payloadRead.reason.length < 300, "refusal has a bounded safe explanation");
      assert.ok(!body.includes("fixture-result") && !body.includes("TOOL_CALL_ARGS"), "foreign observer receives no payload");
    }
    await stopDashboard();
  }
  console.log("COTAL_SMOKE_SENTINEL cells=23 passed=23 failed=0");
} finally {
  await agent?.stop();
  await stopDashboard();
  release();
  if (broker.exitCode === null) { const exited = new Promise((resolve) => broker.once("exit", resolve)); broker.kill("SIGTERM"); await exited; }
  rmSync(dir, { recursive: true, force: true });
}
