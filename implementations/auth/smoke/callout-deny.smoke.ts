/**
 * Callout DENY-path live smoke (D5 legible-refusal). Proves a DENIED user-mode connect gets a prompt,
 * legible signed refusal — never a hang. The bug: the auth-response JWT encoder is Latin1-limited, so a
 * deny reason carrying a non-ASCII char (an em-dash, which many of our throw messages use) raised
 * "Invalid character", the deny response never sent, and the client connect TIMED OUT instead of failing
 * fast with the reason. `asciiFold` at the deny boundary coerces the reason to ASCII so the deny always
 * encodes (fail-closed: refuse, never hang).
 *
 * Run: pnpm smoke:callout-deny:auth   (needs nats-server on PATH; operator-mode callout, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, tokenAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { SignJWT, generateKeyPair } from "jose";
import { createSpaceAuth, isReachable, serverConfig } from "@cotal-ai/core";
import { createCalloutAuth, calloutPermissions, deriveOwnerToken, startAuthCallout, USER_TOKEN_VER } from "../src/index.js";

const PORT = 20000 + Math.floor(Math.random() * 40000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const enc = (s: string) => new TextEncoder().encode(s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// A prompt signed deny returns on the first round-trip; the original encoding bug hung to the full
// connect timeout. Give a generous timeout so a loaded CI/Windows runner never mistakes a slow-but-
// prompt deny for a hang, and assert the reject landed well inside it (not at the ceiling).
const CONNECT_TIMEOUT_MS = 15000;
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };

const space = `deny-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const callout = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
const dir = mkdtempSync(join(tmpdir(), "cotal-deny-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js"), extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }] }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const ISS = "https://auth.cotal.test";
const OWNER = deriveOwnerToken("d".repeat(32), "better-auth|human-deny");
async function bearer(actor: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: OWNER, ver: USER_TOKEN_VER, act: { owner: OWNER, actor, scope: [] } })
    .setProtectedHeader({ alg: "EdDSA" }).setIssuer(ISS).setAudience(space).setSubject(OWNER)
    .setIssuedAt(now - 60).setNotBefore(now - 60).setExpirationTime(now + 300)
    .sign(privateKey as CryptoKey);
}

// The em-dash here is the exact hazard: before the fix it broke deny-response encoding → client hang.
const DENY_REASON = "actor not on the roster — denied by policy";

let calloutNc: NatsConnection | undefined;
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
    authorizeActor: () => { throw new Error(DENY_REASON); }, // deny EVERY actor, with a non-ASCII reason
    permissionsFor: calloutPermissions(() => ({ allowSubscribe: ["general"], allowPublish: ["general"] })),
    log: () => {},
  });

  // A user-mode connect that the callout will deny. With the bug the deny can't encode → this hangs to the
  // connect timeout; with the fix the server rejects promptly carrying the (folded) reason.
  const b = await bearer("agentx");
  const nonce = `ibx${randomUUID().replace(/-/g, "")}`;
  const t0 = Date.now();
  let rejected = false, elapsed = 0, msg = "";
  try {
    const nc = await connect({
      servers: SERVERS,
      authenticator: [credsAuthenticator(enc(callout.sentinelCreds)), tokenAuthenticator(b)],
      name: nonce, inboxPrefix: `_INBOX_${nonce}`, timeout: CONNECT_TIMEOUT_MS, maxReconnectAttempts: 0,
    });
    await nc.close(); // should not reach — a deny must reject the connect
  } catch (e) {
    rejected = true; elapsed = Date.now() - t0; msg = (e as Error).message;
  }

  check("a denied user-mode connect is REJECTED (not accepted)", rejected, msg);
  check("the rejection is PROMPT (well inside the connect timeout, not a hang)", rejected && elapsed < CONNECT_TIMEOUT_MS / 2, `${elapsed}ms of ${CONNECT_TIMEOUT_MS}ms`);
  check("the connect fails as an authorization/authentication denial", /auth/i.test(msg), msg);
  // The KEY property of the fix: the deny RESPONSE ENCODED (with the em-dash reason ASCII-folded), so the
  // server could reject at all. NATS surfaces only a GENERIC "Authorization Violation" to the client — it
  // does NOT forward the callout's reason string, which stays in the callout's server-side log. So the
  // client-legible outcome is "denied, promptly" (checks above); the specific why is operator-side. Before
  // the fix the em-dash broke encoding, no deny was sent, and this connect hung to the 8s timeout instead.
  check("the client sees a prompt generic Authorization Violation (reason is server-side only)", /authorization violation/i.test(msg), msg);

  console.log(`\nCALLOUT-DENY SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  try { await calloutNc?.close(); } catch { /* */ }
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
