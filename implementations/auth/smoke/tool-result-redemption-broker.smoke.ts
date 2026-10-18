/**
 * Tool-result redemption through a live broker — run with (needs nats-server on PATH):
 *   pnpm --dir implementations/auth exec tsx smoke/tool-result-redemption-broker.smoke.ts
 *
 * The holder connects with a `tool-result-caller` bearer through the PRODUCTION callout
 * (startAuthCallout + calloutPermissions + verifyToolResultRedemption). The broker then admits its
 * handle-mode request on the consent's exact incarnation and refuses a sibling target, another
 * incarnation and another caller's reply rail. A bearer whose target has moved to a
 * successor incarnation cannot connect at all. The lifecycle head reader is a fixture.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, tokenAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { createUser } from "@nats-io/nkeys";
import { SignJWT, generateKeyPair, type CryptoKey } from "jose";
import {
  createSpaceAuth, epCallerReplyFilter, epRequestSubject, isReachable, mintCreds, mintLifecycleUid, mintToolResultConsent, newIdentity, serverConfig,
  TOOL_RESULT_COMMAND, TOOL_RESULT_CONSENT_MAX_TTL_MS, TOOL_RESULT_ENDPOINT, type SignerAnchor,
} from "@cotal-ai/core";
import { createCalloutAuth, calloutPermissions, deriveOwnerToken, startAuthCallout, USER_TOKEN_VER, verifyToolResultRedemption } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const enc = (s: string) => new TextEncoder().encode(s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };

const space = `trr-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const callout = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js"), extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }] }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const ISS = "https://auth.cotal.test";
const OWNER = deriveOwnerToken("s".repeat(32), "better-auth|human-1");
const targetUid = mintLifecycleUid();
const holderUid = mintLifecycleUid();
const host = createUser();
const now = Date.now();
const anchor: SignerAnchor = { keyId: "host", publicKey: host.getPublicKey(), owner: "host.example", roles: ["consents"], scope: { consents: ["tool-results"] }, validFrom: now - 60_000, validTo: now + TOOL_RESULT_CONSENT_MAX_TTL_MS * 2 };
const heads = new Map([[`${OWNER}.seat`, { lifecycleUid: targetUid, state: "active" }]]);
const consent = mintToolResultConsent({ space, target: { owner: OWNER, actor: "seat", lifecycleUid: targetUid }, holder: `${OWNER}.web`, proofAt: now - 1000, ttlMs: 120_000, issuerKeyId: "host", now }, host);
const holder = { owner: OWNER, actor: "web", uid: holderUid };

async function bearer(): Promise<string> {
  const t = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: OWNER, ver: USER_TOKEN_VER, act: { owner: OWNER, actor: "web", scope: [], lifecycleUid: holderUid, view: "tool-result-caller", toolResult: consent } })
    .setProtectedHeader({ alg: "EdDSA" }).setIssuer(ISS).setAudience(space).setSubject(OWNER)
    .setIssuedAt(t - 60).setNotBefore(t - 60).setExpirationTime(t + 60)
    .sign(privateKey as CryptoKey);
}
const holderConnect = async (): Promise<NatsConnection> => connect({
  servers: SERVERS, name: `trr${randomUUID().replace(/-/g, "")}`, reconnect: false,
  authenticator: [credsAuthenticator(enc(callout.sentinelCreds)), tokenAuthenticator(await bearer())],
});
const request = (target: { tOwner: string; tActor: string; tUid: string }, instanceId = targetUid) => epRequestSubject(space, {
  route: { mode: "inst", instanceId }, endpoint: TOOL_RESULT_ENDPOINT, command: TOOL_RESULT_COMMAND,
  target: { mode: "handle", ...target }, caller: holder, nonce: randomUUID().replace(/-/g, ""),
});

let calloutNc: NatsConnection | undefined, witnessNc: NatsConnection | undefined, holderNc: NatsConnection | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
  calloutNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(callout.calloutCreds)) });
  await wait(300);
  startAuthCallout(calloutNc as never, {
    xkeySeed: callout.xkey.seed,
    authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
    dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    space,
    token: { key: publicKey as never, issuer: ISS },
    authorizeActor: () => {},
    permissionsFor: calloutPermissions(
      () => ({ allowSubscribe: [], allowPublish: [], lifecycleUid: holderUid, scope: [] }),
      async () => { throw new Error("no manager gate in this fixture"); },
      async () => { throw new Error("no session in this fixture"); },
      undefined,
      (h, c) => verifyToolResultRedemption({ space, resolveAnchor: (id) => (id === "host" ? anchor : undefined), readHead: async (o, a) => heads.get(`${o}.${a}`) }, h, c),
    ),
    log: (l) => { if (/denied|drop|fail/i.test(l)) console.log("  [callout]", l); },
  });

  witnessNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(await mintCreds(auth, newIdentity(), "admin"))) });
  const seen: string[] = [];
  const exact = request({ tOwner: OWNER, tActor: "seat", tUid: targetUid });
  const sibling = request({ tOwner: OWNER, tActor: "sibling", tUid: targetUid });
  const otherUid = mintLifecycleUid();
  const successor = request({ tOwner: OWNER, tActor: "seat", tUid: otherUid }, otherUid);
  for (const s of [exact, sibling, successor]) witnessNc.subscribe(s, { callback: (err, m) => { if (!err) seen.push(m.subject); } });
  const otherReply = epCallerReplyFilter(space, { owner: OWNER, actor: "other", uid: mintLifecycleUid() });
  await witnessNc.flush();

  holderNc = await holderConnect();
  check("the consent's holder connects through the callout with a tool-result-caller bearer", !!holderNc);
  const leaked: string[] = [];
  holderNc.subscribe(otherReply, { callback: (err, m) => { if (!err) leaked.push(m.subject); } });
  holderNc.publish(exact, enc("{}"));
  holderNc.publish(sibling, enc("{}"));
  holderNc.publish(successor, enc("{}"));
  await holderNc.flush().catch(() => undefined);
  witnessNc.publish(otherReply.replace(/\*/g, "x"), enc("{}"));
  await wait(500);
  check("the handle-mode request on the consented incarnation reaches the serving side", seen.includes(exact), seen);
  check("a sibling target is refused by the broker", !seen.includes(sibling), seen);
  check("another incarnation is refused by the broker", !seen.includes(successor), seen);
  check("another caller's reply rail is not readable", leaked.length === 0, leaked);
  await holderNc.close();

  heads.set(`${OWNER}.seat`, { lifecycleUid: otherUid, state: "active" });
  let refusedConnect = false;
  try { const nc = await holderConnect(); await nc.close(); } catch { refusedConnect = true; }
  check("after the alias moves to a successor the same bearer cannot connect", refusedConnect);

  console.log(`\nTOOL-RESULT-REDEMPTION BROKER SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  for (const nc of [holderNc, witnessNc, calloutNc]) { try { await nc?.close(); } catch { /* */ } }
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  releaseBroker();
}
