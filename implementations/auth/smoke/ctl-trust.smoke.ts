/**
 * Gate-1 CONTROL-PLANE TRUST live smoke (the security lane's 4 cases) — pins the assumptions the
 * manager makes about a control caller's principal against a REAL user-auth broker + REAL callout,
 * for CALLOUT-MINTED user-mode connections (not the static/dev creds every other control test uses).
 *
 * The manager trusts the ctl caller's principal from the SUBJECT (`ctl.<tier>.<owner>.<actor>`) after
 * serveControl's two guards. That trust is only sound if the BROKER actually forge-locks the subject's
 * identity slots to the connection's minted grant, and the guards reject a payload that disagrees. This
 * stands up the real pieces and proves both halves at once:
 *
 *   (a) PAYLOAD FORGE   — A.cli sends a control request on its OWN subject but with a payload `from.id`
 *                         claiming A.victim; serveControl's `req.from.id === subject-sender` guard rejects
 *                         it BEFORE the handler runs (error reply, handler never recorded it).
 *   (b) SELF-SUBJECT FORGE — A.cli raw-publishes onto ctl.<A>.victim (its own owner, another actor); the
 *                         BROKER denies the publish (the mint grants only ctl.<A>.cli) — the manager never sees it.
 *   (c) CROSS-OWNER     — A.cli raw-publishes onto ctl.<B>.cli (another owner); the broker denies it too.
 *   (d) REPLY ESCAPE    — A.cli sends a well-formed request on its own subject but points the reply at a
 *                         PEER's reply lane (ctl.<B>.cli.reply.… — exactly the confused-deputy condition
 *                         `boundReply` closes); boundReply drops it before the handler, and a privileged
 *                         witness on that lane confirms nothing lands.
 *
 * The bearers are minted DIRECTLY by the production issuer against a real actor ledger (no IdP HTTP
 * exchange); the callout runs in-process on the callout-account connection; the "manager" is a
 * CotalEndpoint on a static supervisor cred serving CONTROL_PRIVILEGED with { boundReply: true }.
 * Every subject comes from core's controlServiceSubject/CONTROL_PRIVILEGED — never a hand-rolled string.
 *
 * COTAL_HOME-free (no workspace state); kills only the nats-server it starts, by exact PID.
 * Run: npx tsx implementations/auth/smoke/ctl-trust.smoke.ts   (needs nats-server on PATH)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, tokenAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import {
  CotalEndpoint, createSpaceAuth, isReachable, mintCreds, newIdentity, serverConfig,
  principalKey, controlServiceSubject, CONTROL_PRIVILEGED,
  type ControlRequest, type ControlReply,
} from "@cotal-ai/core";
import {
  createCalloutAuth, startAuthCallout, calloutPermissions,
  createUserTokenIssuer, generateSigningKey,
  deriveOwnerToken, grantActor, ledgerAclResolver, ledgerAuthorizeConnect,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const enc = (s: string) => new TextEncoder().encode(s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 2000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await wait(25);
  return cond();
};
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

// ---------- a real operator-mode broker with the callout account preloaded ----------
const space = `ctltrust-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const callout = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
const dir = mkdtempSync(join(tmpdir(), "cotal-ctltrust-"));
writeFileSync(
  join(dir, "server.conf"),
  serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js"), extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }] }),
);
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });

// ---------- the actor ledger + the two owners (derived, per the flip's owner grammar) ----------
const SECRET = "s".repeat(32);
const ISS = "https://auth.cotal.test";
const ledgerDir = mkdtempSync(join(tmpdir(), "cotal-ctltrust-ledger-"));
const ownerA = deriveOwnerToken(SECRET, "idp-subject-A");
const ownerB = deriveOwnerToken(SECRET, "idp-subject-B");
const ACL = { allowSubscribe: ["general"], allowPublish: ["general"] };
const aCliRow = grantActor(ledgerDir, { owner: ownerA, actor: "cli", scope: ["spawn"], ...ACL });     // spawn-capable ⇒ holds ctl.<A>.cli
grantActor(ledgerDir, { owner: ownerA, actor: "victim", scope: [], ...ACL });          // no spawn ⇒ no ctl grant of its own
grantActor(ledgerDir, { owner: ownerB, actor: "cli", scope: ["spawn"], ...ACL });      // a different owner's spawn-capable actor

// ---------- the production issuer: mint A.cli's bearer directly (no IdP HTTP exchange) ----------
// Lifecycle-bound to A.cli's row uid (SPEC 13.1): a directly-minted bearer must carry the row's
// lifecycleUid or the callout's connect equality check refuses it.
const issuer = createUserTokenIssuer({ issuer: ISS, key: await generateSigningKey() });
const bearerAcli = await issuer.issue({ owner: ownerA, space, actor: "cli", scope: ["spawn"], lifecycleUid: aCliRow.lifecycleUid, ttlSec: 300 });

let calloutNc: NatsConnection | undefined, witnessNc: NatsConnection | undefined, ncA: NatsConnection | undefined;
let managerEp: CotalEndpoint | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  // ---------- the auth callout, wired to the real ledger (connect boundary + channel ACL) ----------
  calloutNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(callout.calloutCreds)) });
  await wait(300);
  startAuthCallout(calloutNc as never, {
    xkeySeed: callout.xkey.seed,
    authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
    dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    space,
    token: { key: issuer.localKeySet(), issuer: ISS },
    authorizeActor: ledgerAuthorizeConnect(ledgerDir),
    permissionsFor: calloutPermissions(ledgerAclResolver(ledgerDir)),
    log: () => {},
  });

  // ---------- the "manager": a static supervisor cred serving CONTROL_PRIVILEGED (boundReply) ----------
  const supervisorCreds = await mintCreds(auth, newIdentity(), "supervisor");
  managerEp = new CotalEndpoint({
    space, servers: SERVERS, creds: supervisorCreds,
    card: { name: "manager", kind: "agent" },
    registerPresence: false, watchPresence: false, watchChannels: false, consume: false,
  });
  const managerErrors: string[] = [];
  managerEp.on("error", (e: Error) => managerErrors.push(e.message)); // serveControl emits on every rejection
  await managerEp.start();
  const handled: ControlRequest[] = []; // records ONLY requests that pass both guards + reach the handler
  managerEp.serveControl(
    CONTROL_PRIVILEGED,
    (req) => { handled.push(req); return { ok: true, data: { echoedOp: req.op } }; },
    { boundReply: true },
  );
  await wait(300); // let the ctl.<tier>.*.* subscription register on the server

  // ---------- a privileged witness on B.cli's reply lane (the confused-deputy target for check d) ----------
  const witnessCreds = await mintCreds(auth, newIdentity(), "admin"); // admin sub.allow = cotal.<space>.>
  witnessNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(witnessCreds)) });
  const bReplyLane = `${controlServiceSubject(space, CONTROL_PRIVILEGED, ownerB, "cli")}.reply.>`;
  const escapeLanded: string[] = [];
  witnessNc.subscribe(bReplyLane, { callback: (err, m) => { if (!err) escapeLanded.push(m.subject); } });
  await witnessNc.flush();

  // ---------- connect A.cli USER-MODE (sentinel + bearer → callout mints its scoped grant) ----------
  const nonceA = `ibx${randomUUID().replace(/-/g, "")}`;
  ncA = await connect({
    servers: SERVERS,
    authenticator: [credsAuthenticator(enc(callout.sentinelCreds)), tokenAuthenticator(bearerAcli)],
    maxReconnectAttempts: 0, timeout: 4000, name: nonceA, inboxPrefix: `_INBOX_${nonceA}`,
  });
  // Collect broker permission-violation errors (surfaced as `{ type: "error" }` status events). Sliced
  // per-publish below — the only error source on THIS connection is a denied pub/sub, so a `/permission/i`
  // hit in a publish's window is that publish's denial.
  const permErrors: string[] = [];
  void (async () => { for await (const s of ncA!.status()) { if (s.type === "error") permErrors.push(String((s as { error?: Error }).error?.message ?? "")); } })().catch(() => {});
  check("setup: A.cli connects user-mode via the callout (valid bearer + granted actor)", !!ncA);

  // Subjects + principal dot-forms — ALL from core's builders (never hand-rolled).
  const reqA = controlServiceSubject(space, CONTROL_PRIVILEGED, ownerA, "cli");
  const subjAvictim = controlServiceSubject(space, CONTROL_PRIVILEGED, ownerA, "victim");
  const subjBcli = controlServiceSubject(space, CONTROL_PRIVILEGED, ownerB, "cli");
  const idAcli = principalKey(ownerA, "cli").key;       // == parseSubject(reqA).sender
  const idAvictim = principalKey(ownerA, "victim").key; // the forged claim in (a)/(b)
  const idBcli = principalKey(ownerB, "cli").key;

  // Build the raw ControlRequest requestControl would send, but with a caller-chosen `from` + reply.
  const reqBody = (op: string, fromId: string): Uint8Array =>
    enc(JSON.stringify({ op, from: { id: fromId, name: "acli" } } satisfies ControlRequest));
  const requestOn = async (subject: string, op: string, fromId: string, replyUnder: string): Promise<ControlReply | undefined> => {
    try {
      const m = await ncA!.request(subject, reqBody(op, fromId), { noMux: true, reply: `${replyUnder}.reply.${randomUUID()}`, timeout: 2500 });
      return JSON.parse(new TextDecoder().decode(m.data)) as ControlReply;
    } catch { return undefined; }
  };

  // ---------- POSITIVE CONTROL: a legit A.cli request reaches + is recorded by the handler ----------
  // Makes every negative assertion below meaningful: it proves the manager serves, and that a request
  // which passes the guards IS recorded — so "not recorded" downstream is a real rejection, not silence.
  const pos = await requestOn(reqA, "sanity", idAcli, reqA);
  check(
    "setup: manager serves A.cli's legit privileged request (ok reply, handler recorded it)",
    pos?.ok === true && handled.some((r) => r.op === "sanity" && r.from.id === idAcli),
    { pos, handled: handled.map((h) => h.op) },
  );

  // ---------- (a) PAYLOAD FORGE ----------
  const forge = await requestOn(reqA, "forge-payload", idAvictim, reqA);
  check(
    "(a) payload from.id forge (claims A.victim on A.cli's own subject) is rejected before the handler",
    forge?.ok === false && /sender mismatch/i.test(forge?.error ?? "") && !handled.some((r) => r.op === "forge-payload"),
    { forge, handled: handled.map((h) => h.op) },
  );

  // ---------- (b) SELF-SUBJECT FORGE ----------
  const beforeB = permErrors.length;
  ncA.publish(subjAvictim, reqBody("self-forge", idAvictim));
  await ncA.flush().catch(() => {});
  const deniedB = await until(() => permErrors.slice(beforeB).some((e) => /permission/i.test(e)));
  check(
    "(b) self-subject forge (publish to ctl.<A>.victim) is broker-denied; the manager never sees it",
    deniedB && !handled.some((r) => r.op === "self-forge"),
    { deniedB, perm: permErrors.slice(beforeB), handled: handled.map((h) => h.op) },
  );

  // ---------- (c) CROSS-OWNER ----------
  const beforeC = permErrors.length;
  ncA.publish(subjBcli, reqBody("cross-owner", idBcli));
  await ncA.flush().catch(() => {});
  const deniedC = await until(() => permErrors.slice(beforeC).some((e) => /permission/i.test(e)));
  check(
    "(c) cross-owner forge (publish to ctl.<B>.cli) is broker-denied; the manager never sees it",
    deniedC && !handled.some((r) => r.op === "cross-owner"),
    { deniedC, perm: permErrors.slice(beforeC), handled: handled.map((h) => h.op) },
  );

  // ---------- (d) REPLY ESCAPE ----------
  // A.cli publishes a well-formed request on its OWN subject (broker-allowed) but points the reply at a
  // PEER's reply lane — ctl.<B>.cli.reply.<uuid> — which the supervisor cred CAN publish to
  // (ctl.<tier>.*.*.reply.>). Only boundReply stops the manager from becoming a confused deputy here.
  const escapeReply = `${controlServiceSubject(space, CONTROL_PRIVILEGED, ownerB, "cli")}.reply.${randomUUID()}`;
  const escapeBefore = escapeLanded.length;
  ncA.publish(reqA, reqBody("reply-escape", idAcli), { reply: escapeReply });
  await ncA.flush().catch(() => {});
  await wait(1500);
  check(
    "(d) reply escape (reply target on a peer's reply lane) is dropped by boundReply; handler not invoked, nothing lands on the lane",
    !handled.some((r) => r.op === "reply-escape") &&
      escapeLanded.length === escapeBefore &&
      managerErrors.some((e) => /reply target .* is not under the sender/i.test(e)),
    { handled: handled.map((h) => h.op), escapeLanded: escapeLanded.slice(escapeBefore), managerErrors },
  );

  console.log(`\nCTL-TRUST SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  for (const nc of [ncA, witnessNc, calloutNc]) { try { await nc?.close(); } catch { /* */ } }
  try { await managerEp?.stop(); } catch { /* */ }
  srv.kill("SIGKILL"); // exact PID — never pkill nats-server
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  rmSync(ledgerDir, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
