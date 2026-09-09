/**
 * Loopback session-renewal HTTP path: the production caller of
 * parseSessionEnrollment / issueSessionRenewal.
 *
 * A subscribe-only replica remint reissued revoked publish/scope. This suite
 * drives handleSessionRenewal: stored enrollment + live ledger grant, then a
 * signed session-agent JWT. Broker-free.
 *
 * PRODUCTION CALLER: implementations/auth/src/session-renewal.ts
 * handleSessionRenewal → renewSessionFromEnrollmentStore → getSessionEnrollment
 * (parseSessionEnrollment) + issueSessionRenewal.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromSeed } from "@nats-io/nkeys";
import {
  chatSubject,
  createSpaceAuth,
  mintSessionRemintCap,
  mintSessionRemintRequestNonce,
  newArtifactSigner,
  newIdentity,
  putSessionEnrollment,
  taskDurable,
  taskStream,
  type MeshEnrolledSessionEnrollment,
  type NativeOnlySessionEnrollment,
  type ResourceKey,
  type SignerAnchor,
} from "@cotal-ai/core";
import type { KV } from "@nats-io/kv";
import { grantActor, grantManagedActor, newActorToken, revokeActor } from "../src/ledger.js";
import { encodeRemintPossession, handleSessionRenewal, memoryRemintNonceBook, SESSION_RENEWAL_PATH } from "../src/session-renewal.js";

let ok = 0, fail = 0;
const c = (name: string, value: boolean, extra?: unknown) => {
  if (value) { ok++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};

type Row = { value: Uint8Array; revision: number; operation: "PUT" };
class MemKv {
  rows = new Map<string, Row>();
  seq = 0;
  async get(key: string) { return this.rows.get(key) as never; }
  async put(key: string, value: Uint8Array, opts?: { previousSeq?: number }) {
    const row = this.rows.get(key);
    if ((opts?.previousSeq ?? -1) !== 0 || row) throw Object.assign(new Error("cas"), { code: 10071 });
    const revision = ++this.seq;
    this.rows.set(key, { value, revision, operation: "PUT" });
    return revision;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("request body is not valid JSON")); }
    });
    req.on("error", reject);
  });
}

function decodeJwt(jwt: string): { name?: string; nats?: { pub?: { allow?: string[] } } } {
  const payload = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(payload, "base64").toString()) as { name?: string; nats?: { pub?: { allow?: string[] } } };
}

const dir = mkdtempSync(join(tmpdir(), "cotal-session-renewal-"));
const cap = "cap-session-renewal-smoke";
const space = "demo";
const owner = "u_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const actor = "native_session";
const lifecycleUid = "0123456789abcdefghijklmnop";
const identity = newIdentity();
const issuer = newArtifactSigner();
const issuerKeyId = "remint-1";
const remintAnchor: SignerAnchor = {
  keyId: issuerKeyId,
  publicKey: issuer.publicKey,
  owner: `${owner}.owner`,
  roles: ["sessions"],
  scope: { sessions: ["session-remint"] },
  validFrom: 0,
  validTo: Date.now() + 10_000_000_000,
};
const remintNonces = memoryRemintNonceBook();
const resource: ResourceKey = {
  hostIdentity: "host-key-sha256:abc",
  provider: "com.cotal.opencode",
  nativeOwnerNamespace: "uid:1000",
  stableSessionId: "native-session-17",
  resourceGeneration: "creation:2026-09-08T20:00:00Z",
};
const common = {
  resourceKey: resource,
  ownerPrincipal: `${owner}.owner`,
  provenance: {
    authorizedBy: `${owner}.owner`,
    nativeEvidence: { provider: "com.cotal.opencode", nativeOwner: "uid:1000" },
    authenticatedAt: Date.now() - 60_000,
  },
  incarnationProof: {
    nativeHostIncarnation: "native-host-start:41",
    sessionIncarnation: "session-process-start:92",
    evidence: { origin: "provider-inspection", immutableCreationId: "c-17" },
  },
  rights: ["adopt", "control", "release", "transfer"] as const,
  expiry: Date.now() + 3_600_000,
};
const meshEnrolled: MeshEnrolledSessionEnrollment = {
  ...common,
  kind: "mesh-enrolled",
  sessionActor: `${owner}.${actor}`,
  enrolledPublicId: identity.id,
  meshLifecycle: { id: `${owner}.${actor}`, lifecycleUid },
  ceiling: {
    owner,
    actor,
    lifecycleUid,
    scope: ["session:control", "spawn"],
    allowSubscribe: ["general", "review.>"],
    allowPublish: ["general", "ops"],
  },
};
const nativeOnly: NativeOnlySessionEnrollment = { ...common, kind: "native-only" };

const kv = new MemKv() as unknown as KV;
await putSessionEnrollment(kv, meshEnrolled);
grantActor(dir, {
  owner,
  actor,
  lifecycleUid,
  scope: ["session:control"],
  allowSubscribe: ["general"],
  allowPublish: ["general"],
});

const auth = await createSpaceAuth(space);
const remintCap = mintSessionRemintCap({
  space,
  resourceKey: resource,
  holder: { owner, actor, lifecycleUid },
  enrolledPublicId: identity.id,
  ttlMs: 60_000,
  issuerKeyId,
}, issuer);
const proof = () => {
  const requestNonce = mintSessionRemintRequestNonce();
  const possession = encodeRemintPossession(
    fromSeed(new TextEncoder().encode(identity.seed)).sign(new TextEncoder().encode(requestNonce)),
  );
  return { resourceKey: resource, remintCap, requestNonce, possession };
};
const ctx = {
  cap,
  dir,
  space,
  records: kv,
  account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
  resolveAnchor: (keyId: string) => keyId === issuerKeyId ? remintAnchor : undefined,
  nonceSeen: (nonce: string) => Promise.resolve(remintNonces.nonceSeen(nonce)),
  markNonce: (nonce: string) => Promise.resolve(remintNonces.markNonce(nonce)),
};
const http = createServer((req, res) => {
  void handleSessionRenewal(req, res, ctx, send, readJsonBody);
});
await new Promise<void>((resolve, reject) => {
  http.once("error", reject);
  http.listen(0, "127.0.0.1", () => resolve());
});
const addr = http.address();
const port = typeof addr === "object" && addr ? addr.port : 0;
const url = `http://127.0.0.1:${port}${SESSION_RENEWAL_PATH}`;

const post = async (body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
};

const taskRows = (role: string): string[] => {
  const TASK = taskStream(space);
  const svcD = taskDurable(role);
  return [
    `$JS.API.STREAM.INFO.${TASK}`,
    `$JS.API.CONSUMER.INFO.${TASK}.${svcD}`,
    `$JS.API.CONSUMER.MSG.NEXT.${TASK}.${svcD}`,
    `$JS.ACK.${TASK}.${svcD}.>`,
  ];
};

const serve = async (override: Partial<typeof ctx> = {}) => {
  const server = createServer((req, res) => {
    void handleSessionRenewal(req, res, { ...ctx, ...override }, send, readJsonBody);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const call = async (body: unknown = proof()) => {
    const res = await fetch(`http://127.0.0.1:${port}${SESSION_RENEWAL_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() as Record<string, unknown> };
  };
  return { server, call };
};

try {
  console.log("A. loopback route gates");
  {
    const get = await fetch(url);
    c("GET is refused", get.status === 405);
    const browser = await fetch(url, { method: "POST", headers: { origin: "https://evil.test", "content-type": "application/json" }, body: JSON.stringify(proof()) });
    c("browser Origin is refused", browser.status === 403);
    const operator = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cap}` }, body: JSON.stringify(proof()) });
    c("loopback operator bearer is refused as remint proof", operator.status === 401);
    const extra = await post({ ...proof(), profile: "agent" });
    c("unknown body fields are refused", extra.status === 400);
  }

  console.log("B. production remint intersects every issued dimension");
  const okRes = await post(proof());
  const jwt = typeof okRes.json.jwt === "string" ? okRes.json.jwt : "";
  const claims = jwt ? decodeJwt(jwt) : {};
  const pub = claims.nats?.pub?.allow ?? [];
  const opsPub = chatSubject(space, owner, actor, "ops");
  const generalPub = chatSubject(space, owner, actor, "general");
  const authority = okRes.json.authority as { scope?: string[]; allowPublish?: string[]; allowSubscribe?: string[] } | undefined;
  c("PRODUCTION CALLER handleSessionRenewal returns a session-agent JWT",
    okRes.status === 200 && claims.name === "session-agent", { status: okRes.status, name: claims.name });
  c("revoked allowPublish does not survive the HTTP remint",
    pub.includes(generalPub) && !pub.includes(opsPub), { pub });
  c("revoked spawn does not survive the HTTP remint",
    authority?.scope?.join(",") === "session:control" && !authority.scope.includes("spawn"),
    authority?.scope);
  c("intersected authority drops spawn and ops",
    authority?.scope?.join(",") === "session:control"
    && authority.allowPublish?.join(",") === "general"
    && authority.allowSubscribe?.join(",") === "general"
    && !authority.scope?.includes("spawn")
    && !authority.allowPublish?.includes("ops"),
    authority);

  console.log("C. native-only and missing grant refuse");
  const nativeKv = new MemKv() as unknown as KV;
  await putSessionEnrollment(nativeKv, nativeOnly);
  const nativeHttp = createServer((req, res) => {
    void handleSessionRenewal(req, res, { ...ctx, records: nativeKv }, send, readJsonBody);
  });
  await new Promise<void>((resolve, reject) => {
    nativeHttp.once("error", reject);
    nativeHttp.listen(0, "127.0.0.1", () => resolve());
  });
  const nativeAddr = nativeHttp.address();
  const nativePort = typeof nativeAddr === "object" && nativeAddr ? nativeAddr.port : 0;
  const nativeUrl = `http://127.0.0.1:${nativePort}${SESSION_RENEWAL_PATH}`;
  const nativeRes = await fetch(nativeUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(proof()),
  });
  const nativeJson = await nativeRes.json() as { error?: string };
  c("native-only enrollment cannot renew over HTTP",
    nativeRes.status === 409 && typeof nativeJson.error === "string" && nativeJson.error.includes("native-only"),
    nativeJson);
  nativeHttp.close();

  console.log("D. expired enrollment and parent-chain refuse over HTTP");
  const expiredKv = new MemKv() as unknown as KV;
  await putSessionEnrollment(expiredKv, { ...meshEnrolled, expiry: Date.now() - 1 });
  const expiredHttp = createServer((req, res) => {
    void handleSessionRenewal(req, res, { ...ctx, records: expiredKv }, send, readJsonBody);
  });
  await new Promise<void>((resolve, reject) => {
    expiredHttp.once("error", reject);
    expiredHttp.listen(0, "127.0.0.1", () => resolve());
  });
  const expiredAddr = expiredHttp.address();
  const expiredPort = typeof expiredAddr === "object" && expiredAddr ? expiredAddr.port : 0;
  const expiredRes = await fetch(`http://127.0.0.1:${expiredPort}${SESSION_RENEWAL_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(proof()),
  });
  const expiredJson = await expiredRes.json() as { error?: string };
  c("expired enrollment cannot renew over HTTP",
    expiredRes.status === 409 && typeof expiredJson.error === "string" && expiredJson.error.includes("expired"),
    expiredJson);
  expiredHttp.close();

  const parentDir = mkdtempSync(join(tmpdir(), "cotal-session-renewal-parent-"));
  grantActor(parentDir, {
    owner,
    actor: "cli",
    lifecycleUid: "0123456789abcdefghijklmnoq",
    scope: ["spawn", "session:control"],
    allowSubscribe: ["general"],
    allowPublish: ["general"],
  });
  grantManagedActor(parentDir, {
    owner,
    actor,
    lifecycleUid,
    scope: ["session:control"],
    allowSubscribe: ["general"],
    allowPublish: ["general"],
    parent: `${owner}.cli`,
    tokenHash: newActorToken().tokenHash,
  });
  revokeActor(parentDir, owner, "cli");
  const parentHttp = createServer((req, res) => {
    void handleSessionRenewal(req, res, { ...ctx, dir: parentDir }, send, readJsonBody);
  });
  await new Promise<void>((resolve, reject) => {
    parentHttp.once("error", reject);
    parentHttp.listen(0, "127.0.0.1", () => resolve());
  });
  const parentAddr = parentHttp.address();
  const parentPort = typeof parentAddr === "object" && parentAddr ? parentAddr.port : 0;
  const parentRes = await fetch(`http://127.0.0.1:${parentPort}${SESSION_RENEWAL_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(proof()),
  });
  const parentJson = await parentRes.json() as { error?: string };
  c("revoked parent chain cannot renew over HTTP",
    parentRes.status === 403 && typeof parentJson.error === "string" && parentJson.error.includes("no longer granted"),
    parentJson);
  parentHttp.close();
  rmSync(parentDir, { recursive: true, force: true });

  const narrowKv = new MemKv() as unknown as KV;
  await putSessionEnrollment(narrowKv, {
    ...meshEnrolled,
    ceiling: { ...meshEnrolled.ceiling, allowSubscribe: ["review.pua"], allowPublish: ["general"] },
  });
  const narrowDir = mkdtempSync(join(tmpdir(), "cotal-session-renewal-narrow-"));
  grantActor(narrowDir, {
    owner,
    actor,
    lifecycleUid,
    scope: ["session:control"],
    allowSubscribe: ["review.>"],
    allowPublish: ["general"],
  });
  const narrowHttp = createServer((req, res) => {
    void handleSessionRenewal(req, res, { ...ctx, dir: narrowDir, records: narrowKv }, send, readJsonBody);
  });
  await new Promise<void>((resolve, reject) => {
    narrowHttp.once("error", reject);
    narrowHttp.listen(0, "127.0.0.1", () => resolve());
  });
  const narrowAddr = narrowHttp.address();
  const narrowPort = typeof narrowAddr === "object" && narrowAddr ? narrowAddr.port : 0;
  const narrowRes = await fetch(`http://127.0.0.1:${narrowPort}${SESSION_RENEWAL_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(proof()),
  });
  const narrowJson = await narrowRes.json() as { authority?: { allowSubscribe?: string[] } };
  c("HTTP remint keeps a narrower ceiling under a broader live grant",
    narrowRes.status === 200
    && narrowJson.authority?.allowSubscribe?.join(",") === "review.pua"
    && !narrowJson.authority?.allowSubscribe?.includes("review.>"),
    narrowJson.authority);
  narrowHttp.close();
  rmSync(narrowDir, { recursive: true, force: true });

  console.log("E. PRODUCTION CALLER handleSessionRenewal handles role and parent explicitly");
  const enroll = async (role?: string) => {
    const records = new MemKv() as unknown as KV;
    await putSessionEnrollment(records, {
      ...meshEnrolled,
      ceiling: role ? { ...meshEnrolled.ceiling, role } : meshEnrolled.ceiling,
    });
    return records;
  };
  {
    // R ∩ R through handleSessionRenewal: enrolled reviewer + live reviewer keeps TASK grants.
    const roleDir = mkdtempSync(join(tmpdir(), "cotal-session-renewal-role-"));
    grantActor(roleDir, {
      owner, actor, lifecycleUid,
      scope: ["session:control"], allowSubscribe: ["general"], allowPublish: ["general"],
      role: "reviewer",
    });
    const { server, call } = await serve({ dir: roleDir, records: await enroll("reviewer") });
    const res = await call();
    const jwt = typeof res.json.jwt === "string" ? res.json.jwt : "";
    const pub = jwt ? (decodeJwt(jwt).nats?.pub?.allow ?? []) : [];
    const want = taskRows("reviewer");
    c("PRODUCTION CALLER handleSessionRenewal: unchanged-role R∩R keeps reviewer TASK grants",
      res.status === 200 && want.every((row) => pub.includes(row)),
      { status: res.status, missing: want.filter((row) => !pub.includes(row)) });
    server.close();
    rmSync(roleDir, { recursive: true, force: true });
  }
  {
    // R ∩ S through handleSessionRenewal. Roles are non-hierarchical (own svc_<role> durables),
    // so there is no meet: refuse, never mint implementer's TASK rows.
    const changeDir = mkdtempSync(join(tmpdir(), "cotal-session-renewal-role-change-"));
    grantActor(changeDir, {
      owner, actor, lifecycleUid,
      scope: ["session:control"], allowSubscribe: ["general"], allowPublish: ["general"],
      role: "implementer",
    });
    const { server, call } = await serve({ dir: changeDir, records: await enroll("reviewer") });
    const res = await call();
    const err = typeof res.json.error === "string" ? res.json.error : "";
    c("PRODUCTION CALLER handleSessionRenewal: R→S refuses and never grants implementer TASK rows",
      res.status === 403 && err.includes("re-enroll") && !("jwt" in res.json),
      { status: res.status, error: err, keys: Object.keys(res.json) });
    server.close();
    rmSync(changeDir, { recursive: true, force: true });
  }
  {
    const noneDir = mkdtempSync(join(tmpdir(), "cotal-session-renewal-role-none-"));
    grantActor(noneDir, {
      owner, actor, lifecycleUid,
      scope: ["session:control"], allowSubscribe: ["general"], allowPublish: ["general"],
    });
    const { server, call } = await serve({ dir: noneDir, records: await enroll() });
    const res = await call();
    const jwt = typeof res.json.jwt === "string" ? res.json.jwt : "";
    const pub = jwt ? (decodeJwt(jwt).nats?.pub?.allow ?? []) : [];
    const TASK = taskStream(space);
    c("PRODUCTION CALLER handleSessionRenewal: role-less enrollment renews role-less and is not an error",
      res.status === 200
      && !pub.some((row) => row.includes(`STREAM.INFO.${TASK}`) || row.includes(`.${TASK}.`)),
      { status: res.status, taskish: pub.filter((row) => row.includes("TASK_")) });
    server.close();
    rmSync(noneDir, { recursive: true, force: true });
  }
  {
    // none ∩ live R: a later ledger role cannot be acquired from a role-less enrollment.
    const acquireDir = mkdtempSync(join(tmpdir(), "cotal-session-renewal-role-acquire-"));
    grantActor(acquireDir, {
      owner, actor, lifecycleUid,
      scope: ["session:control"], allowSubscribe: ["general"], allowPublish: ["general"],
      role: "reviewer",
    });
    const { server, call } = await serve({ dir: acquireDir, records: await enroll() });
    const res = await call();
    const err = typeof res.json.error === "string" ? res.json.error : "";
    c("PRODUCTION CALLER handleSessionRenewal: role-less enrollment cannot acquire a later live role",
      res.status === 403 && err.includes("cannot acquire") && !("jwt" in res.json),
      { status: res.status, error: err });
    server.close();
    rmSync(acquireDir, { recursive: true, force: true });
  }
  {
    // R ∩ none: revocation lands as role-less attenuation.
    const revokeDir = mkdtempSync(join(tmpdir(), "cotal-session-renewal-role-revoke-"));
    grantActor(revokeDir, {
      owner, actor, lifecycleUid,
      scope: ["session:control"], allowSubscribe: ["general"], allowPublish: ["general"],
    });
    const { server, call } = await serve({ dir: revokeDir, records: await enroll("reviewer") });
    const res = await call();
    const jwt = typeof res.json.jwt === "string" ? res.json.jwt : "";
    const pub = jwt ? (decodeJwt(jwt).nats?.pub?.allow ?? []) : [];
    const TASK = taskStream(space);
    c("PRODUCTION CALLER handleSessionRenewal: role revocation remints role-less (no TASK grants)",
      res.status === 200
      && !pub.some((row) => row.includes(`STREAM.INFO.${TASK}`) || row.includes(`.${TASK}.`)),
      { status: res.status, taskish: pub.filter((row) => row.includes("TASK_")) });
    server.close();
    rmSync(revokeDir, { recursive: true, force: true });
  }
  {
    // Live-chain only: these cells bind assertWithinSpawnerGrant, not an enrolled parent.
    const parentDir = mkdtempSync(join(tmpdir(), "cotal-session-renewal-reparent-"));
    grantActor(parentDir, {
      owner, actor: "cli", lifecycleUid: "0123456789abcdefghijklmnoq",
      scope: ["spawn", "session:control", "role:reviewer"],
      allowSubscribe: ["general"], allowPublish: ["general"],
    });
    grantManagedActor(parentDir, {
      owner, actor, lifecycleUid,
      scope: ["session:control"], allowSubscribe: ["general"], allowPublish: ["general"],
      role: "reviewer", parent: `${owner}.cli`, tokenHash: newActorToken().tokenHash,
    });
    const { server: okServer, call: okCall } = await serve({ dir: parentDir, records: await enroll("reviewer") });
    const okRes = await okCall();
    const okJwt = typeof okRes.json.jwt === "string" ? okRes.json.jwt : "";
    const okPub = okJwt ? (decodeJwt(okJwt).nats?.pub?.allow ?? []) : [];
    c("PRODUCTION CALLER handleSessionRenewal: live parent chain holding still remints reviewer TASK grants",
      okRes.status === 200 && taskRows("reviewer").every((row) => okPub.includes(row)),
      { status: okRes.status, missing: taskRows("reviewer").filter((row) => !okPub.includes(row)) });
    okServer.close();
    rmSync(parentDir, { recursive: true, force: true });
  }
  {
    const first = await post(proof());
    const second = await post(proof());
    const used = proof();
    const firstUse = await post(used);
    c("PRODUCTION CALLER handleSessionRenewal remints twice with one remint cap",
      first.status === 200 && second.status === 200
      && typeof first.json.jwt === "string" && typeof second.json.jwt === "string",
      { first: first.status, second: second.status });
    const replayAgain = await post(used);
    c("PRODUCTION CALLER handleSessionRenewal refuses a replayed request nonce",
      replayAgain.status === 403 && typeof replayAgain.json.error === "string" && String(replayAgain.json.error).includes("already been used"),
      replayAgain.json);
    c("first request of a later-replayed nonce still reminted", firstUse.status === 200);
  }
} finally {
  http.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
