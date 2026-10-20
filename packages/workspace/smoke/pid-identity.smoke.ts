/**
 * CREATION-IDENTITY TELEMETRY smoke (#969): a teardown may only signal a pid whose IDENTITY it can
 * prove, where identity = the pid + the start of the process behind it.
 *
 * THE DEFECT, reproduced live before the fix: a pidfile whose pid has been REUSED by an unrelated
 * process was signalled by `cotal down`'s teardown paths, because "the pid is alive" was the only
 * check. The foreign process died (exit 9 on its own SIGTERM handler), and the teardown reported a
 * clean stop. PID reuse is aggressive on Windows and eventual everywhere, and it is exactly the
 * state a detached stack (PR #880's CreateProcess path, which closes the handle and keeps only the
 * pid) will meet in production.
 *
 * THE DESIGN: the launch writes a sibling identity pin `<pidfile>.identity` holding `pid token`
 * (the process-start token the advisory lock already uses on Linux/macOS, and on Windows the
 * process creation FILETIME), and every teardown runs ONE shared open-verify-terminate rule:
 * mismatch (pid reuse) refuses and preserves; legacy (no pin) live records warn and proceed for
 * upgrade compatibility; torn pins refuse; only an ESRCH-proven death clears a record.
 *
 * WHAT IS AND IS NOT PROVEN HERE. Every cell drives the REAL stop entry points with REAL child
 * processes and REAL pins; the pid-reuse state itself is built by pinning a start token that
 * differs from the live process's actual start (the truthful post-reuse state: the recorded start
 * belongs to the dead process, the live process started later). The NATIVE WINDOWS launcher
 * (CreateProcess handle lifetime, DETACHED_PROCESS parent exit) is not exercised here. The win32
 * identity token IS: cell F drives the Windows reader/writer seam, including a mutation that
 * restores "write no pin on win32" and must red. Cell W injects the refusal Windows gives a rename over
 * a record another handle holds open into the real publish (#4168); the Windows file-sharing rule that
 * causes it is not exercised here.
 *
 * Run: pnpm smoke:pid-identity
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultStartToken, formatRecord, identityPinPath, identityStartToken, parsePid, parseRecord,
  parseWin32CreationToken, verifyIdentityPin, win32ProcessCreationToken, writeIdentityPin, writePidPair, type RecordReplaceIo,
} from "../src/pid.js";
import { requestLocalStop } from "../src/local-stop.js";

const prevCwd = process.cwd();
const root = mkdtempSync(join(tmpdir(), "pid-identity-"));
mkdirSync(join(root, ".cotal"), { recursive: true });
process.chdir(root);
const here = fileURLToPath(new URL(".", import.meta.url));

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const reap = (child: { kill: (s?: NodeJS.Signals) => void }) => { try { child.kill("SIGKILL"); } catch { /* gone */ } };

/** A child that dies on SIGTERM, reporting its own exit through `exitCode`. `as` adds the argv
 *  token that path's own command attribution reads, so a cell grading the identity pin is not
 *  answered first by attribution (#1528). */
const spawnTarget = (as?: "supervise" | "deliver"): { child: ReturnType<typeof spawn>; pid: number | undefined } => {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);", ...(as ? [as] : [])], { stdio: "ignore" });
  return { child, pid: child.pid };
};
/** A FOREIGN process: it records being signalled by dying with a distinctive exit code. For the
 *  manager and delivery cells the argv token (`supervise` / `deliver`) is added so the process
 *  passes that path's OWN command attribution first - grading the identity refusal, not attribution. */
const spawnForeign = (as?: "supervise" | "deliver"): { child: ReturnType<typeof spawn>; pid: number | undefined } => {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>process.exit(9)); setInterval(()=>{},1000);", ...(as ? [as] : [])], { stdio: "ignore" });
  return { child, pid: child.pid };
};

const strays: ReturnType<typeof spawn>[] = [];
const spawnLocalTarget = async (pidPath: string): Promise<ReturnType<typeof spawn>> => {
  const code = `import { listenForLocalStop } from ${JSON.stringify(new URL("../src/local-stop.ts", import.meta.url).href)};
    listenForLocalStop(${JSON.stringify(pidPath)}, () => process.exit(0));
    process.on("message", (message) => { if (message === "probe") process.send("alive"); });
    process.send("ready"); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", code, "deliver"], { cwd: prevCwd, stdio: ["ignore", "ignore", "inherit", "ipc"] });
  strays.push(child);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("local stop child did not become ready")), 30_000);
    child.once("message", () => { clearTimeout(timer); resolve(); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`local stop child exited before ready (${code})`)); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  return child;
};
let suiteFailed = false;
try {
  await wait(200); // let every child install its SIGTERM handler before any cell runs

  // ── the pin format: one parser, one writer, round-trip ────────────────────────────────────
  check("parseRecord reads a pinned record", parseRecord("4321 28870819").kind === "record" && (parseRecord("4321 28870819") as { kind: "record"; record: { token: string } }).record?.token === "28870819");
  check("parseRecord reads a bare pid as LEGACY (pre-identity)", parseRecord("4321\n").kind === "legacy");
  check("parseRecord reads an empty file as a husk", parseRecord("  \n").kind === "husk");
  check("parseRecord refuses garbled content as unattributable", parseRecord("x y z").kind === "unattributable");
  check("formatRecord is the inverse of parseRecord", parseRecord(formatRecord({ pid: 4321, token: "t" })).kind === "record");
  // The macOS start token is `ps -o lstart=` output, which has spaces. Every pin written on a Mac
  // read back as unattributable, so the manager failed its own pin at boot and `cotal down` refused
  // every component (#3924). The live cell P3 is the repro on a Mac; P1 and P2 hold the format on
  // any platform, since a Linux token has no spaces to lose.
  {
    const roundTrip = (token: string) => {
      const read = parseRecord(formatRecord({ pid: 4321, token }));
      return read.kind === "record" && read.record.pid === 4321 && read.record.token === token;
    };
    check("P1 a start token with spaces (macOS lstart) reads back as a record", roundTrip("Thu Oct 15 21:16:51 2026"));
    check("P2 a padded one-digit day keeps its double space byte for byte", roundTrip("Thu Oct  5 09:01:02 2026"));
    // The pin line is written here from this process's live start token, so P3 reads what a launch
    // on this platform writes without depending on writeIdentityPin, which M4 breaks on purpose.
    const own = join(root, "own.pid");
    writeFileSync(own, String(process.pid));
    writeFileSync(identityPinPath(own), formatRecord({ pid: process.pid, token: defaultStartToken(process.pid)! }));
    const verdict = verifyIdentityPin(own);
    check("P3 this process's own pin verifies as a match on this platform", verdict.kind === "match", verdict);
    check("P4 multiple pin lines are not a single identity record", parseRecord("4321 first\n4322 second").kind === "unattributable");
    check("P5 a newline cannot separate a pid from its token", parseRecord("4321\n28870819").kind === "unattributable");
    check("P6 a carriage return cannot occur inside a token", parseRecord("4321 first\rsecond").kind === "unattributable");
  }

  // ── A. THE MISMATCH REFUSAL on the delivery daemon's own stop path (#969 acceptance 1) ─────
  {
    const { stopDelivery } = await import("../../../implementations/cli/src/lib/delivery-proc.js");
    // The trailing `deliver` argv makes command attribution PASS, so the PIN is the only thing that
    // can refuse here: a reused pid running a delivery-looking command line (another mesh's daemon)
    // is exactly the case attribution cannot catch and the pin must (#1528).
    const foreign = spawnForeign("deliver");
    strays.push(foreign.child);
    await wait(150);
    // The post-reuse state: pidfile holds the FOREIGN process's pid, the pin holds a start token
    // belonging to the DEAD recorded process. Forged as "1": the earliest possible starttime, so it
    // can never equal the live token of any process started this boot.
    writeFileSync(join(root, ".cotal", "delivery.pid"), String(foreign.pid));
    writeFileSync(join(root, ".cotal", "delivery.pid.identity"), `${foreign.pid} 1`);
    let refused: string | undefined;
    try { await stopDelivery(); }
    catch (e) { refused = (e as Error).message; }
    check("A1 a REUSED pid (pin mismatch) is REFUSED by stopDelivery, never signalled", refused !== undefined, refused?.split("\n")[0]);
    check("A2 the refusal names the pid reuse and the two starts", /reused/.test(refused ?? "") && /recorded start/.test(refused ?? ""), refused?.split("\n")[0]);
    check("A3 the foreign process SURVIVES the refused stop", foreign.child.exitCode === null && alive(foreign.pid));
    check("A4 the pidfile AND its pin are preserved for the operator", existsSync(join(root, ".cotal", "delivery.pid")) && existsSync(join(root, ".cotal", "delivery.pid.identity")));
    reap(foreign.child);
  }

  // ── B. THE SAME REFUSAL on the manager, auth-service and broker (down) stop paths ─────────
  {
    const { stopManager } = await import("../../../implementations/cli/src/lib/manager-proc.js");
    // The trailing `supervise` argv makes command attribution PASS, so the pin is the only thing
    // that can refuse here: a reused pid that happens to run a supervisor-looking command line
    // (another mesh's manager) is exactly the case attribution cannot catch and the pin must.
    const foreign = spawnForeign("supervise");
    strays.push(foreign.child);
    await wait(150);
    writeFileSync(join(root, ".cotal", "manager.pid"), String(foreign.pid));
    writeFileSync(join(root, ".cotal", "manager.pid.identity"), `${foreign.pid} 1`);
    let refused: string | undefined;
    try { await stopManager(); }
    catch (e) { refused = (e as Error).message; }
    check("B1 a reused pid is REFUSED by stopManager too (one rule, four paths)", refused !== undefined && foreign.child.exitCode === null && alive(foreign.pid), refused?.split("\n")[0]);
    check("B2 stopManager preserves pidfile, pin and marker", existsSync(join(root, ".cotal", "manager.pid")) && existsSync(join(root, ".cotal", "manager.pid.identity")));
    reap(foreign.child);
  }
  {
    const { stopAuthService } = await import("../../../implementations/cli/src/lib/auth-proc.js");
    const foreign = spawnForeign();
    strays.push(foreign.child);
    await wait(150);
    const pidPath = join(root, ".cotal", "auth-service.6d61696e.pid"); // spaceKey("main")
    writeFileSync(pidPath, String(foreign.pid));
    writeFileSync(identityPinPath(pidPath), `${foreign.pid} 1`);
    let refused: string | undefined;
    try { await stopAuthService("main"); }
    catch (e) { refused = (e as Error).message; }
    check("B3 a reused pid is REFUSED by stopAuthService too", refused !== undefined && foreign.child.exitCode === null && alive(foreign.pid), refused?.split("\n")[0]);
    check("B4 the auth record and pin are preserved", existsSync(pidPath) && existsSync(identityPinPath(pidPath)));
    reap(foreign.child);
  }
  {
    const { stopLocalProcess } = await import("../../../implementations/cli/src/lib/local-process-stop.js");
    const foreign = spawnForeign();
    strays.push(foreign.child);
    await wait(150);
    const pidPath = join(root, ".cotal", "nats.pid");
    writeFileSync(pidPath, String(foreign.pid));
    writeFileSync(identityPinPath(pidPath), `${foreign.pid} 1`);
    let refused: string | undefined;
    try {
      await stopLocalProcess(
        { kind: "local-process", name: "nats", label: "nats-server", pidFile: "nats.pid", stopLast: true, clearsMesh: true },
        { root, space: "main" },
      );
    } catch (e) { refused = (e as Error).message; }
    check("B5 a reused pid is REFUSED on the BROKER's stop path (cotal down nats)", refused !== undefined && foreign.child.exitCode === null, { head: refused?.split("\n")[0] });
    check("B6 the broker record and pin are preserved", existsSync(pidPath) && existsSync(identityPinPath(pidPath)));
    reap(foreign.child);
  }

  // ── C. THE HAPPY PATH still tears down: a MATCHING pin is signalled and its death confirmed ─
  {
    const { stopDelivery } = await import("../../../implementations/cli/src/lib/delivery-proc.js");
    const target = process.platform === "win32"
      ? await spawnLocalTarget(join(root, ".cotal", "delivery.pid")).then((child) => ({ child, pid: child.pid }))
      : spawnTarget("deliver");
    strays.push(target.child);
    await wait(150);
    const token = defaultStartToken(target.pid!); // the REAL start token of the REAL process
    assert.ok(token !== undefined, "this host must expose a native start token for the happy-path cell");
    writeFileSync(join(root, ".cotal", "delivery.pid"), String(target.pid));
    writeFileSync(join(root, ".cotal", "delivery.pid.identity"), formatRecord({ pid: target.pid!, token }));
    await stopDelivery();
    await wait(200);
    check("C1 a MATCHING pin IS torn down (cleanup, death confirmed, record cleared)", target.child.exitCode === 0, { exitCode: target.child.exitCode });
    check("C2 a proven-death teardown clears the pidfile AND the pin", !existsSync(join(root, ".cotal", "delivery.pid")) && !existsSync(join(root, ".cotal", "delivery.pid.identity")));
  }

  // ── D. A PROVEN-DEAD pinned record is cleared without a signal (stale record cleanup) ─────
  {
    const { stopDelivery } = await import("../../../implementations/cli/src/lib/delivery-proc.js");
    // A process that is ALREADY EXITED, not merely signalled: spawnTarget's child lives forever
    // until signalled, so wait for a REAL exit of a short-lived child instead.
    const dead = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 50);"], { stdio: "ignore" });
    const token = defaultStartToken(dead.pid!);
    await new Promise<void>((r) => dead.once("exit", r)); // it exits on its own timer
    await wait(100);
    writeFileSync(join(root, ".cotal", "delivery.pid"), String(dead.pid));
    if (token !== undefined) writeFileSync(join(root, ".cotal", "delivery.pid.identity"), formatRecord({ pid: dead.pid!, token }));
    await stopDelivery();
    check("D1 a pinned record whose pid is ESRCH-dead is cleared with NO signal", !existsSync(join(root, ".cotal", "delivery.pid")));
  }

  // ── E. LEGACY records warn + proceed; TORN records still refuse on a LIVE pid ─────────────
  {
    const { stopDelivery } = await import("../../../implementations/cli/src/lib/delivery-proc.js");
    const foreign = spawnForeign("deliver");
    strays.push(foreign.child);
    await wait(150);
    writeFileSync(join(root, ".cotal", "delivery.pid"), String(foreign.pid)); // legacy: no pin
    let warning = "";
    const originalError = console.error;
    console.error = (...args: unknown[]) => { warning += `${args.join(" ")}\n`; };
    let legacyRefusal: string | undefined;
    try { await stopDelivery(); }
    catch (error) { legacyRefusal = (error as Error).message; }
    finally { console.error = originalError; }
    await wait(200);
    if (process.platform === "win32") {
      check("E1 Windows cooperative teardown refuses a live legacy daemon", /no creation identity for cooperative shutdown/.test(legacyRefusal ?? "") && foreign.child.exitCode === null);
      check("E2 Windows preserves the refused legacy record", existsSync(join(root, ".cotal", "delivery.pid")));
      reap(foreign.child);
    } else {
      assert.equal(legacyRefusal, undefined);
      check("E1 a LEGACY (unpinned) live record is signalled with a loud reduced-guarantee warning", foreign.child.exitCode === 9 && /predates process identity pinning/.test(warning) && /without an identity check/.test(warning) && /relaunch will pin/.test(warning), { exitCode: foreign.child.exitCode, warning });
      check("E2 the legacy record auto-clears after confirmed death", !existsSync(join(root, ".cotal", "delivery.pid")));
    }
    const torn = spawnForeign("deliver");
    strays.push(torn.child);
    await wait(150);
    writeFileSync(join(root, ".cotal", "delivery.pid"), String(torn.pid));
    // Torn pairing: the pin names a DIFFERENT pid than the pidfile holds.
    writeFileSync(join(root, ".cotal", "delivery.pid.identity"), "999999 1");
    let tornRefused: string | undefined;
    try { await stopDelivery(); }
    catch (e) { tornRefused = (e as Error).message; }
    check("E3 a TORN pairing is refused as an observation, without claiming a crash caused it", tornRefused !== undefined && /names pid/.test(tornRefused) && !/crash between writes/.test(tornRefused) && /stop it, then rerun/.test(tornRefused), tornRefused?.split("\n")[0]);
    check("E4 the torn pair is preserved", existsSync(join(root, ".cotal", "delivery.pid")) && existsSync(join(root, ".cotal", "delivery.pid.identity")));
    reap(torn.child);
  }

  // ── F. WIN32 LAUNCHES WRITE A PIN (#1437). The pre-fix defect: processStartToken was undefined
  // on win32, writeIdentityPin skipped, every teardown took the legacy path. Cell F1 is the
  // mutation target: restoring "never write a pin" must red here, on this host, without Windows.
  {
    check("F0 a FILETIME integer is a win32 pin token; a MSYS ps date is not",
      parseWin32CreationToken("  133000000000000000\r\n") === "133000000000000000"
      && parseWin32CreationToken("Wed Sep 11 23:05:21 2026") === undefined
      && parseWin32CreationToken("") === undefined);
    const win32Token = "133000000000000000";
    check("F1 win32 identity uses the creation-time reader, not undefined",
      identityStartToken(4242, "win32", () => win32Token) === win32Token);
    const pidPath = join(root, ".cotal", "win32.pid");
    writeFileSync(pidPath, "4242");
    writeIdentityPin(pidPath, 4242, (pid) => identityStartToken(pid, "win32", () => win32Token));
    check("F2 a win32 launch WRITES the sibling pin (the #1437 defect is writing none)",
      existsSync(identityPinPath(pidPath)), { pin: identityPinPath(pidPath) });
    check("F3 the written pin is a two-field record, not a bare pid",
      parseRecord(readFileSync(identityPinPath(pidPath), "utf8")).kind === "record");
    check("F4 a matching win32 pin verifies as match",
      verifyIdentityPin(pidPath, () => win32Token).kind === "match");
    check("F5 a win32 pin mismatch is mismatch, never the legacy proceed-and-signal path",
      verifyIdentityPin(pidPath, () => "133000000000000001").kind === "mismatch");
    const liveLegacy = spawnTarget();
    strays.push(liveLegacy.child);
    await wait(150);
    const legacyPath = join(root, ".cotal", "win32-legacy.pid");
    writeFileSync(legacyPath, String(liveLegacy.pid));
    check("F6 a live record with no sibling pin is still legacy (upgrade path only)",
      verifyIdentityPin(legacyPath, () => win32Token).kind === "legacy");
    reap(liveLegacy.child);
    // These controls exercise the reader boundary. The native suite reaches GetProcessTimes.
    const exact = "133000000000000001";
    let calledPid: number | undefined;
    check("F7 win32 creation preserves every FILETIME digit through its reader",
      win32ProcessCreationToken(4242, (pid) => { calledPid = pid; return exact; }) === exact && calledPid === 4242);
    let calls = 0;
    const counted = (): undefined => { calls++; return undefined; };
    const invalid = [0, -1, 1.5, NaN, Infinity].map((pid) => win32ProcessCreationToken(pid, counted));
    check("F8 invalid Windows pids never reach the native reader", invalid.every((token) => token === undefined) && calls === 0);
    calls = 0;
    const denied = win32ProcessCreationToken(4242, counted);
    check("F9 an unavailable Windows identity stays unverified without retry", denied === undefined && calls === 1);
    calls = 0;
    const missing = new Error("synthetic missing native binding");
    let failure: unknown;
    try { win32ProcessCreationToken(4242, () => { calls++; throw missing; }); }
    catch (error) { failure = error; }
    check("F10 a broken Windows binding throws without retry", failure === missing && calls === 1);
    calls = 0;
    const malformed = win32ProcessCreationToken(4242, () => { calls++; return "not-a-filetime"; });
    check("F11 malformed Windows native output is not a token", malformed === undefined && calls === 1);
    calls = 0;
    const oversized = win32ProcessCreationToken(0x80000000, counted);
    check("F12 an oversized Windows pid never reaches the native reader", oversized === undefined && calls === 0);
  }

  // ── G. writePidPair (#1238): the WRITE side has no cell today; a crash mid-publish is planted
  // through `onStep` and each cell reads the two files back, never the helper's return.
  {
    const gPath = join(root, ".cotal", "g-replace.pid");
    const oldTarget = spawnTarget();
    strays.push(oldTarget.child);
    await wait(150);
    let g0Ok = true;
    try {
      writePidPair(gPath, oldTarget.pid!);
    } catch { g0Ok = false; }
    check("G0 a first publish with no injection leaves a complete, matching record",
      g0Ok && verifyIdentityPin(gPath).kind === "match" && parsePid(readFileSync(gPath, "utf8")) === oldTarget.pid);

    const newTarget = spawnTarget();
    strays.push(newTarget.child);
    await wait(150);

    let g1Threw = false;
    try {
      writePidPair(gPath, newTarget.pid!, { onStep: (step) => { if (step === "temporaries") throw new Error("planted crash after temporaries"); } });
    } catch { g1Threw = true; }
    check("G1 a crash after `temporaries` leaves the OLD complete record untouched",
      g1Threw && parsePid(readFileSync(gPath, "utf8")) === oldTarget.pid && verifyIdentityPin(gPath).kind === "match",
      { pidfile: readFileSync(gPath, "utf8"), verdict: verifyIdentityPin(gPath).kind });
    check("G1b no `.publish.` temporary survives the planted crash",
      !readdirSync(join(root, ".cotal")).some((n) => n.includes(".publish.")));

    let g2Threw = false;
    try {
      writePidPair(gPath, newTarget.pid!, { onStep: (step) => { if (step === "bridge-pin") throw new Error("planted crash after bridge-pin"); } });
    } catch { g2Threw = true; }
    check("G2 a crash after `bridge-pin` leaves the OLD pid checked against its own line of a two-line pin (match, never legacy or torn)",
      g2Threw && parsePid(readFileSync(gPath, "utf8")) === oldTarget.pid && verifyIdentityPin(gPath).kind === "match"
        && readFileSync(identityPinPath(gPath), "utf8").trim().split("\n").length === 2,
      { pidfile: readFileSync(gPath, "utf8"), pin: readFileSync(identityPinPath(gPath), "utf8"), verdict: verifyIdentityPin(gPath).kind });

    let g3Threw = false;
    try {
      writePidPair(gPath, newTarget.pid!, { onStep: (step) => { if (step === "publish-pid") throw new Error("planted crash after publish-pid"); } });
    } catch { g3Threw = true; }
    check("G3 a crash after `publish-pid` leaves the NEW pid checked against its own pin line (match, never legacy or torn-pairing)",
      g3Threw && parsePid(readFileSync(gPath, "utf8")) === newTarget.pid && verifyIdentityPin(gPath).kind === "match",
      { pidfile: readFileSync(gPath, "utf8"), verdict: verifyIdentityPin(gPath).kind });

    let g4Ok = true;
    try {
      writePidPair(gPath, newTarget.pid!);
    } catch { g4Ok = false; }
    check("G4 a full publish leaves the NEW complete record, matching",
      g4Ok && verifyIdentityPin(gPath).kind === "match" && parsePid(readFileSync(gPath, "utf8")) === newTarget.pid);
    reap(oldTarget.child);
    reap(newTarget.child);

    const firstPath = join(root, ".cotal", "g-first.pid");
    const firstTarget = spawnTarget();
    strays.push(firstTarget.child);
    await wait(150);
    let g5Threw = false;
    try {
      writePidPair(firstPath, firstTarget.pid!, { onStep: (step) => { if (step === "publish-pid") throw new Error("planted crash after publish-pid, first start"); } });
    } catch { g5Threw = true; }
    check("G5 a first-start crash after `publish-pid` leaves the NEW pid already pinned (match, never legacy)",
      g5Threw && parsePid(readFileSync(firstPath, "utf8")) === firstTarget.pid && verifyIdentityPin(firstPath).kind === "match");
    reap(firstTarget.child);

    check("G6 no `.publish.` temporary survives ANY of G1 through G5",
      !readdirSync(join(root, ".cotal")).some((n) => n.includes(".publish.")));
  }

  // ── W. Windows refuses a rename over a record another handle holds open (#4168). The refusal is
  // injected into the real writePidPair through `replaceIo`: the platform reads win32, the rename
  // refuses one target a set number of times and then really renames, and the sleep records instead
  // of waiting. Each cell reads the two files back.
  {
    const wPath = join(root, ".cotal", "w-held.pid");
    const oldTarget = spawnTarget();
    const newTarget = spawnTarget();
    strays.push(oldTarget.child, newTarget.child);
    await wait(150);
    const refusing = (target: string, code: string, times: number, platform: NodeJS.Platform = "win32") => {
      const seen = { attempts: 0, sleeps: [] as number[], error: Object.assign(new Error(`${code}: injected refusal, rename -> ${target}`), { code }) };
      const replaceIo: RecordReplaceIo = {
        platform,
        sleep: (ms) => { seen.sleeps.push(ms); },
        rename: (from, to) => {
          if (to === target && ++seen.attempts <= times) throw seen.error;
          renameSync(from, to);
        },
      };
      return { seen, replaceIo };
    };
    const publish = (pid: number, replaceIo?: RecordReplaceIo): unknown => {
      try { writePidPair(wPath, pid, replaceIo ? { replaceIo } : {}); return undefined; } catch (e) { return e; }
    };
    const state = () => ({ pidfile: readFileSync(wPath, "utf8"), pin: readFileSync(identityPinPath(wPath), "utf8"), verdict: verifyIdentityPin(wPath).kind });

    for (const code of ["EPERM", "EACCES", "EBUSY"]) {
      publish(oldTarget.pid!);
      const { seen, replaceIo } = refusing(wPath, code, 3);
      const thrown = publish(newTarget.pid!, replaceIo);
      check(`W1 a pidfile commit refused three times with ${code} retries and publishes the NEW complete record`,
        thrown === undefined && parsePid(readFileSync(wPath, "utf8")) === newTarget.pid && verifyIdentityPin(wPath).kind === "match"
          && readFileSync(identityPinPath(wPath), "utf8").trim().split("\n").length === 1 && seen.attempts === 4 && seen.sleeps.length === 3,
        { thrown: String(thrown), ...seen, ...state() });
    }

    {
      publish(oldTarget.pid!);
      const { seen, replaceIo } = refusing(identityPinPath(wPath), "EPERM", 2);
      const thrown = publish(newTarget.pid!, replaceIo);
      check("W2 a bridge pin rename refused twice retries, and the settled pin rename after it succeeds at once",
        thrown === undefined && parsePid(readFileSync(wPath, "utf8")) === newTarget.pid && verifyIdentityPin(wPath).kind === "match"
          && seen.attempts === 4 && seen.sleeps.length === 2,
        { thrown: String(thrown), ...seen, ...state() });
    }

    {
      publish(oldTarget.pid!);
      const { seen, replaceIo } = refusing(wPath, "EPERM", Infinity);
      const thrown = publish(newTarget.pid!, replaceIo);
      const total = seen.sleeps.reduce((a, b) => a + b, 0);
      check("W3 a refusal that never ends still throws that same error once the retry is spent",
        thrown === seen.error && seen.attempts > 1 && seen.attempts === seen.sleeps.length + 1,
        { thrown: String(thrown), attempts: seen.attempts, sleeps: seen.sleeps.length });
      check("W3b its backoff grows by at most 10 ms a step to 100 ms, and its total stays inside the publish lock's 30 s wait",
        seen.sleeps.every((ms, i) => ms <= 100 && (i === 0 || (ms >= seen.sleeps[i - 1]! && ms - seen.sleeps[i - 1]! <= 10))) && total > 0 && total < 30_000,
        { first: seen.sleeps.slice(0, 12), total });
      check("W3c the refused commit leaves the OLD pid checked against its own line of the bridge pin (match, never torn)",
        parsePid(readFileSync(wPath, "utf8")) === oldTarget.pid && verifyIdentityPin(wPath).kind === "match"
          && readFileSync(identityPinPath(wPath), "utf8").trim().split("\n").length === 2,
        state());
    }

    {
      publish(oldTarget.pid!);
      const linux = refusing(wPath, "EPERM", Infinity, "linux");
      const offWindows = publish(newTarget.pid!, linux.replaceIo);
      check("W4 off Windows the same EPERM throws at once, with no retry",
        offWindows === linux.seen.error && linux.seen.attempts === 1 && linux.seen.sleeps.length === 0 && parsePid(readFileSync(wPath, "utf8")) === oldTarget.pid,
        { thrown: String(offWindows), ...linux.seen });
      const other = refusing(wPath, "EXDEV", Infinity);
      const notHeld = publish(newTarget.pid!, other.replaceIo);
      check("W4b on Windows a code that is not a held-file refusal (EXDEV) throws at once, with no retry",
        notHeld === other.seen.error && other.seen.attempts === 1 && other.seen.sleeps.length === 0,
        { thrown: String(notHeld), ...other.seen });
    }

    {
      publish(oldTarget.pid!);
      const { seen, replaceIo } = refusing(wPath, "EPERM", 2);
      const thrown = publish(newTarget.pid!, { rename: replaceIo.rename, platform: replaceIo.platform });
      check("W5 with the real sleep, a pidfile commit refused twice publishes the NEW complete record",
        thrown === undefined && parsePid(readFileSync(wPath, "utf8")) === newTarget.pid && verifyIdentityPin(wPath).kind === "match" && seen.attempts === 3,
        { thrown: String(thrown), attempts: seen.attempts, ...state() });
    }
    reap(oldTarget.child);
    reap(newTarget.child);

    check("W6 no `.publish.` temporary survives ANY of W1 through W5",
      !readdirSync(join(root, ".cotal")).some((n) => n.includes(".publish.")));
  }

  // The real local control channel runs on every host; Windows CLI routing is qualified natively.
  {
    const pidPath = join(root, ".cotal", "local-control.pid");
    const child = await spawnLocalTarget(pidPath);
    const target = { pid: child.pid!, token: defaultStartToken(child.pid!)! };
    const prefix = join(root, ".cotal", "local-stop", `local-control.pid.${createHash("sha256").update(formatRecord(target)).digest("base64url")}`);
    const capability = JSON.parse(readFileSync(`${prefix}.ready`, "utf8")) as { token: string };
    const marker = `${pidPath}.stopping`;
    writeFileSync(marker, String(process.pid));
    const stat = lstatSync(marker);
    const frame = { version: 1, target: formatRecord(target), token: capability.token,
      stopper: formatRecord({ pid: process.pid, token: defaultStartToken(process.pid)! }), reservation: `${stat.dev}:${stat.ino}` };
    const consuming = (): boolean => readdirSync(join(root, ".cotal", "local-stop")).some((name) => name.startsWith(`${basename(prefix)}.request.`) && name.endsWith(".consuming"));
    const rejected = async (name: string, data: string): Promise<void> => {
      writeFileSync(`${prefix}.request`, data);
      const until = Date.now() + 20_000;
      while (Date.now() < until && (existsSync(`${prefix}.request`) || consuming())) await wait(50);
      // A reply proves the child's event loop got past the request callback; an exit cannot race a
      // snapshot of exitCode and make an accepted request look refused.
      const responsive = await new Promise<boolean>((resolve) => {
        if (!child.connected) { resolve(false); return; }
        const done = (alive: boolean): void => { clearTimeout(timer); child.off("message", onMessage); child.off("exit", onExit); resolve(alive); };
        const onMessage = (message: unknown): void => { if (message === "alive") done(true); };
        const onExit = (): void => done(false);
        const timer = setTimeout(() => done(false), 5000);
        child.on("message", onMessage); child.once("exit", onExit);
        try { child.send("probe", (error) => { if (error) done(false); }); }
        catch { done(false); }
      });
      check(name, responsive && child.exitCode === null && !existsSync(`${prefix}.request`) && !consuming());
    };
    await rejected("H1 a local stop without its private nonce cannot invoke cleanup", JSON.stringify({ ...frame, token: "0".repeat(64) }));
    await rejected("H2 a local stop for another process generation cannot invoke cleanup", JSON.stringify({ ...frame, target: `${frame.target}other` }));
    await rejected("H3 a local stop with a replaced reservation cannot invoke cleanup", JSON.stringify({ ...frame, reservation: "different-inode" }));
    await rejected("H4 a local stop with a stale stopper identity cannot invoke cleanup", JSON.stringify({ ...frame, stopper: `${frame.stopper}other` }));
    await rejected("H5 oversized local stop metadata cannot invoke cleanup", `${JSON.stringify(frame)}${" ".repeat(4097)}`);
    const successor = join(root, ".cotal", "local-stop", `local-control.pid.${createHash("sha256").update(`${formatRecord(target)}other`).digest("base64url")}.ready`);
    writeFileSync(successor, "successor capability");
    const cleanup = requestLocalStop(pidPath, { target, stopper: { pid: process.pid, marker } });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("authenticated local stop did not complete")), 20_000);
      child.once("exit", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`local stop child exit ${code}`)); });
    });
    cleanup(true);
    check("H6 an authenticated local stop reaches the real cleanup handler", child.exitCode === 0);
    check("H7 a predecessor stop leaves a successor capability intact", existsSync(successor) && !existsSync(`${prefix}.ready`));
    check("H8 a synchronous cleanup consumes its one-shot request before exiting", !consuming());
    rmSync(marker);
  }
} catch (error) {
  suiteFailed = true;
  throw error;
} finally {
  for (const s of strays) reap(s);
  const exited = await Promise.all(strays.map((child) => new Promise<boolean>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(true); return; }
    const timer = setTimeout(() => resolve(false), 5000);
    child.once("exit", () => { clearTimeout(timer); resolve(true); });
  })));
  process.chdir(prevCwd);
  if (exited.some((gone) => !gone)) {
    console.error(`! test state retained at ${root}: a child exit could not be confirmed`);
    if (!suiteFailed) throw new Error("test cleanup could not confirm every child exit");
  } else {
    try { rmSync(root, { recursive: true, force: true }); }
    catch (error) {
      if (!suiteFailed) throw error;
      console.error(`! test state retained at ${root}: cleanup ${(error as NodeJS.ErrnoException).code}; the original suite failure is preserved`);
    }
  }
}

console.log(`\nPID IDENTITY TESTS PASSED ✅  (${pass} checks)`);
console.log(
  "  COVERAGE, precisely: every cell drives a REAL stop entry point against REAL child processes.\n" +
  "  Cell F proves the win32 identity seam: a creation-time token is a pin, a launch writes the\n" +
  "  sibling, mismatch refuses, and a missing sibling remains the legacy upgrade path. What this\n" +
  "  suite does NOT prove: CreateProcess handle lifetime and DETACHED_PROCESS parent exit.",
);
process.exit(0);
