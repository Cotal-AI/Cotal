/**
 * Callout request-authentication unit smoke (broker-free) — pins the fail-closed "drop with NO
 * response" paths in `startAuthCallout` that the live E2E can't exercise directly, plus the
 * request-provenance forgery guard (plan §"Plane 2"; panel finding on 8dd59ed).
 *
 * Drives the handler with a fake connection + hand-built sealed requests and asserts respond() is
 * NEVER called for: missing seal header, undecryptable payload, signed server_id.xkey != sealing
 * key (anti-reseal), issuer != server_id.id (in-account forgery), non-server issuer. A well-formed
 * request DOES reach a response (control). Also asserts xkey-mandatory startup.
 * Run: pnpm smoke:callout-shape
 */
import { Algorithms, decode, encode } from "@nats-io/jwt";
import { SignJWT, generateKeyPair } from "jose";
import { createAccount, createCurve, createServer, createUser } from "@nats-io/nkeys";
import { AUTH_CALLOUT_SUBJECT, createCalloutAuth, startAuthCallout, USER_TOKEN_VER, type StartAuthCalloutOpts } from "../src/index.js";
import { createSpaceAuth } from "@cotal-ai/core";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`); }
};
const enc = (s: string) => new TextEncoder().encode(s);

const auth = await createSpaceAuth("shape");
const callout = await createCalloutAuth({ space: "shape", operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
const calloutXkeyPub = callout.xkey.pub;

// A well-formed server: its signing key + curve key. `serverId`/`serverXkey` are what a real
// nats-server would present.
const serverKp = createServer();
const serverId = serverKp.getPublicKey();
const serverCurve = createCurve();
const serverXkey = serverCurve.getPublicKey();

/** Build a sealed callout request. Overrides let each case bend exactly one property. */
async function sealedRequest(opts: { signer?: ReturnType<typeof createServer>; serverIdInClaim?: string; xkeyInClaim?: string; sealWith?: string; token?: string; brokerExp?: number | false } = {}) {
  const userNkey = createUser().getPublicKey();
  const claim = {
    aud: calloutXkeyPub,
    sub: "nats_user_auth_request",
    ...(opts.brokerExp === false ? {} : { exp: opts.brokerExp ?? Math.floor(Date.now() / 1000) + 30 }),
    nats: {
      user_nkey: userNkey,
      server_id: { name: "n", host: "127.0.0.1", id: opts.serverIdInClaim ?? serverId, xkey: opts.xkeyInClaim ?? serverXkey },
      connect_opts: { auth_token: opts.token ?? "irrelevant.for.shape", name: userNkey },
      client_info: { id: 1 },
      type: "authorization_request",
      version: 2,
    },
  } as never;
  const jwt = await encode(Algorithms.v2, claim, opts.signer ?? serverKp);
  return serverCurve.seal(enc(jwt), opts.sealWith ?? calloutXkeyPub);
}

interface FakeMsg {
  data: Uint8Array;
  headers?: { get(k: string): string | undefined };
  responded: boolean;
  respond(d: Uint8Array): void;
}
function msg(data: Uint8Array, xkeyHeader?: string): FakeMsg {
  return {
    data,
    headers: xkeyHeader === undefined ? undefined : { get: (k) => (k === "Nats-Server-Xkey" ? xkeyHeader : undefined) },
    responded: false,
    respond(_d: Uint8Array) { this.responded = true; },
  };
}

async function run(cases: FakeMsg[]) {
  const conn = {
    // eslint-disable-next-line require-yield
    async *subscribe() {
      for (const m of cases) yield m;
    },
  };
  await startAuthCallout(conn as never, {
    xkeySeed: callout.xkey.seed,
    authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
    dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    space: "shape",
    token: { key: {} as never, issuer: "https://auth.test" },
    recordIssuance: async () => {},
    authorizeActor: () => {},
    permissionsFor: () => ({}),
    log: () => {},
  }).done;
}

// ---- startup: xkey mandatory ----
let threw = false;
try {
  startAuthCallout({ subscribe: async function* () {} } as never, {
    xkeySeed: "",
    authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
    dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    space: "shape",
    token: { key: {} as never, issuer: "i" },
    recordIssuance: async () => {},
    authorizeActor: () => {},
    permissionsFor: () => ({}),
  });
} catch { threw = true; }
check("startup refuses an empty xkey seed", threw);

// ---- the NO-RESPONSE shape violations ----
const noHeader = msg(await sealedRequest(), undefined);
const undecryptable = msg(enc("not a sealed payload"), serverXkey);
const xkeyMismatch = msg(await sealedRequest({ xkeyInClaim: createCurve().getPublicKey() }), serverXkey);
const forgedIssuer = msg(await sealedRequest({ signer: createServer(), serverIdInClaim: serverId }), serverXkey); // signed by a DIFFERENT server key, claims the real server id
const noBrokerExpiry = msg(await sealedRequest({ brokerExp: false }), serverXkey);
const nonServerIssuer = (async () => {
  const acct = createAccount();
  // issuer === server_id.id but it's an A-key, not an N-server key
  return msg(await sealedRequest({ signer: acct as never, serverIdInClaim: acct.getPublicKey() }), serverXkey);
})();

const cases = [noHeader, undecryptable, xkeyMismatch, forgedIssuer, noBrokerExpiry, await nonServerIssuer];
await run(cases);
check("missing seal header → no response", !noHeader.responded);
check("undecryptable payload → no response", !undecryptable.responded);
check("signed server_id.xkey != sealing key → no response (anti-reseal)", !xkeyMismatch.responded);
check("issuer != server_id.id → no response (in-account forgery guard)", !forgedIssuer.responded);
check("missing broker expiry → no response", !noBrokerExpiry.responded);
check("non-server (N…) issuer → no response", !(await nonServerIssuer).responded);

// ---- control: a well-formed request DOES get a response (a signed deny, since the bearer is junk) ----
const wellFormed = msg(await sealedRequest(), serverXkey);
await run([wellFormed]);
check("well-formed request reaches a response (control — proves the drops are the guards, not a dead handler)", wellFormed.responded);

// Bound asynchronous hooks and drain already admitted work when the subscription ends.
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const owner = `u_${"a".repeat(26)}`;
const now = Math.floor(Date.now() / 1000);
const token = await new SignJWT({ scope: [], ver: USER_TOKEN_VER, act: { owner, actor: "bounded" } })
  .setProtectedHeader({ alg: "EdDSA" }).setSubject(owner).setAudience("shape").setIssuer("https://auth.test")
  .setIssuedAt(now).setNotBefore(now).setExpirationTime(now + 300).sign(privateKey);
const options: StartAuthCalloutOpts = {
  xkeySeed: callout.xkey.seed,
  authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
  dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
  space: "shape", token: { key: publicKey, issuer: "https://auth.test" },
  expectedServerIds: [serverId], recordIssuance: async () => {}, authorizeActor: () => {},
  permissionsFor: () => ({ pub: { deny: [">"] }, sub: { deny: [">"] } }), log: () => {},
};
// A valid signed request the broker has already stopped waiting for is answered without entering
// bearer or ledger work. The response signing is asynchronous, so wait for it after the input ends.
const expiredDeadline = msg(await sealedRequest({ token, brokerExp: Math.floor(Date.now() / 1000) - 1 }), serverXkey);
let expiredAuthorized = false;
const expiredLog: string[] = [];
await startAuthCallout({ async *subscribe() { yield expiredDeadline; } }, {
  ...options, authorizeActor: () => { expiredAuthorized = true; }, log: (line) => expiredLog.push(line),
}).done;
check("an already-expired broker request is shed before bearer verification",
  !expiredDeadline.responded && !expiredAuthorized && expiredLog.some((line) => /^auth callout: level=warn outcome=shed /.test(line)));
const boundedMessages = await Promise.all(Array.from({ length: 12 }, async () => msg(await sealedRequest({ token }), serverXkey)));
const firstRelease = deferred(), tailRelease = deferred(), atCapacity = deferred(), atTail = deferred();
let active = 0, peak = 0, entered = 0, yielded = 0, settled = false;
const bounded = startAuthCallout({ async *subscribe() {
  for (const message of boundedMessages) { yielded++; yield message; }
} }, {
  ...options,
  connectLimiter: { take() {}, limits: { actorPerMinute: 1_000_000, ownerPerMinute: 1_000_000, hostPerMinute: 1_000_000 } } as never,
  limits: { maxInFlight: 4 },
  async authorizeActor() {
    const index = ++entered;
    active++;
    peak = Math.max(peak, active);
    if (index === 4) atCapacity.resolve();
    if (index === 8) atTail.resolve();
    try { await (index <= 4 ? firstRelease.promise : tailRelease.promise); }
    finally { active--; }
  },
});
void bounded.done.then(() => { settled = true; }, () => { settled = true; });
try {
  await Promise.race([atCapacity.promise, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("callout capacity was not reached")), 5000))]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  check("at most 4 authorization hooks run together while every request is read on arrival", entered === 4 && peak === 4 && yielded === 12);
  firstRelease.resolve();
  await Promise.race([atTail.promise, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("callout tail was not reached")), 5000))]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  check("done waits for the bounded admitted queue after the input iterator ends", !settled && entered === 8 && active === 4);
  tailRelease.resolve();
} finally {
  firstRelease.resolve();
  tailRelease.resolve();
}
await bounded.done;
check("the waiting queue is capped at one wave and excess burst requests are shed", boundedMessages.filter((message) => message.responded).length === 8 && peak === 4 && active === 0);

// A worker can fail after the input iterator ended; that failure still rejects done.
const failureRelease = deferred(), failureEntered = deferred();
const failure = new Error("fixture logger failed");
const failed = startAuthCallout({ async *subscribe() { yield msg(await sealedRequest({ token }), serverXkey); } }, {
  ...options,
  async authorizeActor() {
    failureEntered.resolve();
    await failureRelease.promise;
    throw new Error("fixture authorizer refused");
  },
  log() { throw failure; },
});
const failureResult = failed.done.then(() => undefined, (error: unknown) => error);
await failureEntered.promise;
await new Promise<void>((resolve) => setImmediate(resolve));
failureRelease.resolve();
check("a worker failure during the final drain is not reported as success", await failureResult === failure);

// ---- limits ----
const badLimits = [{ authTimeoutMs: 499 }, { authTimeoutMs: 1500.5 }, { maxInFlight: 0 }, { slowMs: 0 }];
check("startup refuses out-of-range callout limits", badLimits.every((limits) => {
  try { startAuthCallout({ subscribe: async function* () {} }, { ...options, limits }); return false; } catch { return true; }
}));

// ---- deadlines: a signed timeout denial at the deadline, and at once when admission sheds ----
interface Tracked {
  data: Uint8Array;
  headers: { get(k: string): string | undefined };
  answers: number;
  sentAt?: number;
  answeredAt?: number;
  reply?: Uint8Array;
  respond(d: Uint8Array): void;
}
const tracked = async (actor: string, brokerExp = Math.floor(Date.now() / 1000) + 3): Promise<Tracked> => {
  const t = Math.floor(Date.now() / 1000);
  const bearer = await new SignJWT({ scope: [], ver: USER_TOKEN_VER, act: { owner, actor } })
    .setProtectedHeader({ alg: "EdDSA" }).setSubject(owner).setAudience("shape").setIssuer("https://auth.test")
    .setIssuedAt(t).setNotBefore(t).setExpirationTime(t + 300).sign(privateKey);
  const m: Tracked = {
    data: await sealedRequest({ token: bearer, brokerExp }),
    headers: { get: (k) => (k === "Nats-Server-Xkey" ? serverXkey : undefined) },
    answers: 0,
    respond(d) { m.answers++; m.answeredAt ??= performance.now(); m.reply ??= d; },
  };
  return m;
};
const replyOf = (m: Tracked) => {
  const opened = m.reply && serverCurve.open(m.reply, calloutXkeyPub);
  return opened ? (decode(new TextDecoder().decode(opened)) as { nats: { jwt?: string; error?: string } }).nats : undefined;
};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const deadlineLog: string[] = [];
const heldRelease = deferred(), heldEntered = deferred();
let heldRecorded = false, heldMinted = false;
while (Date.now() % 1000 > 50) await sleep(5);
const brokerExp = Math.floor(Date.now() / 1000) + 2;
const brokerDeadlineAt = brokerExp * 1000 - 250;
const warm = await tracked("warm", brokerExp), held = await tracked("held", brokerExp);
const queued = await tracked("queued", brokerExp), queuedNext = await tracked("queued_next", brokerExp), shed = await tracked("shed", brokerExp);
// One request at a time with a 1750 ms full budget. The broker expiry's whole-second precision
// leaves about 1700 ms in this aligned fixture. While held keeps the slot, two requests queue; one
// arriving after the oldest has less than half the full budget left is shed.
const deadlines = startAuthCallout({ async *subscribe() {
  yield warm;
  while (!warm.answers) await sleep(5);
  yield held;
  await heldEntered.promise;
  queued.sentAt = performance.now();
  yield queued;
  queuedNext.sentAt = performance.now();
  yield queuedNext;
  while (Date.now() < brokerDeadlineAt - 800) await sleep(5);
  shed.sentAt = performance.now();
  yield shed;
} }, {
  ...options,
  limits: { authTimeoutMs: 2000, maxInFlight: 1 },
  async authorizeActor(t) {
    if (t.act.actor === "held") { heldEntered.resolve(); await heldRelease.promise; }
  },
  recordIssuance: async ({ token }) => { if (token.act.actor === "held") heldRecorded = true; },
  onMint: (info) => { if (info.principal.endsWith(".held")) heldMinted = true; },
  log: (line) => deadlineLog.push(line),
});
try {
  for (let i = 0; i < 500 && !(held.answers && queued.answers && queuedNext.answers && shed.answers); i++) await sleep(10);
} finally { heldRelease.resolve(); }
await deadlines.done;
const lineOf = (actor: string) => deadlineLog.filter((line) => line.includes(`actor=${actor} `));
check("requests still waiting for a slot at their deadline are abandoned without a response",
  queued.answers === 0 && queuedNext.answers === 0 &&
  deadlineLog.filter((line) =>
    (/^auth callout: level=warn outcome=timeout /.test(line) && line.endsWith(" at=queue")) ||
    /^auth callout: level=warn outcome=shed /.test(line)).length >= 2);
check("a request whose ledger hook outlives the deadline is abandoned and its work stops there",
  held.answers === 0 && !heldRecorded && !heldMinted &&
  lineOf("held").length === 1 && /^auth callout: level=warn outcome=timeout .* at=ledger$/.test(lineOf("held")[0]));
check("each answered request writes one callout line",
  replyOf(warm)?.jwt !== undefined && lineOf("warm").length === 1 &&
  deadlineLog.filter((line) => line.startsWith("auth callout: level=")).length === 5);

console.log(`\ncallout-shape smoke: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
