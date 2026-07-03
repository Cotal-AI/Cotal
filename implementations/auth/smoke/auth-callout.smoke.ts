/**
 * Plane-2 auth-callout E2E smoke (per-user-auth cutover prep — plan §"Plane 2").
 *
 * Boots a REAL operator-mode nats-server with the dedicated auth-callout account
 * (`createCalloutAuth` + `serverConfig extraAccounts`), runs `startAuthCallout` on the callout
 * creds, and proves the full bridge against live broker behavior:
 *
 *   A. a VALID bearer (sentinel creds + auth_token) connects, lands in the DATA account with the
 *      minted scoped permissions (allowed pub/sub round-trips; forbidden pub is a violation);
 *   B. the deny matrix holds AT CONNECT: expired bearer / stale `ver` / rogue-signed bearer /
 *      missing bearer / ledger-denied actor — all refused by the broker;
 *   C. the sentinel alone is powerless (deny-all).
 *
 * This is deliberately a LIVE smoke: xkey sealing, account binding via issuer_account, and the
 * CONNECT auth_token path are exactly the pieces static review has missed before.
 * Run: pnpm smoke:auth-callout:auth  (needs nats-server on PATH)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connect,
  credsAuthenticator,
  tokenAuthenticator,
  type NatsConnection,
} from "@nats-io/transport-node";
import { SignJWT, generateKeyPair } from "jose";
import { createSpaceAuth, isReachable, serverConfig } from "@cotal-ai/core";
import { createCalloutAuth, deriveOwnerToken, startAuthCallout, USER_TOKEN_VER } from "../src/index.js";

const PORT = 20000 + Math.floor(Math.random() * 40000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = (s: string) => new TextEncoder().encode(s);
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const space = `callout-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const callout = await createCalloutAuth(auth);
const dir = mkdtempSync(join(tmpdir(), "cotal-callout-"));
writeFileSync(
  join(dir, "server.conf"),
  serverConfig(auth, { port: PORT, storeDir: join(dir, "js"), extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }] }),
);
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });

// ---- the IdP side: an EdDSA keypair + a bearer mint helper ----
const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const { privateKey: roguePriv } = await generateKeyPair("EdDSA");
const ISS = "https://auth.cotal.test";
const secret = "s".repeat(32);
const owner = deriveOwnerToken(secret, "better-auth|human-1");
async function bearer(opts: { actor?: string; ver?: number; expiredBy?: number; key?: CryptoKey } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000) - (opts.expiredBy ?? 0);
  return new SignJWT({
    sub: owner,
    scope: ["chat"],
    ver: opts.ver ?? USER_TOKEN_VER,
    act: { owner, actor: opts.actor ?? "agent_1" },
  })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer(ISS)
    .setAudience(space)
    .setIssuedAt(now - 60)
    .setNotBefore(now - 60)
    .setExpirationTime(now + 300)
    .sign((opts.key ?? privateKey) as CryptoKey);
}

let calloutNc: NatsConnection | undefined;
const conns: NatsConnection[] = [];
async function tryConnect(token?: string): Promise<{ nc?: NatsConnection; err?: string }> {
  try {
    const authenticators = [credsAuthenticator(enc(callout.sentinelCreds))];
    if (token) authenticators.push(tokenAuthenticator(token));
    const nc = await connect({ servers: SERVERS, authenticator: authenticators, maxReconnectAttempts: 0, timeout: 4000 });
    conns.push(nc);
    return { nc };
  } catch (e) {
    return { err: e instanceof Error ? e.message : String(e) };
  }
}

try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  // ---- start the callout service on its own creds (auth account) ----
  calloutNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(callout.calloutCreds)) });
  startAuthCallout(calloutNc as never, {
    xkeySeed: callout.xkey.seed,
    authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
    dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    space,
    token: { key: publicKey as never, issuer: ISS },
    authorizeActor: (t) => {
      if (t.act.actor !== "agent_1") throw new Error(`actor ${t.act.actor} not in the spawn ledger`);
    },
    permissionsFor: () => ({
      pub: { allow: ["smoke.allowed"] },
      sub: { allow: ["smoke.allowed", "_INBOX.>"] },
    }),
    log: () => {},
  });

  // A. valid bearer connects and carries the minted scoped permissions
  const good = await tryConnect(await bearer());
  check("valid bearer connects via callout", !!good.nc, good.err);
  if (good.nc) {
    const sub = good.nc.subscribe("smoke.allowed", { max: 1 });
    good.nc.publish("smoke.allowed", enc("hi"));
    let got = false;
    for await (const m of sub) got = new TextDecoder().decode(m.data) === "hi";
    check("minted permissions allow the granted subject (pub+sub round-trip)", got);

    let violation = false;
    const errWatch = (async () => {
      for await (const s of good.nc!.status()) {
        if (String(s.type).toLowerCase().includes("error") || /permission/i.test(JSON.stringify(s))) { violation = true; break; }
      }
    })().catch(() => {});
    good.nc.publish("smoke.forbidden", enc("nope"));
    await Promise.race([errWatch, wait(1500)]);
    check("forbidden publish is a permission violation", violation);
  }

  // B. the deny matrix — every bad bearer is refused AT CONNECT
  const expired = await tryConnect(await bearer({ expiredBy: 3600 }));
  check("expired bearer refused at connect", !expired.nc, expired.err ?? "(connected!)");
  const staleVer = await tryConnect(await bearer({ ver: 0 }));
  check("stale-ver bearer refused (downgrade defense)", !staleVer.nc);
  const rogue = await tryConnect(await bearer({ key: roguePriv as CryptoKey }));
  check("rogue-signed bearer refused", !rogue.nc);
  const noTok = await tryConnect(undefined);
  check("sentinel without a bearer refused", !noTok.nc);
  const badActor = await tryConnect(await bearer({ actor: "agent_2" }));
  check("ledger-denied actor refused", !badActor.nc);

  console.log(`\nauth-callout smoke: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
} catch (e) {
  console.error("auth-callout smoke: fatal:", e);
  process.exitCode = 1;
} finally {
  for (const nc of conns) await nc.close().catch(() => {});
  await calloutNc?.close().catch(() => {});
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
