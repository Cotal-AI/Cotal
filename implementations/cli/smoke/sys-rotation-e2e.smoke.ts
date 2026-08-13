/**
 * `$SYS` ROTATION E2E (issue #338) — the operator's whole recovery cycle, through the packaged
 * binary, against a real broker + a real delivery daemon + a real manager. Nothing here is staged in
 * process: every state transition is a `cotal` subprocess, and every assertion reads what that
 * subprocess left behind.
 *
 * `sys-rotation.smoke.ts` proves the mechanism (`rotateSystemCreds`, the refusal guards, the boot
 * split-check) and drives `up` in process. It cannot see any of the following, because all of it
 * lives in other processes:
 *
 *  - the reported SYMPTOM: with the $SYS pair past its 30-day horizon the real daemon's membership
 *    feed does not come up, and what it logs is now the credential and the repair rather than a bare
 *    "Authorization Violation";
 *  - the NO-OP that shipped as the fix: `cotal down` + a plain `cotal up` rewrites neither $SYS file
 *    — byte-identical, still expired, doctor still red. This is the regression the branch exists to
 *    kill, so it is a check, not a comment;
 *  - the REPAIR: `cotal up --rotate-sys` clears the symptom in the daemon that reported it;
 *  - the SURVIVAL claim the repair copy makes to the operator. An agent credential minted before the
 *    rotation still connects afterwards, and a message published before it is still readable at its
 *    JetStream sequence after it. "Your agents and your data are untouched" is otherwise a promise
 *    with no test behind it.
 *
 * Elapsed time is the one thing simulated: the $SYS pair is minted with a past `exp`, which is the
 * state a 30-day-old mesh reaches on its own. It is signed by the space's CURRENT system account, so
 * what the daemon and the doctor react to is expiry — not the torn-pair case, which is
 * `sys-rotation.smoke.ts` stage 6.
 *
 * NOTE: runs the BUILT dist — `pnpm build` first.
 * Run: pnpm smoke:sys-rotation-e2e   (needs `nats-server` on PATH; local-only; ~60s)
 */
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  chatStream,
  createSpaceAuth,
  credsClaims,
  inspectCredHealth,
  mintConnectionEvictorCreds,
  mintCreds,
  mintLifecycleUid,
  mintMembershipObserverCreds,
  newIdentity,
  standaloneConnectOpts,
} from "@cotal-ai/core";
import { getSpaceAuth, MEMBERSHIP_RW_CREDS_KEY, putSpaceAuth, SYSTEM_CREDS_FILES, workspaceSecretStore } from "@cotal-ai/workspace";
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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = (s: string) => new TextEncoder().encode(s);
const survivors = (label: string): void => {
  if (process.env.SYSROT_DEBUG !== "1") return;
  const ps = execFileSync("ps", ["-eo", "pid,command"], { encoding: "utf8" })
    .split("\n")
    .filter((l) => (l.includes(SPACE) || l.includes(`-e2e-${RUN}-`)) && !l.includes("ps -eo"));
  console.log(`  [debug] after ${label}: ${ps.length} live —\n${ps.map((l) => "      " + l.trim().slice(0, 150)).join("\n")}`);
};

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const cotalJs = join(repoRoot, "bin", "dist", "cotal.js");
if (!existsSync(cotalJs)) {
  console.error(`no built CLI at ${cotalJs} — run \`pnpm build\` first`);
  process.exit(1);
}

// Unique per run: both the temp root and the space name appear in the child processes' command
// lines, and the teardown sweep keys on them, so they must not collide with another lane's mesh.
const RUN = randomUUID().slice(0, 8);
const SPACE = `sysrote2e-${RUN}`;
const HOME = mkdtempSync(join(tmpdir(), `cotal-sysrot-e2e-home-${RUN}-`));
const root = mkdtempSync(join(tmpdir(), `cotal-sysrot-e2e-${RUN}-`));
const cotalPath = (f: string) => join(root, ".cotal", f);
const obsPath = cotalPath(SYSTEM_CREDS_FILES[0]);
const evPath = cotalPath(SYSTEM_CREDS_FILES[1]);
const deliveryLog = cotalPath("delivery.log");
mkdirSync(join(root, ".cotal", "auth"), { recursive: true });

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;

/** One `cotal` subprocess, on the sandboxed home, from the provisioned root. */
function cotal(args: string[], timeout = 120_000): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [cotalJs, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout,
    env: { ...process.env, NO_COLOR: "1", COTAL_HOME: HOME, COTAL_SKIP_CONNECTOR_SEED: "1" },
  });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

/** The delivery daemon appends across boots, so every read is of ONE boot's tail. Marked in DECODED
 *  characters, not bytes: the log is full of `✓`/`—`/`•`, so a `statSync().size` mark would slice a
 *  UTF-8 string at the wrong place and silently eat the head of the tail. */
const logSize = (): number => (existsSync(deliveryLog) ? readFileSync(deliveryLog, "utf8").length : 0);
const logTail = (from: number): string => (existsSync(deliveryLog) ? readFileSync(deliveryLog, "utf8").slice(from) : "");
/** The daemon starts a beat behind the CLI's exit. Wait for its membership VERDICT — up, degraded,
 *  or unprovisioned — which is the last thing it writes before installing its signal handlers. */
async function daemonTail(from: number, ms = 25_000): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const t = logTail(from);
    if (/membership feed up|[!•] membership:/.test(t)) {
      await wait(700);
      return logTail(from);
    }
    await wait(250);
  }
  return logTail(from);
}

/**
 * `cotal down`, but never within the delivery daemon's first few seconds.
 *
 * A daemon SIGTERMed that young never completes the KV delete that releases its single-flight
 * delivery lease: the request does not settle, its own 2s hard-exit fallback fires first, and the
 * lease is left holding a live value for the rest of its 30s TTL — so the NEXT daemon refuses to
 * bind ("a live lease already exists for shard 0") and the mesh comes back without Plane-3 delivery.
 *
 * This is a property of the daemon's shutdown path, not of anything here: it reproduces on an
 * ordinary mesh with no expired credential and no rotation anywhere, purely by stopping a
 * seconds-old daemon (three `up`/`down` cycles back to back, ~2.5s of daemon life apiece → the third
 * boot cannot bind; give each daemon 2.5s more and every cycle is clean). A real operator's daemon
 * has been up for weeks, so this suite waits rather than encoding the bug as an expectation.
 */
async function settleThenDown(): Promise<{ code: number | null; out: string }> {
  await wait(3000);
  return cotal(["down"]);
}

async function accepts(creds: string): Promise<boolean> {
  try {
    const nc = await connect({ servers: SERVERS, timeout: 3000, reconnect: false, maxReconnectAttempts: 0, authenticator: credsAuthenticator(enc(creds)) });
    await nc.close();
    return true;
  } catch {
    return false;
  }
}

/** A privileged standalone JS connection: a scoped cred subscribes only `_INBOX_<id>.>`, so the
 *  JS-API replies need the pinned inbox prefix or every request hangs on a permissions violation. */
async function withJsm<T>(creds: string, fn: (jsm: Awaited<ReturnType<typeof jetstreamManager>>) => Promise<T>): Promise<T> {
  const nc = await connect({ servers: SERVERS, timeout: 5000, reconnect: false, maxReconnectAttempts: 0, ...standaloneConnectOpts({ creds }) });
  try {
    return await fn(await jetstreamManager(nc));
  } finally {
    await nc.close();
  }
}
/** The CHAT stream's identity as the operator's data: how many messages, and where the log is. A
 *  stream that was recreated by the rotation would come back at sequence 0. (No role may
 *  `STREAM.MSG.GET` on CHAT — reads there are consumer-scoped by design — so the bytes are proven
 *  through the registry instead, below.) */
const chatState = (creds: string): Promise<{ messages: number; last_seq: number; first_ts: string }> =>
  withJsm(creds, async (jsm) => {
    const s = (await jsm.streams.info(chatStream(SPACE))).state;
    return { messages: s.messages, last_seq: s.last_seq, first_ts: String(s.first_ts) };
  });

try {
  // ── the state a 30-day-old mesh reaches on its own ──────────────────────────────────────────────
  const store = workspaceSecretStore(root);
  const auth = await createSpaceAuth(SPACE);
  await putSpaceAuth(store, auth);
  const deadAt = Math.floor(Date.now() / 1000) - 3600;
  writeFileSync(obsPath, await mintMembershipObserverCreds(auth, newIdentity(), { expiresAt: deadAt }), { mode: 0o600 });
  writeFileSync(evPath, await mintConnectionEvictorCreds(auth, newIdentity(), { expiresAt: deadAt }), { mode: 0o600 });
  // The rest of the membership bundle, exactly as a `cotal up` that CREATED this space left it: the
  // reported mesh had a feed that ran for weeks, so the file set must be complete or the daemon stops
  // at "not provisioned here" and never reaches the expiry it is supposed to report.
  writeFileSync(cotalPath("membership.json"), JSON.stringify({ accountId: auth.account.pub }), { mode: 0o600 });
  await store.put(MEMBERSHIP_RW_CREDS_KEY, await mintCreds(auth, newIdentity(), "membership-rw"));
  // Two DATA-account creds minted before any rotation. The whole safety claim of the repair is that
  // these keep working, so they are minted here, once, and never re-minted.
  const preAgent = await mintCreds(auth, newIdentity(), "agent", { lifecycleUid: mintLifecycleUid() });
  const preReader = await mintCreds(auth, newIdentity(), "provisioner");
  const expiredObs = readFileSync(obsPath, "utf8");
  const expiredEv = readFileSync(evPath, "utf8");

  // ── 1) the mesh as the reporter found it ───────────────────────────────────────────────────────
  console.log("\n1) an auth mesh whose $SYS pair is past its horizon");
  let mark = logSize();
  const boot1 = cotal(["up", "--detach", "--space", SPACE, "--server", SERVERS]);
  check("`cotal up --detach` boots the mesh (the expiry does not stop the space)", boot1.code === 0, boot1.out.slice(-500));
  const tail1 = await daemonTail(mark);
  check("the real delivery daemon came up", /delivery daemon up/.test(tail1), tail1.slice(-400));
  // The reported symptom, in the process that reports it.
  check("its membership feed did NOT start (#338's symptom, reproduced live)", !/membership feed up/.test(tail1), tail1.slice(-400));
  // ...and the diagnosis, which used to be a bare "Authorization Violation" naming nothing.
  check("the daemon names the EXPIRED $SYS cred, not just a dead feed", /! membership:.*EXPIRED/s.test(tail1), tail1.slice(-400));
  check("the daemon names the repair that works", /--rotate-sys/.test(tail1), tail1.slice(-400));
  const doc1 = cotal(["doctor", "auth"]);
  check("`cotal doctor auth` exits 1 on the expired pair", doc1.code === 1, `code=${doc1.code} ${doc1.out.slice(-300)}`);
  check("`cotal doctor auth` names both $SYS files as EXPIRED", doc1.out.includes(SYSTEM_CREDS_FILES[0]) && doc1.out.includes(SYSTEM_CREDS_FILES[1]) && /EXPIRED/.test(doc1.out), doc1.out.slice(-400));
  check("`cotal doctor auth` prints `--rotate-sys` as the repair", /--rotate-sys/.test(doc1.out), doc1.out.slice(-400));

  // ── 2) data written BEFORE the rotation, through the product surface ────────────────────────────
  console.log("\n2) traffic and durable state before any rotation");
  const NONCE = `sysrot-${randomUUID()}`;
  const CH = `survive-${RUN}`;
  const sent = cotal(["send", "msg", "general", NONCE, "--space", SPACE, "--server", SERVERS]);
  check("`cotal send msg` exits 0 on the expiring mesh", sent.code === 0, sent.out.slice(-400));
  const set = cotal(["channels", "set", CH, "--desc", NONCE, "--space", SPACE, "--server", SERVERS]);
  check("`cotal channels set` writes durable registry state", set.code === 0, set.out.slice(-400));
  const list1 = cotal(["channels", "list", "--space", SPACE, "--server", SERVERS]);
  check("`cotal channels list` reads it back before the rotation", list1.out.includes(CH) && list1.out.includes(NONCE), list1.out.slice(-400));
  const chatBefore = await chatState(preReader);
  check("the message landed on the CHAT stream", chatBefore.messages > 0 && chatBefore.last_seq > 0, chatBefore);

  // ── 3) the repair the tooling used to advertise ────────────────────────────────────────────────
  console.log("\n3) `down` + a plain `up` — the repair that shipped, and did nothing");
  const down1 = await settleThenDown();
  check("`cotal down` exits 0", down1.code === 0, down1.out.slice(-400));
  survivors("down 1");
  mark = logSize();
  const boot2 = cotal(["up", "--detach", "--space", SPACE, "--server", SERVERS]);
  check("a plain `cotal up` comes back", boot2.code === 0, boot2.out.slice(-500));
  // Wait for THIS boot's daemon to finish coming up before the next `down`. A daemon killed between
  // acquiring its single-flight lease and installing its signal handlers never releases it, and the
  // next boot then refuses to bind for the lease TTL — a harness artefact of three cycles in twenty
  // seconds, not something an operator's weeks-old daemon can hit.
  const tail2 = await daemonTail(mark);
  check("the plain re-up's daemon came up", /delivery daemon up/.test(tail2), tail2.slice(-400));
  check("...and still reports the same expired $SYS cred (the re-up healed nothing)", /! membership:.*EXPIRED/s.test(tail2), tail2.slice(-400));
  // The bug, pinned: `up` mints the $SYS pair only on the branch that CREATES the trust record.
  check("it left the observer cred BYTE-IDENTICAL (still expired)", readFileSync(obsPath, "utf8") === expiredObs);
  check("it left the evictor cred BYTE-IDENTICAL (still expired)", readFileSync(evPath, "utf8") === expiredEv);
  const doc2 = cotal(["doctor", "auth"]);
  check("`cotal doctor auth` is still red after the advertised repair", doc2.code === 1, `code=${doc2.code} ${doc2.out.slice(-300)}`);

  // ── 4) the repair that works ───────────────────────────────────────────────────────────────────
  console.log("\n4) `down` + `up --rotate-sys`");
  const down2 = await settleThenDown();
  check("`cotal down` exits 0 before the rotation", down2.code === 0, down2.out.slice(-400));
  survivors("down 2");
  mark = logSize();
  const boot3 = cotal(["up", "--rotate-sys", "--detach", "--space", SPACE, "--server", SERVERS]);
  check("`cotal up --rotate-sys --detach` exits 0", boot3.code === 0, boot3.out.slice(-800));
  check("the rotation tells the operator its backups are now unrestorable", /backup/i.test(boot3.out), boot3.out.slice(-800));

  const rotated = await getSpaceAuth(store, SPACE);
  const newObs = readFileSync(obsPath, "utf8");
  const newEv = readFileSync(evPath, "utf8");
  check("the system-account generation advanced", (rotated?.gen ?? 0) > (auth.gen ?? 0), `${auth.gen} → ${rotated?.gen}`);
  check("both $SYS creds were rewritten", newObs !== expiredObs && newEv !== expiredEv);
  check("both are issued by the record's CURRENT system account", credsClaims(newObs).iss === rotated?.sys.pub && credsClaims(newEv).iss === rotated?.sys.pub, `${credsClaims(newObs).iss} / ${credsClaims(newEv).iss} vs ${rotated?.sys.pub}`);
  check("neither is expired any more", inspectCredHealth(newObs).state !== "expired" && inspectCredHealth(newEv).state !== "expired", `${inspectCredHealth(newObs).state} / ${inspectCredHealth(newEv).state}`);

  // The symptom, cleared in the process that reported it — the same reader that said "did NOT start"
  // above, so its silence there was a real reading rather than a broken probe.
  const tail3 = await daemonTail(mark);
  check("the daemon's membership feed IS up after the rotation", /membership feed up/.test(tail3), tail3.slice(-500));
  check("the daemon no longer reports a degraded membership feed", !/! membership:/.test(tail3), tail3.slice(-500));
  const doc3 = cotal(["doctor", "auth"]);
  check("`cotal doctor auth` exits 0 after the rotation", doc3.code === 0, `code=${doc3.code} ${doc3.out.slice(-400)}`);

  // ── 5) what the repair promised to leave alone ─────────────────────────────────────────────────
  console.log("\n5) the survival claim the repair copy makes");
  check("the ROTATED observer is accepted by the broker `up` started", await accepts(newObs));
  check("the ROTATED evictor is accepted too (live eviction rides this pair)", await accepts(newEv));
  check("the pre-rotation observer is REJECTED (the old system account is retired)", !(await accepts(expiredObs)));
  check("an AGENT cred minted before the rotation still connects", await accepts(preAgent));
  const chatAfter = await chatState(preReader);
  check("the CHAT stream came back at the same sequence, count and start (not recreated)", JSON.stringify(chatAfter) === JSON.stringify(chatBefore), `${JSON.stringify(chatBefore)} vs ${JSON.stringify(chatAfter)}`);
  const list2 = cotal(["channels", "list", "--space", SPACE, "--server", SERVERS]);
  check("durable registry state written before the rotation reads back byte-for-byte after it", list2.out.includes(CH) && list2.out.includes(NONCE), list2.out.slice(-400));

  const down3 = await settleThenDown();
  check("`cotal down` tears the rotated mesh down cleanly", down3.code === 0, down3.out.slice(-400));

  if (process.env.SYSROT_DEBUG === "1") {
    console.log("\n---- FULL DELIVERY LOG ----\n" + readFileSync(deliveryLog, "utf8"));
    console.log("\n---- DOWN OUTPUTS ----\n1:", down1.out, "\n2:", down2.out, "\n3:", down3.out);
    console.log("\n---- BOOT3 OUT ----\n", boot3.out);
  }

  console.log(`\n${fail ? "✗" : "✓"} $SYS ROTATION E2E: ${pass} passed, ${fail} failed`);
} finally {
  // `up --detach` starts THREE processes that outlive this suite (broker, delivery, manager) and a
  // failed check skips the `down` above. Sweep by command line: the broker carries this run's temp
  // root, the daemons carry its unique space name. Both tokens are unique to this run, so no other
  // lane's broker is in range. POSIX-only (no `ps` on Windows, where this lane is advisory); the
  // pass path has already torn everything down through `cotal down` before reaching here.
  try {
    const ps = execFileSync("ps", ["-eo", "pid,command"], { encoding: "utf8" });
    for (const line of ps.split("\n")) {
      const pid = Number(line.trim().split(/\s+/)[0]);
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      if (!line.includes(`-e2e-${RUN}-`) && !line.includes(SPACE)) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* best effort */
  }
  await wait(400);
  rmSync(root, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
