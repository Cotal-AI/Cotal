/**
 * The bearer-expiry ceiling (#4184): an exchanged bearer, and the NATS user JWT the callout mints
 * from it, never outlive the IdP proof the exchange rests on.
 *
 * The exchange used to cap the bearer with a RELATIVE ttl taken before it awaited the embedder's
 * `mintConnectCredential` hook; the issuer then read the clock again and signed `now + ttl`, so
 * time spent in the hook moved `exp` past the proof, and a hook that returned after the proof had
 * expired still got a bearer. This suite drives the shipped `createIdpBridge`,
 * `createUserTokenIssuer` and `startAuthCallout` on a REAL operator-mode nats-server; the only
 * delay is inside the hook, which is the embedder's own code. A synthetic EdDSA IdP signs the
 * proofs, so their `exp` is exact.
 *
 * Every delayed cell is red against the relative cap and green against the absolute one. The
 * undelayed control and the ttl-binds cell are green on both, so a red here is about the ceiling,
 * not a broken harness.
 * Run: pnpm smoke:bearer-exp-ceiling:auth  (needs nats-server on PATH)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, tokenAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { SignJWT, decodeJwt, generateKeyPair, type CryptoKey } from "jose";
import { decode } from "@nats-io/jwt";
import { createSpaceAuth, isReachable, mintLifecycleUid, serverConfig } from "@cotal-ai/core";
import { createCalloutAuth, createIdpBridge, createUserTokenIssuer, generateSigningKey, startAuthCallout, type UserTokenIssuer } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const CELLS = 12;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const enc = (s: string) => new TextEncoder().encode(s);
const now = () => Math.floor(Date.now() / 1000);
/** Resolve `ms` milliseconds into the next wall-clock second. */
const atMs = (ms: number) => wait((ms - (Date.now() % 1000) + 1000) % 1000 || 1000);
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const space = `expceil-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const callout = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(
  join(dir, "server.conf"),
  serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js"), extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }] }),
);
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });

// ---- the synthetic IdP, the stock issuer (counting signatures), and the bridge ----
const IDP_ISS = "https://idp.expceil.test", COTAL_ISS = "https://auth.expceil.test", KID = "idp-1";
const { privateKey: idpPriv, publicKey: idpPub } = await generateKeyPair("EdDSA");
const idpKey = (async (h: { kid?: string }) => {
  if (h.kid !== KID) throw new Error(`no key for kid ${String(h.kid)}`);
  return idpPub as CryptoKey;
}) as never;
const proof = (exp: number) => new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: KID })
  .setSubject("human-1").setIssuer(IDP_ISS).setAudience(IDP_ISS).setIssuedAt(now()).setExpirationTime(exp).sign(idpPriv);
const stock = createUserTokenIssuer({ issuer: COTAL_ISS, key: await generateSigningKey() });
let signed = 0;
const issuer: UserTokenIssuer = { ...stock, issue: async (c) => { const t = await stock.issue(c); signed++; return t; } };
let hookDelay: () => Promise<void> = async () => {};
const bridge = createIdpBridge({
  idp: { issuer: IDP_ISS, audience: IDP_ISS, key: idpKey },
  space,
  spaceSecret: "s".repeat(32),
  issuer,
  mintConnectCredential: async () => { await hookDelay(); return "root0001"; },
  authorizeActor: () => ({ lifecycleUid: mintLifecycleUid() }),
});
type Claims = { exp: number; iat: number; act: { session?: { exp: number } } };
/** Exchange with the hook delayed by `delay`; returns the bearer's claims or the refusal. */
async function exchange(
  proofExp: number, delay: () => Promise<void>, extra: Partial<Parameters<typeof bridge.exchange>[1]> = {},
): Promise<{ token?: string; claims?: Claims; refused?: string; signedNow: number }> {
  hookDelay = delay;
  const before = signed;
  try {
    const res = await bridge.exchange(await proof(proofExp), { actor: "agent_1", ttlSec: 900, ...extra });
    return { token: res.token, claims: decodeJwt(res.token) as unknown as Claims, signedNow: signed - before };
  } catch (e) {
    return { refused: e instanceof Error ? e.message : String(e), signedNow: signed - before };
  }
}

const conns: NatsConnection[] = [];
let calloutNc: NatsConnection | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  const minted: number[] = [];
  calloutNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(callout.calloutCreds)) });
  startAuthCallout(calloutNc as never, {
    xkeySeed: callout.xkey.seed,
    authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
    dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    space,
    token: { key: stock.localKeySet(), issuer: COTAL_ISS },
    recordIssuance: async () => {},
    authorizeActor: () => {},
    permissionsFor: (_t, connId) => ({ pub: { allow: [`_INBOX_${connId}.>`] }, sub: { allow: [`_INBOX_${connId}.>`] } }),
    onMint: (info) => { minted.push((decode(info.jwt) as { exp?: number }).exp ?? Number.NaN); },
    log: () => {},
  });
  /** Connect through the callout with `token`; returns the minted NATS user JWT's `exp`. */
  async function natsExp(token: string): Promise<number | undefined> {
    const nonce = `ibx${randomUUID().replace(/-/g, "")}`;
    const before = minted.length;
    const nc = await connect({ servers: SERVERS, authenticator: [credsAuthenticator(enc(callout.sentinelCreds)), tokenAuthenticator(token)], maxReconnectAttempts: 0, timeout: 4000, name: nonce, inboxPrefix: `_INBOX_${nonce}` });
    conns.push(nc);
    return minted[before];
  }

  // Control: no delay, and a start just past a second boundary so the cap binds without crossing one.
  await atMs(20);
  const ctlExp = now() + 6;
  const ctl = await exchange(ctlExp, async () => {});
  check("control: an undelayed exchange signs exp equal to the proof's exp", ctl.claims?.exp === ctlExp, { ctl, ctlExp });
  check("control: the callout's NATS user JWT for it expires at the proof's exp", ctl.token !== undefined && await natsExp(ctl.token) === ctlExp);

  // The requested ttl still binds when it ends before the proof.
  const long = await exchange(now() + 600, async () => {}, { ttlSec: 60 });
  check("a proof that outlives the requested ttl leaves the ttl in charge", long.claims !== undefined && long.claims.exp === long.claims.iat + 60, long);

  // A hook that takes 2 s, ending well before the proof expires.
  const dlExp = now() + 5;
  const dl = await exchange(dlExp, () => wait(2000));
  check("a mint delayed 2 s signs exp equal to the proof's exp, not 2 s past it", dl.claims?.exp === dlExp, { bearerExp: dl.claims?.exp, proofExp: dlExp, refused: dl.refused });
  const dlNats = dl.token === undefined ? undefined : await natsExp(dl.token);
  check("the NATS user JWT minted for the delayed bearer expires no later than the proof", dlNats !== undefined && dlNats <= dlExp, { natsExp: dlNats, proofExp: dlExp });

  // A hook that starts at .900 and returns 150 ms later, in the next wall-clock second.
  await atMs(900);
  const crExp = now() + 4;
  const cr = await exchange(crExp, () => wait(150));
  check("a mint that crosses a second boundary still signs exp no later than the proof's", cr.claims !== undefined && cr.claims.exp <= crExp, { bearerExp: cr.claims?.exp, proofExp: crExp });

  // A hook that returns after the proof has expired.
  const lateExp = now() + 2;
  const late = await exchange(lateExp, () => wait(2500));
  check("a mint whose hook returns after the proof expired is refused", late.refused?.includes("expiry ceiling") === true, { late, proofExp: lateExp });
  check("and nothing is signed for it", late.signedNow === 0, { signedNow: late.signedNow });

  // session-caller: the session decision's expiry is part of the ceiling.
  const sessionAt = (exp: number) => ({ endpoint: "manager", sessionId: `sess${randomUUID().replace(/-/g, "")}`, epoch: 1, exp });
  const sExp = now() + 3;
  const sc = await exchange(now() + 60, () => wait(2000), { view: "session-caller", verifySession: async () => sessionAt(sExp) });
  check("session-caller: a delayed mint signs exp equal to the session's exp when the session ends first", sc.claims?.exp === sExp, { bearerExp: sc.claims?.exp, sessionExp: sExp, refused: sc.refused });
  check("session-caller: the bearer still carries that session's exp", sc.claims?.act.session?.exp === sExp, sc.claims?.act);
  const slExp = now() + 2;
  const sl = await exchange(now() + 60, () => wait(2500), { view: "session-caller", verifySession: async () => sessionAt(slExp) });
  check("session-caller: a mint whose hook returns after the session expired is refused", sl.refused?.includes("expiry ceiling") === true, sl);
  check("session-caller: and nothing is signed for it", sl.signedNow === 0, { signedNow: sl.signedNow });

  console.log(`\nbearer-exp-ceiling smoke: ${pass} passed, ${fail} failed`);
  if (pass + fail !== CELLS) { console.log(`  ✗ FAIL: ran ${pass + fail} cells, expected ${CELLS}`); fail++; }
  if (fail > 0) process.exitCode = 1;
} catch (e) {
  console.error("bearer-exp-ceiling smoke: fatal:", e);
  process.exitCode = 1;
} finally {
  for (const nc of conns) await nc.close().catch(() => {});
  await calloutNc?.close().catch(() => {});
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
process.exit(process.exitCode ?? 0);
