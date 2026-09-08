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
 * (the process-start token the advisory lock already uses on Linux/macOS), and every teardown runs
 * ONE shared open-verify-terminate rule: mismatch (pid reuse) refuses and preserves; legacy (no
 * pin) live records warn and proceed for upgrade compatibility; torn pins refuse; only an
 * ESRCH-proven death clears a record.
 *
 * WHAT IS AND IS NOT PROVEN HERE. Every cell drives the REAL stop entry points with REAL child
 * processes and REAL pins; the pid-reuse state itself is built by pinning a start token that
 * differs from the live process's actual start (the truthful post-reuse state: the recorded start
 * belongs to the dead process, the live process started later). The NATIVE WINDOWS surface
 * (CreateProcess handle lifetime, DETACHED_PROCESS parent exit, the absence of a stable start
 * token on win32) is NOT exercised here and is named as the gap in the PR: this suite runs the
 * cross-platform seam, not the Windows-native launcher.
 *
 * Run: pnpm smoke:pid-identity
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultStartToken, formatRecord, identityPinPath, parseRecord,
} from "@cotal-ai/workspace";

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

/** A child that dies on SIGTERM, reporting its own exit through `exitCode`. */
const spawnTarget = (): { child: ReturnType<typeof spawn>; pid: number | undefined } => {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);"], { stdio: "ignore" });
  return { child, pid: child.pid };
};
/** A FOREIGN process: it records being signalled by dying with a distinctive exit code. For the
 *  manager cell, `asSupervisor` adds a trailing argv token so the process passes the manager
 *  path's OWN command attribution first - grading the identity refusal, not attribution. */
const spawnForeign = (asSupervisor = false): { child: ReturnType<typeof spawn>; pid: number | undefined } => {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>process.exit(9)); setInterval(()=>{},1000);", ...(asSupervisor ? ["supervise"] : [])], { stdio: "ignore" });
  return { child, pid: child.pid };
};

const strays: ReturnType<typeof spawn>[] = [];
try {
  await wait(200); // let every child install its SIGTERM handler before any cell runs

  // ── the pin format: one parser, one writer, round-trip ────────────────────────────────────
  check("parseRecord reads a pinned record", parseRecord("4321 28870819").kind === "record" && parseRecord("4321 28870819").record?.token === "28870819");
  check("parseRecord reads a bare pid as LEGACY (pre-identity)", parseRecord("4321\n").kind === "legacy");
  check("parseRecord reads an empty file as a husk", parseRecord("  \n").kind === "husk");
  check("parseRecord refuses garbled content as unattributable", parseRecord("x y z").kind === "unattributable");
  check("formatRecord is the inverse of parseRecord", parseRecord(formatRecord({ pid: 4321, token: "t" })).kind === "record");

  // ── A. THE MISMATCH REFUSAL on the delivery daemon's own stop path (#969 acceptance 1) ─────
  {
    const { stopDelivery } = await import("../../../implementations/cli/src/lib/delivery-proc.js");
    const foreign = spawnForeign();
    strays.push(foreign.child);
    await wait(150);
    // The post-reuse state: pidfile holds the FOREIGN process's pid, the pin holds a start token
    // belonging to the DEAD recorded process. Forged as "1": the earliest possible starttime, so it
    // can never equal the live token of any process started this boot.
    writeFileSync(join(root, ".cotal", "delivery.pid"), String(foreign.pid));
    writeFileSync(join(root, ".cotal", "delivery.pid.identity"), `${foreign.pid} 1`);
    let sent = 0;
    let refused: string | undefined;
    try { await stopDelivery(() => "alive", (pid) => { sent++; process.kill(pid, "SIGTERM"); }); }
    catch (e) { refused = (e as Error).message; }
    check("A1 a REUSED pid (pin mismatch) is REFUSED by stopDelivery, never signalled", sent === 0 && refused !== undefined, { sent, head: refused?.split("\n")[0] });
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
    const foreign = spawnForeign(true);
    strays.push(foreign.child);
    await wait(150);
    writeFileSync(join(root, ".cotal", "manager.pid"), String(foreign.pid));
    writeFileSync(join(root, ".cotal", "manager.pid.identity"), `${foreign.pid} 1`);
    let sent = 0;
    let refused: string | undefined;
    try { await stopManager(() => "alive", (pid) => { sent++; process.kill(pid, "SIGTERM"); }); }
    catch (e) { refused = (e as Error).message; }
    check("B1 a reused pid is REFUSED by stopManager too (one rule, four paths)", sent === 0 && refused !== undefined, { sent });
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
    let sent = 0;
    let refused: string | undefined;
    try { await stopAuthService("main", () => "alive", (pid) => { sent++; process.kill(pid, "SIGTERM"); }); }
    catch (e) { refused = (e as Error).message; }
    check("B3 a reused pid is REFUSED by stopAuthService too", sent === 0 && refused !== undefined, { sent });
    check("B4 the auth record and pin are preserved", existsSync(pidPath) && existsSync(identityPinPath(pidPath)));
    reap(foreign.child);
  }
  {
    const { stopLocalProcess } = await import("../../../implementations/cli/src/commands/down.js");
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
    const target = spawnTarget();
    strays.push(target.child);
    await wait(150);
    const token = defaultStartToken(target.pid!); // the REAL start token of the REAL process
    assert.ok(token !== undefined, "this host must expose a start token for the happy-path cell (Linux/macOS do; a Windows run is the named gap)");
    writeFileSync(join(root, ".cotal", "delivery.pid"), String(target.pid));
    writeFileSync(join(root, ".cotal", "delivery.pid.identity"), formatRecord({ pid: target.pid!, token }));
    await stopDelivery(undefined, (pid, sig) => process.kill(pid, sig));
    await wait(200);
    check("C1 a MATCHING pin IS torn down (SIGTERM, death confirmed, record cleared)", target.child.exitCode === 0, { exitCode: target.child.exitCode });
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
    let sent = 0;
    await stopDelivery(() => "dead", (pid) => { sent++; process.kill(pid, "SIGTERM"); });
    check("D1 a pinned record whose pid is ESRCH-dead is cleared with NO signal", sent === 0 && !existsSync(join(root, ".cotal", "delivery.pid")));
  }

  // ── E. LEGACY records warn + proceed; TORN records still refuse on a LIVE pid ─────────────
  {
    const { stopDelivery } = await import("../../../implementations/cli/src/lib/delivery-proc.js");
    const foreign = spawnForeign();
    strays.push(foreign.child);
    await wait(150);
    writeFileSync(join(root, ".cotal", "delivery.pid"), String(foreign.pid)); // legacy: no pin
    let sent = 0;
    let warning = "";
    const originalError = console.error;
    console.error = (...args: unknown[]) => { warning += `${args.join(" ")}\n`; };
    try { await stopDelivery(undefined, (pid) => { sent++; process.kill(pid, "SIGTERM"); }); }
    finally { console.error = originalError; }
    await wait(200);
    check("E1 a LEGACY (unpinned) live record is signalled with a loud reduced-guarantee warning", sent === 1 && foreign.child.exitCode === 9 && /predates process identity pinning/.test(warning) && /without an identity check/.test(warning) && /relaunch will pin/.test(warning), { sent, exitCode: foreign.child.exitCode, warning });
    check("E2 the legacy record auto-clears after confirmed death", !existsSync(join(root, ".cotal", "delivery.pid")));
    const torn = spawnForeign();
    strays.push(torn.child);
    await wait(150);
    writeFileSync(join(root, ".cotal", "delivery.pid"), String(torn.pid));
    // Torn pairing: the pin names a DIFFERENT pid than the pidfile holds.
    writeFileSync(join(root, ".cotal", "delivery.pid.identity"), "999999 1");
    let tornRefused: string | undefined;
    try { await stopDelivery(() => "alive", (pid) => { process.kill(pid, "SIGTERM"); }); }
    catch (e) { tornRefused = (e as Error).message; }
    check("E3 a TORN pairing is refused as an observation, without claiming a crash caused it", tornRefused !== undefined && /names pid/.test(tornRefused) && !/crash between writes/.test(tornRefused) && /stop it, then rerun/.test(tornRefused), tornRefused?.split("\n")[0]);
    check("E4 the torn pair is preserved", existsSync(join(root, ".cotal", "delivery.pid")) && existsSync(join(root, ".cotal", "delivery.pid.identity")));
    reap(torn.child);
  }
} finally {
  for (const s of strays) reap(s);
  process.chdir(prevCwd);
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nPID IDENTITY TESTS PASSED ✅  (${pass} checks)`);
console.log(
  "  COVERAGE, precisely: every cell drives a REAL stop entry point against REAL child processes.\n" +
  "  What this suite does NOT prove: the native Windows surface - CreateProcess handle lifetime,\n" +
  "  DETACHED_PROCESS parent exit, and the fact that win32 has no stable start token (a pin cannot\n" +
  "  be written there, so every record is the reduced-guarantee legacy shape and warns). That is named as the\n" +
  "  gap in the PR; the Windows-native launcher (PR #880) must integrate with this seam there.",
);
process.exit(0);
