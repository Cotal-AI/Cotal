import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import { PermissionViolationError } from "@nats-io/transport-node";
import { EpEnvelopeError, canonicalJson, epAuthBucket, isReachable, type ToolResultConsent } from "@cotal-ai/core";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { authorityWriterGrants, openAuthorityClient, type AuthorityClient } from "../src/authority-client.js";
import { createToolResultRevocationCustody, recordToolResultRevocation, snapshotToolResultRevocations,
  consumeToolResultSnapshot, requireToolResultClockPrerequisite, toolResultRevocationWriterGrants, toolResultSnapshotReaderGrants,
  type ToolResultRevocationCustody, type ToolResultSnapshotRequest } from "../src/tool-result-prerequisites.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";

let passed = 0;
function check(name: string, condition: unknown) { assert.ok(condition, name); passed++; console.log(`PASS ${name}`); }
async function refuses(name: string, run: () => unknown | Promise<unknown>, code?: string) {
  await assert.rejects(async () => run(), error => error instanceof EpEnvelopeError && (!code || error.code === code));
  check(name, true);
}
const fixture = await startHostedAuthFixture("tool-result-prerequisites", 2);
const account = fixture.accounts[0]!;
const clients: AuthorityClient[] = [], custodies: ToolResultRevocationCustody[] = [];
const target = { owner: `u_${"a".repeat(26)}`, actor: "target", lifecycleUid: "a".repeat(26) };
const other = { ...target, actor: "other" };
let allowed = true;
const consent = (id: string): ToolResultConsent => ({ v: 1, kind: "tool-result-consent", id, space: account.space, target,
  holder: { owner: target.owner, actor: "holder" }, iat: Date.now() - 10, exp: Date.now() + 60_000, issuer: { keyId: "test" }, sig: "A".repeat(86) });
const options = (directory: string) => ({ directory, server: fixture.servers, space: account.space,
  dataAccount: { pub: account.accountPublicKey, signingSeed: account.auth.account.signingSeed! }, log: () => {},
  authorizeConsent: async (c: ToolResultConsent) => { if (!allowed || c.target.actor !== target.actor) throw new EpEnvelopeError("permission-denied", "not authorized"); },
  authorizeTarget: async (t: typeof target) => { if (!allowed || canonicalJson(t) !== canonicalJson(target)) throw new EpEnvelopeError("permission-denied", "not authorized"); } });
const request = (overrides: Partial<ToolResultSnapshotRequest> = {}): ToolResultSnapshotRequest => ({ accountPublicKey: account.accountPublicKey, target, deadline: Date.now() + 10_000, maxEntries: 100, maxBytes: 1_000_000, ...overrides });
try {
  const directory = join(fixture.dir, "custody");
  const custody = await createToolResultRevocationCustody(options(directory)); custodies.push(custody);
  check("fresh custody fsynced intent precedes creation receipt", JSON.parse(readFileSync(join(directory, "intent.json"), "utf8")).generation === JSON.parse(readFileSync(join(directory, "created.json"), "utf8")).generation);
  const empty = await snapshotToolResultRevocations(custody, request());
  check("native proven-empty fixed cut", empty.snapshot.revokedConsentIds.length === 0 && empty.snapshot.watermark === 0);
  check("snapshot carries original T0 before watermark time", empty.snapshot.t0 <= empty.snapshot.watermarkTakenAt);
  await refuses("forged witness refuses", () => consumeToolResultSnapshot(custody, { snapshot: empty.snapshot }, target), "permission-denied");
  await refuses("wrong target witness refuses", () => consumeToolResultSnapshot(custody, empty, other), "permission-denied");
  check("real witness is consumed once", (await consumeToolResultSnapshot(custody, empty, target)).watermark === 0);
  await refuses("reused witness refuses", () => consumeToolResultSnapshot(custody, empty, target), "permission-denied");
  await refuses("forged custody refuses", () => snapshotToolResultRevocations({ ...custody }, request()), "permission-denied");
  await refuses("wrong account refuses", () => snapshotToolResultRevocations(custody, request({ accountPublicKey: fixture.accounts[1]!.accountPublicKey })), "permission-denied");
  await refuses("unauthorized target refuses", () => snapshotToolResultRevocations(custody, request({ target: other })), "permission-denied");
  await refuses("bad request refuses", () => snapshotToolResultRevocations(custody, request({ maxEntries: 0 })), "bad-request");
  const controller = new AbortController(); controller.abort();
  await refuses("cancelled snapshot refuses", () => snapshotToolResultRevocations(custody, request({ signal: controller.signal })), "unavailable");
  await refuses("expired deadline refuses before IO", () => snapshotToolResultRevocations(custody, request({ deadline: Date.now() - 1 })), "bad-request");
  await refuses("existing journal never adopted", () => createToolResultRevocationCustody(options(directory)), "unavailable");
  await refuses("existing auth store never adopted via a new journal", () => createToolResultRevocationCustody(options(join(fixture.dir, "second"))), "unavailable");
  const open = async (label: string, grants: typeof authorityWriterGrants) => {
    const client = await openAuthorityClient({ ...options(directory), label, noReconnect: true, grants: id => grants(account.space, id) });
    clients.push(client); return client;
  };
  const issuer = await open("tool-result-test-issuer", authorityWriterGrants);
  const kv = await new Kvm(issuer.nc).open(epAuthBucket(account.space));
  check("retained issuer really enumerates auth metadata", (await (await jetstreamManager(issuer.nc)).streams.info(`KV_${epAuthBucket(account.space)}`)).state.messages === 0);
  for (const id of ["one", "two", "three"]) {
    const c = consent(id); await kv.put(`consent.${id}`, new TextEncoder().encode(canonicalJson(c)), { previousSeq: 0 });
    for (const field of ["previousSeq", "operation", "ttl"]) {
      await refuses(`mediated ${field} option rejected before write`, () => recordToolResultRevocation(custody, { ...c, [field]: field === "operation" ? "DEL" : 1 }), "bad-request");
    }
    const marker = await recordToolResultRevocation(custody, c);
    check(`mediated ${id} marker receives native durable ack`, marker.consentId === id);
  }
  await refuses("identical recorded consent still conflicts on repeated revocation", async () => {
    const c = (await kv.get("consent.one"))!.json<ToolResultConsent>();
    await recordToolResultRevocation(custody, c);
  }, "conflict");
  const result = await snapshotToolResultRevocations(custody, request());
  check("multipage leader cut exact IDs, not transfer counts", canonicalJson(result.snapshot.revokedConsentIds) === canonicalJson(["one", "three", "two"]));
  await refuses("independent count cap refuses instead of partial witness", () => snapshotToolResultRevocations(custody, request({ maxEntries: 2 })), "unavailable");
  await refuses("independent byte cap refuses instead of partial witness", () => snapshotToolResultRevocations(custody, request({ maxBytes: 1 })), "unavailable");
  await refuses("conflicting consent ID not idempotent success", () => recordToolResultRevocation(custody, consent("one")), "permission-denied");
  allowed = false;
  await refuses("lost target authority refuses current witness use", () => consumeToolResultSnapshot(custody, result, target), "permission-denied");
  allowed = true;
  check("supported fresh snapshot resumes after target authority restored", (await snapshotToolResultRevocations(custody, request())).snapshot.revokedConsentIds.length === 3);
  const writer = await open("tool-result-test-writer", toolResultRevocationWriterGrants);
  const reader = await open("tool-result-test-reader", toolResultSnapshotReaderGrants);
  const denial = async (client: AuthorityClient, subject: string) => {
    let caught: unknown;
    try { await client.nc.request(subject, new TextEncoder().encode("{}"), { timeout: 1000 }); }
    catch (error) { caught = error instanceof PermissionViolationError ? error : (error as Error).cause; }
    check(`native denial ${subject.split(".").slice(0, 5).join(".")}`, caught instanceof PermissionViolationError && caught.operation === "publish" && caught.subject === subject);
  };
  await denial(writer, `$JS.API.STREAM.INFO.KV_${epAuthBucket(account.space)}`);
  await denial(issuer, `$KV.${epAuthBucket(account.space)}.revocation.other.one`);
  await denial(reader, `$JS.API.STREAM.UPDATE.KV_${epAuthBucket(account.space)}`);
  await denial(writer, `$JS.API.STREAM.CREATE.KV_${epAuthBucket(account.space)}`);
  const info = await (await jetstreamManager(reader.nc)).streams.info(`KV_${epAuthBucket(account.space)}`);
  check("native reader positive carries exact approved v2 shape", info.config.storage === "file" && info.config.allow_direct === false && info.config.allow_msg_ttl === true && !info.config.mirror && !info.config.sources?.length && info.config.max_age === 0 && info.config.max_msgs === -1 && info.config.max_bytes === -1);
  await denial(reader, `$KV.${epAuthBucket(account.space)}.revocation.foreign.one`);
  await denial(reader, `$JS.API.CONSUMER.CREATE.KV_${epAuthBucket(account.space)}`);
  await denial(reader, `$JS.API.STREAM.MSG.GET.KV_${epAuthBucket(fixture.accounts[1]!.space)}`);
  await refuses("gate2 explicitly refuses absent native clock evidence", () => requireToolResultClockPrerequisite(), "unavailable");
  appendFileSync(join(directory, "created.json"), " ");
  await refuses("custody journal mutation invalidates permanently", () => snapshotToolResultRevocations(custody, request()), "unavailable");
  await custody.close();
  await refuses("closed custody refuses even existing witness", () => consumeToolResultSnapshot(custody, result, target), "unavailable");
  console.log(`tool-result-prerequisites: ${passed} passed, 0 failed`);
  emitSentinel({ passed, failed: 0 });
} finally {
  await Promise.all(custodies.map(c => c.close()));
  await Promise.all(clients.map(c => c.close()));
  await fixture.close();
  check("owned native fixture listener is closed after scoped teardown", !await isReachable(fixture.servers));
}
