// Native fault fixtures for SPEC effect outcomes. No product mutation or persistence shim.
import assert from "node:assert/strict";
import { createServer, createConnection, type Socket } from "node:net";
import { mkdirSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { join } from "node:path";
import { Kvm } from "@nats-io/kv";
import { canonicalJson, epAuthBucket, EpEnvelopeError, isReachable, type ToolResultConsent } from "@cotal-ai/core";
import { authorityWriterGrants, openAuthorityClient } from "../src/authority-client.js";
import { createToolResultRevocationCustody, recordToolResultRevocation } from "../src/tool-result-prerequisites.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";

if (process.platform !== "linux" || statfsSync(tmpdir()).type !== 0xef53) {
  console.log("Native outcome fault cells unavailable: qualified Linux/ext4 required; prerequisite suite checks refusal");
  process.exit(0);
}
const fixture = await startHostedAuthFixture("tool-result-outcomes", 2);
let passed = 0, failed = 0;
const target = { owner: `u_${"a".repeat(26)}`, actor: "target", lifecycleUid: "a".repeat(26) };
const sockets: Socket[] = [];
const broker = new URL(fixture.servers);
let dropped = false;
const proxy = createServer((downstream) => {
  const upstream = createConnection({ host: broker.hostname, port: Number(broker.port) });
  sockets.push(downstream, upstream);
  let drop = false;
  downstream.on("data", (data: Buffer) => {
    // Withhold the real publish ACK from the writer, not the request to the broker.
    if (data.includes(Buffer.from(".revocation."))) { drop = true; dropped = true; }
    upstream.write(data);
  });
  upstream.on("data", (data: Buffer) => { if (!drop) downstream.write(data); });
  upstream.on("error", () => downstream.destroy());
  downstream.on("error", () => upstream.destroy());
  upstream.on("close", () => downstream.destroy());
  downstream.on("close", () => upstream.destroy());
});
await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
const address = proxy.address();
assert.ok(address && typeof address !== "string");
const clients: Array<{ close(): Promise<void> }> = [];
async function cell(name: string, run: () => Promise<void>) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}: ${(e as Error).message}`); }
}
try {
  for (const [index, kind] of ["lost-ack", "receipt-failure"].entries()) {
    const account = fixture.accounts[index]!;
    const directory = join(fixture.dir, kind);
    const dataAccount = { pub: account.accountPublicKey, signingSeed: account.auth.account.signingSeed! };
    let authorizations = 0;
    let expectedSequence = 0;
    const custody = await createToolResultRevocationCustody({ directory, space: account.space, dataAccount,
      server: kind === "lost-ack" ? `nats://127.0.0.1:${address.port}` : fixture.servers,
      log: () => {}, authorizeTarget: async () => {}, authorizeConsent: async () => {
        authorizations++;
        if (kind === "receipt-failure" && authorizations === 2) mkdirSync(join(directory, `receipt-${expectedSequence}.json`));
      } });
    clients.push(custody);
    const issuer = await openAuthorityClient({ server: fixture.servers, space: account.space, dataAccount, log: () => {}, label: "outcome-native-reader", grants: id => authorityWriterGrants(account.space, id) });
    clients.push(issuer);
    const kv = await new Kvm(issuer.nc).open(epAuthBucket(account.space));
    const consent: ToolResultConsent = { v: 1, kind: "tool-result-consent", id: kind, space: account.space, target,
      holder: { owner: target.owner, actor: "holder" }, iat: Date.now() - 10, exp: Date.now() + 60_000, issuer: { keyId: "fixture" }, sig: "A".repeat(86) };
    expectedSequence = (await kv.put(`consent.${kind}`, new TextEncoder().encode(canonicalJson(consent)), { previousSeq: 0 })) + 1;
    let error: unknown;
    try { await recordToolResultRevocation(custody, consent); } catch (e) { error = e; }
    await cell(`B2-${kind}-native-effect-fixture`, async () => {
      assert.ok(error instanceof EpEnvelopeError);
      assert.match(error.message, kind === "lost-ack" ? /persistence unknown/ : /acknowledged/);
      if (kind === "lost-ack") assert.ok(dropped);
      const digest = (await import("node:crypto")).createHash("sha256").update(canonicalJson(target)).digest("hex");
      const marker = await kv.get(`revocation.${digest}.${kind}`);
      assert.ok(marker, "independent reader proves the native effect committed");
      assert.equal(marker.revision, expectedSequence);
    });
    await cell(`B2-${kind}-true-outcome`, async () => {
      assert.ok(error instanceof EpEnvelopeError);
      assert.equal(error.toEpError().outcome, kind === "lost-ack" ? "unknown" : "executed");
    });
  }
} finally {
  await Promise.all(clients.map(c => c.close()));
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((done) => proxy.close(() => done()));
  await fixture.close();
  assert.equal(await isReachable(fixture.servers), false);
}
console.log(`REVOCATION_OUTCOMES cells=${passed + failed} passed=${passed} failed=${failed}`);
emitSentinel({ passed, failed });
assert.equal(failed, 0);
