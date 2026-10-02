/**
 * Credential lifetime smoke (D5 slice 1): user JWT `exp` is stamped from the profile matrix and enforced
 * by a real auth broker. This does NOT claim full credential death yet: signer rotation, live eviction,
 * and standing renewal are later D5 slices.
 *
 * Run: pnpm smoke:cred-lifetime
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCreds } from "@nats-io/jwt";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import {
  CotalEndpoint,
  createSpaceAuth,
  credentialLifetime,
  isReachable,
  probeConnect,
  mintConnectionEvictorCreds,
  mintMembershipObserverCreds,
  mintCreds,
  newIdentity,
  serverConfig,
  ROTATION_RENEWED_TTL_SEC,
  STANDING_RENEWABLE_TTL_SEC,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = (s: string) => new TextEncoder().encode(s);
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });

const SELF = fileURLToPath(import.meta.url);

if (process.argv[2] === "expiry-child") {
  const [, , , servers, childSpace, credsPath, id] = process.argv;
  if (!servers || !childSpace || !credsPath || !id) throw new Error("expiry child requires servers, space, creds path, and id");
  const liveCreds = readFileSync(credsPath, "utf8");
  const liveClaims = await parseCreds(enc(liveCreds));
  if (typeof liveClaims.uc.exp !== "number") throw new Error("expiry child credential has no exp");
  const ep = new CotalEndpoint({
    space: childSpace,
    servers,
    creds: liveCreds,
    card: { name: "expiry-child", kind: "endpoint", id },
    consume: false,
    registerPresence: false,
    watchPresence: false,
    watchChannels: false,
  });
  const endpointErrors: string[] = [];
  ep.on("error", (err: Error) => endpointErrors.push(err.message));
  await ep.start();
  const nc = (ep as unknown as { nc?: NatsConnection }).nc;
  if (!nc) throw new Error("expiry child started without a NATS connection");
  const closed = nc.closed();
  // Observe the policy after Cotal's pre-expiry timer has fired but before the broker's expiry close.
  // This makes the root mechanism itself a deterministic mutation control while the same child keeps
  // running to grade the real nc.closed() value and process survival below.
  await wait(Math.max(0, liveClaims.uc.exp * 1000 - Date.now() - 250));
  const reconnectDisabled = (nc as unknown as { protocol?: { options?: { reconnect?: boolean } } }).protocol?.options?.reconnect === false;
  const reason = await Promise.race([
    closed,
    wait(10_000).then(() => "timeout" as const),
  ]);
  if (reason === "timeout") throw new Error("the broker did not close the expired connection");
  console.log(`EXPIRY_CHILD_CLOSED ${JSON.stringify({ name: reason?.name, message: reason?.message, reconnectDisabled, endpointErrors })}`);
  await ep.stop();
  // Let the transport-close continuation and its microtasks settle before the explicit exit. With the
  // reconnect fence removed, nats-core's discarded continuation rejects during this window and Node
  // exits nonzero. No process-level rejection handler is installed.
  await wait(100);
  process.exit(0);
}

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

async function tryConnect(creds: string, id: string): Promise<"ok" | "rejected"> {
  try {
    const nc = await connect({
      servers: SERVERS,
      authenticator: credsAuthenticator(enc(creds)),
      inboxPrefix: `_INBOX_${id}`,
      reconnect: false,
      maxReconnectAttempts: 0,
    });
    await nc.close();
    return "ok";
  } catch {
    return "rejected";
  }
}

const space = `cred-life-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(SERVERS)) { up = true; break; }
    await wait(200);
  }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  const now = Math.floor(Date.now() / 1000);
  const prov = newIdentity();
  const provCreds = await mintCreds(auth, prov, "provisioner");
  const provClaims = await parseCreds(enc(provCreds));
  const provTtl = credentialLifetime("provisioner").defaultTtlSeconds;
  check("provisioner profile has a default max age", provTtl === 300, provTtl);
  check("provisioner creds include exp", typeof provClaims.uc.exp === "number", provClaims.uc);
  check("provisioner exp is near the matrix TTL", Boolean(provClaims.uc.exp && provClaims.uc.exp - now <= 305 && provClaims.uc.exp - now > 0), provClaims.uc.exp);

  const sup = newIdentity();
  const supCreds = await mintCreds(auth, sup, "supervisor");
  const supClaims = await parseCreds(enc(supCreds));
  check("standing supervisor is bounded now that self-remint renewal exists (slice 5 class 1)", credentialLifetime("supervisor").class === "standing-renewable" && Boolean(supClaims.uc.exp && supClaims.uc.exp - now <= STANDING_RENEWABLE_TTL_SEC + 5 && supClaims.uc.exp - now > STANDING_RENEWABLE_TTL_SEC - 60), supClaims.uc);
  check("agent is mixed until managed/unmanaged paths split", credentialLifetime("agent").class === "mixed" && credentialLifetime("agent").renewalOwner === undefined, credentialLifetime("agent"));
  const dlv = await parseCreds(enc(await mintCreds(auth, newIdentity(), "delivery")));
  check("delivery is bounded now that the manager-remint reload seam exists (slice 5 class 2)", credentialLifetime("delivery").defaultTtlSeconds === STANDING_RENEWABLE_TTL_SEC && typeof dlv.uc.exp === "number", dlv.uc.exp);
  const mrw = await parseCreds(enc(await mintCreds(auth, newIdentity(), "membership-rw")));
  check("membership-rw is bounded now that the manager-remint reload seam exists (slice 5 class 2)", credentialLifetime("membership-rw").defaultTtlSeconds === STANDING_RENEWABLE_TTL_SEC && typeof mrw.uc.exp === "number", mrw.uc.exp);

  const obs = newIdentity();
  const obsCreds = await mintMembershipObserverCreds(auth, obs);
  const obsClaims = await parseCreds(enc(obsCreds));
  check("membership-observer is rotation-renewed (bounded exp, no online renewal)", credentialLifetime("membership-observer").class === "rotation-renewed", credentialLifetime("membership-observer"));
  check("membership-observer creds carry the rotation-renewed exp", Boolean(obsClaims.uc.exp && obsClaims.uc.exp - now <= ROTATION_RENEWED_TTL_SEC + 5 && obsClaims.uc.exp - now > ROTATION_RENEWED_TTL_SEC - 60), obsClaims.uc.exp);
  const evi = newIdentity();
  const eviCreds = await mintConnectionEvictorCreds(auth, evi);
  const eviClaims = await parseCreds(enc(eviCreds));
  check("connection-evictor is rotation-renewed (bounded exp, no online renewal)", credentialLifetime("connection-evictor").class === "rotation-renewed", credentialLifetime("connection-evictor"));
  check("connection-evictor creds carry the rotation-renewed exp", Boolean(eviClaims.uc.exp && eviClaims.uc.exp - now <= ROTATION_RENEWED_TTL_SEC + 5 && eviClaims.uc.exp - now > ROTATION_RENEWED_TTL_SEC - 60), eviClaims.uc.exp);
  check("deployer is classified but not default-expired before near-expiry guards", credentialLifetime("deployer").defaultTtlSeconds === undefined, credentialLifetime("deployer"));
  check("teardown is classified but not default-expired before near-expiry guards", credentialLifetime("teardown").defaultTtlSeconds === undefined, credentialLifetime("teardown"));

  const expired = newIdentity();
  const expiredCreds = await mintCreds(auth, expired, "probe", { expiresAt: now - 1 });
  check("expired copied cred is broker-denied on connect", await tryConnect(expiredCreds, expired.id) === "rejected");
  // D5 slice 6: the probe CLASSIFIES credential death — a provably-expired cred is "stale-auth"
  // (repair: doctor auth), never conflated with "wrong creds" or "mesh down". The classification
  // reads the cred's own JWT exp LOCALLY, so it does not depend on the connect outcome — it can't be
  // flaked by a slow CI/Windows handshake racing the broker's rejection against the socket close.
  const staleProbe = await probeConnect(SERVERS, { creds: expiredCreds });
  check("probeConnect classifies an expired cred as stale-auth (the structured diagnostic)", !staleProbe.ok && staleProbe.reason === "stale-auth", staleProbe);
  // Reachability-independent BY CONSTRUCTION: the same expired cred against a broker that never
  // answers is still stale-auth (the dead cred is the actionable truth). This is the exact scenario
  // that used to flake — a bare transport failure instead of a clean AuthorizationError — and it now
  // resolves deterministically on every OS regardless of connect latency.
  const deadProbe = await probeConnect("nats://127.0.0.1:1", { creds: expiredCreds, timeoutMs: 500 });
  check("probeConnect classifies an expired cred as stale-auth even when unreachable (the flake, killed)", !deadProbe.ok && deadProbe.reason === "stale-auth", deadProbe);

  const fresh = newIdentity();
  const freshCreds = await mintCreds(auth, fresh, "probe", { expiresInSeconds: 60 });
  check("fresh bounded cred connects", await tryConnect(freshCreds, fresh.id) === "ok");

  const live = newIdentity();
  const liveCreds = await mintCreds(auth, live, "operator", { expiresInSeconds: 6 });
  const liveCredsPath = join(dir, "live.creds");
  writeFileSync(liveCredsPath, liveCreds, { mode: 0o600 });
  const expiryChild = spawn(process.execPath, ["--import", "tsx", SELF, "expiry-child", SERVERS, space, liveCredsPath, live.id], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let expiryOutput = "";
  expiryChild.stdout?.on("data", (chunk) => { expiryOutput += String(chunk); });
  expiryChild.stderr?.on("data", (chunk) => { expiryOutput += String(chunk); });
  await awaitExit(expiryChild, 12_000);
  if (expiryChild.exitCode === null && expiryChild.signalCode === null) expiryChild.kill("SIGKILL");
  const closeLine = expiryOutput.split("\n").find((line) => line.startsWith("EXPIRY_CHILD_CLOSED "));
  const closeReason = closeLine ? JSON.parse(closeLine.slice("EXPIRY_CHILD_CLOSED ".length)) as { name?: string; message?: string; reconnectDisabled?: boolean; endpointErrors?: string[] } : undefined;
  check(
    "CotalEndpoint disables library reconnect before credential expiry, nc.closed() resolves with the expiry error, and the process stays alive",
    expiryChild.exitCode === 0 && closeReason?.reconnectDisabled === true && closeReason.name === "UserAuthenticationExpiredError" && closeReason.message === "User Authentication Expired",
    { exitCode: expiryChild.exitCode, signal: expiryChild.signalCode, closeReason, output: expiryOutput },
  );
} finally {
  srv.kill();
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}

if (fail) {
  console.error(`\nCREDENTIAL LIFETIME TEST FAILED (${fail} failed, ${pass} passed)`);
  process.exit(1);
}
console.log(`\nCREDENTIAL LIFETIME TEST PASSED ✅  (${pass} checks)`);
