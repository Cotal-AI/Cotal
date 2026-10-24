/**
 * Native-key issuance evidence LIFECYCLE live smoke (SPEC 13.1 `natkey.`), on an owned broker with
 * the authority plane and callout composed as deny-new.smoke.ts composes them:
 *
 *  - a memory-storage auth bucket refuses the plane open (existing bind shape proof);
 *  - a transfer-writer success records its view (retirement and a same-name successor need the
 *    delivery-admin eviction rail, so they live in native-issuance-composed.smoke.ts);
 *  - kernel witness: the key read from the PERSISTED row of a working connection is revoked by a
 *    test-operator account claim; exactly that socket closes while a sibling keeps working (this
 *    proves the mapping only: a fresh connect on the same bearer still gets a new key);
 *  - the plane's own writer prunes a row only after its exp plus the clock tolerance, at boot and
 *    on its timer, leaving a purge marker that carries the bucket's marker TTL; a corrupt row fences the plane visibly and refuses the next open; after close no
 *    pass runs.
 *
 * Instrumentation: a full-grant test-account connection reads/seeds the auth bucket, and a test
 * system-account user pushes the account claim. Every product write is the plane's own.
 *
 * Run: pnpm exec tsx smoke/native-issuance-lifecycle.smoke.ts   (needs nats-server on PATH)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, type NatsConnection, type ConnectionOptions } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm, type KV } from "@nats-io/kv";
import { decode, encodeAccount, encodeUser, fmtCreds } from "@nats-io/jwt";
import { createUser, fromPublic, fromSeed } from "@nats-io/nkeys";
import { EP_AUTH_MARKER_TTL_MS, createEndpointStreams, createSpaceAuth, epAuthBucket, isReachable, serverConfig, standaloneConnectOpts, mintLifecycleUid } from "@cotal-ai/core";
import {
  calloutPermissions, createCalloutAuth, createUserTokenIssuer, deriveOwnerToken, generateSigningKey,
  grantManagedActor, ledgerAclResolver, newActorToken, openAuthAuthorityPlane, startAuthCallout,
} from "../src/index.js";
import { openAuthorityClient } from "../src/authority-client.js";
import { readNativeIssuance } from "../src/native-issuance.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const enc = (s: string) => new TextEncoder().encode(s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };
const within = <T>(p: Promise<T>, ms: number): Promise<T | "timeout"> => Promise.race([p, wait(ms).then(() => "timeout" as const)]);

const space = `natlife-${randomUUID().slice(0, 8)}`;
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
const PRUNE_MS = 500;

const live: NatsConnection[] = [];
async function connectBearer(bearer: string): Promise<NatsConnection | "denied"> {
  try {
    const nc = await connect({ servers: SERVERS, reconnect: false, ...(standaloneConnectOpts({ bearer, sentinelCreds: callout.sentinelCreds, tls: false }) as Partial<ConnectionOptions>) });
    live.push(nc);
    return nc;
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
const fresh = (before: string[], after: string[]) => after.filter((k) => !before.includes(k));

let plane: Awaited<ReturnType<typeof openAuthAuthorityPlane>> | undefined;
let calloutNc: NatsConnection | undefined, sysNc: NatsConnection | undefined;
let setup: Awaited<ReturnType<typeof openAuthorityClient>> | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
  setup = await openAuthorityClient({ server: SERVERS, space, dataAccount, label: `cotal:smoke-streams:${space}`, grants: (id) => (void id, { publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: quiet });
  const jsm = await jetstreamManager(setup.nc);
  await createEndpointStreams(jsm, new Kvm(setup.nc), space);

  // ---- M0: memory-only auth store refuses the bind (createEndpointStreams made the file one) ----
  await jsm.streams.delete(`KV_${epAuthBucket(space)}`);
  await new Kvm(setup.nc).create(epAuthBucket(space), { allow_direct: false, markerTTL: EP_AUTH_MARKER_TTL_MS, storage: "memory" } as never);
  const m0Storage = (await jsm.streams.info(`KV_${epAuthBucket(space)}`)).config.storage;
  check("M0 instrument: the seeded auth bucket really is memory storage", m0Storage === "memory", m0Storage);
  let m0 = "";
  try { const p0 = await openAuthAuthorityPlane({ server: SERVERS, space, dir, identityRoot: dir, dataAccount, log: quiet, nativeIssuancePruneMs: PRUNE_MS }); await p0.close(); m0 = "opened"; }
  catch (e) { m0 = (e as Error).message; }
  check("M0 a memory-storage auth bucket refuses the plane open", m0 !== "opened" && /storage|file|memory/i.test(m0), m0.slice(0, 160));
  await jsm.streams.delete(`KV_${epAuthBucket(space)}`);

  plane = await openAuthAuthorityPlane({ server: SERVERS, space, dir, identityRoot: dir, dataAccount, log: quiet, nativeIssuancePruneMs: PRUNE_MS });
  check("M0 control: with the file store the plane opens (boot prune pass included)", true);
  const kv = await new Kvm(setup.nc).open(epAuthBucket(space));
  const grant = async (actor: string, scope: string[] = ["spawn"]) => {
    const uid = mintLifecycleUid();
    grantManagedActor(dir, { custody: { kind: "foreground" }, owner: OWNER, actor, scope, allowSubscribe: ["general"], allowPublish: ["general"], tokenHash: newActorToken().tokenHash, lifecycleUid: uid });
    return { uid, credid: await plane!.mintConnectCredential({ owner: OWNER, actor, lifecycleUid: uid }) };
  };
  const issuer = createUserTokenIssuer({ issuer: ISS, key: await generateSigningKey() });
  calloutNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(callout.calloutCreds)) });
  startAuthCallout(calloutNc as never, {
    xkeySeed: callout.xkey.seed, authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed }, dataAccount, space,
    token: { key: issuer.localKeySet(), issuer: ISS }, authorizeActor: plane.authorizeConnect, recordIssuance: plane.recordIssuance,
    permissionsFor: calloutPermissions(ledgerAclResolver(dir)), log: quiet,
  });
  await calloutNc.flush();

  // ---- V1: transfer-writer records its view ----
  const tw = await grant("mover", ["spawn", "admin"]);
  let k0 = await natkeys(kv);
  const twNc = await connectBearer(await issuer.issue({ owner: OWNER, space, actor: "mover", scope: ["admin"], view: "transfer-writer", transferWriter: { instanceId: "m".repeat(26), hex: "a".repeat(64) }, lifecycleUid: tw.uid, credentialId: tw.credid }));
  const twKeys = fresh(k0, await natkeys(kv));
  const twRow = twKeys[0] ? await readNativeIssuance(kv, twKeys[0]) : undefined;
  check("V1 a transfer-writer connect records view \"transfer-writer\" under its own uid", twNc !== "denied" && twKeys.length === 1 && twRow?.view === "transfer-writer" && twRow.lifecycleUid === tw.uid, { twNc: twNc === "denied" ? "denied" : "ok", view: twRow?.view });

  // ---- K: the persisted row's key, revoked by a test-operator claim, closes exactly that socket ----
  const a = await grant("target"), b = await grant("sibling");
  k0 = await natkeys(kv);
  const aBearer = await issuer.issue({ owner: OWNER, space, actor: "target", scope: ["spawn"], lifecycleUid: a.uid, credentialId: a.credid });
  const aNc = await connectBearer(aBearer);
  const aKeys = fresh(k0, await natkeys(kv));
  const k1 = await natkeys(kv);
  const bNc = await connectBearer(await issuer.issue({ owner: OWNER, space, actor: "sibling", scope: ["spawn"], lifecycleUid: b.uid, credentialId: b.credid }));
  const aRow = aKeys[0] ? await readNativeIssuance(kv, aKeys[0]) : undefined;
  check("K the target connection has exactly one persisted row (its key is the revocation target)", aNc !== "denied" && bNc !== "denied" && aKeys.length === 1 && aRow?.lifecycleUid === a.uid);
  if (aNc !== "denied" && bNc !== "denied" && aRow) {
    await aNc.flush(); await bNc.flush();
    check("K control: both sockets work before the claim", !aNc.isClosed() && !bNc.isClosed());
    const sysUser = createUser();
    const sysJwt = await encodeUser("r52-claims", sysUser, fromPublic(auth.sys.pub), { pub: { allow: [`$SYS.REQ.ACCOUNT.${auth.account.pub}.CLAIMS.UPDATE`] }, sub: { allow: ["_INBOX.>"] } }, { signer: fromSeed(enc(auth.sys.signingSeed!)) });
    sysNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(fmtCreds(sysJwt, sysUser)) });
    const current = decode(auth.account.jwt) as unknown as { iss: string; name: string; nats: Record<string, unknown> };
    const opSigner = [auth.operator.seed, (auth.operator as { signingSeed?: string }).signingSeed].filter((x): x is string => !!x).map((sd) => fromSeed(enc(sd))).find((kp) => kp.getPublicKey() === current.iss);
    if (!opSigner) throw new Error("instrument: no test operator key matches the account issuer");
    const { type: _t, version: _v, ...claims } = current.nats;
    const revokedJwt = await encodeAccount(current.name, fromPublic(auth.account.pub), { ...claims, revocations: { ...((claims.revocations as object | undefined) ?? {}), [aKeys[0]!]: aRow.iat } } as never, { signer: opSigner });
    const closedA = aNc.closed();
    const reply = JSON.parse(new TextDecoder().decode((await sysNc.request(`$SYS.REQ.ACCOUNT.${auth.account.pub}.CLAIMS.UPDATE`, enc(revokedJwt), { timeout: 3000 })).data)) as { data?: { code?: number }; error?: unknown };
    check("K the isolated broker accepted the test-operator claim update", reply.data?.code === 200 && !reply.error, reply.error ?? reply.data);
    const closed = await within(closedA, 5000);
    check("K exactly the recorded key's socket CLOSES", closed !== "timeout" && aNc.isClosed());
    let bOk = false;
    try { await bNc.flush(); bOk = !bNc.isClosed(); } catch { bOk = false; }
    check("K the sibling socket still works after the claim", bOk);
    const again = await connectBearer(aBearer);
    const againKeys = fresh(k1, await natkeys(kv)).filter((k) => k !== aKeys[0]);
    const againRows = (await Promise.all(againKeys.map((k) => readNativeIssuance(kv, k)))).filter((r) => r?.lifecycleUid === a.uid);
    check("K (mapping only, not M2) a fresh connect on the same still-authorized bearer gets a NEW key and row", again !== "denied" && againRows.length === 1);
  }

  // ---- PR: the plane's writer prunes only after exp + tolerance ----
  const pr = await grant("brief");
  k0 = await natkeys(kv);
  const prNc = await connectBearer(await issuer.issue({ owner: OWNER, space, actor: "brief", scope: ["spawn"], lifecycleUid: pr.uid, credentialId: pr.credid, ttlSec: 2 }));
  const prKeys = fresh(k0, await natkeys(kv));
  const prRow = prKeys[0] ? await readNativeIssuance(kv, prKeys[0]) : undefined;
  check("PR a short-lived connect records its own exp", prNc !== "denied" && prKeys.length === 1 && prRow !== undefined && prRow.exp - prRow.iat <= 2, prRow && { life: prRow.exp - prRow.iat });
  const others = (await natkeys(kv)).filter((k) => k !== prKeys[0]);
  if (prRow) {
    while (nowSec() < prRow.exp + 3) await wait(200);
    check("PR inside exp + tolerance the expired row is still present", (await readNativeIssuance(kv, prKeys[0]!)) !== undefined);
    while (nowSec() <= prRow.exp + 6) await wait(200);
    await wait(PRUNE_MS * 3);
    check("PR after exp + tolerance the plane's own timer removed it", (await readNativeIssuance(kv, prKeys[0]!)) === undefined);
    const marker = await jsm.streams.getMessage(`KV_${epAuthBucket(space)}`, { last_by_subj: `$KV.${epAuthBucket(space)}.natkey.${prKeys[0]}` });
    check("PR the removal is a purge marker carrying the bucket's marker TTL", marker?.header?.get("KV-Operation") === "PURGE" && marker.header.get("Nats-TTL") === `${EP_AUTH_MARKER_TTL_MS / 1000}s`, marker?.header?.get("Nats-TTL"));
    const left = await natkeys(kv);
    check("PR every unexpired row is untouched", others.every((k) => left.includes(k)), { others: others.length, left: left.length });
  }

  // ---- PF: corrupt evidence fences the plane visibly ----
  const fencedP = plane.fenced;
  const bad = createUser().getPublicKey();
  await kv.create(`natkey.${bad}`, enc("{\"v\":1}"));
  const why = await within(fencedP, PRUNE_MS * 10);
  check("PF a corrupt row fences the plane with a visible cleanup failure", typeof why === "string" && why.includes("native-issuance cleanup failed"), why);
  const z = await grant("late").catch((e: Error) => e);
  check("PF the fenced plane refuses new issuance work", z instanceof Error, z instanceof Error ? z.message.slice(0, 80) : "minted");
  await plane.close(); plane = undefined;

  // ---- PB: the boot pass refuses an open over corrupt evidence ----
  let pb = "";
  try { const p2 = await openAuthAuthorityPlane({ server: SERVERS, space, dir, identityRoot: dir, dataAccount, log: quiet, nativeIssuancePruneMs: PRUNE_MS }); await p2.close(); pb = "opened"; }
  catch (e) { pb = (e as Error).message; }
  check("PB the next open refuses while the corrupt row remains", pb !== "opened" && pb.includes("natkey"), pb.slice(0, 160));
  await kv.purge(`natkey.${bad}`);
  plane = await openAuthAuthorityPlane({ server: SERVERS, space, dir, identityRoot: dir, dataAccount, log: quiet, nativeIssuancePruneMs: PRUNE_MS });
  check("PB control: the open succeeds once the corrupt row is gone", true);

  // ---- SD: after close no prune pass runs ----
  await plane.close(); plane = undefined;
  const expired = createUser().getPublicKey();
  await kv.create(`natkey.${expired}`, enc(JSON.stringify({ v: 1, space, owner: OWNER, actor: "gone", lifecycleUid: mintLifecycleUid(), credentialId: mintLifecycleUid(), view: "agent", connId: "seeded", iat: 1, exp: 2 })));
  await wait(PRUNE_MS * 4);
  check("SD after close the plane's timer is gone: an expired row stays", (await readNativeIssuance(kv, expired))?.exp === 2);

  console.log(`\nNATIVE-ISSUANCE LIFECYCLE SMOKE ${fail === 0 ? "OK" : "FAILED"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ smoke crashed:", e instanceof Error ? (e.stack ?? e.message) : e);
  process.exitCode = 1;
} finally {
  for (const nc of live) await nc.close().catch(() => {});
  await plane?.close().catch(() => {});
  await sysNc?.close().catch(() => {});
  await setup?.close().catch(() => {});
  await calloutNc?.close().catch(() => {});
  srv.kill();
  await new Promise((r) => { if (srv.exitCode !== null || srv.signalCode !== null) return r(undefined); srv.once("exit", r); setTimeout(r, 3000); });
  rmSync(tmp, { recursive: true, force: true });
  releaseBroker();
}
