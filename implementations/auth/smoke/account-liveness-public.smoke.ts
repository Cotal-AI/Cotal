import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { decode } from "@nats-io/jwt";
import { connect, credsAuthenticator, type NatsConnection, type Subscription } from "@nats-io/transport-node";
import * as core from "@cotal-ai/core";
import { startAuthService, type AuthServiceHandle, type EndpointAuthorityPolicy } from "../src/index.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";
import { emitSentinel } from "@cotal-ai/smoke-kit";

const fx = await startHostedAuthFixture("public-sweep", 2);
const handles: AuthServiceHandle[] = [];
let foreign: NatsConnection | undefined;
let observer: NatsConnection | undefined;
let count = 0;
const SETTLE_MS = 50, MAX_WAIT_MS = 400, PAGE_LIMIT = 2;
// New observations never escape through assertion diffs, decoder messages or error causes.
function refuse(): never { throw new Error("native account observation refused"); }
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse();
  const row = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) refuse();
  return row;
}
function integer(value: unknown, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) refuse();
  return value;
}
function text(value: unknown): string { if (typeof value !== "string" || !value) refuse(); return value; }
function exact(value: unknown, expected: unknown): boolean { return core.canonicalJson(value) === core.canonicalJson(expected); }
type Page = { total: number; rows: Record<string, unknown>[] };
function page(raw: unknown, serverId: string, account: string, offset: number): Page {
  const response = object(raw, ["server", "data"]);
  const server = object(response.server, ["name", "host", "id", "ver", "jetstream", "flags", "seq", "time"], ["domain", "tags", "metadata"]);
  if (server.id !== serverId || server.ver !== "2.12.12") refuse();
  const data = object(response.data, ["server_id", "now", "num_connections", "total", "offset", "limit", "connections"]);
  const total = integer(data.total);
  if (data.server_id !== serverId || data.offset !== offset || data.limit !== PAGE_LIMIT || offset > total || !Array.isArray(data.connections)) refuse();
  if (data.connections.length !== Math.min(PAGE_LIMIT, total - offset) || data.num_connections !== data.connections.length) refuse();
  const rows = data.connections.map(value => {
    const row = object(value, ["cid", "ip", "port", "start", "last_activity", "uptime", "idle", "pending_bytes", "in_msgs", "out_msgs", "in_bytes", "out_bytes", "subscriptions", "account", "authorized_user"],
      ["kind", "type", "rtt", "stalls", "name", "lang", "version", "tls_version", "tls_cipher_suite", "tls_peer_certs", "tls_first", "subscriptions_list_detail", "jwt", "issuer_key", "name_tag", "tags", "mqtt_client", "proxy"]);
    integer(row.cid, 1);
    if (row.account !== account) refuse();
    return row;
  });
  return { total, rows };
}
async function sweep(nc: NatsConnection, account: string): Promise<Record<string, unknown>[]> {
  const serverId = text(nc.info?.server_id), until = performance.now() + MAX_WAIT_MS;
  const rows: Record<string, unknown>[] = [];
  let total: number | undefined, previous = 0;
  for (let offset = 0, index = 0; index < 64; offset += PAGE_LIMIT, index++) {
    const remaining = until - performance.now();
    if (remaining <= SETTLE_MS) refuse();
    const inbox = `${core.MEMBERSHIP_INBOX_PREFIX}.capture.${randomUUID()}.${index}`;
    let sub: Subscription | undefined;
    let hard: ReturnType<typeof setTimeout> | undefined, settle: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await new Promise<unknown>((resolve, reject) => {
        let seen = false, result: unknown;
        const fail = () => reject(new Error("native account observation refused"));
        hard = setTimeout(fail, remaining);
        sub = nc.subscribe(inbox, { callback: (error, message) => {
          if (error || seen) { fail(); return; }
          seen = true;
          try { result = message.json<unknown>(); } catch { fail(); return; }
          settle = setTimeout(() => resolve(result), SETTLE_MS);
        } });
        try {
          nc.publish(core.connzRequestSubject(account), new TextEncoder().encode(JSON.stringify({ auth: true, subscriptions_detail: true, offset, limit: PAGE_LIMIT, state: 0 })), { reply: inbox });
        } catch { fail(); }
      });
      if (performance.now() >= until || nc.info?.server_id !== serverId) refuse();
      const next = page(raw, serverId, account, offset);
      if (total !== undefined && next.total !== total) refuse();
      total = next.total;
      for (const row of next.rows) {
        const cid = integer(row.cid, 1);
        if (cid <= previous) refuse();
        previous = cid;
        rows.push(row);
      }
      if (rows.length === total) return rows;
      if (next.rows.length === 0) refuse();
    } finally {
      if (hard !== undefined) clearTimeout(hard);
      if (settle !== undefined) clearTimeout(settle);
      sub?.unsubscribe();
    }
  }
  return refuse();
}
function target(rows: Record<string, unknown>[], name: string, account: string, signer: string): { row: Record<string, unknown>; claims: Record<string, unknown>; nats: Record<string, unknown>; subjects: string[] } {
  const matches = rows.filter(row => row.name === name);
  if (matches.length !== 1) refuse();
  const row = matches[0], jwt = text(row.jwt);
  // Public decode verifies the NKey signature. Its error can contain the JWT, so never propagate it.
  let decoded: unknown;
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) refuse();
    const header = object(JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")), ["typ", "alg"]);
    if (header.typ !== "JWT" || header.alg !== "ed25519-nkey") refuse();
    decoded = decode(jwt);
  } catch { return refuse(); }
  const claims = object(decoded, ["aud", "jti", "iat", "iss", "name", "sub", "exp", "nats"]);
  const now = Math.floor(Date.now() / 1000);
  if (claims.aud !== "NATS" || claims.iss !== signer || claims.name !== name || claims.sub !== row.authorized_user || !core.isUserNkey(text(claims.sub))) refuse();
  text(claims.jti);
  if (integer(claims.iat) > now || integer(claims.exp, 1) <= now || (claims.iat as number) >= (claims.exp as number)) refuse();
  const nats = object(claims.nats, ["data", "payload", "subs", "pub", "sub", "issuer_account", "type", "version"]);
  if (nats.issuer_account !== account || nats.type !== "user" || nats.version !== 2 || nats.data !== -1 || nats.payload !== -1 || nats.subs !== -1) refuse();
  if (!Array.isArray(row.subscriptions_list_detail) || row.subscriptions !== row.subscriptions_list_detail.length) refuse();
  const sids = new Set<string>();
  const subjects = row.subscriptions_list_detail.map(value => {
    const detail = object(value, ["subject", "sid", "msgs", "cid"], ["max"]);
    const sid = text(detail.sid);
    if (detail.cid !== row.cid || sids.has(sid)) refuse();
    sids.add(sid);
    integer(detail.msgs);
    if (Object.hasOwn(detail, "max")) integer(detail.max, 1);
    return text(detail.subject);
  });
  return { row, claims, nats, subjects };
}
function inboxSubject(subject: string, identity: string): boolean {
  const prefix = `_INBOX_${identity}.`;
  return subject.startsWith(prefix) && /^[A-Za-z0-9_-]+\.\*$/.test(subject.slice(prefix.length));
}
function managerSubscriptions(subjects: string[], space: string, identity: string): boolean {
  const expected = [
    `cotal.${space}.ep.v1.inst.manager.*.run-start.>`, `cotal.${space}.ep.v1.one.manager.run-start.>`,
    `cotal.${space}.ep.v1.inst.manager.*.run-resume.>`, `cotal.${space}.ep.v1.one.manager.run-resume.>`,
    `cotal.${space}.ep.v1.inst.manager.*.run-answer.>`, `cotal.${space}.ep.v1.one.manager.run-answer.>`,
    `cotal.${space}.ep.inst.manager.*.run-answer.>`, `cotal.${space}.ep.one.manager.run-answer.>`,
  ];
  return subjects.length === 9 && expected.every(subject => subjects.filter(value => value === subject).length === 1)
    && subjects.filter(subject => inboxSubject(subject, identity)).length === 1;
}
function hostedCeiling(nats: Record<string, unknown>, space: string, identity: string, account: string): boolean {
  // This is the complete captured signed claim ceiling, not the server's effective c.perms.
  // Independent fixture literals do not call the product's grant or observer builders.
  const publish = ["$JS.API.INFO"];
  for (const bucket of [`cotal_auth_${space}`, `cotal_records_${space}`, `cotal_issued_${space}`, `cotal_accepted_${space}`]) {
    publish.push(`$KV.${bucket}.>`, `$JS.API.STREAM.INFO.KV_${bucket}`, `$JS.API.STREAM.MSG.GET.KV_${bucket}`,
      `$JS.API.CONSUMER.CREATE.KV_${bucket}.>`, `$JS.API.CONSUMER.INFO.KV_${bucket}.>`, `$JS.API.CONSUMER.DELETE.KV_${bucket}.>`, `$JS.API.DIRECT.GET.KV_${bucket}.>`);
  }
  publish.push(`cotal.${space}.epc.*`, `$JS.API.DIRECT.GET.EPC_${space}.cotal.${space}.epc.>`, "$JS.FC.>");
  return exact(nats, { data: -1, payload: -1, subs: -1, pub: { allow: publish }, sub: { allow: [`_INBOX_${identity}.>`, `cotal.${space}.ep.v1.inst.>`] }, issuer_account: account, type: "user", version: 2 });
}
function projection(value: ReturnType<typeof target>): unknown {
  return { cid: value.row.cid, identity: value.claims.sub, signer: value.claims.iss, nats: value.nats, subjects: [...value.subjects].sort() };
}
function inventory(rows: Record<string, unknown>[]): unknown {
  return rows.map(row => ({ cid: row.cid, account: row.account, identity: row.authorized_user, name: row.name ?? null }));
}
function rejectsPrivately(operation: () => unknown): boolean {
  try { operation(); return false; } catch { return true; }
}
type Capture = { complete: true; manager: boolean; host: boolean } | { complete: false };
function requireCapture(capture: Capture): asserts capture is Extract<Capture, { complete: true }> {
  assert.ok(capture.complete, "native account capture is complete and attributed");
}
try {
  for (const a of fx.accounts) {
    await core.setupSpaceStreams({ servers: fx.servers, space: a.space, creds: await core.mintCreds(a.auth, core.newIdentity(), "provisioner") });
    let endpointAuthority: Parameters<typeof startAuthService>[0]["endpointAuthority"] = undefined;
    if (a === fx.accounts[0]) {
      const assignment = core.parseEndpointDeploymentAssignment({ account: { space: a.space, accountPublicKey: a.accountPublicKey, assignmentRevision: 1 }, lifecycleUid: core.mintLifecycleUid(), state: "active", expiresAt: Math.floor(Date.now() / 1000) + 120 });
      const policy: EndpointAuthorityPolicy = { namespace: async () => refuse(), serving: async () => refuse(), caller: async () => refuse(), authorizeInstance: async () => ({ authorized: false }), actorIsCurrent: async () => false };
      endpointAuthority = { policy, deployment: { assignment, withCurrentAssignment: async (expected, operation) => {
        if (!exact(expected, assignment)) refuse();
        core.parseEndpointDeploymentAssignment(assignment);
        const result = await operation();
        core.parseEndpointDeploymentAssignment(assignment);
        return result;
      } } };
    }
    handles.push(await startAuthService({ context: { accountPublicKey: a.accountPublicKey, lifecycleUid: "life-a" }, space: a.space, servers: fx.servers, store: a.store, storeIdentity: a.store.identity, stateDir: a.stateDir, ...(endpointAuthority ? { endpointAuthority } : {}) }));
  }
  const [a, b] = fx.accounts;
  foreign = await connect({ servers: fx.servers, name: "foreign-live-b", authenticator: credsAuthenticator(new TextEncoder().encode(await core.mintCreds(b.auth, core.newIdentity(), "provisioner"))) });
  assert.ok("observeAccountLivenessWithCreds" in core && typeof core.observeAccountLivenessWithCreds === "function", "cell 3a: root exports account liveness observer"); count++;
  const observerCreds = await core.mintMembershipObserverCreds(a.auth, core.newIdentity());
  const observe = (accountId = a.accountPublicKey) => core.observeAccountLivenessWithCreds({ servers: fx.servers, accountId, observerCreds, options: { settleMs: 50, maxWaitMs: 400, pageLimit: 2 } });
  const live = await observe();
  assert.ok(live.gotAnyReply && !live.truncated && live.sweepComplete, "cell 3b: account filter returns complete live plane sweep"); count++;
  for (const label of ["auth-mint", "auth-barrier", "auth-scan", "records-scan", "auth-reader", "auth-admin", "remote-manager-issuer"]) {
    assert.ok(live.conns.some((c) => c.label === `cotal:${label}:${a.space}` && Number.isSafeInteger(c.cid) && c.serverId.length > 0), `cell 3a: sweep lists ${label}`); count++;
  }
  assert.ok(live.conns.every((c) => c.label !== "foreign-live-b" && !c.label?.includes(b.space)), "cell 3a: sweep never lists another account"); count++;
  const denied = await observe(b.accountPublicKey);
  assert.ok(!denied.gotAnyReply && !denied.sweepComplete && denied.conns.length === 0, "cell 3a: scoped credentials never widen to another account"); count++;
  // Keep the original observer credential and all original observation controls unchanged.
  const capture: Capture = await (async (): Promise<Capture> => {
    try {
      // Handshake setup has its own existing 400ms ceiling. Each sweep separately keeps 400ms.
      observer = await connect({ servers: fx.servers, authenticator: credsAuthenticator(new TextEncoder().encode(observerCreds)), inboxPrefix: core.MEMBERSHIP_INBOX_PREFIX, maxReconnectAttempts: 0, timeout: MAX_WAIT_MS });
      if ((await handles[0].readiness()).state !== "ready" || (await handles[1].readiness()).state !== "ready" || !handles[0].endpointDeploymentTrust) refuse();
      const trust = await handles[0].endpointDeploymentTrust();
      if (trust.account.accountPublicKey !== a.accountPublicKey || trust.account.space !== a.space || trust.accountSigningKey !== a.auth.account.signingPub) refuse();
      const first = await sweep(observer, a.accountPublicKey), second = await sweep(observer, a.accountPublicKey);
      const manager = target(first, `cotal:remote-manager-issuer:${a.space}`, a.accountPublicKey, trust.accountSigningKey);
      const host = target(first, `cotal:endpoint-authority:${a.space}`, a.accountPublicKey, trust.accountSigningKey);
      const managerAgain = target(second, `cotal:remote-manager-issuer:${a.space}`, a.accountPublicKey, trust.accountSigningKey);
      const hostAgain = target(second, `cotal:endpoint-authority:${a.space}`, a.accountPublicKey, trust.accountSigningKey);
      if (!exact(inventory(first), inventory(second)) || manager.row.cid === host.row.cid || manager.claims.sub === host.claims.sub || !exact(projection(manager), projection(managerAgain)) || !exact(projection(host), projection(hostAgain))) refuse();
      if ((await handles[0].readiness()).state !== "ready" || (await handles[1].readiness()).state !== "ready") refuse();
      return { complete: true, manager: managerSubscriptions(manager.subjects, a.space, text(manager.claims.sub)), host: hostedCeiling(host.nats, a.space, text(host.claims.sub), a.accountPublicKey) && host.subjects.length === 1 && inboxSubject(host.subjects[0], text(host.claims.sub)) };
    } catch { return { complete: false }; }
    finally { await observer?.close().catch(() => refuse()); observer = undefined; }
  })();
  // Only admitted observations reach the two native semantic mutation targets.
  let reachedSemantic = false, separated = false;
  try { requireCapture({ complete: false }); reachedSemantic = true; }
  catch (error) { separated = error instanceof Error && error.message === "native account capture is complete and attributed"; }
  assert.ok(separated && !reachedSemantic, "private failed capture never reaches semantic observation predicates"); count++;
  requireCapture(capture); count++;
  assert.ok(capture.manager, "full-service manager installs exactly eight observer subscriptions"); count++;
  assert.ok(capture.host, "full-service hosted authority has its complete closed self-minted claim ceiling"); count++;
  // These validator controls are private data checks, not native mutation proof.
  assert.ok(rejectsPrivately(() => page({}, "private-control", "private-control", 0))
    && rejectsPrivately(() => page({ server: { name: "private-control", host: "private-control", id: "private-control", ver: "2.12.12", jetstream: true, flags: 1, seq: 1, time: "private-control" }, data: { server_id: "private-control", now: "private-control", num_connections: 0, total: 1, offset: 0, limit: PAGE_LIMIT, connections: [] } }, "private-control", "private-control", 0))
    && rejectsPrivately(() => target([], "private-control", "private-control", "private-control"))
    && rejectsPrivately(() => target([{ name: "private-control" }, { name: "private-control" }], "private-control", "private-control", "private-control"))
    && rejectsPrivately(() => object({ allow: [], extra: true }, ["allow"]))
    && rejectsPrivately(() => decode("private-malformed-control")), "private observation validators reject absent, duplicate and extra fields"); count++;
  await handles[0].close();
  await handles[0].closed;
  const gone = await observe();
  assert.ok(gone.gotAnyReply && !gone.truncated && gone.sweepComplete && gone.conns.length === 0, "cell 3a: closed account has no live plane connections"); count++;
  assert.equal((await handles[1].readiness()).state, "ready", "cell 3a: sibling account remains serving"); count++;
  console.log(`account liveness public: ${count} assertions passed`);
  emitSentinel({ passed: count, failed: 0 });
} finally {
  for (const h of handles) await h.close().catch(() => {});
  let observerCloseFailed = false;
  await observer?.close().catch(() => { observerCloseFailed = true; });
  await foreign?.close();
  await fx.close();
  if (observerCloseFailed) refuse();
}
