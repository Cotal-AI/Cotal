/**
 * M7 drive: the connection verbs in USER MODE (bearer + callout), end to end.
 *
 * WHY THIS EXISTS. The authed arm in `extensions/connector-core/smoke/connection-control.smoke.ts`
 * is STATIC-CREDS only. User mode is proven at the tool gate (G3/G4) and nowhere past it, and
 * `implementations/auth/smoke/endpoint-usermode.smoke.ts` proves the ENDPOINT half but never drives
 * `MeshAgent` — nothing in the repo drives the CONNECTOR in user mode. So the mode most deployments
 * use is, for these verbs, the mode nobody has run.
 *
 * WHAT THIS ARM CAN PROVE THAT THE STATIC-CREDS ARM CANNOT. A static credential is a string the
 * session already holds; re-presenting it is nearly free. A user-mode session holds no credential —
 * it holds a COMMAND, re-EXEC'd per connect attempt (`agent.ts:202`, a getter). So the question
 * "does a self-directed reconnect re-present authority, or reuse a cached grant?" is only ANSWERABLE
 * here, and `U8` answers it by counting execs across the disconnect/connect pair.
 *
 * REFUTATION CONDITIONS, stated before any result is cited:
 *  - `UX` is refuted if a bearer signed by the WRONG key connects anyway. Then the callout is not
 *    verifying, this is not user mode, and U0-U8 are a rename of the open-mode arm. Its inverse
 *    control is U0: the SAME fixture with a correctly-signed bearer must connect, in the same
 *    window, or "did not connect" means "was slow".
 *  - The observable-departure claim is refuted if the independent witness does not see the subject
 *    go offline after a self-disconnect, or sees it offline without the disconnect being called.
 *  - `U8` is refuted if the bearer command exec count does NOT rise across a disconnect/connect
 *    pair — the session would be reusing authority it was granted before it deliberately left.
 *
 * Run: copy to `implementations/auth/` first (its imports are package-relative), then
 *   node_modules/.bin/tsx implementations/auth/meshctl-m7-usermode.mts
 * Needs `nats-server` on PATH. Local-only, loopback-only.
 *
 * ⚠️ NOT YET RUN — BLOCKED ON THIS WORKTREE, NOT ON THE DESIGN. `implementations/auth` has no
 * `node_modules` here, so the auth package cannot load at all:
 *
 *   Cannot find package '@nats-io/jwt' imported from implementations/auth/src/callout.ts
 *
 * The worktree carries a PARTIAL dependency farm — `packages/core`, `packages/workspace`,
 * `implementations/{cli,delivery,manager}` are symlinked to the principal checkout and
 * `extensions/connector-core` is a real dir, but `implementations/auth` (and eight others) are
 * missing. Every leg this lane ran until now lived in a package that happened to have one.
 *
 * Refutation stated before the diagnosis was cited: *if importing `implementations/auth/src/index.js`
 * succeeded, the blocker would be this probe rather than the worktree.* It failed, on a dependency
 * this probe never names.
 *
 * NOT worked around on purpose. Creating the missing symlink would point this worktree's resolution
 * into the principal checkout — a shared side effect across worktrees, invisible to `git status`,
 * which is the exact hazard class that put every result on this lane under review tonight. Routed to
 * fm-orchestrator instead. **NO CELL BELOW HAS EVER REPORTED A RESULT; treat the whole file as
 * unrun.**
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { SignJWT, generateKeyPair } from "jose";
import {
  CotalEndpoint, createSpaceAuth, isReachable, mintCreds, newIdentity, serverConfig,
  setupSpaceStreams, provisionAgentDurables, mintLifecycleUid,
} from "@cotal-ai/core";
import { createCalloutAuth, calloutPermissions, deriveOwnerToken, startAuthCallout, USER_TOKEN_VER } from "./src/index.js";
import { pickFreePort } from "./smoke/_free-port.js";

// ---- FIRST ACTION: never the live broker, and never anything inherited ------------------------
for (const k of Object.keys(process.env)) if (/^COTAL_(SERVERS|CREDS|SPACE|NAME|ID|CONTROL_|LIFECYCLE)/.test(k)) delete process.env[k];
const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
if (SERVERS.includes("broker.cotal.ai")) throw new Error(`REFUSING: ${SERVERS} is the live broker`);
if (!/^nats:\/\/127\.0\.0\.1:\d+$/.test(SERVERS)) throw new Error(`REFUSING: ${SERVERS} is not loopback`);
console.log(`[safety] target=${SERVERS} — asserted not broker.cotal.ai, loopback only; inherited COTAL_* deleted`);

let pass = 0, fail = 0, voided = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
// Carried from the connector suite, where a broken fixture produced two GREEN cells asserting a
// property it could not possibly have exercised. Built in from the start here rather than retrofitted.
const contaminated = new Set<string>();
const precondition = (arm: string, name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ PRE-${arm}: ${name}`); }
  else { fail++; contaminated.add(arm); console.log(`  ✗ FAIL PRE-${arm}: ${name}`, extra ?? ""); }
};
const armCheck = (arm: string, name: string, cond: boolean, extra?: unknown) => {
  if (contaminated.has(arm)) { voided++; console.log(`  ⊘ VOID (${arm} fixture contaminated upstream): ${name}`); return; }
  check(name, cond, extra);
};

const enc = (s: string) => new TextEncoder().encode(s);
const space = `m7user-${randomUUID().slice(0, 8)}`;
const uid = mintLifecycleUid();
const auth = await createSpaceAuth(space);
const callout = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
const dir = mkdtempSync(join(tmpdir(), "meshctl-m7-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], {
  transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js"),
  extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }],
}));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore", detached: true });
const pgid = srv.pid!;
console.log(`[broker] nats-server pid/pgid=${pgid} store=${dir}`);

// The bearer arrives from a COMMAND, not a field. `cat` of a token file is a legitimate bearer
// command — the exchange protocol lives entirely behind the argv and the runtime just runs it and
// reads a line — and it lets the fixture count execs, which is the whole point of U8.
const tokenFile = join(dir, "bearer.jwt");
const countFile = join(dir, "bearer.execs");
const badTokenFile = join(dir, "bearer-wrongkey.jwt");
const bearerCmd = ["sh", "-c", `echo x >> "${countFile}"; cat "${tokenFile}"`];
const execCount = () => (existsSync(countFile) ? readFileSync(countFile, "utf8").trim().split("\n").filter(Boolean).length : 0);

const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const wrong = await generateKeyPair("EdDSA");
const ISS = "https://auth.cotal.test";
const OWNER = deriveOwnerToken("s".repeat(32), "better-auth|human-1");
const ACTOR = "agentone";
const signBearer = async (key: CryptoKey): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: OWNER, ver: USER_TOKEN_VER, act: { owner: OWNER, actor: ACTOR, scope: [], lifecycleUid: uid } })
    .setProtectedHeader({ alg: "EdDSA" }).setIssuer(ISS).setAudience(space).setSubject(OWNER)
    .setIssuedAt(now - 60).setNotBefore(now - 60).setExpirationTime(now + 900)
    .sign(key);
};
writeFileSync(tokenFile, await signBearer(privateKey as CryptoKey));
writeFileSync(badTokenFile, await signBearer(wrong.privateKey as CryptoKey));

let calloutNc: NatsConnection | undefined, witness: CotalEndpoint | undefined, prov: CotalEndpoint | undefined;
let S: any, BAD: any;
try {
  for (let i = 0; i < 80 && !(await isReachable(SERVERS)); i++) await sleep(150);

  const provCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: provCreds });

  calloutNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(callout.calloutCreds)) });
  await sleep(300);
  startAuthCallout(calloutNc as never, {
    xkeySeed: callout.xkey.seed,
    authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
    dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    space,
    token: { key: publicKey as never, issuer: ISS },
    authorizeActor: () => {},
    permissionsFor: calloutPermissions(() => ({ allowSubscribe: ["general"], allowPublish: ["general"], lifecycleUid: uid, scope: [] })),
    log: (l) => { if (/denied|drop|fail/i.test(l)) console.log("  [callout]", l); },
  });

  // The USER-MODE spawn path provisions durables WITHOUT minting a cred (the bearer is the
  // credential, callout-minted per connect) — the same call the real launcher makes.
  prov = new CotalEndpoint({
    space, servers: SERVERS, creds: provCreds, card: { name: "m7-prov", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false,
  });
  await prov.start();
  await provisionAgentDurables(prov as never, { owner: OWNER, actor: ACTOR, lifecycleUid: uid },
    { subscribe: ["general"], allowSubscribe: ["general"], role: "worker" });

  // An INDEPENDENT witness on a directly-minted data-account cred — never the callout, so what it
  // reports is not the subject's own account vouching for itself.
  witness = new CotalEndpoint({
    space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "admin"),
    card: { name: "m7-witness", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: true,
  });
  await witness.start();
  const seen = (): { status?: string; activity?: string } | undefined => {
    const row = (witness!.getRoster() as any[]).find((p) => (p.name ?? p.card?.name) === "m7-subject");
    return row ? { status: row.status, activity: row.activity } : undefined;
  };

  const { MeshAgent } = await import("../../extensions/connector-core/src/agent.js");
  const { cotalToolSpecs } = await import("../../extensions/connector-core/src/tool-specs.js");
  const cfg: any = {
    space, name: "m7-subject", role: "worker", kind: "agent", servers: SERVERS,
    subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"], tls: false,
    userAuth: { owner: OWNER, actor: ACTOR, sentinelCreds: callout.sentinelCreds, bearerCmd },
    lifecycleUid: uid, capabilities: ["connection"],
  };
  const badCfg: any = {
    ...cfg, name: "m7-badbearer",
    userAuth: { ...cfg.userAuth, bearerCmd: ["sh", "-c", `cat "${badTokenFile}"`] },
  };

  console.log("\n=== UX/U0: is the callout REALLY verifying? (paired arms, same window) ===");
  S = new MeshAgent(cfg); BAD = new MeshAgent(badCfg);
  S.start(300); BAD.start(300);
  for (let i = 0; i < 90 && !S.connected; i++) await sleep(150);
  // UX is asserted in the window in which U0 succeeded, so "did not connect" cannot mean "was slow".
  precondition("USER", "UX a bearer signed by the WRONG key does NOT connect — the callout verifies, so this is really user mode",
    !BAD.connected, { bad: BAD.connected, good: S.connected });
  precondition("USER", "U0 CONTROL: the SAME fixture with a correctly-signed bearer DOES connect (so UX's arms could differ)",
    S.connected, { connected: S.connected });
  await BAD.stop().catch(() => { /* never came up */ });
  await sleep(1500);

  const specs = cotalToolSpecs(cfg, "smoke");
  const names = specs.map((s: any) => s.name);
  check("U1 the verbs are on the surface of a REAL user-mode + granted session",
    names.includes("cotal_disconnect") && names.includes("cotal_connect"), names);
  const run = async (tool: string, args?: any) => {
    const spec = specs.find((s: any) => s.name === tool);
    if (!spec) throw new Error(`fixture failed: ${tool} absent from the user-mode surface`);
    return spec.run(S, cfg, args);
  };
  armCheck("USER", "U2 CONTROL: the witness can see the user-mode subject at all, BEFORE anything is claimed about its departure",
    seen()?.status !== undefined && seen()!.status !== "offline", seen());

  console.log("\n=== the verbs, in user mode ===");
  const execsBefore = execCount();
  const d = await run("cotal_disconnect", { cause: "m7-usermode" });
  armCheck("USER", "U3 a USER-MODE self-disconnect succeeds through the real tool", !d.isError, d.text);
  armCheck("USER", "U4 the INDEPENDENT witness sees it offline — observable departure holds in user mode too",
    await (async () => { for (let i = 0; i < 40; i++) { if (seen()?.status === "offline") return true; await sleep(150); } return false; })(), seen());
  armCheck("USER", "U5 the cause travels with it, so a deliberate departure is not a crash",
    /m7-usermode/.test(String(seen()?.activity ?? "")), seen());

  const c = await run("cotal_connect", {});
  armCheck("USER", "U6 the user-mode agent brings ITSELF back — a fresh bearer is obtained, not a cached grant reused",
    !c.isError, c.text);
  armCheck("USER", "U7 CONTROL: the witness sees it back (so U4's offline was the disconnect, not a dead fixture)",
    await (async () => { for (let i = 0; i < 40; i++) { const s = seen(); if (s && s.status !== "offline") return true; await sleep(150); } return false; })(), seen());

  // THE CELL ONLY THIS ARM CAN HAVE. A static credential is already in hand; a user-mode session
  // holds a COMMAND. If the reconnect did not re-exec it, the session came back on authority it was
  // granted before it deliberately left — which is exactly what a revoked bearer must not survive.
  const execsAfter = execCount();
  armCheck("USER", "U8 the reconnect RE-EXEC'd the bearer command — authority is re-obtained on return, not reused from before the departure",
    execsAfter > execsBefore, { execsBefore, execsAfter });

  console.log(`\nM7 USER-MODE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed, ${voided} VOID)`);
  if (voided) console.log(`  ⚠ ${voided} cell(s) VOID — they did not run, so they are not evidence. Do not read this as coverage.`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  try { await S?.stop(); } catch { /* */ }
  try { await BAD?.stop(); } catch { /* */ }
  for (const ep of [witness, prov]) { try { await ep?.stop(); } catch { /* */ } }
  try { await calloutNc?.close(); } catch { /* */ }
  try { process.kill(-pgid, "SIGTERM"); } catch { /* already gone */ }
  for (let i = 0; i < 20 && srv.exitCode === null && srv.signalCode === null; i++) await sleep(100);
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  console.log("[cleanup] broker group signalled, scratch removed");
}
