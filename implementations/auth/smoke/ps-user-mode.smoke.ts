/**
 * USER-MODE `cotal ps` (fix/ps-option3 C): mode chosen up front — ep.one, not scatter.
 *
 *   1. up --user-auth + device login + admin grant (the arm-2 shape that may reach ps)
 *   2. cotal ps exits 0 (the product claim C authorises)
 *   3. manager killed — ps exits non-zero, never a bare empty list
 *
 * Spawn-only refusal is asserted in user-spawn.smoke.ts B1e (ungated); not duplicated here.
 * Gated: a RED here is C or the user-mode connect path broken.
 *
 * STEP 3 IS DELIBERATELY STRICTER THAN ITS SIBLING, and the difference is not an oversight.
 * `ps-operator-path.smoke.ts` accepts exit 0 for a dead manager as long as the output says
 * "unreachable"; this suite demands a non-zero exit. Different rails, different observable
 * vocabularies: a class scatter can attribute a specific instance and label it unreachable, while
 * `ep.one` has no such label to print — it either got its one answer or it did not. Asking the
 * user-mode path for the operator path's wording would be asking for a sentence it cannot say.
 *
 * The strictness only ever errs toward RED, and only if user-mode ps deliberately moves to a
 * label-and-exit-0 shape. That is a product decision to be made on its own evidence; a red here
 * demanding a human look at it is then the correct behaviour, not a defect in this file.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins/jwt";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { bearer } from "better-auth/plugins/bearer";
import { toNodeHandler } from "better-auth/node";
import { pickFreePort } from "./_free-port.js";
import { assertScratchHeld, foreignRootFor, killManagerAtRoot, makeScratch } from "../../../bin/smoke/_scratch.js";

// Sandbox the temp root BEFORE minting the fixture. `findCotalRoot` walks to `/` unbounded, so a
// `.cotal` above `tmpdir()` makes `cotal up` write `manager.pid` into that ancestor. Step 4 then
// finds no pid, skips its kill, and grades a LIVE manager's honest "(no managed agents)" as the
// empty-success defect it is meant to catch. On Linux/CI `os.tmpdir()` is `/tmp`, so a stray
// `/tmp/.cotal` there hits this suite every time; on macOS the temp root is `/var/folders/…` and is
// clean, which is why it stayed green locally. Measured: exit 0 + "(no managed agents)" under a
// poisoned base, 5/5 under a clean one, at the same commit.
const scratch = makeScratch("cotal-psuser-");
// Assigned inside the ONE setup transaction below. Everything between `makeScratch` and the main
// body is fallible, and guarding it a line at a time is how the first attempt at this left the
// cookie read, the auth construction and the port pick outside the guard while a comment claimed
// otherwise. One transaction or none.
let home!: string;
let root!: string;
let establishIdpSession!: typeof import("../src/index.js").establishIdpSession;

// Was `cotal up` ever INVOKED? Not "did it succeed" — a failed, timed-out or signalled `up` can still
// have launched detached processes, and those are exactly the ones whose pidfiles must survive.
// Attribution evidence is earned by the attempt, not by the outcome.
let upAttempted = false;
type DeviceLoginPrompt = import("../src/index.js").DeviceLoginPrompt;

let pass = 0, fail = 0;
const check = (n: string, v: boolean, x?: unknown) => {
  v ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ FAIL: ${n}`, x ?? ""));
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let SERVER!: string;
const SPACE = `psuser-${Math.floor(Math.random() * 1e6)}`;
const CLIENT_ID = "cotal-cli";
const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "cotal.ts");
const TSX = join(import.meta.dirname, "..", "..", "..", "node_modules", ".bin", "tsx");

/**
 * How the child ENDED is part of the result, not a detail of the wrapper.
 *
 * `status: null` is reported for ANY signal death — this suite's own timeout, an external
 * SIGTERM/SIGKILL, an OOM kill, a supervisor sweep — and a launch failure never fires `exit` at
 * all. Every one of those yields the exact shape step 4's cell demands (`status !== 0`, no
 * "(no managed agents)"), so any of them lets a run that proved nothing print PASS. A `timedOut`
 * flag alone is not enough: it only knows about OUR timer.
 *
 * So carry all four routes and let {@link mustHaveRun} insist on the only gradeable outcome —
 * the child exited by itself, with a real numeric code.
 */
// How long to keep draining inherited stdio after the direct child exits. Long enough for the tail
// a detached component flushes (measured ~450ms), short enough that a long-lived one cannot hang
// the suite. Exceeding it is reported, never absorbed.
const DRAIN_MS = 2_000;

type Run = {
  status: number | null;
  out: string;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
  launchError?: string;
  /** Descendants held the inherited pipes past the drain bound: `out` is a PREFIX, not the whole. */
  stdioTimedOut?: boolean;
};
function cotal(args: string[], timeoutMs = 120_000): Promise<Run> {
  return new Promise((res) => {
    const child = spawn(TSX, [BIN, ...args], {
      cwd: root, env: { ...process.env, COTAL_HOME: home }, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let timedOut = false;
    let settled = false;
    let exited = false;
    let status: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let drain: NodeJS.Timeout | undefined;
    // One settle path. A launch error otherwise leaves this Promise pending until the timer, and the
    // failure then wears the wrong label — "timed out" for something that never started.
    const done = (r: Run) => { if (settled) return; settled = true; clearTimeout(cmd); clearTimeout(drain); res(r); };
    // Descendants still hold our pipe ends. Stop waiting, drop them, and SAY the output is partial
    // rather than grading a prefix silently.
    const giveUpOnStdio = () => { child.stdout?.destroy(); child.stderr?.destroy(); done({ status, out, timedOut, signal, stdioTimedOut: true }); };
    const cmd = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      // A kill cannot close pipes an already-exited child handed to a detached descendant, so the
      // command timeout has to be able to settle by itself or this wrapper hangs forever.
      if (exited) giveUpOnStdio(); else drain = setTimeout(giveUpOnStdio, DRAIN_MS);
    }, timeoutMs);
    child.on("error", (e) => done({ status: null, out, timedOut, signal: null, launchError: e.message }));
    child.stdout!.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr!.on("data", (d: Buffer) => { out += d.toString(); });
    // TWO PHASE. `exit` gives the direct child's outcome; `close` gives the COMPLETE output, because
    // pipes handed to DETACHED descendants keep carrying text after the child dies (measured:
    // `out: ""` at exit 26ms, `out: "STREAM.INFO"` at close 453ms) and every cell below that reads
    // output content would otherwise judge text that had not arrived. But waiting only for `close`
    // hangs whenever a long-lived detached component holds the pipe — which `cotal` creates on
    // purpose. So: record the outcome at `exit`, keep draining, and bound that drain.
    child.on("exit", (s, sg) => { exited = true; status = s; signal = sg; drain = setTimeout(giveUpOnStdio, DRAIN_MS); });
    child.on("close", (s, sg) => done({ status: s ?? status, out, timedOut, signal: sg ?? signal }));
  });
}

/** Refuse to grade anything but a self-terminated child with a real exit code. Fatal, because every
 *  rejected shape here is one that would otherwise SATISFY the cells below. */
function mustHaveRun(r: Run, what: string): void {
  const why =
    r.launchError ? `never launched (${r.launchError})`
    : r.timedOut ? "was SIGKILLed by this suite's timeout"
    : r.signal ? `was killed by ${r.signal} from outside this suite`
    : r.stdioTimedOut ? "left its output incomplete (detached descendants held the pipes past the drain bound)"
    : r.status === null ? "ended with neither an exit code nor a signal"
    : null;
  if (why === null) return;
  process.exitCode = 1;
  throw new Error(
    `${what} ${why}: that yields status null and no output, which is exactly the shape the ` +
      `empty-success cell treats as a pass. Grading it would be a false green.`,
  );
}

/**
 * ONE SETUP TRANSACTION. Everything between `makeScratch` and the main body happens in here, and a
 * throw anywhere in it removes the scratch and closes the IdP before rethrowing.
 *
 * Guarding this a step at a time does not work, and the previous attempt is the proof: it wrapped
 * the listen and the signup, left the cookie read, the auth construction and the port pick outside,
 * and carried a comment claiming everything fallible was covered. A forced null `set-cookie` then
 * threw past it, stranding the scratch AND leaving the IdP listening so the process survived to the
 * harness's 120s kill. The unit that needs to be atomic is the whole setup, not each fallible line.
 *
 * The stakes are higher than tidiness since the anchor landed: a leaked scratch owns a `.cotal`, so
 * what gets left behind is a live capture hazard for whatever runs under that temp base next — the
 * exact poison this suite exists to detect, manufactured on its own error path.
 */
let handler: ReturnType<typeof toNodeHandler> | undefined;
let idpSrv: ReturnType<typeof createServer> | undefined;
let base!: string;
let origin!: string;
let cookie!: string;
let ba!: ReturnType<typeof betterAuth>;
try {
  home = mkdtempSync(join(scratch, "home-"));
  process.env.COTAL_HOME = home;
  root = mkdtempSync(join(scratch, "root-"));
  // ANCHOR THE ROOT BEFORE ANY PRODUCT COMMAND RUNS. `findCotalRoot` stops at the first `.cotal`
  // starting from the directory itself, so owning one here makes every later resolution from this
  // root land on this root - during `up`, during `ps`, and during `down` - no matter what appears
  // above it in between. Ownership then does not depend on the timing of any check, which is the
  // only way to close a race against a child that re-resolves cwd for itself.
  mkdirSync(join(root, ".cotal"), { recursive: true });
  ({ establishIdpSession } = await import("../src/index.js"));
  SERVER = `nats://127.0.0.1:${await pickFreePort()}`;

  idpSrv = createServer((req, res) => handler!(req, res));
  await new Promise<void>((r, rej) => { idpSrv!.once("error", rej); idpSrv!.listen(0, "127.0.0.1", r); });
  origin = `http://127.0.0.1:${(idpSrv.address() as AddressInfo).port}`;
  base = `${origin}/api/auth`;
  ba = betterAuth({
    baseURL: origin,
    secret: "repro-only-better-auth-secret-0123456789",
    database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [], deviceCode: [] }),
    emailAndPassword: { enabled: true },
    plugins: [
      jwt({ jwt: { issuer: origin, audience: origin } }),
      deviceAuthorization({ expiresIn: "2m", interval: "1s", validateClient: (id) => id === CLIENT_ID }),
      bearer(),
    ],
  });
  handler = toNodeHandler(ba);
  const signup = await ba.api.signUpEmail({
    body: { email: "human@example.test", password: "correct-horse-battery", name: "Human 42" },
    returnHeaders: true,
  });
  const setCookie = signup.headers.get("set-cookie");
  if (!setCookie) throw new Error("IdP signup returned no set-cookie header");
  cookie = setCookie.split(";")[0];
} catch (e) {
  // A listening server keeps the process alive past the throw, and `finally` is not reachable from
  // out here — so both the server and the scratch are this handler's responsibility.
  // `Server.close()` reports through its CALLBACK, not by throwing — a `try/catch` around it sees
  // nothing, so the previous "reporting" version was still blind and the message below still
  // asserted a close it had not observed. Await the callback and say what actually happened.
  // `ERR_SERVER_NOT_RUNNING` is the benign case: the failure came before `listen`, so there was
  // never a server to close.
  let closed = "not created";
  if (idpSrv) {
    const err = await new Promise<NodeJS.ErrnoException | undefined>((r) => idpSrv!.close((x) => r(x ?? undefined)));
    closed = !err ? "closed"
      : err.code === "ERR_SERVER_NOT_RUNNING" ? "never listened"
      : `CLOSE FAILED (${err.code ?? err.message}) — a listening server may still hold this process open`;
  }
  rmSync(scratch, { recursive: true, force: true });
  throw new Error(`fixture setup failed (scratch removed, IdP: ${closed}): ${(e as Error).message}`, { cause: e });
}
async function approve(userCode: string): Promise<void> {
  await fetch(`${base}/device?user_code=${encodeURIComponent(userCode)}`, { headers: { cookie, origin } });
  const res = await fetch(`${base}/device/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ userCode }),
  });
  if (!res.ok) throw new Error(`device/approve failed: HTTP ${res.status}`);
}

try {
  console.log("1) up --user-auth");
  // DIRECT EXISTENCE, not a consequence of it. `foreignRootFor(root) === null` is ALSO true with no
  // anchor at all under the clean ancestry makeScratch builds, so it cannot tell "anchored" from
  // "nothing here" on an ordinary run - it would have let CI delete the load-bearing anchor and stay
  // green. Assert the thing itself; keep the resolution cell beside it as the consequence.
  // Read ONCE, so the graded cell and the fatal branch cannot report different things about the
  // same instant.
  const anchored = existsSync(join(root, ".cotal"));
  check("the fixture root OWNS its .cotal (the anchor exists)", anchored, root);
  // FATAL HERE, before any product command. A failed `check` alone only increments the tally and
  // lets `up` run UNANCHORED — the precise state whose race this anchor exists to remove. The suite
  // would still exit red, but only after starting a mesh that could root anywhere.
  if (!anchored) {
    process.exitCode = 1;
    throw new Error(`FIXTURE FAILURE: the anchor ${join(root, ".cotal")} is missing, so no product command below can be trusted to root here.`);
  }
  const captor = foreignRootFor(root);
  check("...and therefore outranks any ancestor", captor === null, captor);
  if (captor) { process.exitCode = 1; throw new Error(`anchor missing: ${root} resolves to ${captor}`); }
  upAttempted = true;
  const up = await cotal(["up", "--user-auth", "--idp", base, "--detach", "--server", SERVER, "--space", SPACE]);
  // Attribute HOW `up` ended before reading its status: a signalled or timed-out `up` reports
  // `status: null`, which reads only as "non-zero" and loses why.
  mustHaveRun(up, "`cotal up`");
  check("up exits 0", up.status === 0, up.out.slice(-600));
  if (up.status !== 0) { process.exitCode = 1; throw new Error("fixture"); }
  await wait(3000);

  console.log("2) device login + admin grant");
  const { sub } = await establishIdpSession({
    dir: home, idpUrl: base, clientId: CLIENT_ID,
    onPrompt: (p: DeviceLoginPrompt) => void approve(p.userCode),
  });
  const grant = await cotal(["actor", "grant", "cli", "--sub", sub, "--scope", "spawn,role:default,admin", "--label", "ps human"]);
  check("actor grant succeeds", grant.status === 0 && /granted/i.test(grant.out), grant.out.slice(-300));

  console.log("3) cotal ps under user-mode admin bearer (C: ep.one)");
  const ps = await cotal(["ps", "--space", SPACE], 20_000);
  console.log(`   exit=${ps.status}\n` + ps.out.split("\n").map((l) => `   | ${l}`).join("\n").slice(0, 600));
  check("user-mode ps exits 0 (C: ep.one path)", ps.status === 0, ps.status);
  check("user-mode ps does not die on STREAM.INFO (would mean it still scattered)",
    !/STREAM\.INFO/.test(ps.out), ps.out.slice(-200));

  console.log("4) kill manager — ps must fail loud, not empty-success");
  // The mesh can only root somewhere else if a `.cotal` appeared above the scratch mid-run; witness
  // it here so that shows up as itself and not as the cell below.
  assertScratchHeld(root, "fixture root");
  // Fatal, not conditional. `if (existsSync(pid)) kill()` cannot distinguish "manager dead" from
  // "manager never found" — and under a captured root it is always the second, which is precisely
  // how a live manager came to be graded as a bare empty success.
  // Not a check(): it cannot fail here (the helper throws), and a cell that cannot fail only
  // inflates the pass count. Log the pid so the transcript shows WHICH process died.
  console.log(`   killed manager pid ${await killManagerAtRoot(root)} — the cell below grades a DEAD mesh`);
  const psDead = await cotal(["ps", "--space", SPACE], 20_000);
  console.log(`   dead exit=${psDead.status}\n` + psDead.out.split("\n").map((l) => `   | ${l}`).join("\n").slice(0, 500));
  // Fatal BEFORE grading, not a cell alongside it.
  mustHaveRun(psDead, "the dead-manager `cotal ps`");
  const emptySuccess =
    psDead.status === 0 &&
    !/unreachable/i.test(psDead.out) &&
    (/\(no managed agents\)/.test(psDead.out) || psDead.out.trim() === "");
  check("dead manager: non-zero or explicit failure, never bare empty success",
    psDead.status !== 0 && !emptySuccess, { status: psDead.status, out: psDead.out.slice(-200) });

  console.log(`\nPS USER MODE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
} catch (e) {
  console.error("ps-user-mode threw:", e);
  process.exitCode = 1;
} finally {
  // Every teardown step runs INDEPENDENTLY. A throw anywhere in a finalizer aborts the rest of it,
  // so one bad line leaves a live broker and a scratch behind — a teardown that fails OPEN, which is
  // worse than one that never ran, because the suite still reports its verdict. Measured for real:
  // an unwired identifier in this block once aborted cleanup mid-flight and stranded a nats-server.
  // A failing step is RED, not a log line. Cleanup that quietly declines and still lets the suite
  // exit 0 is the same false-green class as everything else on this branch, just moved to the end.
  const step = async (label: string, fn: () => unknown | Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      process.exitCode = 1;
      console.error(`  ! teardown step "${label}" FAILED: ${(e as Error).message}`);
    }
  };
  // `cotal down` re-resolves its root from cwd, so under a FOREIGN root it aims at that root's
  // `.cotal` and signals pids this fixture never started — another lane's manager, on the one path
  // where the suite has already concluded something is wrong. Cleanup must not be the most
  // dangerous thing the suite does.
  let meshStopped = false;
  await step("stop the mesh", async () => {
    // AN ANCHOR, NOT A GATE. `cotal down` is a child that re-resolves its own root from cwd, so no
    // check performed here can bind what it will decide a moment later — a pre-spawn `foreignRootFor`
    // returning null then losing to a `.cotal` created before the spawn was measured killing a
    // foreign process. A time-of-check test cannot win a time-of-use race.
    //
    // What CAN close it is a fact that outranks anything appearing afterwards: `findCotalRoot` stops
    // at the FIRST `.cotal` starting from the directory itself, so once `root/.cotal` exists the
    // child's resolution IS `root`, permanently, whatever appears above it later. That is the only
    // condition under which a root-resolving teardown is safe here.
    if (!existsSync(join(root, ".cotal"))) {
      const foreign = foreignRootFor(root);
      throw new Error(
        `refusing \`cotal down\`: ${root} does not own a .cotal, so the child would resolve to whatever root `
          + `wins from its cwd and could signal processes this suite never started`
          + (upAttempted
            ? `. A mesh may have started under ${foreign ? join(foreign, ".cotal") : "another root"} — stop it by hand.`
            : `. Nothing was started.`),
      );
    }
    const down = await cotal(["down"], 60_000);
    // The same standard the graded cells get: `cotal()` resolves for a timeout, a signal death and a
    // launch failure alike, so an unchecked `await` treats every one of those as a successful stop.
    mustHaveRun(down, "`cotal down`");
    if (down.status !== 0) throw new Error(`\`cotal down\` exited ${down.status}: ${down.out.slice(-300)}`);
    meshStopped = true;
  });
  await step("close the IdP", () => idpSrv?.close());
  await step("remove the scratch", () => {
    // Only once nothing is left to find. The scratch's `.cotal` holds the pidfiles that are the only
    // way to locate a mesh this suite failed to stop; deleting them turns a recoverable orphan into
    // an anonymous one.
    if (upAttempted && !meshStopped) {
      process.exitCode = 1;
      console.error(
        `  ! PRESERVING ${scratch}: the mesh was not confirmed stopped, and its .cotal holds the pidfiles `
          + `needed to find and stop whatever is still running.`,
      );
      return;
    }
    rmSync(scratch, { recursive: true, force: true }); // home and root live under it
  });
}
if (fail) process.exitCode = 1;
