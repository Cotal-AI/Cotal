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
 * ⚠️ STANDING AT THIS EDIT — RUNS, DOES NOT PASS, AND ITS LAST DIAGNOSIS WAS UNSOUND.
 * The earlier "BLOCKED — `implementations/auth` has no `node_modules`" header is discharged: it has
 * one, the probe loads, and it ran once (`EXIT=1`, 2 passed / 1 failed / 7 VOID). Three defects came
 * out of that run. Defect 1 (the fixture minted a 960s token against a 900s lifetime cap) is FIXED
 * below. Defects 2 and 3 are open, and defect 2's stated cause does not survive being checked:
 *
 * **DEFECT 2 — `U0` fails, and "the callout rejects the correctly-signed bearer" was an
 * ATTRIBUTION, not an observation.** The evidence for it was one line in the callout's log,
 * `auth callout: denied <user_nkey>: signature verification failed`, read while BOTH arms were
 * connecting concurrently. `req.user_nkey` is minted per connect by the server, so it names no
 * agent — and `BAD` is the arm that is SUPPOSED to produce exactly that string. One denial line and
 * two candidate authors is not evidence about either. The connector's own stderr does not break the
 * tie: `agent.ts:1138` writes `[cotal-connector] endpoint error: …` with **no agent name**, so two
 * MeshAgents in one process are indistinguishable in the log — recorded as a product gap, not
 * patched from here.
 *
 * Driven, with no broker at all (`implementations/auth/m7d2-token-only.mts`): the fixture's own
 * token, minted by the body below and handed to `validateUserToken` with the key this probe pins
 * into the callout, **VERIFIES** — while a wrong-key token is refused for the signature, so the
 * validator was verifying. **The fixture is exonerated; whatever fails `U0` is not the token.**
 *
 * So the arms below are SEQUENCED rather than concurrent, which is what makes any denial line
 * attributable: `S` runs alone in its own window, then `BAD` starts against a log cursor taken
 * after `S` settled. What that costs and what it preserves is stated at the arms themselves.
 *
 * **DEFECT 4 — FOUND BY THE SEQUENCED RUN, and it is what actually fails `U0`.** With attribution
 * fixed, the run said: `[diag] S window: bearer execs 0 -> 1, callout said []`. **The good bearer
 * was fetched, and the callout said NOTHING about it** — every `signature verification failed` line
 * arrives after `BAD` starts. So the withdrawn sentence was not merely unsupported, it is
 * **refuted**: the callout never refused the correctly-signed bearer.
 *
 * What refuses is one line further down, counted (not eyeballed) at 111 occurrences in the
 * same log — and 56 of those fall in S's OWN window, i.e. before `BAD` had started, which is what
 * makes them S's rather than the log's:
 *   `cannot publish "$JS.API.CONSUMER.INFO.TASK_<space>.svc_worker" - check this endpoint's ACLs`
 * The bearer authenticates; the MINTED PERMISSIONS do not reach the role consumer. Cause: this
 * fixture's ACL resolver omitted `role`, so the mint took the `opts.role ? … : undefined` branch
 * (`packages/core/src/provision.ts:1073`) and never granted the bind — while the fixture had
 * already provisioned `svc_worker` and built the agent with `role: "worker"`. **A FIXTURE bug, the
 * twin of defect 1: the real path supplies `role` from the ledger row (`ledgerAclResolver`,
 * `implementations/auth/src/service.ts:461`), so nothing here indicts the product.** Fixed below.
 *
 * **PREDICTION, WRITTEN BEFORE THE RE-RUN so it cannot be fitted to a result:**
 *  1. `U0 CONTROL` flips **FAIL → pass**;
 *  2. occurrences of `JS.API.CONSUMER.INFO.TASK` in the run log go from **111 → 0** — a named,
 *     discriminating string with a COUNTED baseline (`grep -c` over
 *     `runs/2026-08-15T0226Z-m7-usermode.txt`), not "the suite got greener". The number is 111 and
 *     not the "~30" I first wrote from reading the log: each failure prints two lines, and an
 *     eyeballed count is the kind of estimate this lane is not allowed to make;
 *  3. the seven `U2`–`U8` cells stop being **VOID** and report real results, whatever they are.
 * **Refutation:** if `U0` still fails, `role` was not the cause and I say so rather than adjusting
 * the claim. If (2) holds while `U0` still fails, there is a THIRD condition and it will be named
 * from the log, not guessed. **Cells `U2`–`U8` reporting green is NOT part of this prediction** —
 * they have never once run, and a first run is a measurement, not a confirmation.
 *
 * **DEFECT 3 — the probe printed its verdict and never exited**, sitting in the connector's
 * reconnect loop until a 10-minute timeout killed it at `143`. `143` is the timeout's number, not a
 * verdict. Handled at the end of `finally`, where the reason is written out.
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
// LATCH HOLE CLOSED. `precondition` used to count a pass even after an EARLIER precondition on the
// same arm had failed — only `armCheck` voided. mc-rev-evidence found it, and my own two
// `UX ATTRIBUTION` cells inherited it: in the 0226Z run they reported GREEN on a fixture where the
// good bearer never connected, so "the callout verifies, so this is really user mode" passed on an
// arm that could not have differed. A fix can be correct and still be built on the defect it did
// not know it was standing on.
// A voided precondition still PRINTS its observed values — the diagnosis is why the run is worth
// reading — but it is no longer counted as a pass, because it is not evidence.
const precondition = (arm: string, name: string, cond: boolean, extra?: unknown) => {
  if (contaminated.has(arm)) {
    voided++;
    console.log(`  ⊘ VOID (${arm} contaminated by an earlier precondition — observed, not evidence): ${name}`, extra ?? "");
    return;
  }
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
    // exp is now+780, NOT now+900. The 60s back-date on iat/nbf is deliberate (clock-skew
    // tolerance), and `verifyUserToken` caps the token's LIFETIME — `exp - iat`, token.ts:159-160 —
    // not its remaining validity. now+900 against a back-dated iat therefore mints a 960s token
    // and the callout refuses every bearer this fixture signs, including the correctly-signed one.
    // That is a FIXTURE bug: the 900s cap (token.ts:30) is the product behaving exactly as
    // specified. 780 leaves the lifetime at 840s, off the boundary rather than exactly on it.
    .setIssuedAt(now - 60).setNotBefore(now - 60).setExpirationTime(now + 780)
    .sign(key);
};
writeFileSync(tokenFile, await signBearer(privateKey as CryptoKey));
writeFileSync(badTokenFile, await signBearer(wrong.privateKey as CryptoKey));

const calloutLog: string[] = [];
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
    // DEFECT 4, and it is defect 1's twin: the fixture asked the product for LESS than it then
    // required. `role` was omitted from this resolver, so the mint took the `opts.role ? … :
    // undefined` branch (`packages/core/src/provision.ts:1073`) and granted no bind on the role's
    // TASK durable — while the same fixture had already provisioned `svc_worker` and constructed
    // the subject with `role: "worker"`. The bearer was ACCEPTED and the session then could not
    // bind, retrying forever on
    //   `cannot publish "$JS.API.CONSUMER.INFO.TASK_<space>.svc_worker"`.
    // That string was printed 111 times in the previous run (`grep -c`, not read off the screen),
    // next to the single callout line that
    // was read instead — the evidence was never missing, it was passed over for one that named a
    // cause instead of a condition.
    permissionsFor: calloutPermissions(() => ({ allowSubscribe: ["general"], allowPublish: ["general"], role: "worker", lifecycleUid: uid, scope: [] })),
    // Captured, not just printed. The arms below slice this by cursor to attribute a denial to the
    // connection that caused it — `req.user_nkey` is per-connect and names no agent, so ordering is
    // the only attribution available without changing the product.
    log: (l) => { if (/denied|drop|fail/i.test(l)) { calloutLog.push(l); console.log("  [callout]", l); } },
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

  console.log("\n=== U0 then UX: is the callout REALLY verifying? (SEQUENCED arms, one live window) ===");
  // WHY SEQUENCED, AND WHAT IT COSTS. Run concurrently, the two arms share one callout log in which
  // `req.user_nkey` names no agent — so a denial line has two candidate authors and attributing it
  // to either is a guess. Run in order, every line printed between two cursors belongs to the only
  // connection that was being attempted between them.
  // The property the concurrent form was bought for is PRESERVED: UX is still asserted inside a
  // window in which the good bearer is CONNECTED — S is up and stays up while BAD is tried — so
  // "BAD did not connect" still cannot mean "the broker/callout was not answering yet".
  S = new MeshAgent(cfg);
  const cursorS = calloutLog.length;
  const execsAtStart = execCount();
  S.start(300);
  for (let i = 0; i < 90 && !S.connected; i++) await sleep(150);
  const deniedS = calloutLog.slice(cursorS);
  // Diagnostic, not an assertion: if U0 fails again, this says in the SAME window whether the
  // failure is upstream or downstream of the callout. Bearer execs > 0 means the session fetched a
  // token and something rejected it; execs == 0 means it never got that far and the callout was
  // never the thing refusing — a distinction the last run could not make, and the reason it needed
  // a second window to learn anything.
  console.log(`  [diag] S window: bearer execs ${execsAtStart} -> ${execCount()}, callout said ${JSON.stringify(deniedS)}`);
  precondition("USER", "U0 CONTROL: the SAME fixture with a correctly-signed bearer DOES connect (so UX's arms could differ)",
    S.connected, { connected: S.connected, bearerExecs: execCount() - execsAtStart, calloutSaidWhileOnlyThisArmWasConnecting: deniedS });

  BAD = new MeshAgent(badCfg);
  const cursorBad = calloutLog.length;
  BAD.start(300);
  for (let i = 0; i < 40 && !BAD.connected; i++) await sleep(150);
  const deniedBad = calloutLog.slice(cursorBad);
  precondition("USER", "UX a bearer signed by the WRONG key does NOT connect — the callout verifies, so this is really user mode",
    !BAD.connected, { bad: BAD.connected, good: S.connected });
  // Not-connected is a weak signal on its own: an arm that never attempted looks identical. The
  // callout must have SEEN this bearer and refused it, and refused it for the SIGNATURE — a denial
  // naming ttl/aud/shape would mean UX proves something other than "the callout verifies keys".
  precondition("USER", "UX ATTRIBUTION: the callout logged a SIGNATURE denial in the window where BAD was the only arm connecting",
    deniedBad.some((l) => /signature verification failed/i.test(l)), { deniedBad, deniedS });
  precondition("USER", "UX ATTRIBUTION: and S's own window carried NO signature denial — so the good bearer was never the one refused",
    !deniedS.some((l) => /signature verification failed/i.test(l)), { deniedS });
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
  // LABEL CORRECTED, same defect as E5: this asserts a substring is present, not that anything is
  // distinguishable. A stale heartbeat leaves the same text standing.
  armCheck("USER", "U5 the cause STRING is displayed in user mode too (display only — NOT a discrimination claim; see DESIGN 9.1)",
    /m7-usermode/.test(String(seen()?.activity ?? "")), seen());

  const c = await run("cotal_connect", {});
  // LABEL FIXED AFTER THE RUN THAT REFUTED IT. This cell used to read "…— a fresh bearer is
  // obtained, not a cached grant reused", while asserting only `!c.isError`. The half after the
  // dash was asserted by nothing, and `U8` two cells below proved it FALSE in the same run: the
  // bearer command was not re-exec'd. A green cell claiming what the failing cell beside it
  // refutes. The name now says exactly what the assertion covers, and no more.
  armCheck("USER", "U6 the user-mode agent brings ITSELF back — the verb returns success (says NOTHING about where the credential came from; that is U8)",
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
  // DEFECT 3. Every handle this probe owns is closed above, and the process still does not exit —
  // the connector's reconnect loop keeps the event loop alive, so the last run printed its verdict
  // and then sat until an external 10-minute timeout killed it at 143. A suite that has to be killed
  // hands you the KILLER's exit code, not its own. Exit on the verdict this run produced.
  process.exit(process.exitCode ?? 0);
}
