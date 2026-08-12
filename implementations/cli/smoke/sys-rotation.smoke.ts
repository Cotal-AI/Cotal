/**
 * `$SYS` credential rotation smoke (issue #338) — the class-3 renewal that `renewal.ts` cannot do.
 *
 * `membership-observer.creds` and `connection-evictor.creds` carry a 30-day expiry and are
 * `rotation-renewed`: no resident process re-signs them. The bug this pins was that the only repair
 * the tooling named — "`cotal down` then a fresh `cotal up`" — did NOTHING: `up` mints the $SYS pair
 * only on the branch that CREATES the trust record, so re-upping an existing space reused the same
 * expired files and reported success, while the delivery daemon's membership feed stayed dead and
 * every `membership-rw` adoption was refused.
 *
 * Three layers:
 *
 *  1. `rotateSystemCreds` on a staged root: the generation advances, BOTH files are rewritten, and
 *     the data account + operator seed are untouched (this is why the repair is safe to run on a
 *     live space). A rotation for a space with no trust record throws instead of inventing one.
 *  2. Record/creds are ONE generation: the persisted trust record's system account is the issuer of
 *     the creds on disk. A writer that persisted the creds from a different (or pre-rotation) bundle
 *     would split them and hand the broker creds it will never honor.
 *  3. Live broker: started from the ROTATED config it REJECTS the pre-rotation observer, ACCEPTS
 *     both rotated $SYS creds, and still accepts a data-account cred minted BEFORE the rotation —
 *     the "your agents survive this" claim the repair copy makes, proven rather than asserted.
 *
 * Plus the copy-to-behavior link: `doctor auth`'s repair for an EXPIRED $SYS cred must name
 * `--rotate-sys`. That string regressing back to a bare `up` is the original bug, so it is a check.
 *
 * Run: pnpm smoke:sys-rotation   (needs nats-server on PATH)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  createSpaceAuth,
  credsClaims,
  inspectCredHealth,
  isReachable,
  mintCreds,
  mintConnectionEvictorCreds,
  mintLifecycleUid,
  mintMembershipObserverCreds,
  newIdentity,
  serverConfig,
} from "@cotal-ai/core";
import { getSpaceAuth, putSpaceAuth, rotateSystemCreds, SYSTEM_CREDS_FILES, workspaceSecretStore } from "@cotal-ai/workspace";
import { doctor } from "../src/commands/doctor.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";

let pass = 0,
  fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};
const enc = (s: string) => new TextEncoder().encode(s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SPACE = "sysrot";
const root = mkdtempSync(join(tmpdir(), "cotal-sysrot-"));
const cotal = (f: string) => join(root, ".cotal", f);
const obsPath = cotal(SYSTEM_CREDS_FILES[0]);
const evPath = cotal(SYSTEM_CREDS_FILES[1]);
mkdirSync(join(root, ".cotal", "auth"), { recursive: true });

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const storeDir = join(root, ".cotal", "nats");
const confPath = join(root, ".cotal", "auth", "server.conf");
let broker: ReturnType<typeof spawn> | undefined;

async function startBroker(): Promise<void> {
  broker = spawn("nats-server", ["-c", confPath], { stdio: "ignore" });
  for (let i = 0; i < 60 && !(await isReachable(SERVERS)); i++) await wait(100);
}
async function stopBroker(): Promise<void> {
  if (!broker) return;
  broker.kill("SIGTERM");
  await wait(400);
  broker = undefined;
}
/** Does the LIVE broker accept these exact creds? `reconnect:false` so a refusal resolves fast. */
async function accepts(creds: string): Promise<boolean> {
  try {
    const nc = await connect({ servers: SERVERS, timeout: 3000, reconnect: false, maxReconnectAttempts: 0, authenticator: credsAuthenticator(enc(creds)) });
    await nc.close();
    return true;
  } catch {
    return false;
  }
}

const origCwd = process.cwd();
try {
  // ── stage the #338 state: a provisioned space whose $SYS creds are already dead ────────────────
  const auth = await createSpaceAuth(SPACE);
  const store = workspaceSecretStore(root);
  await putSpaceAuth(store, auth); // strips the $SYS seed at rest — exactly what makes these unremintable
  const deadAt = Math.floor(Date.now() / 1000) - 60;
  const preObserver = await mintMembershipObserverCreds(auth, newIdentity(), { expiresAt: deadAt });
  writeFileSync(obsPath, preObserver, { mode: 0o600 });
  writeFileSync(evPath, await mintConnectionEvictorCreds(auth, newIdentity(), { expiresAt: deadAt }), { mode: 0o600 });
  // An agent cred from BEFORE the rotation: the thing an operator is afraid of losing.
  const agentCreds = await mintCreds(auth, newIdentity(), "agent", { lifecycleUid: mintLifecycleUid() });

  console.log("\n1) the repair copy names the rotation, not a bare `up`");
  const origLog = console.log, origErr = console.error;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { lines.push(a.join(" ")); };
  process.chdir(root);
  try {
    await doctor({ values: {}, positionals: ["auth"], raw: [] });
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.chdir(origCwd);
    process.exitCode = 0;
  }
  const out = lines.join("\n").replace(/\[[0-9;]*m/g, "");
  check("an expired $SYS cred is reported as a problem", out.includes("EXPIRED") && out.includes(SYSTEM_CREDS_FILES[0]), out);
  check("its repair names `up --rotate-sys`", out.includes("up --rotate-sys"), out);
  check("its repair is NOT the no-op bare re-`up`", !/then a fresh `?\w* ?up`? regenerates/.test(out), out);

  console.log("\n2) rotateSystemCreds: advances the authority, preserves the space");
  const before = await getSpaceAuth(store, SPACE);
  const rot = await rotateSystemCreds(root, SPACE);
  const after = await getSpaceAuth(store, SPACE);
  check("the system-account generation advances", (after?.gen ?? 0) === (before?.gen ?? 0) + 1, { before: before?.gen, after: after?.gen });
  check("a NEW system account is issued", after?.sys.pub !== before?.sys.pub);
  check("the DATA account is untouched (agent creds keep their issuer)", after?.account.pub === before?.account.pub);
  check("the broker operator seed is untouched (every account under it survives)", after?.operator.seed === before?.operator.seed);

  const obsAfter = readFileSync(obsPath, "utf8");
  const evAfter = readFileSync(evPath, "utf8");
  check("BOTH $SYS creds were rewritten", obsAfter !== preObserver && inspectCredHealth(evAfter).state === "healthy");
  check("the fresh observer is bounded, not immortal", inspectCredHealth(obsAfter).state === "healthy" && typeof credsClaims(obsAfter).exp === "number");
  check("the reported expiry is the observer's own", rot.expiresAt === credsClaims(obsAfter).exp, { reported: rot.expiresAt, actual: credsClaims(obsAfter).exp });

  console.log("\n3) the persisted record and the creds on disk are ONE generation");
  check("the observer on disk is issued by the PERSISTED system account", credsClaims(obsAfter).iss === after?.sys.pub, { iss: credsClaims(obsAfter).iss, sys: after?.sys.pub });
  check("the evictor on disk is issued by the PERSISTED system account", credsClaims(evAfter).iss === after?.sys.pub);
  check("neither is still issued by the RETIRED system account", credsClaims(obsAfter).iss !== before?.sys.pub && credsClaims(evAfter).iss !== before?.sys.pub);

  console.log("\n4) a space with no trust record refuses, it does not invent one");
  let refusal = "";
  try {
    await rotateSystemCreds(root, "no-such-space");
  } catch (e) {
    refusal = (e as Error).message;
  }
  check("rotating an unknown space throws", refusal.includes("no trust record"), refusal);

  console.log("\n5) live broker on the ROTATED config");
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(confPath, serverConfig(rot.auth, [rot.auth], { storeDir, port: PORT }));
  await startBroker();
  check("the broker came up on the rotated config", await isReachable(SERVERS));
  check("the ROTATED observer is accepted", await accepts(obsAfter));
  check("the ROTATED evictor is accepted", await accepts(evAfter));
  check("the PRE-rotation observer is REJECTED (the old authority is really retired)", !(await accepts(preObserver)));
  check("a data-account cred minted BEFORE the rotation still connects (agents survive)", await accepts(agentCreds));
} finally {
  await stopBroker();
  process.chdir(origCwd);
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "✓" : "✗"} sys-rotation smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
