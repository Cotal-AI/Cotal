/**
 * CLI `--on <instanceId>` REACHES THE MINT — the end-to-end arm `instrument-instance-pin` names as
 * its own coverage boundary and deliberately does not cover.
 *
 * That suite proves the GRANT SHAPING: given a pinned capability, the rows are exact and the live
 * instance rail answers. It states, verbatim, what it cannot prove — "It does NOT prove the CLI
 * actually threads `--on` down to the mint: `agents.ts`/`spawn.ts` → `resolveControlTarget` →
 * `connectOrExit` is covered by typecheck and by the golden flag inventory, not by an executing
 * test. A defect that dropped the argument anywhere along that chain would leave this suite green."
 *
 * THAT DEFECT IS NOT HYPOTHETICAL. It shipped. Measured on a 0.17.0 install against a live
 * two-manager space (2026-08-15): `cotal ps --on <full-id>` returned `no describe reply from
 * manager within 10000ms` for BOTH live instances, while an untargeted `describe` answered from
 * either in well under a second — a 10s deadline against a 115ms RTT. In that build
 * `cli/dist/lib/control.js` pinned the describe SUBJECT (`resolveService(…, { instanceId })`) while
 * calling `connectOrExit(withSpace, profile)` with two arguments, and `workspace/dist/connect.js`
 * declared `connectOrExit(flags, role)` — the third parameter did not exist, and
 * `instancePinnedInstrumentCapabilities` was absent from the entire install. The CLI addressed a
 * rail its own credential was never granted. The broker refused the publish, the client surfaced
 * nothing, and the caller ate the full deadline.
 *
 * WHY THAT IS WORTH A GATED SUITE. The failure is INVISIBLE at every layer that had a test. The
 * subject was right; the subscription was right; the grant emitter was right; only the argument
 * was missing, and a missing argument produces no error — just silence that renders as a timeout,
 * i.e. exactly the shape of "that manager isn't there". Typecheck cannot catch it (the parameter is
 * optional by design, so dropping it type-checks), and a flag inventory cannot (the flag IS parsed
 * and IS forwarded — just not all the way). Only running the real binary catches it.
 *
 * The consequence is not cosmetic. With `--on` dead, every lifecycle call falls back to the
 * unpinned class queue, where describe and invoke are separate trips; in a multi-manager space one
 * instance wins the describe and another wins the invoke, so an effect lands on one manager while
 * the caller is told it failed (SPEC 13.2). Pinning is the ONLY escape from that split, which makes
 * "the flag reaches the pin" a load-bearing claim, not a nicety.
 *
 * WHAT THIS SUITE GRADES. The REAL binary, as a subprocess, against a REAL two-manager mesh. No
 * capability is constructed here and nothing is minted by hand — that is the whole point. If any
 * link in CLI → resolveControlTarget → connectOrExit → mint drops the instance, cell 3 goes red.
 *
 * COVERAGE BOUNDARY of THIS suite, stated so it is not over-read in turn. It invokes `ps` and
 * nothing else. Cell 3 proves the SHARED `resolveControlTarget` → `connectOrExit` → mint seam, and
 * that is all it proves: `spawn` and `stop`/`despawn` reach that seam through their OWN forwarding
 * sites (`spawn.ts` and `agents.ts` each pass `values.on` separately), and dropping the argument at
 * either of those leaves every cell in this file green. Do NOT read this suite as covering them
 * "transitively" — an earlier draft of this comment said exactly that and it was wrong, which is
 * the same over-read that let the original defect ship. Those two commands need their own cells.
 * This suite also does not grade the class-queue split itself (SPEC 13.2 behaviour, not this seam).
 *
 * Mutation-proof target: `cli-on-mint` — drop the instance from the mint (in
 * `packages/workspace/src/connect.ts`, force `pinned` to `undefined`) and cell 3's
 * "a pinned ps is answered by the instance it names" goes red.
 *
 * Run: pnpm smoke:cli-on-instance   (build first — this drives bin/cotal.ts, which imports dist)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isReachable, createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth, recordMesh } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;

// Same live-broker guard as the sibling suite, and for the same reason: this one spawns the REAL
// binary, which resolves a mesh from the environment before it reads any flag. A stray
// COTAL_SERVERS would point a `ps` at production.
const LIVE_HOST = "broker.cotal.ai";
for (const k of ["COTAL_SERVERS", "COTAL_SERVER", "COTAL_CREDS", "COTAL_SPACE"]) delete process.env[k];
for (const [k, v] of Object.entries(process.env))
  if (typeof v === "string" && v.includes(LIVE_HOST)) throw new Error(`refusing to run: ${k} points at the live broker (${v})`);
if (!/^nats:\/\/127\.0\.0\.1:\d+$/.test(SERVERS)) throw new Error(`this probe only runs against an ephemeral loopback broker; got ${SERVERS}`);
console.log(`broker-url guard: ${SERVERS} is ephemeral loopback; no env var references ${LIVE_HOST}\n`);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const space = `clion-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-clion-"));
// SET BEFORE ANY `recordMesh`: the mesh registry is written under COTAL_HOME, and this suite must
// never touch the operator's real `~/.cotal`. The child inherits the same value.
const home = join(dir, "home");
mkdirSync(home, { recursive: true });
process.env.COTAL_HOME = home;
const mkRoot = (tag: string): string => {
  const r = join(dir, tag);
  mkdirSync(join(r, ".cotal", "agents"), { recursive: true });
  saveSpaceAuth(authDir(r), auth);
  return r;
};
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "cotal.ts");

/** How the child ENDED rides in the result: a launch failure, a signal death, or this suite's own
 *  timeout each produce output that would otherwise be graded as if the command had spoken. */
type Run = { status: number | null; out: string; timedOut: boolean; signal: NodeJS.Signals | null; launchError?: string };
function cotal(args: string[], cwd: string, timeoutMs = 90_000): Promise<Run> {
  return new Promise((res) => {
    const child = spawn("npx", ["tsx", BIN, ...args], {
      cwd, env: { ...process.env, COTAL_HOME: home }, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", timedOut = false, settled = false;
    let status: number | null = null, signal: NodeJS.Signals | null = null;
    const done = (r: Run) => { if (settled) return; settled = true; clearTimeout(t); res(r); };
    const t = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.on("error", (e) => done({ status: null, out, timedOut, signal: null, launchError: e.message }));
    child.stdout!.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr!.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("exit", (s, sg) => { status = s; signal = sg; });
    child.on("close", (s, sg) => done({ status: s ?? status, out, timedOut, signal: sg ?? signal }));
  });
}

/** Refuse to grade anything but a self-terminated child with a real exit code. Every shape rejected
 *  here would otherwise SATISFY a "did not report a split" style cell. */
function mustHaveRun(r: Run, what: string): void {
  const why =
    r.launchError ? `never launched (${r.launchError})`
    : r.timedOut ? "was SIGKILLed by this suite's timeout"
    : r.signal ? `was killed by ${r.signal} from outside this suite`
    : r.status === null ? "ended with neither an exit code nor a signal"
    : null;
  if (why === null) return;
  process.exitCode = 1;
  throw new Error(`FIXTURE FAILURE, not a product defect: ${what} ${why}, which fakes the pass shape.\n${r.out.slice(-800)}`);
}

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

type MgrPriv = { managerInstanceId: string };
let m1: InstanceType<typeof Manager> | undefined;
let m2: InstanceType<typeof Manager> | undefined;

try {
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  const root1 = mkRoot("ws1"), root2 = mkRoot("ws2");
  for (const r of [root1, root2]) recordMesh({ space, server: SERVERS, root: r, mode: "auth", ts: new Date().toISOString() });
  m1 = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot: root1 });
  m2 = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot: root2 });
  await m1.start();
  await m2.start();
  const IID1 = (m1 as unknown as MgrPriv).managerInstanceId;
  const IID2 = (m2 as unknown as MgrPriv).managerInstanceId;

  // ---- 1. THE FIXTURE IS THE THING UNDER TEST -------------------------------------------------
  // A one-manager space makes every cell below pass for the wrong reason: with a single responder
  // the class queue and the instance rail are indistinguishable, so a completely unpinned `ps`
  // would satisfy "answered by the instance it names". Assert the split exists FIRST.
  console.log("1. the mesh really is multi-manager (without this, a pin proves nothing)");
  check("two managers registered DISTINCT instance ids", IID1 !== IID2, { IID1, IID2 });

  const unpinned = await cotal(["ps", "--space", space], root1);
  mustHaveRun(unpinned, "the unpinned `ps`");
  const unpinnedOut = strip(unpinned.out);
  check("an UNPINNED ps succeeds", unpinned.status === 0, { status: unpinned.status, tail: unpinnedOut.slice(-300) });
  // FULL ids, not prefixes. Checking `slice(0, 8)` would be satisfied by the abbreviated header
  // this change removed, so it would assert nothing about the behaviour the PR adds — and `--on`
  // rejects anything shorter than the whole 26-32 char token, which is the entire reason the header
  // was widened. The prefix form is asserted ABSENT below for the same reason.
  check("...and sees BOTH instances — the split is real, not a fixture artefact",
    unpinnedOut.includes(IID1) && unpinnedOut.includes(IID2),
    { want: [IID1, IID2], tail: unpinnedOut.slice(-400) });
  check("...and prints ids `--on` will ACCEPT — the full token, never a truncated one",
    new RegExp(`manager ${IID1}(\\s|$)`, "m").test(unpinnedOut) && new RegExp(`manager ${IID2}(\\s|$)`, "m").test(unpinnedOut),
    unpinnedOut.slice(-400));

  // ---- 2. THE FLAG IS ACCEPTED AND VALIDATED --------------------------------------------------
  // Cheap, but it separates "the flag is gone" from "the flag is dead", which are different bugs
  // with different fixes. A malformed id must be refused at the CLI, never widened into a subject.
  console.log("\n2. the flag is parsed and its argument validated before any subject is built");
  const bogus = await cotal(["ps", "--on", "4ik6rb0e", "--space", space], root1);
  mustHaveRun(bogus, "`ps --on <malformed>`");
  check("a malformed instance id is REFUSED, not silently widened",
    bogus.status !== 0 && /not a valid lifecycle token/i.test(strip(bogus.out)),
    { status: bogus.status, tail: strip(bogus.out).slice(-300) });

  // ---- 3. THE CLAIM: `--on` REACHES THE MINT --------------------------------------------------
  // THE cell. Nothing here constructs a capability or mints anything — the binary does it all. In
  // the shipped-broken build this is precisely what returned "no describe reply within 10000ms",
  // because the credential lacked publish on the very subject the CLI had just addressed.
  console.log("\n3. THE CLAIM — a pinned `ps` completes the pinned describe + invoke");
  // NOTE ON WHAT IS ASSERTED. A pinned `ps` prints the addressed instance's SEAT LIST and no
  // `manager <id>` header (the header belongs to the scatter view, cell 1). With no seats spawned
  // that is the literal string "(no managed agents)" — so the instance id does not appear in the
  // output and CANNOT be the discriminator here. Exit status is: reaching zero required the pinned
  // describe to be answered on `ep.inst.<endpoint>.<iid>.describe`, which required the mint to have
  // received the instance. That is exactly the link this suite exists to grade, and it is precisely
  // what returned a 10s deadline in the shipped-broken build.
  for (const [label, iid] of [["IID1", IID1], ["IID2", IID2]] as const) {
    const r = await cotal(["ps", "--on", iid, "--space", space], root1);
    mustHaveRun(r, `\`ps --on ${label}\``);
    const out = strip(r.out);
    // Say WHICH failure it was: a describe timeout here is the exact shipped defect and deserves
    // its name, not a bare "exit 1".
    const timedOutOnDescribe = /no describe reply from manager within/i.test(out);
    check(`ps --on ${label} SUCCEEDS`, r.status === 0,
      timedOutOnDescribe
        ? { defect: "describe timed out on the pinned rail — the mint did not receive the instance (this is the 0.17.0 regression)", tail: out.slice(-300) }
        : { status: r.status, tail: out.slice(-300) });
  }

  // ---- 4. THE PIN ROUTES — IT DOES NOT FALL THROUGH TO THE CLASS QUEUE -------------------------
  // THE DISCRIMINATOR, and the reason cell 3's two green exits are not vacuous. A `--on` that were
  // parsed, validated, and then IGNORED would also give cell 3 two zeroes — the class queue answers
  // happily, and with both managers seatless the output is identical either way. So address a
  // syntactically VALID instance that does not exist: if the pin is honoured there is no responder
  // on that instance rail and the describe must deadline; if `--on` silently degraded to the class
  // queue, a live manager would answer and this exits 0.
  //
  // This is also the no-fallbacks contract stated directly: an unknown instance deadlines, never
  // quietly resolves against a peer.
  console.log("\n4. THE DISCRIMINATOR — a valid-but-absent instance must NOT be answered by a peer");
  const absent = `${"z".repeat(4)}${IID1.slice(4)}`; // same length/alphabet, no such manager
  check("the fixture's absent id is well-formed and really is neither live instance",
    /^[a-z0-9]{26,32}$/.test(absent) && absent !== IID1 && absent !== IID2, absent);
  const ghost = await cotal(["ps", "--on", absent, "--space", space], root1);
  mustHaveRun(ghost, "`ps --on <valid-but-absent>`");
  const ghostOut = strip(ghost.out);
  check("it FAILS rather than being answered by whichever manager won the class queue",
    ghost.status !== 0, { status: ghost.status, tail: ghostOut.slice(-300) });
  check("...and fails as an unanswered pinned describe (the no-fallbacks shape, not some other error)",
    /no describe reply from manager within/i.test(ghostOut), ghostOut.slice(-300));

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
} finally {
  await m1?.stop().catch(() => {});
  await m2?.stop().catch(() => {});
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);
