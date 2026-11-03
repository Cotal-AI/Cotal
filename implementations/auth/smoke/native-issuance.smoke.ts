/**
 * Native-key issuance evidence live smoke (SPEC 13.1 `natkey.`): the authority plane and the
 * callout composed as the daemon composes them, on an owned broker.
 *
 *  - every successful connect leaves exactly one create-only row keyed by the minted JWT's
 *    subject (the broker's `req.user_nkey`), bound to the bearer's own space/owner/actor/uid/
 *    credential/view and the minted iat/exp, readable as soon as the connect resolves;
 *  - reconnects and siblings get disjoint rows; claimless, foreign-space and revoked bearers
 *    get none; non-callout connections get none;
 *  - a held record keeps the JWT in the process; a revoke landing while the plane's real record
 *    write is held is caught by the post-write re-read (deny; the row stays as evidence only);
 *  - a refused write and a pre-existing row under a foreign uid both take the signed deny;
 *  - a callout without a recorder refuses to start.
 *
 * The `hook` around plane.recordIssuance is instrumentation: it delays, refuses or pre-seeds
 * around the shipped recorder, which still performs every write and re-read.
 *
 * Run: pnpm exec tsx smoke/native-issuance.smoke.ts   (needs nats-server on PATH; local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, type NatsConnection, type ConnectionOptions } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm, type KV } from "@nats-io/kv";
import { decode } from "@nats-io/jwt";
import { createUser } from "@nats-io/nkeys";
import { createEndpointStreams, createSpaceAuth, epAuthBucket, isReachable, serverConfig, standaloneConnectOpts, mintLifecycleUid } from "@cotal-ai/core";
import {
  calloutPermissions, createCalloutAuth, createUserTokenIssuer, deriveOwnerToken, generateSigningKey,
  grantManagedActor, ledgerAclResolver, newActorToken, openAuthAuthorityPlane, startAuthCallout,
} from "../src/index.js";
import { credRowKey, markLedgerRowRevoked } from "../src/credential-ledger.js";
import { openLifecycleRegistry, registryStores } from "../src/lifecycle-registry.js";
import { authorityWriterGrants, openAuthorityClient } from "../src/authority-client.js";
import { readNativeIssuance, type NativeIssuance, type NativeIssuanceRecord } from "../src/native-issuance.js";
import { validateUserToken } from "../src/token.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const enc = (s: string) => new TextEncoder().encode(s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };

const space = `natkey-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const callout = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
const tmp = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const dir = join(tmp, "state");
writeFileSync(join(tmp, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(tmp, "js"), extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }] }));
const srv = spawn("nats-server", ["-c", join(tmp, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, tmp);

const ISS = "https://auth.cotal.test";
const OWNER = deriveOwnerToken("s".repeat(32), "better-auth|human-1");
const dataAccount = { pub: auth.account.pub, signingSeed: auth.account.signingSeed };
const quiet = () => {};

/** Connect through the callout; `minted` collects the JWTs the callout released. */
const minted: string[] = [];
async function tryConnect(bearer: string): Promise<"connected" | "denied"> {
  try {
    const nc = await connect({ servers: SERVERS, reconnect: false, ...(standaloneConnectOpts({ bearer, sentinelCreds: callout.sentinelCreds, tls: false }) as Partial<ConnectionOptions>) });
    await nc.close();
    return "connected";
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if (/authorization|authentication/i.test(msg)) return "denied";
    throw e;
  }
}
async function natkeys(kv: KV): Promise<string[]> {
  const out: string[] = [];
  for await (const k of await kv.keys("natkey.>")) out.push(k.slice("natkey.".length));
  return out.sort();
}

let plane: Awaited<ReturnType<typeof openAuthAuthorityPlane>> | undefined;
let calloutNc: NatsConnection | undefined;
let setup: Awaited<ReturnType<typeof openAuthorityClient>> | undefined;
let writer: Awaited<ReturnType<typeof openAuthorityClient>> | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
  setup = await openAuthorityClient({ server: SERVERS, space, dataAccount, label: `cotal:smoke-streams:${space}`, grants: (id) => (void id, { publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: quiet });
  await createEndpointStreams(await jetstreamManager(setup.nc), new Kvm(setup.nc), space);
  plane = await openAuthAuthorityPlane({ server: SERVERS, space, dir, identityRoot: dir, dataAccount, log: quiet });
  const kv = await new Kvm(setup.nc).open(epAuthBucket(space)); // instrumentation: full-grant test reader

  const grant = async (actor: string, scope: string[] = ["spawn"]) => {
    const uid = mintLifecycleUid();
    grantManagedActor(dir, { custody: { kind: "foreground" }, owner: OWNER, actor, scope, allowSubscribe: ["general"], allowPublish: ["general"], tokenHash: newActorToken().tokenHash, lifecycleUid: uid });
    return { uid, credid: await plane!.mintConnectCredential({ owner: OWNER, actor, lifecycleUid: uid }) };
  };
  const key = await generateSigningKey();
  const issuer = createUserTokenIssuer({ issuer: ISS, key });
  const base = {
    xkeySeed: callout.xkey.seed,
    authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
    dataAccount, space, token: { key: issuer.localKeySet(), issuer: ISS },
    authorizeActor: plane.authorizeConnect,
    permissionsFor: calloutPermissions(ledgerAclResolver(dir)),
    log: quiet,
  };
  let threw = "";
  try { startAuthCallout({ subscribe: () => { throw new Error("subscribed"); } } as never, base as never); } catch (e) { threw = (e as Error).message; }
  check("STARTUP: a callout without a recorder refuses to start", threw.includes("recordIssuance is required"), threw);

  let hook: ((i: NativeIssuance) => Promise<void>) | undefined;
  calloutNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(callout.calloutCreds)) });
  startAuthCallout(calloutNc as never, {
    ...base,
    recordIssuance: (i) => (hook ? hook(i) : plane!.recordIssuance(i)),
    onMint: ({ jwt }) => { minted.push(jwt); },
  });
  await calloutNc.flush();

  // ---- P1: one bound row per success, keyed by the minted JWT subject, before connect resolves ----
  const w = await grant("worker");
  const bearerW = await issuer.issue({ owner: OWNER, space, actor: "worker", scope: ["spawn"], lifecycleUid: w.uid, credentialId: w.credid });
  check("P1 a bearer with its stamped credential CONNECTS", (await tryConnect(bearerW)) === "connected");
  const keys1 = await natkeys(kv);
  const jwt1 = decode(minted[0]!);
  check("P1 exactly one natkey row exists once the connect resolved", keys1.length === 1, keys1.length);
  check("P1 the row key is the minted JWT's subject (the broker user key)", keys1[0] === jwt1.sub, { key: keys1[0]?.slice(0, 6), sub: String(jwt1.sub).slice(0, 6) });
  const r1 = keys1[0] ? await readNativeIssuance(kv, keys1[0]) : undefined;
  check("P1 the row binds the bearer's space/owner/actor/uid/credential/view",
    r1?.space === space && r1.owner === OWNER && r1.actor === "worker" && r1.lifecycleUid === w.uid && r1.credentialId === w.credid && r1.view === "agent", r1 && { ...r1, connId: "-" });
  check("P1 the row carries the minted JWT's own iat and exp", r1?.iat === jwt1.iat && r1?.exp === (jwt1 as { exp?: number }).exp, { iat: r1?.iat, exp: r1?.exp });
  check("P1 the nonce is an attribute only (non-empty, not the key)", typeof r1?.connId === "string" && r1.connId.length > 0 && r1.connId !== keys1[0]);

  // ---- P2: an elevated view records its view ----
  const a = await grant("boss", ["spawn", "admin"]);
  const bearerA = await issuer.issue({ owner: OWNER, space, actor: "boss", scope: ["admin"], view: "admin", lifecycleUid: a.uid, credentialId: a.credid });
  const aRes = await tryConnect(bearerA);
  const rA = aRes === "connected" ? await readNativeIssuance(kv, String(decode(minted[minted.length - 1]!).sub)) : undefined;
  check("P2 an admin-view connect records view \"admin\" under its own uid", aRes === "connected" && rA?.view === "admin" && rA.lifecycleUid === a.uid, { aRes, view: rA?.view });

  // ---- P3/P4: reconnect and sibling are disjoint ----
  const before = (await natkeys(kv)).length;
  check("P3 a reconnect with the same bearer CONNECTS", (await tryConnect(bearerW)) === "connected");
  const keys3 = await natkeys(kv);
  const fresh = keys3.filter((k) => !keys1.includes(k) && k !== String(rA ? decode(minted[1]!).sub : ""));
  const r3 = fresh.length === 1 ? await readNativeIssuance(kv, fresh[0]!) : undefined;
  check("P3 the reconnect adds exactly one NEW row under a different key, same uid and credential",
    keys3.length === before + 1 && fresh.length === 1 && r3?.lifecycleUid === w.uid && r3.credentialId === w.credid, { before, after: keys3.length });
  const s = await grant("peer");
  const bearerS = await issuer.issue({ owner: OWNER, space, actor: "peer", scope: ["spawn"], lifecycleUid: s.uid, credentialId: s.credid });
  check("P4 a sibling actor CONNECTS", (await tryConnect(bearerS)) === "connected");
  const all4 = await Promise.all((await natkeys(kv)).map(async (k) => [k, await readNativeIssuance(kv, k)] as const));
  check("P4 the sibling's row carries only its own uid; no other row carries it",
    all4.filter(([, r]) => r?.lifecycleUid === s.uid).length === 1 && all4.filter(([, r]) => r?.actor === "peer").every(([, r]) => r?.lifecycleUid === s.uid));

  // ---- N: denied bearers leave no row ----
  const n0 = (await natkeys(kv)).length;
  const claimless = await issuer.issue({ owner: OWNER, space, actor: "worker", scope: [], lifecycleUid: w.uid });
  check("N1 a claimless (pre-cut) bearer is DENIED", (await tryConnect(claimless)) === "denied");
  const foreign = await issuer.issue({ owner: OWNER, space: `${space}-other`, actor: "worker", scope: [], lifecycleUid: w.uid, credentialId: w.credid });
  check("N2 a foreign-space bearer is DENIED", (await tryConnect(foreign)) === "denied");
  check("N1/N2 denied bearers left no natkey row", (await natkeys(kv)).length === n0);

  // ---- N3: a held record keeps the JWT; a revoke during the REAL held write is caught ----
  const h = await grant("held");
  const bearerH = await issuer.issue({ owner: OWNER, space, actor: "held", scope: ["spawn"], lifecycleUid: h.uid, credentialId: h.credid });
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  let entered = false;
  hook = async (i) => { entered = true; await gate; return plane!.recordIssuance(i); };
  let settled = false;
  const heldConnect = tryConnect(bearerH).then((r) => { settled = true; return r; });
  for (let i = 0; i < 40 && !entered; i++) await wait(25);
  await wait(200);
  check("N3 while the record is held the connect has NOT resolved and no row exists", entered && !settled && (await natkeys(kv)).length === n0, { entered, settled });
  writer = await openAuthorityClient({ server: SERVERS, space, dataAccount, label: `cotal:smoke-writer:${space}`, grants: (id) => authorityWriterGrants(space, id), log: quiet });
  const reg = await openLifecycleRegistry(writer.nc, space);
  await markLedgerRowRevoked(registryStores(reg).authKv, credRowKey(h.uid, h.credid));
  release();
  check("N3 a revoke landing during the held real record write is caught: the connect is DENIED", (await heldConnect) === "denied");
  const heldKeys: string[] = [];
  for (const k of await natkeys(kv)) if ((await readNativeIssuance(kv, k))?.lifecycleUid === h.uid) heldKeys.push(k);
  check("N3 the written row stays as evidence of an issuance that was never released (one row, honest)", heldKeys.length === 1, heldKeys.length);
  hook = undefined;
  check("N3 the revoked credential's next connect is DENIED with no new row", (await tryConnect(bearerH)) === "denied" && (await natkeys(kv)).length === n0 + 1);

  // ---- N4: refused write and foreign-uid collision both deny ----
  const n4 = (await natkeys(kv)).length;
  hook = async () => { throw new Error("instrument: store refused"); };
  check("N4 a refused record write is DENIED (no JWT released)", (await tryConnect(bearerW)) === "denied");
  check("N4 the refused write left no row", (await natkeys(kv)).length === n4);
  const foreignRow: NativeIssuanceRecord = { v: 1, space, owner: OWNER, actor: "worker", lifecycleUid: mintLifecycleUid(), credentialId: w.credid, view: "agent", connId: "seeded", iat: 1, exp: 2 };
  let seededKey = "";
  hook = async (i) => { seededKey = i.userNkey; await kv.create(`natkey.${i.userNkey}`, enc(JSON.stringify(foreignRow))); return plane!.recordIssuance(i); };
  check("N4 a pre-existing row for the same broker key under a foreign uid makes the connect DENIED", (await tryConnect(bearerW)) === "denied");
  const seeded = seededKey ? await readNativeIssuance(kv, seededKey) : undefined;
  check("N4 the colliding row is unchanged (create-only, never overwritten)", seeded?.lifecycleUid === foreignRow.lifecycleUid && seeded.connId === "seeded");
  hook = undefined;

  // ---- direct plane recorder: foreign space and duplicate key refuse ----
  const tok = await validateUserToken(bearerW, { key: issuer.localKeySet(), issuer: ISS, audience: space });
  const userNkey = createUser().getPublicKey();
  let err = "";
  try { await plane.recordIssuance({ userNkey, token: { ...tok, space: `${space}-other` }, connId: "c", iat: 10, exp: 20 }); } catch (e) { err = (e as Error).message; }
  check("D1 the plane recorder refuses a foreign-space token and writes nothing", err.includes("space") && (await readNativeIssuance(kv, userNkey)) === undefined, err);
  await plane.recordIssuance({ userNkey, token: tok, connId: "c", iat: 10, exp: 20 });
  err = "";
  try { await plane.recordIssuance({ userNkey, token: { ...tok, act: { ...tok.act, lifecycleUid: mintLifecycleUid() } }, connId: "c", iat: 10, exp: 20 }); } catch (e) { err = (e as Error).message; }
  check("D2 a second record for the same key refuses (create-only, any uid)", err !== "" && (await readNativeIssuance(kv, userNkey))?.lifecycleUid === w.uid, err);

  // ---- static absence ----
  const subs = new Set(minted.map((j) => String(decode(j).sub)));
  const rows = await natkeys(kv);
  const unreleased = [userNkey, seededKey, ...heldKeys].sort();
  check("S1 rows are exactly the released callout keys plus the three unreleased/direct ones; no static connection has a row",
    JSON.stringify(rows.filter((k) => !subs.has(k))) === JSON.stringify(unreleased) && [...subs].every((k) => rows.includes(k)), { rows: rows.length, minted: subs.size });

  console.log(JSON.stringify({ natkeyRows: rows.length, mintedJwts: minted.length }));
  console.log(`\nNATIVE-ISSUANCE SMOKE ${fail === 0 ? "OK" : "FAILED"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ smoke crashed:", e instanceof Error ? (e.stack ?? e.message) : e);
  process.exitCode = 1;
} finally {
  await plane?.close().catch(() => {});
  await writer?.close().catch(() => {});
  await setup?.close().catch(() => {});
  await calloutNc?.close().catch(() => {});
  srv.kill();
  await new Promise((r) => { if (srv.exitCode !== null || srv.signalCode !== null) return r(undefined); srv.once("exit", r); setTimeout(r, 3000); });
  rmSync(tmp, { recursive: true, force: true });
  releaseBroker();
}
