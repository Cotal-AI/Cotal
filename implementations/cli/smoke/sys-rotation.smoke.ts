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
  composeSpaceAuth,
  createSpaceAccountAuth,
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
import { getSpaceAuth, putSpaceAuth, rotateSystemCreds, staleSystemCreds, SYSTEM_CREDS_FILES, workspaceSecretStore } from "@cotal-ai/workspace";
import { doctor } from "../src/commands/doctor.js";
import { up } from "../src/commands/up.js";
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
  // A HEALTHY pre-rotation observer. The on-disk pair above is deliberately EXPIRED (stage 1 needs
  // that state), but an expired cred proves nothing about retirement: the broker refuses it on exp
  // alone, so asserting its rejection after the rotation would pass even against a broker that still
  // trusted the old system account, and even against a rotator that never changed `system_account`.
  // Retirement is only shown by a cred the PRE-rotation broker ACCEPTS and the POST-rotation broker
  // refuses, with nothing but the loaded config differing between the two connects.
  const livePreObserver = await mintMembershipObserverCreds(auth, newIdentity());
  // Creds from BEFORE the rotation, one per standing class the success copy claims survives. The
  // claim is "every agent credential and both daemon creds"; proving it with a single agent cred
  // would leave the broader sentence asserted rather than shown.
  const agentCreds = await mintCreds(auth, newIdentity(), "agent", { lifecycleUid: mintLifecycleUid() });
  const preRotation: Array<[string, string]> = [
    ["agent", agentCreds],
    ["delivery", await mintCreds(auth, newIdentity(), "delivery")],
    ["membership-rw", await mintCreds(auth, newIdentity(), "membership-rw")],
    ["supervisor", await mintCreds(auth, newIdentity(), "supervisor")],
  ];

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

  console.log("\n1b) baseline: the PRE-rotation broker ACCEPTS the pre-rotation $SYS cred");
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(confPath, serverConfig(auth, [auth], { storeDir, port: PORT }));
  await startBroker();
  check("a healthy pre-rotation observer is ACCEPTED before the rotation", await accepts(livePreObserver));
  check("the already-expired observer is refused even HERE (so its later refusal proves nothing)", !(await accepts(preObserver)));
  await stopBroker();

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

  console.log("\n4b) the blast radius is broker-wide, so a multi-tenant root refuses");
  // A second tenant under the SAME broker operator. The rotation retires the system account for
  // BOTH, and this root holds one $SYS cred pair pinned to one data account — so it must refuse
  // rather than silently leave the neighbour unobservable. Guarded in the workspace export, not at
  // the CLI flag, so a hosted caller hits it too.
  const multiRoot = mkdtempSync(join(tmpdir(), "cotal-sysrot-multi-"));
  mkdirSync(join(multiRoot, ".cotal", "auth"), { recursive: true });
  const multiStore = workspaceSecretStore(multiRoot);
  const tenantA = await createSpaceAuth("tenant-a");
  await putSpaceAuth(multiStore, tenantA);
  await putSpaceAuth(multiStore, composeSpaceAuth(tenantA, await createSpaceAccountAuth(tenantA, "tenant-b")));
  const obsBefore = await mintMembershipObserverCreds(tenantA, newIdentity());
  writeFileSync(join(multiRoot, ".cotal", SYSTEM_CREDS_FILES[0]), obsBefore, { mode: 0o600 });
  let multiRefusal = "";
  try {
    await rotateSystemCreds(multiRoot, "tenant-a");
  } catch (e) {
    multiRefusal = (e as Error).message;
  }
  check("rotating a 2-tenant root refuses and names both spaces", multiRefusal.includes("broker-wide") && multiRefusal.includes("tenant-b"), multiRefusal);
  check("the refusal left the existing $SYS cred untouched", readFileSync(join(multiRoot, ".cotal", SYSTEM_CREDS_FILES[0]), "utf8") === obsBefore);
  const multiGen = (await getSpaceAuth(multiStore, "tenant-a"))?.gen ?? 0;
  check("the refusal did NOT advance the broker generation", multiGen === 0, multiGen);
  rmSync(multiRoot, { recursive: true, force: true });

  console.log("\n4c) --restore and --rotate-sys are refused together");
  // A restore reinstates a trust root; a rotation supersedes one. Together the operator cannot say
  // which authority the mesh came up on, and the artifact's own $SYS creds would be overwritten
  // before anyone verified the restore.
  let comboRefusal = "";
  process.chdir(root);
  try {
    await up({ values: { restore: "/nonexistent-backup", "rotate-sys": true }, positionals: [], raw: [] });
  } catch (e) {
    comboRefusal = (e as Error).message;
  } finally {
    process.chdir(origCwd);
  }
  check(
    "`up --restore --rotate-sys` refuses BEFORE touching the restore",
    comboRefusal.includes("--rotate-sys") && !comboRefusal.includes("nonexistent-backup"),
    comboRefusal,
  );

  console.log("\n4e) a maintenance RE-ENTRY refuses, where the explicit --restore guard cannot see");
  // The `--restore` refusal only sees the explicit flag. A restore/resume re-entry arrives with
  // `restore` cleared and an `__*Attempt` set, and those paths can adopt a live listener and RETURN
  // before `authSetup` — accepting the flag and rotating nothing. Both re-entry keys are checked.
  for (const key of ["__restoreAttempt", "__ordinaryResumeAttempt"]) {
    let reentry = "";
    const genBefore = (await getSpaceAuth(store, SPACE))?.gen ?? 0;
    process.chdir(root);
    try {
      await up({ values: { "rotate-sys": true, [key]: "attempt-1" }, positionals: [], raw: [] });
    } catch (e) {
      reentry = (e as Error).message;
    } finally {
      process.chdir(origCwd);
    }
    check(`\`up --rotate-sys\` refuses on a ${key} re-entry`, reentry.includes("--rotate-sys") && reentry.includes("re-entry"), reentry);
    check(`the ${key} refusal advanced no generation`, ((await getSpaceAuth(store, SPACE))?.gen ?? 0) === genBefore);
  }

  console.log("\n4d) a MANIFEST-open mesh refuses too, not just the --open flag");
  // The flag-level guard cannot see this: openness comes from `broker.auth: false` inside the file,
  // which `upManifest` derives after entry. Left unguarded, `up -f open.yaml --rotate-sys` boots an
  // open broker and exits 0 having rotated nothing — the silent-success class this change removes.
  // `--dry-run` still reaches the guard (it sits before the plan print), so this mutates nothing.
  writeFileSync(
    join(root, "open.yaml"),
    `apiVersion: cotal/v1\nkind: Mesh\nspace: ${SPACE}\nbroker: { servers: "nats://127.0.0.1:${PORT}", auth: false }\nchannels:\n  general: { description: Open coordination. }\n`,
  );
  let manifestRefusal = "";
  const genBeforeManifest = (await getSpaceAuth(store, SPACE))?.gen ?? 0;
  process.chdir(root);
  try {
    await up({ values: { file: join(root, "open.yaml"), "rotate-sys": true, "dry-run": true }, positionals: [], raw: [] });
  } catch (e) {
    manifestRefusal = (e as Error).message;
  } finally {
    process.chdir(origCwd);
  }
  check("`up -f <open manifest> --rotate-sys` refuses", manifestRefusal.includes("--rotate-sys") && manifestRefusal.includes("broker.auth: false"), manifestRefusal);
  check("the manifest refusal advanced no generation", ((await getSpaceAuth(store, SPACE))?.gen ?? 0) === genBeforeManifest);

  console.log("\n5) live broker on the ROTATED config — the same cred, config the only variable");
  writeFileSync(confPath, serverConfig(rot.auth, [rot.auth], { storeDir, port: PORT }));
  await startBroker();
  // Bind "came up on the ROTATED config" to IDENTITY, not to a TCP probe: `isReachable` with no
  // creds proves only that something is listening, which any broker on this port satisfies.
  const conf = readFileSync(confPath, "utf8");
  check("the rendered config names the SUCCESSOR system account", conf.includes(`system_account: ${after?.sys.pub}`), after?.sys.pub);
  check("the rendered config does not name the RETIRED one", !conf.includes(String(before?.sys.pub)));
  check("the ROTATED observer is accepted (so the broker really loaded the successor)", await accepts(obsAfter));
  check("the ROTATED evictor is accepted", await accepts(evAfter));
  // THE retirement check: the SAME healthy cred that connected in stage 1b, now refused. Nothing
  // about the credential changed between the two connects — only the config the broker loaded.
  check("the healthy PRE-rotation observer is now REJECTED (retirement, not expiry)", !(await accepts(livePreObserver)));
  for (const [label, creds] of preRotation)
    check(`a ${label} cred minted BEFORE the rotation still connects (the survival claim, per class)`, await accepts(creds));

  console.log("\n5b) fault injection: every crash state of the non-atomic commit is detected");
  // The commit is a record put plus two cred writes, so a crash leaves the record AHEAD of the creds
  // in one of two shapes. Both are structurally valid and nowhere near expiry, so ONLY a comparison
  // against the persisted record can see either. Staged directly on disk, which is exactly what the
  // crash leaves behind.
  const liveSys = (await getSpaceAuth(store, SPACE))!.sys.pub;
  const goodObs = readFileSync(obsPath, "utf8");
  const goodEv = readFileSync(evPath, "utf8");
  const oldEv = await mintConnectionEvictorCreds(auth, newIdentity()); // healthy, RETIRED issuer

  // (a) crash BEFORE either write: both creds stale, and mutually CONSISTENT — the case a
  //     file-vs-file comparison cannot see, which is why the record is the oracle.
  writeFileSync(obsPath, livePreObserver, { mode: 0o600 });
  writeFileSync(evPath, oldEv, { mode: 0o600 });
  const bothStale = staleSystemCreds(root, liveSys);
  check("record-only crash: BOTH creds reported stale", bothStale.length === 2, bothStale.map((x) => x.file));
  check("record-only crash: they agree with EACH OTHER (so a pair check would miss it)", credsClaims(livePreObserver).iss === credsClaims(oldEv).iss);

  // (b) crash BETWEEN the two writes: observer current, evictor retired.
  writeFileSync(obsPath, goodObs, { mode: 0o600 });
  const oneStale = staleSystemCreds(root, liveSys);
  check("one-file crash: exactly the un-written cred is reported stale", oneStale.length === 1 && oneStale[0].file === SYSTEM_CREDS_FILES[1], oneStale);

  // (c) the complete generation: nothing stale.
  writeFileSync(evPath, goodEv, { mode: 0o600 });
  check("a complete generation reports nothing stale", staleSystemCreds(root, liveSys).length === 0);
  // (d) an unreadable file cannot be shown to match, so it is not assumed to.
  writeFileSync(evPath, "not a creds file", { mode: 0o600 });
  const corrupt = staleSystemCreds(root, liveSys);
  check("an unreadable $SYS cred is reported stale with no issuer", corrupt.length === 1 && corrupt[0].iss === undefined, corrupt);
  writeFileSync(evPath, goodEv, { mode: 0o600 });

  console.log("\n6) a TORN rotation is caught by both readers, not reported healthy");
  // Simulate the crash grok described: the record committed, the observer landed, the evictor did
  // not. Both files parse and neither is near expiry, so ONLY an issuer comparison can see it.
  writeFileSync(evPath, await mintConnectionEvictorCreds(rot.auth, newIdentity()), { mode: 0o600 }); // healthy, current
  const tornEvictor = preObserver; // an old-authority file that is still structurally valid
  writeFileSync(evPath, tornEvictor, { mode: 0o600 });
  const tornLines: string[] = [];
  console.log = (...a: unknown[]) => { tornLines.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { tornLines.push(a.join(" ")); };
  process.chdir(root);
  let tornCode: number | undefined;
  try {
    await doctor({ values: {}, positionals: ["auth"], raw: [] });
    tornCode = process.exitCode as number | undefined;
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.chdir(origCwd);
    process.exitCode = 0;
  }
  const tornOut = tornLines.join("\n").replace(/\[[0-9;]*m/g, "");
  check("doctor does NOT report a torn $SYS pair as healthy", !tornOut.includes("auth: healthy"), tornOut);
  check("doctor names the RETIRED system account as the cause", tornOut.includes("RETIRED system account"), tornOut);
  check("doctor exits non-zero on a torn pair", tornCode === 1, tornCode);
  check("the torn-pair repair is still the rotation", tornOut.includes("up --rotate-sys"), tornOut);
  writeFileSync(evPath, evAfter, { mode: 0o600 }); // restore the complete generation
} finally {
  await stopBroker();
  process.chdir(origCwd);
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "✓" : "✗"} sys-rotation smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
