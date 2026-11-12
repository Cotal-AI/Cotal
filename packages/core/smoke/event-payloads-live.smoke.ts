import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { createSpaceAuth, mintCreds, serverConfig } from "../src/provision.js";
import { newIdentity } from "../src/identity.js";
import { setupSpaceStreams } from "../src/streams.js";
import { CotalEndpoint, isReachable } from "../src/endpoint.js";
import { eventPayloadSubject } from "../src/event-payloads.js";
import { mintLifecycleUid } from "../src/subjects.js";
import { freePort, teardownOnSignal, SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";

const root = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}payload-grants-`));
const space = "payloadgrant";
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const auth = await createSpaceAuth(space);
writeFileSync(join(root, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(root, "js") }));
const broker = spawn(process.env.NATS_SERVER_BIN ?? "nats-server", ["-c", join(root, "server.conf")], { stdio: "ignore" });
const release = teardownOnSignal(broker);
const connections: Awaited<ReturnType<typeof connect>>[] = [];
try {
  for (let n = 0; !(await isReachable(servers)); n++) { if (n > 100) throw Error("broker readiness"); await new Promise(r => setTimeout(r, 25)); }
  await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  const owner = "u_aaaaaaaaaaaaaaaaaaaaaaaaaa", foreign = "u_bbbbbbbbbbbbbbbbbbbbbbbbbb";
  const subject = eventPayloadSubject(space, owner, "seat");
  const native = async (who: string, actor: string, read: string[], eventPayloads = true) => {
    const creds = await mintCreds(auth, newIdentity(), "agent", { principal: { owner: who, actor }, lifecycleUid: mintLifecycleUid(), allowSubscribe: read, eventPayloads });
    const { nativeCredsAuthenticator } = await import("../src/creds-authenticator.js");
    const nc = await connect({ servers, authenticator: nativeCredsAuthenticator(creds), reconnect: false });
    connections.push(nc);
    return nc;
  };
  const writer = await native(owner, "seat", []);
  const own = await native(owner, "reader", []);
  const broad = await native(foreign, "broad", [">"]);
  const explicit = await native(foreign, "explicit", [`events.${owner}.seat`]);
  const a = own.subscribe(subject), b = broad.subscribe(subject), c = explicit.subscribe(subject);
  const denied: unknown[] = [];
  void (async () => { for await (const s of broad.status()) if (s.type === "error") denied.push(s); })();
  await Promise.all([own.flush(), broad.flush(), explicit.flush()]);
  writer.publish(subject, new TextEncoder().encode("payload-grant-probe"));
  await writer.flush();
  await new Promise(r => setTimeout(r, 100));
  assert.equal(a.getReceived(), 1);
  assert.equal(b.getReceived(), 0);
  assert.equal(c.getReceived(), 1);
  assert.ok(denied.length > 0);
  const withheld = await native(owner, "withheld", [], false);
  const withheldErrors: unknown[] = [];
  void (async () => { for await (const s of withheld.status()) if (s.type === "error") withheldErrors.push(s); })();
  const withheldSubject = eventPayloadSubject(space, owner, "withheld");
  const withheldTap = own.subscribe(withheldSubject);
  await own.flush();
  withheld.publish(withheldSubject, new TextEncoder().encode("must-not-publish"));
  await withheld.flush();
  await new Promise(r => setTimeout(r, 100));
  assert.equal(withheldTap.getReceived(), 0);
  assert.ok(withheldErrors.length > 0);
  console.log("PASS real minted broker grants: own owner reads, wildcard foreign denied, explicit foreign reads, withheld publisher denied");
  const observerCreds = await mintCreds(auth, newIdentity(), "observer", { principal: { owner, actor: "observer" } });
  const observer = new CotalEndpoint({ space, servers, creds: observerCreds, channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false, card: { name: "observer", kind: "endpoint" } });
  writer.publish(subject, new TextEncoder().encode(JSON.stringify({ id: "history-probe", space, ts: Date.now(), from: { id: `${owner}.seat`, name: "seat" }, parts: [{ kind: "text", text: "history-payload-canary" }] })));
  await writer.flush();
  try {
    await observer.start();
    const rows = await observer.eventPayloadHistory(owner, "seat", { limit: 10, signal: AbortSignal.timeout(5000) });
    assert.ok(rows.some(row => row.id === "history-probe"), "owner observer reads retained payload using scoped consumer create");
    console.log("PASS real observer retained payload history");
  } finally { await observer.stop(); }
  const foreignObserver = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, newIdentity(), "observer", { principal: { owner: foreign, actor: "observer" } }), channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false, card: { name: "foreign-observer", kind: "endpoint" } });
  try {
    await foreignObserver.start();
    await assert.rejects(foreignObserver.eventPayloadHistory(owner, "seat", { limit: 10, signal: AbortSignal.timeout(5000) }), /permission/i);
    console.log("PASS foreign observer retained payload history denied");
  } finally { await foreignObserver.stop(); }
} finally {
  await Promise.all(connections.map(c => c.close()));
  broker.kill("SIGTERM"); await once(broker, "exit"); release();
}
