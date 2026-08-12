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
import { mkdtempSync, rmSync } from "node:fs";
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
const home = mkdtempSync(join(scratch, "home-"));
process.env.COTAL_HOME = home;
const root = mkdtempSync(join(scratch, "root-"));
const { establishIdpSession } = await import("../src/index.js");
type DeviceLoginPrompt = import("../src/index.js").DeviceLoginPrompt;

let pass = 0, fail = 0;
const check = (n: string, v: boolean, x?: unknown) => {
  v ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ FAIL: ${n}`, x ?? ""));
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PORT = await pickFreePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
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
type Run = {
  status: number | null;
  out: string;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
  launchError?: string;
};
function cotal(args: string[], timeoutMs = 120_000): Promise<Run> {
  return new Promise((res) => {
    const child = spawn(TSX, [BIN, ...args], {
      cwd: root, env: { ...process.env, COTAL_HOME: home }, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let timedOut = false;
    let settled = false;
    const t = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    // One settle path. A launch error otherwise leaves this Promise pending until the timer, and the
    // failure then wears the wrong label — "timed out" for something that never started.
    const done = (r: Run) => { if (settled) return; settled = true; clearTimeout(t); res(r); };
    child.on("error", (e) => done({ status: null, out, timedOut, signal: null, launchError: e.message }));
    child.stdout!.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr!.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("exit", (status, signal) => done({ status, out, timedOut, signal }));
  });
}

/** Refuse to grade anything but a self-terminated child with a real exit code. Fatal, because every
 *  rejected shape here is one that would otherwise SATISFY the cells below. */
function mustHaveRun(r: Run, what: string): void {
  const why =
    r.launchError ? `never launched (${r.launchError})`
    : r.timedOut ? "was SIGKILLed by this suite's timeout"
    : r.signal ? `was killed by ${r.signal} from outside this suite`
    : r.status === null ? "ended with neither an exit code nor a signal"
    : null;
  if (why === null) return;
  process.exitCode = 1;
  throw new Error(
    `${what} ${why}: that yields status null and no output, which is exactly the shape the ` +
      `empty-success cell treats as a pass. Grading it would be a false green.`,
  );
}

let handler: ReturnType<typeof toNodeHandler> | undefined;
const idpSrv = createServer((req, res) => handler!(req, res));
await new Promise<void>((r) => idpSrv.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(idpSrv.address() as AddressInfo).port}`;
const base = `${origin}/api/auth`;
const ba = betterAuth({
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
const cookie = signup.headers.get("set-cookie")!.split(";")[0];
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
  // Checked FIRST and fatal: with the root captured, `up` still exits 0 and every cell below still
  // "runs" — against a mesh that is not where this suite thinks it is.
  const captor = foreignRootFor(root);
  check("fixture root has no .cotal ancestor (else nothing below can arm)", captor === null, captor);
  if (captor) { process.exitCode = 1; throw new Error(`fixture root captured by ${captor}`); }
  const up = await cotal(["up", "--user-auth", "--idp", base, "--detach", "--server", SERVER, "--space", SPACE]);
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
  // `cotal down` re-resolves its root from cwd, so under a captured root it aims at the ANCESTOR's
  // `.cotal` and signals pids this fixture never started — another lane's manager, on the one path
  // where the suite has already concluded something is wrong. Cleanup must not be the most
  // dangerous thing the suite does. Skip the CLI teardown when the root is captured and say so
  // loudly, naming what may be left behind; `scratch` is our own mkdtemp either way.
  const teardownCaptor = foreignRootFor(root);
  if (teardownCaptor === null) {
    await cotal(["down"], 60_000).catch(() => ({ status: 1, out: "" }));
  } else {
    console.error(
      `  ! SKIPPING \`cotal down\`: the fixture root is captured by ${join(teardownCaptor, ".cotal")}, so down would `
        + `resolve THAT root and signal processes this suite did not start. Any mesh this run began is under the `
        + `captor and must be stopped by hand.`,
    );
  }
  idpSrv.close();
  rmSync(scratch, { recursive: true, force: true }); // home and root both live under it
}
if (fail) process.exitCode = 1;
