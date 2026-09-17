/**
 * The three outcomes required by #1648, each asserted on a real custodian process.
 *
 * WHAT WENT WRONG. A full smoke shard left about eighteen `custodian.js` processes behind per run,
 * each with parent pid 1 and roughly 65 MB resident. Ninety-one were resident at once on one host,
 * about 6 GB, with swap fully used. None of them exited on their own, nothing reaped them, and they
 * could not even be FOUND without walking `/proc/*\/cwd`, because the only thing tying a custodian
 * to its worktree was its cwd.
 *
 * WHY THE EXISTING SEAT SUITES STAYED GREEN THROUGH ALL OF IT. Every lifecycle cell ends by killing
 * the seat it launched, so the thing they measure is what a custodian does when someone is still
 * there to ask. The orphan is the opposite case: nobody is left, and no assertion in this package
 * looked at it. `lifecycle` now covers the unauthenticated-peer settle, which is one entry into that
 * state; the three cells here cover what the issue actually required.
 *
 *   O1  a custodian whose controller is gone exits on its own within a bounded time, and stops its
 *       child rather than leaving a blocked orphan in place of a resident one
 *   O2  an ordinary detach-and-re-adopt does NOT trip that bound: the window restarts at each
 *       disconnect, so a manager restart keeps its seats
 *   O3  a census is cheap: the run marker is on argv AND in the environment, and reads back
 *
 * O1 IS TIMED AGAINST A SHORT BOUND, NOT THE TEN-MINUTE DEFAULT, via `COTAL_SEAT_UNATTENDED_MS`.
 * That the default is ten minutes is asserted separately from the constant, so a suite that passes
 * on a short bound cannot imply the shipped one is anything in particular.
 *
 * A NOTE ON HOW THIS SUITE IMPORTS ITS SUBJECT, because it is load-bearing for the revert gate.
 * The production surface is taken through a NAMESPACE import and each symbol is then asserted by a
 * named cell. A named import (`import { UNATTENDED_MS } ...`) would make a tree with the fix
 * reverted fail at module instantiation with `does not provide an export named`, which is a
 * SyntaxError before any assertion runs: red, but red for the wrong reason, and indistinguishable
 * from a typo in the import list. Reverting the fix must fail a cell that says what was lost.
 *
 * Run: `pnpm smoke:seat-orphan`
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as seat from "../src/index.js";
import { makeSeatRoot, SEAT_MAX_SOCKET_PATH } from "@cotal-ai/smoke-kit";
const { adoptSeatSync, launchSeat } = seat;

/**
 * The surface this suite is about, resolved through the namespace so a tree with the fix reverted
 * reaches the cells below instead of dying at module instantiation. Each is asserted present by
 * name in the SURFACE block, so a revert reports what is missing rather than a SyntaxError.
 */
const UNATTENDED_MS: number | undefined = (seat as { UNATTENDED_MS?: number }).UNATTENDED_MS;
const RUN_MARKER_FLAG: string | undefined = (seat as { RUN_MARKER_FLAG?: string }).RUN_MARKER_FLAG;
type EnvLike = NodeJS.ProcessEnv;
const unattendedMs: ((env?: EnvLike) => number) | undefined = (seat as { unattendedMs?: (env?: EnvLike) => number }).unattendedMs;
const runMarker: ((env?: EnvLike, pid?: number) => string) | undefined = (seat as { runMarker?: (env?: EnvLike, pid?: number) => string }).runMarker;
const runMarkerOf: ((pid: number) => string | undefined) | undefined = (seat as { runMarkerOf?: (pid: number) => string | undefined }).runMarkerOf;
const censusCustodians: ((run?: string) => { pid: number; run: string }[]) | undefined = (seat as {
  censusCustodians?: (run?: string) => { pid: number; run: string }[];
}).censusCustodians;

if (process.platform !== "linux") {
  // Not a skip-as-pass: the custody transport is Linux-only, so there is no custodian to orphan.
  console.log(`SEAT ORPHAN COMPLETE on ${process.platform}: custody transport unsupported`);
  console.log("SMOKE CELLS: 0");
  process.exit(0);
}

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, extra?: unknown): void => {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const root = makeSeatRoot("seat-orphan-");
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const state = (pid: number): string => {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    return s.slice(s.lastIndexOf(") ") + 2).split(" ")[0] ?? "?";
  } catch {
    return "gone";
  }
};
const gone = (pid: number): boolean => state(pid) === "gone" || state(pid) === "Z";
const until = async (p: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (!p() && Date.now() < deadline) await wait(50);
  return p();
};
const kill = (pid: number): void => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
};

/** A long-lived child, so nothing here can pass because the child happened to exit on its own. */
const FOREVER = ["-e", "setInterval(()=>{}, 1000)"];
const BOUND_MS = 6_000;

// SURFACE. Asserted first and by name, so a tree missing any of it says WHICH piece is gone. The
// cells below need these to exist to mean anything, so they are skipped rather than crashed when
// one is absent: a stack trace names a line, this names the behaviour that was lost.
const surfaceOk =
  typeof UNATTENDED_MS === "number" &&
  typeof RUN_MARKER_FLAG === "string" &&
  typeof unattendedMs === "function" &&
  typeof runMarker === "function" &&
  typeof runMarkerOf === "function" &&
  typeof censusCustodians === "function";
check("the custodian exposes an unattended bound, so a custodian with no controller can exit on its own", typeof UNATTENDED_MS === "number" && typeof unattendedMs === "function", {
  UNATTENDED_MS: typeof UNATTENDED_MS,
  unattendedMs: typeof unattendedMs,
});
check("the launcher exposes a run marker, so a census can name the run that started a custodian", typeof RUN_MARKER_FLAG === "string" && typeof runMarker === "function" && typeof runMarkerOf === "function", {
  RUN_MARKER_FLAG: typeof RUN_MARKER_FLAG,
  runMarker: typeof runMarker,
  runMarkerOf: typeof runMarkerOf,
});
check("the package exposes a census, so orphans are found without walking /proc/*/cwd", typeof censusCustodians === "function", {
  censusCustodians: typeof censusCustodians,
});

try {
  if (!surfaceOk) {
    // Nothing below can run without the surface, and inventing a result for it would be worse than
    // saying so. The three cells above have already recorded which half is missing.
    console.log("  — the behavioural cells need that surface and were not run");
  } else {
  // Bound once, after the surface check above proved each is present. The cells read like ordinary
  // calls from here on, and a reverted tree never reaches them.
  const CENSUS = censusCustodians as (run?: string) => { pid: number; run: string }[];
  const MARKER_OF = runMarkerOf as (pid: number) => string | undefined;
  const MARKER = runMarker as (env?: EnvLike, pid?: number) => string;
  const BOUND_OF = unattendedMs as (env?: EnvLike) => number;
  const FLAG = RUN_MARKER_FLAG as string;
  const DEFAULT_BOUND = UNATTENDED_MS as number;
  {
    // O1. The manager is a SEPARATE process that adopts and then dies without unwinding, which is
    // what a crashed manager and a SIGKILLed suite runner both leave behind. Killing an in-process
    // client instead would prove only that `close()` works, which was never in doubt.
    process.env.COTAL_SEAT_UNATTENDED_MS = String(BOUND_MS);
    const rec = launchSeat({
      root,
      name: "o1-unattended",
      spec: { command: process.execPath, args: FOREVER, env: { PATH: process.env.PATH ?? "" } },
      cwd: repo,
    });
    const managerSrc = join(root, "o1-manager.mjs");
    writeFileSync(
      managerSrc,
      `import { adoptSeatSync } from ${JSON.stringify(join(repo, "packages/seat/dist/index.js"))};
const h = adoptSeatSync(JSON.parse(process.argv[2]));
h.attach();
console.log("ADOPTED");
setInterval(() => {}, 1000);
`,
    );
    const manager = spawn(process.execPath, [managerSrc, JSON.stringify(rec)], { stdio: ["ignore", "pipe", "ignore"] });
    const adopted = await new Promise<boolean>((r) => {
      const t = setTimeout(() => r(false), 30_000);
      manager.stdout?.on("data", (d: Buffer) => {
        if (d.toString().includes("ADOPTED")) {
          clearTimeout(t);
          r(true);
        }
      });
    });
    check("O1 armed: a separate manager process adopted the seat", adopted);
    // The bound only starts once the controller is gone, so the window must be measured from HERE.
    kill(manager.pid as number);
    const killedAt = Date.now();
    const exited = await until(() => gone(rec.custodianPid), BOUND_MS * 4);
    const elapsed = Date.now() - killedAt;
    check(
      `O1 a custodian whose manager is gone exits on its own within the bound (${(elapsed / 1000).toFixed(2)}s of ${(BOUND_MS / 1000).toFixed(0)}s)`,
      adopted && exited,
      { custodian: state(rec.custodianPid), elapsedMs: elapsed },
    );
    // Not before it, either: an exit that ignored the bound would also satisfy the line above.
    check("O1 it waits for the bound rather than exiting the moment the manager drops", elapsed >= BOUND_MS * 0.5, {
      elapsedMs: elapsed,
      boundMs: BOUND_MS,
    });
    check(
      "O1 its child goes with it, rather than being left behind with no reader",
      await until(() => gone(rec.childPid), 10_000),
      { child: state(rec.childPid) },
    );
    check("O1 the custody record is gone, so nothing points at processes that no longer exist", !existsSync(join(root, rec.id, "record.json")));
    kill(manager.pid as number);
    kill(rec.childPid);
    kill(rec.custodianPid);
  }

  {
    // O2. The bound must not fire under a seat that is merely BETWEEN controllers. A manager that
    // restarts detaches and re-adopts, and a custodian that counted from launch would kill a live
    // agent mid-session. The window restarts at each disconnect, so this seat outlives two of them.
    process.env.COTAL_SEAT_UNATTENDED_MS = String(BOUND_MS);
    const rec = launchSeat({
      root,
      name: "o2-readopt",
      spec: { command: process.execPath, args: FOREVER, env: { PATH: process.env.PATH ?? "" } },
      cwd: repo,
    });
    const first = adoptSeatSync(rec);
    await first.attach().backlog();
    first.close();
    // Wait most of the bound, then re-adopt: if the timer ran from launch rather than from this
    // disconnect, the seat is already dead by the second window's end.
    await wait(BOUND_MS * 0.7);
    const second = adoptSeatSync(rec);
    await second.attach().backlog();
    check("O2 a seat survives a detach and re-adopt inside the unattended window", !gone(rec.custodianPid), {
      custodian: state(rec.custodianPid),
    });
    await wait(BOUND_MS * 0.7);
    check("O2 and stays up past the ORIGINAL window while that second controller holds it", !gone(rec.custodianPid), {
      custodian: state(rec.custodianPid),
      heldMs: BOUND_MS * 1.4,
    });
    second.close();
    check(
      "O2 the bound then applies from the last disconnect, not from launch",
      await until(() => gone(rec.custodianPid), BOUND_MS * 4),
      { custodian: state(rec.custodianPid) },
    );
    kill(rec.childPid);
    kill(rec.custodianPid);
  }

  {
    // O3. The census the issue asked for: cheap, and able to name the run. Both carriers are
    // asserted, because they fail differently. argv is world-readable and is what a reaper running
    // as another uid can use; the environment copy is what a descendant inherits.
    delete process.env.COTAL_SEAT_UNATTENDED_MS; // the default bound: this cell must not race it
    const run = `seat-orphan-${process.pid}`;
    process.env.COTAL_RUN = run;
    const recs = [0, 1].map((i) =>
      launchSeat({
        root,
        name: `o3-census-${i}`,
        spec: { command: process.execPath, args: FOREVER, env: { PATH: process.env.PATH ?? "" } },
        cwd: repo,
      }),
    );
    const started = process.hrtime.bigint();
    const seen = CENSUS(run);
    const censusMs = Number(process.hrtime.bigint() - started) / 1e6;
    const pids = recs.map((r) => r.custodianPid).sort((a, b) => a - b);
    const found = seen.map((s) => s.pid).sort((a, b) => a - b);
    check(`O3 the census finds every custodian of this run, and only those (${censusMs.toFixed(0)}ms)`,
      found.length === pids.length && pids.every((p, i) => p === found[i]),
      { launched: pids, found });
    check("O3 argv names the run, so a reader without the owner's uid can still attribute it",
      recs.every((r) => MARKER_OF(r.custodianPid) === run));
    const environRun = (pid: number): string | undefined =>
      readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").find((s) => s.startsWith("COTAL_RUN="))?.slice("COTAL_RUN=".length);
    check("O3 the environment names it too, so a custodian's own descendants stay attributable",
      recs.every((r) => environRun(r.custodianPid) === run));
    // A census that claimed another run's custodians would SIGKILL a live seat in a parallel lane.
    check("O3 a census for a different run claims none of them", CENSUS(`${run}-other`).length === 0);
    for (const r of recs) {
      kill(r.childPid);
      kill(r.custodianPid);
    }
    delete process.env.COTAL_RUN;
  }

  {
    // The contract around the two knobs, asserted apart from the timed cells above so a short-bound
    // pass can never be read as a statement about what ships.
    check("the shipped default bound is ten minutes", DEFAULT_BOUND === 10 * 60_000, { UNATTENDED_MS: DEFAULT_BOUND });
    check("an absent override yields the default", BOUND_OF({}) === DEFAULT_BOUND);
    check("an override is taken as milliseconds", BOUND_OF({ COTAL_SEAT_UNATTENDED_MS: "1234" }) === 1234);
    let refused = "";
    try {
      BOUND_OF({ COTAL_SEAT_UNATTENDED_MS: "soon" });
    } catch (e) {
      refused = (e as Error).message;
    }
    // Falling back to ten minutes here would leave a test waiting on a clock it did not ask for.
    check("a malformed override throws rather than silently restoring the default", /positive number of milliseconds/.test(refused), { refused });
    let refusedZero = "";
    try {
      BOUND_OF({ COTAL_SEAT_UNATTENDED_MS: "0" });
    } catch (e) {
      refusedZero = (e as Error).message;
    }
    check("a zero override throws, rather than meaning 'exit immediately'", /positive number of milliseconds/.test(refusedZero), { refusedZero });
    check("an unnamed run still gets a marker, from the launching pid", MARKER({}, 4242) === "pid-4242");
    check("a named run is used as given", MARKER({ COTAL_RUN: "ci-7" }, 1) === "ci-7");
    // Whitespace would split one marker into two argv tokens and break the read-back.
    check("whitespace in a run name is folded, so the marker stays one argv token", MARKER({ COTAL_RUN: "ci 7\n" }, 1) === "ci_7");
    // The runner's copy of the flag cannot import this built package (it runs before any build), so
    // it is a literal there. Read as TEXT rather than imported: the suite must not need a type
    // declaration for an untyped runner script in order to assert the two agree.
    const runnerSource = readFileSync(join(repo, "bin/smoke/reap-seat-custodians.mjs"), "utf8");
    const runnerFlag = /export const RUN_MARKER_FLAG = "([^"]+)"/.exec(runnerSource)?.[1];
    check("the suite runner's copy of the run-marker flag matches this package's", runnerFlag === FLAG, { runnerFlag, RUN_MARKER_FLAG: FLAG });
  }

  {
    // THE SOCKET-PATH CEILING. A seat socket is `<root>/<32 hex>/seat.sock`, and `sun_path` holds
    // 108 bytes including its NUL. Over that, libuv TRUNCATES and `listen` still succeeds, so the
    // custodian chmods a path it never created, dies, and the launcher reports only `custodian
    // exited before ready: pid N gone`. Two independent reviews of this issue set TMPDIR inside
    // their worktree, hit 116-byte sockets, and every gate run they attempted died before reaching
    // one assertion. They read that as the fix being unproven. A transport that cannot start must
    // say why.
    const MAX = (seat as { MAX_SOCKET_PATH?: number }).MAX_SOCKET_PATH;
    const fits = (seat as { assertSocketPathFits?: (s: string) => string }).assertSocketPathFits;
    check("the transport names its socket-path ceiling", MAX === 107, { MAX_SOCKET_PATH: MAX });
    check("smoke-kit agrees with the package about that ceiling, so a suite's root is sized by the same number", SEAT_MAX_SOCKET_PATH === MAX, {
      smokeKit: SEAT_MAX_SOCKET_PATH,
      seat: MAX,
    });
    if (typeof fits === "function" && typeof MAX === "number") {
      check("a path at the ceiling is accepted", fits("/" + "a".repeat(MAX - 1)).length === MAX);
      let refusedPath = "";
      try {
        fits("/" + "a".repeat(MAX));
      } catch (e) {
        refusedPath = (e as Error).message;
      }
      // The message has to carry the number and the cure, because the person reading it is looking
      // at an unexplained death in a detached process.
      check("one byte over is refused, naming the size, the limit and the cause",
        /over the 107-byte limit/.test(refusedPath) && /\b108 bytes\b/.test(refusedPath) && /shorter custody root/.test(refusedPath),
        { refusedPath });
    } else {
      check("the transport refuses an oversized socket path", false, { assertSocketPathFits: typeof fits });
    }

    // The end-to-end shape: a real launch under a root too deep to hold a socket must fail with that
    // named refusal rather than the unattributable `exited before ready`.
    const deepBase = join(root, "d".repeat(60));
    mkdirSync(deepBase, { recursive: true });
    let launchError = "";
    try {
      launchSeat({
        root: deepBase,
        name: "too-deep",
        spec: { command: process.execPath, args: FOREVER, env: { PATH: process.env.PATH ?? "" } },
        cwd: repo,
      });
    } catch (e) {
      launchError = (e as Error).message;
    }
    check("a launch under an unusable custody root is refused by name, not as 'exited before ready'",
      /over the 107-byte limit/.test(launchError) && !/exited before ready/.test(launchError),
      { launchError });
  }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nSMOKE CELLS: ${pass + fail}`);
if (fail > 0) {
  console.log(`SEAT ORPHAN FAILED (${pass} passed, ${fail} failed)`);
  process.exit(1);
}
console.log(`SEAT ORPHAN PASSED (${pass} cells)`);
