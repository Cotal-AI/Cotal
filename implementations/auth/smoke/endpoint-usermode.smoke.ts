/**
 * User-mode CotalEndpoint live smoke (D4c) — proves an endpoint connects through the auth callout with a
 * user BEARER (no static creds), derives its owner+actor PRINCIPAL from the bearer, and publishes on a
 * principal-shaped subject that a data-account witness receives. This is the client half of the flip's
 * "log in and run an agent" path: EndpointOptions.bearer + sentinelCreds → the `[sentinel, bearer]`
 * authenticator arm → the callout mints a scoped data-account JWT → the endpoint's `chat.<owner>.<actor>`
 * publish is allowed. The reply-inbox nonce is the client-chosen connId passed as the connection `name`.
 *
 * Run: pnpm smoke:endpoint-usermode:auth   (needs nats-server on PATH; operator-mode callout, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { SignJWT, generateKeyPair } from "jose";
import {
  CotalEndpoint, createSpaceAuth, isReachable, mintCreds, newIdentity, serverConfig,
  setupSpaceStreams, principalKey, chatSubject, type CotalMessage,
} from "@cotal-ai/core";
import { createCalloutAuth, calloutPermissions, deriveOwnerToken, startAuthCallout, USER_TOKEN_VER } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const enc = (s: string) => new TextEncoder().encode(s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 5000): Promise<boolean> => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await wait(50); return cond(); };
// Wait for the killed broker to actually exit so it releases its JetStream file handles before we rm
// its store dir; on Windows the rm otherwise races the handle release and throws EBUSY on a `.blk`.
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };

const space = `epuser-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const callout = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
const dir = mkdtempSync(join(tmpdir(), "cotal-epuser-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { port: PORT, storeDir: join(dir, "js"), extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }] }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const ISS = "https://auth.cotal.test";
const OWNER = deriveOwnerToken("s".repeat(32), "better-auth|human-1");
async function bearer(actor: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: OWNER, ver: USER_TOKEN_VER, act: { owner: OWNER, actor, scope: [] } })
    .setProtectedHeader({ alg: "EdDSA" }).setIssuer(ISS).setAudience(space).setSubject(OWNER)
    .setIssuedAt(now - 60).setNotBefore(now - 60).setExpirationTime(now + 300)
    .sign(privateKey as CryptoKey);
}

let calloutNc: NatsConnection | undefined, witnessNc: NatsConnection | undefined, ep: CotalEndpoint | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

  // Data-account provisioner creates the space streams (CHAT etc.) so the endpoint's js.publish acks.
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  // The callout: the PRODUCTION permissions supplier (calloutPermissions → core permissionsFor), with a
  // server-side ACL resolver granting #general. authorizeActor allows any actor for the smoke.
  calloutNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(callout.calloutCreds)) });
  await wait(300);
  startAuthCallout(calloutNc as never, {
    xkeySeed: callout.xkey.seed,
    authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
    dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    space,
    token: { key: publicKey as never, issuer: ISS },
    authorizeActor: () => {},
    permissionsFor: calloutPermissions(() => ({ allowSubscribe: ["general"], allowPublish: ["general"] })),
    log: (l) => { if (/denied|drop|fail/i.test(l)) console.log("  [callout]", l); },
  });

  // A data-account witness (directly minted, NOT via the callout) subscribed to the channel firehose.
  witnessNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(await mintCreds(auth, newIdentity(), "admin"))) });
  const got: CotalMessage[] = [];
  witnessNc.subscribe(chatSubject(space, "*", "*", "general"), { callback: (err, m) => { if (!err) try { got.push(m.json<CotalMessage>()); } catch { /* skip */ } } });
  await witnessNc.flush();

  // THE USER-MODE ENDPOINT: bearer + sentinel, no static creds. Publish-only (the receive path reuses the
  // principal-keyed durables the other smokes already prove); minimal so it just connects and posts.
  const b = await bearer("agentone");
  ep = new CotalEndpoint({
    space, servers: SERVERS,
    bearer: b, sentinelCreds: callout.sentinelCreds,
    card: { name: "alice", kind: "agent" },
    channels: ["general"],
    registerPresence: false, watchPresence: false, watchChannels: false, consume: false,
  });
  ep.on("error", (e: Error) => console.error("  ! alice:", e.message));
  await ep.start();

  const principal = principalKey(OWNER, "agentone").key;
  check("user-mode endpoint connects via the callout (no static creds)", !!ep);
  check("endpoint derives card.id = the bearer PRINCIPAL (owner.actor)", ep.card.id === principal, ep.card.id);
  check("endpoint card.owner/actor come from the bearer", ep.card.owner === OWNER && ep.card.actor === "agentone", { owner: ep.card.owner, actor: ep.card.actor });

  const sent = await ep.multicast("hello from user mode", { channel: "general" });
  check("user-mode multicast is accepted (scoped chat.<owner>.<actor>.general grant)", !!sent);
  const arrived = await until(() => got.some((g) => g.id === sent.id));
  check("the witness receives the user-mode post", arrived, got.map((g) => g.id));
  const rec = got.find((g) => g.id === sent.id);
  check("the received frame's from.id is the PRINCIPAL dot-form", rec?.from.id === principal, rec?.from);

  console.log(`\nENDPOINT-USERMODE SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  try { await ep?.stop(); } catch { /* */ }
  for (const nc of [witnessNc, calloutNc]) { try { await nc?.close(); } catch { /* */ } }
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
