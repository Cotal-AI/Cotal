/**
 * CLI `--on <instanceId>` REACHES THE MINT: the end-to-end arm `instrument-instance-pin` names as
 * its own coverage boundary and deliberately does not cover.
 *
 * That suite proves the GRANT SHAPING: given a pinned capability, the rows are exact and the live
 * instance rail answers. It states, verbatim, what it cannot prove: "It does NOT prove the CLI
 * actually threads `--on` down to the mint: `agents.ts`/`spawn.ts` → `resolveControlTarget` →
 * `connectOrExit` is covered by typecheck and by the golden flag inventory, not by an executing
 * test. A defect that dropped the argument anywhere along that chain would leave this suite green."
 *
 * THAT DEFECT IS NOT HYPOTHETICAL. It shipped. Measured on a 0.17.0 install against a live
 * two-manager space (2026-08-15): `cotal ps --on <full-id>` returned `no describe reply from
 * manager within 10000ms` for BOTH live instances, while an untargeted `describe` answered from
 * either in well under a second, a 10s deadline against a 115ms RTT. In that build
 * `cli/dist/lib/control.js` pinned the describe SUBJECT (`resolveService(…, { instanceId })`) while
 * calling `connectOrExit(withSpace, profile)` with two arguments, and `workspace/dist/connect.js`
 * declared `connectOrExit(flags, role)`: the third parameter did not exist, and
 * `instancePinnedInstrumentCapabilities` was absent from the entire install. The CLI addressed a
 * rail its own credential was never granted. The broker refused the publish, the client surfaced
 * nothing, and the caller ate the full deadline.
 *
 * WHY THAT IS WORTH A GATED SUITE. The failure is INVISIBLE at every layer that had a test. The
 * subject was right; the subscription was right; the grant emitter was right; only the argument
 * was missing, and a missing argument produces no error, just silence that renders as a timeout,
 * i.e. exactly the shape of "that manager isn't there". Typecheck cannot catch it (the parameter is
 * optional by design, so dropping it type-checks), and a flag inventory cannot (the flag IS parsed
 * and IS forwarded, just not all the way). Only running the real binary catches it.
 *
 * The consequence is not cosmetic. With `--on` dead, every lifecycle call falls back to the
 * unpinned class queue, where describe and invoke are separate trips; in a multi-manager space one
 * instance wins the describe and another wins the invoke, so an effect lands on one manager while
 * the caller is told it failed (SPEC 13.2). Pinning is the ONLY escape from that split, which makes
 * "the flag reaches the pin" a load-bearing claim, not a nicety.
 *
 * WHAT THIS SUITE GRADES. The REAL binary, as a subprocess, against a REAL two-manager mesh. No
 * capability is constructed here and nothing is minted by hand; that is the whole point. If any
 * link in CLI → resolveControlTarget → connectOrExit → mint drops the instance, cell 3 goes red.
 *
 * COVERAGE BOUNDARY of THIS suite, stated so it is not over-read in turn. The chain splits in two
 * and the cells cover it in two pieces, deliberately:
 *   • the SHARED tail (`resolveControlTarget` → `connectOrExit` → mint) is graded ONCE, by cell 3,
 *     which is the only cell that completes a real pinned call end to end;
 *   • the PER-COMMAND heads are graded by cells 4 and 5: `ps`, `spawn --detach`, `stop`, `attach`
 *     each forward `--on` at their own call site, and each is checked separately because dropping
 *     any one of them type-checks and leaves the others green.
 * Read together they cover the whole path; neither covers it alone. An earlier draft claimed the
 * lifecycle commands were covered "transitively" by the `ps` cells; they were not, and that
 * over-read is the same one that let the original defect ship.
 *
 * What is still NOT graded here: cells 4 and 5 prove the pin ROUTES (an absent instance is refused
 * or deadlines rather than falling through), not that a pinned `spawn`/`stop`/`attach` completes against a real
 * instance; those mutate, and a live-mutation cell is a different fixture. And this suite does not
 * grade the class-queue split itself (SPEC 13.2 behaviour, not this seam).
 *
 * Cell 11 starts a manager with no agent application installed and grades the refusal a pinned and
 * an unpinned `spawn --detach` meet there: the code, the manager and host it names, and its Next.
 * Cell 12 adds a second manager whose catalog lacks a persona the first one has, and grades the
 * refusal of a spawn pinned to it: the manager, host and file it names, and the manager its Next pins.
 * Cell 13 invokes an endpoint nothing serves with `--timeout 1000` and grades that the refusal comes
 * within that deadline, with the same code, message and `--json` envelope.
 * Cell 14 invokes the manager with a `--timeout` its contract read outruns and grades the failure
 * that names the flag and the read, with a Next naming a longer `--timeout`.
 *
 * Mutation-proof target `cli-on-mint`: drop the instance from the mint (in
 * `packages/workspace/src/connect.ts`, force `pinned` to `undefined`) and cell 3's
 * "a pinned ps is answered by the instance it names" goes red.
 *
 * Run: pnpm smoke:cli-on-instance   (build first; this drives bin/cotal.ts, which imports dist)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  isReachable, createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity, registry, type Connector, type LaunchOpts, type LaunchSpec,
} from "@cotal-ai/core";
import { authDir, saveExtensionsManifest, saveSpaceAuth, recordMesh } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { SMOKE_BROKER_TOKEN, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";
const TSX = join(import.meta.dirname, "..", "..", "..", "node_modules", ".bin", "tsx");
const repoRoot = join(import.meta.dirname, "..", "..", "..");

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
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
// SET BEFORE ANY `recordMesh`: the mesh registry is written under COTAL_HOME, and this suite must
// never touch the operator's real `~/.cotal`. The child inherits the same value.
const home = join(dir, "home");
// Private, as cotal creates its own home: the local-record store refuses a group- or world-readable one.
mkdirSync(home, { recursive: true, mode: 0o700 });
process.env.COTAL_HOME = home;
const mkRoot = (tag: string): string => {
  const r = join(dir, tag);
  mkdirSync(join(r, ".cotal", "agents"), { recursive: true });
  saveSpaceAuth(authDir(r), auth);
  return r;
};
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "cotal.ts");

/** How the child ENDED rides in the result: a launch failure, a signal death, or this suite's own
 *  timeout each produce output that would otherwise be graded as if the command had spoken. */
type Run = { status: number | null; out: string; stdout: string; timedOut: boolean; signal: NodeJS.Signals | null; launchError?: string };
function cotal(args: string[], cwd: string, timeoutMs = 90_000): Promise<Run> {
  return new Promise((res) => {
    const child = spawn(TSX, [BIN, ...args], {
      cwd, env: { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: join(home, "xdg"), COTAL_SKIP_CONNECTOR_SEED: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", stdout = "", timedOut = false, settled = false;
    let status: number | null = null, signal: NodeJS.Signals | null = null;
    const done = (r: Run) => { if (settled) return; settled = true; clearTimeout(t); res(r); };
    const t = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.on("error", (e) => done({ status: null, out, stdout, timedOut, signal: null, launchError: e.message }));
    child.stdout!.on("data", (d: Buffer) => { out += d.toString(); stdout += d.toString(); });
    child.stderr!.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("exit", (s, sg) => { status = s; signal = sg; });
    child.on("close", (s, sg) => done({ status: s ?? status, out, stdout, timedOut, signal: sg ?? signal }));
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

type PsEnvelope = {
  outcome: string; completeness: string; target: { scope?: string; managerInstanceId?: string | null } | null;
  result: { items: { name?: string }[]; managers: { instanceId: string; state: string; reportedHost?: string }[] } | null;
  warnings: { code: string; target: { managerInstanceId?: string } }[]; error?: { code: string };
};
/** stdout as the one envelope `--json` promises, or undefined when it is anything else. */
function envelopeOf(r: Run): PsEnvelope | undefined {
  const lines = r.stdout.split("\n").filter(Boolean);
  if (lines.length !== 1) return undefined;
  try { return JSON.parse(lines[0]!) as PsEnvelope; } catch { return undefined; }
}

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
  // this change removed, so it would assert nothing about the behaviour the PR adds, and `--on`
  // rejects anything shorter than the whole 26-32 char token, which is the entire reason the header
  // was widened. The prefix form is asserted ABSENT below for the same reason.
  check("...and sees BOTH instances: the split is real, not a fixture artefact",
    unpinnedOut.includes(IID1) && unpinnedOut.includes(IID2),
    { want: [IID1, IID2], tail: unpinnedOut.slice(-400) });
  check("...and prints ids `--on` will ACCEPT: the full token, never a truncated one",
    new RegExp(`manager ${IID1}(\\s|$)`, "m").test(unpinnedOut) && new RegExp(`manager ${IID2}(\\s|$)`, "m").test(unpinnedOut),
    unpinnedOut.slice(-400));

  const unpinnedJson = await cotal(["ps", "--json", "--space", space], root1);
  mustHaveRun(unpinnedJson, "the unpinned `ps --json`");
  const census = envelopeOf(unpinnedJson);
  check("ps --json across both managers is one complete envelope with both instances answered",
    unpinnedJson.status === 0 && census?.outcome === "ok" && census.completeness === "complete" && census.target?.scope === "all-managers" &&
      JSON.stringify(census.result?.managers.map((m) => m.instanceId).sort()) === JSON.stringify([IID1, IID2].sort()) &&
      census.result?.managers.every((m) => m.state === "answered") === true && census.warnings.length === 0,
    { status: unpinnedJson.status, stdout: unpinnedJson.stdout.slice(-600) });
  // Each answering manager's header carries the host it reports in its own status reply, for
  // reading only. The label sits after the full id, so the id check above still holds.
  check("...and each answering manager's header and JSON row carry the host it reports",
    [IID1, IID2].every((iid) => unpinnedOut.includes(`manager ${iid} · reports host ${hostname()}`)) &&
      census?.result?.managers.every((m) => m.reportedHost === hostname()) === true,
    { host: hostname(), out: unpinnedOut.slice(-400), managers: census?.result?.managers });

  // An unpinned `models` goes to the one manager the class queue picks. It names the other as not
  // asked, and an empty catalog list says the answering manager has no application installed.
  check("rig: no connector is registered yet, so each manager lists no catalog", registry.all<Connector>("connector").length === 0, registry.all<Connector>("connector").map((c) => c.name));
  const modelsUnpinned = await cotal(["models", "--json", "--space", space], root1);
  mustHaveRun(modelsUnpinned, "the unpinned `models --json`");
  let modelsEnv: { result?: { answeringManagerInstanceId?: string | null; notAskedManagerInstanceIds?: string[] | null; items?: unknown[] } } | undefined;
  try { modelsEnv = JSON.parse(modelsUnpinned.stdout) as typeof modelsEnv; } catch { modelsEnv = undefined; }
  const answering = modelsEnv?.result?.answeringManagerInstanceId;
  check("an unpinned models --json names the live manager it did not ask",
    modelsUnpinned.status === 0 && (answering === IID1 || answering === IID2) && modelsEnv?.result?.items?.length === 0 &&
      JSON.stringify(modelsEnv.result.notAskedManagerInstanceIds) === JSON.stringify([answering === IID1 ? IID2 : IID1]),
    { status: modelsUnpinned.status, stdout: modelsUnpinned.stdout.slice(-600) });
  const modelsHuman = await cotal(["models", "--space", space], root1);
  mustHaveRun(modelsHuman, "the unpinned `models`");
  const modelsOut = strip(modelsHuman.out);
  const asked = /Answering manager: +(\S+)/.exec(modelsOut)?.[1];
  const notAsked = asked === IID1 ? IID2 : IID1;
  check("...and its report says why no catalog came back, names the other manager and asks it with --on",
    modelsHuman.status === 0 && modelsOut.includes("No model catalogs were returned: the answering manager has no agent application installed.") &&
      (asked === IID1 || asked === IID2) && new RegExp(`Not asked: +${notAsked}$`, "m").test(modelsOut) && modelsOut.includes(`cotal models --space ${space} --on ${notAsked}`),
    modelsOut.slice(-900));

  // ---- 2. THE FLAG IS ACCEPTED AND VALIDATED --------------------------------------------------
  // Cheap, but it separates "the flag is gone" from "the flag is dead", which are different bugs
  // with different fixes. A malformed id must be refused at the CLI, never widened into a subject.
  console.log("\n2. the flag is parsed and its argument validated before any subject is built");
  const bogusJson = await cotal(["ps", "--on", "4ik6rb0e", "--json", "--space", space], root1);
  mustHaveRun(bogusJson, "`ps --on <malformed> --json`");
  check("a malformed instance id under --json is one USAGE_INVALID envelope, exit 1",
    bogusJson.status === 1 && envelopeOf(bogusJson)?.error?.code === "USAGE_INVALID",
    { status: bogusJson.status, stdout: bogusJson.stdout.slice(-400) });
  const bogus = await cotal(["ps", "--on", "4ik6rb0e", "--space", space], root1);
  mustHaveRun(bogus, "`ps --on <malformed>`");
  check("a malformed instance id is REFUSED, not silently widened",
    bogus.status !== 0 && /not a valid lifecycle token/i.test(strip(bogus.out)),
    { status: bogus.status, tail: strip(bogus.out).slice(-300) });

  const bogusDescribe = await cotal(["describe", "manager", "--on", "4ik6rb0e", "--space", space], root1);
  mustHaveRun(bogusDescribe, "`describe manager --on <malformed>`");
  check("a malformed instance id on describe is REFUSED, not silently widened (#554)",
    bogusDescribe.status !== 0 && /not a valid lifecycle token/i.test(strip(bogusDescribe.out)),
    { status: bogusDescribe.status, tail: strip(bogusDescribe.out).slice(-300) });

  // A roster PRINCIPAL id (`local.U…`) is the mismatch #423 reports: an operator pins by the id
  // they can see on `endpoints`/multi-manager `ps`, gets the mint's bare grammar error, and neither
  // it nor the flag's help names the identifier `--on` wants or where `cotal ps` prints it.
  const principalId = "local.UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const onInstanceRefusalSites: ReadonlyArray<{ what: string; argv: string[] }> = [
    { what: "ps --on <roster principal id> is refused with the identifier --on wants and where ps prints it (#423)", argv: ["ps", "--on", principalId, "--space", space] },
    { what: "spawn --detach --on <roster principal id> is refused with the identifier --on wants and where ps prints it (#423)", argv: ["spawn", `no-such-persona-${randomUUID().slice(0, 6)}`, "--detach", "--on", principalId, "--space", space] },
    { what: "describe manager --on <roster principal id> is refused with the identifier --on wants and where ps prints it (#554)", argv: ["describe", "manager", "--on", principalId, "--space", space] },
  ];
  for (const site of onInstanceRefusalSites) {
    const r = await cotal(site.argv, root1);
    mustHaveRun(r, `\`${site.what}\``);
    const out = strip(r.out);
    check(site.what,
      r.status !== 0
        && /--on wants the manager INSTANCE id as `cotal ps` prints it/.test(out)
        && /not the roster's principal id/.test(out)
        && /is a principal id/.test(out)
        && !/no describe reply|did not answer/i.test(out),
      { status: r.status, tail: out.slice(-400) });
  }

  // ---- 3. THE CLAIM: `--on` REACHES THE MINT --------------------------------------------------
  // THE cell. Nothing here constructs a capability or mints anything; the binary does it all. In
  // the shipped-broken build this is precisely what returned "no describe reply within 10000ms",
  // because the credential lacked publish on the very subject the CLI had just addressed.
  console.log("\n3. THE CLAIM: a pinned `ps` completes the pinned describe + invoke");
  // NOTE ON WHAT IS ASSERTED. A pinned `ps` prints the addressed instance's SEAT LIST and no
  // `manager <id>` header (the header belongs to the scatter view, cell 1). With no seats spawned
  // that is the literal string "(no managed agents)", so the instance id does not appear in the
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
    const timedOutOnDescribe = /no describe reply from manager( instance \S+)? within/i.test(out);
    check(`ps --on ${label} SUCCEEDS`, r.status === 0,
      timedOutOnDescribe
        ? { defect: "describe timed out on the pinned rail; the mint did not receive the instance (this is the 0.17.0 regression)", tail: out.slice(-300) }
        : { status: r.status, tail: out.slice(-300) });
    const pinned = await cotal(["ps", "--on", iid, "--json", "--space", space], root1);
    mustHaveRun(pinned, `\`ps --on ${label} --json\``);
    const env = envelopeOf(pinned);
    check(`ps --on ${label} --json targets that one manager and names it answered`,
      pinned.status === 0 && env?.outcome === "ok" && env.target?.scope === "manager" && env.target.managerInstanceId === iid &&
        JSON.stringify(env.result?.managers) === JSON.stringify([{ instanceId: iid, state: "answered" }]),
      { status: pinned.status, stdout: pinned.stdout.slice(-400) });
  }

  // describe --on <iid> SUCCEEDS and its attribution line names <iid>: the pinned instance
  // answered, not the queue winner (#554). Exit 0 alone is satisfied by the class queue; the
  // equality of the report's "Answering instance" field is the claim.
  for (const [label, iid] of [["IID1", IID1], ["IID2", IID2]] as const) {
    const r = await cotal(["describe", "manager", "--on", iid, "--space", space], root1);
    mustHaveRun(r, `\`describe manager --on ${label}\``);
    const out = strip(r.out);
    check(`describe --on ${label} SUCCEEDS and its attribution line names ${label}: the pinned instance answered, not the queue winner (#554)`,
      r.status === 0 && new RegExp(`^ +Answering instance: +${iid}$`, "m").test(out),
      { status: r.status, tail: out.slice(-300) });
  }

  // ---- 4. THE PIN ROUTES: IT DOES NOT FALL THROUGH TO THE CLASS QUEUE -------------------------
  // THE DISCRIMINATOR, and the reason cell 3's two green exits are not vacuous. A `--on` that were
  // parsed, validated, and then IGNORED would also give cell 3 two zeroes; the class queue answers
  // happily, and with both managers seatless the output is identical either way. So address a
  // syntactically VALID instance that does not exist: if the pin is honoured there is no responder
  // on that instance rail and the describe must deadline; if `--on` silently degraded to the class
  // queue, a live manager would answer and this exits 0.
  //
  // This is also the no-fallbacks contract stated directly: an unknown instance deadlines, never
  // quietly resolves against a peer.
  // `--on` where it cannot apply is REFUSED, never ignored (the `--dry-run` rule, mirrored): a
  // foreground spawn has no manager to pin and a manifest deploy launches through the class queue.
  // Both used to accept the flag and drop it, so an operator who read the split message's advice and
  // typed `spawn -f ... --on <id>` was pinned to nothing and never told. Manifest deploys are now
  // `team deploy`, which has no `--on` at all.
  for (const [what, argv, refusal] of [
    ["a foreground spawn", ["spawn", "no-such-persona", "--foreground", "--on", IID1, "--space", space], /a spawn in this terminal takes no structured receipt, manager credential or manager pin/],
    ["a manifest deploy", ["team", "deploy", "no-such-manifest.yaml", "--on", IID1, "--space", space], /Unknown option '--on'/],
  ] as const) {
    const r = await cotal([...argv], root1);
    mustHaveRun(r, `\`${what} --on\``);
    const out = strip(r.out);
    check(`--on on ${what} is REFUSED up front (not silently ignored)`,
      r.status === 1 && refusal.test(out), { status: r.status, tail: out.slice(-300) });
  }

  console.log("\n4. THE DISCRIMINATOR: a valid-but-absent instance must NOT be answered by a peer");
  const absent = `${"z".repeat(4)}${IID1.slice(4)}`; // same length/alphabet, no such manager
  check("the fixture's absent id is well-formed and really is neither live instance",
    /^[a-z0-9]{26,32}$/.test(absent) && absent !== IID1 && absent !== IID2, absent);
  const ghost = await cotal(["ps", "--on", absent, "--space", space], root1);
  mustHaveRun(ghost, "`ps --on <valid-but-absent>`");
  const ghostOut = strip(ghost.out);
  check("it FAILS rather than being answered by whichever manager won the class queue",
    ghost.status !== 0, { status: ghost.status, tail: ghostOut.slice(-300) });
  // The registry lists no manager with that id, so ps refuses before any describe, naming the two that run.
  check("...and is refused before any describe, naming the managers that run (the no-fallbacks shape, not some other error)",
    new RegExp(`--on ${absent} names no manager running for space ${space}; the ones running are `).test(ghostOut) && ghostOut.includes(IID1) && ghostOut.includes(IID2) && !/no describe reply/.test(ghostOut),
    ghostOut.slice(-300));
  // WHAT THE HEADLINE SAYS. Two live managers answered `ps` seconds earlier; the operator typed an
  // instance that is not there. The CLI wrapper used to prefix EVERY ep-rail failure with "no
  // manager reachable", so a typo in `--on` read as an empty mesh and sent the operator to the
  // broker (measured on a live three-manager mesh in review). A pinned call that went unanswered
  // must name the instance and must not pronounce on the mesh.
  check("...and the headline names the INSTANCE that was asked for, not an unreachable mesh",
    new RegExp(`--on ${absent} names no manager`).test(ghostOut) && !/no manager reachable/i.test(ghostOut),
    ghostOut.slice(-300));

  // ---- 5. THE OTHER FORWARDING SITES ----------------------------------------------------------
  // `ps` is not the only command with `--on`, and the other three do NOT reach the seam through it.
  // Each passes the flag at its own call site: `spawn.ts` reads `values.on` directly, while
  // `stop`/`attach` go through `pinForTarget`, which returns `v.on` when present and otherwise
  // LOCATES the seat. Those are independent optional arguments: dropping any one of them
  // type-checks (the parameter is optional by design) and leaves every cell above green. An earlier
  // draft of this file's coverage note claimed they were covered "transitively"; they were not, and
  // that over-read is the same one that let the original defect ship.
  //
  // The probe is cell 4's discriminator applied per command, and it is chosen because it is
  // NON-MUTATING BY CONSTRUCTION: aimed at a valid-but-absent instance, an honoured pin has no
  // responder on that rail and must deadline on the pinned describe; the command never reaches an
  // execute. If the argument is dropped anywhere before the resolve, a live manager answers the
  // class queue instead and the run fails (or succeeds) with some OTHER message, so the assertion
  // is on the describe-deadline TEXT, not on exit status. Nothing is spawned, stopped, or attached
  // in either direction.
  //
  // What this establishes, precisely: the argument reaches `resolveControlTarget` at each of the
  // four sites. That it then reaches the MINT is cell 3, once, on the shared tail. Together those
  // cover the whole chain; neither covers it alone.
  console.log("\n5. every OTHER `--on` site forwards it too (spawn/stop/attach have their own)");
  const pinnedDescribeDeadline = /no describe reply from manager( instance \S+)? within/i;
  const unregistered = new RegExp(`--on ${absent} names no manager running for space ${space}; the ones running are `);
  const sites: ReadonlyArray<{ what: string; argv: string[]; deadline?: RegExp }> = [
    // --on is a `--detach` flag on spawn (foreground runs in this process, not on a manager). The
    // persona ref is deliberately nonexistent so that a dropped pin cannot start anything: the
    // worst case is a manager refusal, which is a DIFFERENT message and still fails this cell.
    // spawn, stop, models, attach and input read the registry first, so an absent instance is refused
    // naming the running ones, before any describe; a dropped pin would reach the class queue instead.
    { what: "spawn --detach", argv: ["spawn", `no-such-persona-${randomUUID().slice(0, 6)}`, "--detach", "--on", absent, "--space", space], deadline: unregistered },
    { what: "stop", argv: ["stop", "--name", `no-such-agent-${randomUUID().slice(0, 6)}`, "--on", absent, "--space", space], deadline: unregistered },
    { what: "models", argv: ["models", "--on", absent, "--space", space], deadline: unregistered },
    { what: "attach", argv: ["attach", "--name", `no-such-agent-${randomUUID().slice(0, 6)}`, "--on", absent, "--space", space], deadline: unregistered },
    { what: "input", argv: ["input", "--name", `no-such-agent-${randomUUID().slice(0, 6)}`, "--text", "x", "--on", absent, "--space", space], deadline: unregistered },
    // describe reports the read as a failed request that names the pinned instance and the native deadline.
    { what: "describe", argv: ["describe", "manager", "--on", absent, "--space", space], deadline: new RegExp(`^ +Requested instance: +${absent}\n +Native code: +deadline-exceeded$`, "m") },
  ];
  for (const site of sites) {
    const r = await cotal(site.argv, root1);
    mustHaveRun(r, `\`${site.what} --on <valid-but-absent>\``);
    const out = strip(r.out);
    check(`${site.what} HONOURS --on: it deadlines on the pinned rail instead of asking the class queue`,
      (site.deadline ?? pinnedDescribeDeadline).test(out),
      { status: r.status, tail: out.slice(-400) });
    check(`...and ${site.what}'s headline names the instance, not an unreachable mesh`,
      !/no manager reachable/i.test(out), out.slice(-300));
    // The launch and attach blocks name the space as a field; only the refusal's heading names the mesh.
    if (site.what === "spawn --detach" || site.what === "attach")
      check(`...and ${site.what} names the mesh once, in the refusal's heading`,
        (out.match(/^Mesh: /gm) ?? []).length === 1 && !/using mesh/.test(out), out.slice(0, 700));
  }

  // ---- 6. AN EMPTY `--on` IS REFUSED AT THE FLAG, ON EVERY SITE ------------------------------
  // `--on ""` (or `--on "$INSTANCE"` with the variable unset) is falsy but present. Before this
  // guard the four sites gave two answers to that one input: `ps` and detached `spawn` carried it
  // to the mint, which refused it as an invalid token; `stop`/`attach` tested `if (v.on)`, read it
  // as absent, and fell through to seat locality with the operator none the wiser. A dropped pin
  // is a silent fallback. The assertion is on the up-front text, so a site that still forwards the
  // empty value to the mint (a different refusal) or drops it (no refusal) fails this cell.
  console.log("\n6. an EMPTY `--on` is refused at the flag on every site, never dropped or forwarded");
  const emptyRefused = /--on requires a manager instance id/;
  const emptySites: ReadonlyArray<{ what: string; argv: string[] }> = [
    { what: "ps", argv: ["ps", "--on", "", "--space", space] },
    { what: "spawn --detach", argv: ["spawn", `no-such-persona-${randomUUID().slice(0, 6)}`, "--detach", "--on", "", "--space", space] },
    { what: "stop", argv: ["stop", "--name", `no-such-agent-${randomUUID().slice(0, 6)}`, "--on", "", "--space", space] },
    { what: "attach", argv: ["attach", "--name", `no-such-agent-${randomUUID().slice(0, 6)}`, "--on", "", "--space", space] },
    { what: "describe", argv: ["describe", "manager", "--on", "", "--space", space] },
  ];
  for (const site of emptySites) {
    const r = await cotal(site.argv, root1);
    mustHaveRun(r, `\`${site.what} --on ""\``);
    const out = strip(r.out);
    check(`${site.what} --on "" is REFUSED at the flag (exit non-zero, the up-front text, not the mint's token error, not a seat miss)`,
      r.status !== 0 && emptyRefused.test(out) && !/not a valid lifecycle token/i.test(out) && !/no managed agent/i.test(out),
      { status: r.status, tail: out.slice(-300) });
  }

  // A persona created on m2 lands in root2's catalog, the root the space is registered at, so the
  // receipt names the file it wrote. Each static call mints its own caller, so the manager records
  // no owner and the file is operator-owned: the receipt's Next reads it locally, a later
  // show --on names that command, and the --on listing's Next offers the local show.
  console.log("\n7. a persona created on the exact manager names the file it wrote and a Next that works");
  const createdJson = await cotal(["persona", "create", "remote-rev", "--prompt", "review", "--subscribe", "", "--on", IID2, "--space", space, "--json"], root2);
  mustHaveRun(createdJson, "`persona create --on --json`");
  let created: { outcome?: string; result?: { localFilesChanged?: boolean; perCallCaller?: boolean } } | undefined;
  try { created = JSON.parse(createdJson.stdout); } catch { created = undefined; }
  const remoteRev = join(root2, ".cotal", "agents", "remote-rev.md");
  check("persona create --on writes this root's catalog file with no owner, and its JSON says local files changed",
    createdJson.status === 0 && created?.outcome === "ok" && created.result?.localFilesChanged === true && created.result.perCallCaller === true && existsSync(remoteRev) && !/^owner:/m.test(readFileSync(remoteRev, "utf8")),
    { status: createdJson.status, stdout: createdJson.stdout.slice(-600) });
  const createdText = await cotal(["persona", "create", "remote-rev2", "--prompt", "review", "--subscribe", "", "--on", IID2, "--space", space], root2);
  mustHaveRun(createdText, "`persona create --on`");
  const receipt = strip(createdText.out);
  check("the receipt names the file the manager wrote and offers the local show, not a show --on that would refuse",
    createdText.status === 0 && /Local files:\s+\S*remote-rev2\.md, written by the manager in this root's catalog/.test(receipt) &&
      /cotal p show remote-rev2\s/.test(receipt) && !receipt.includes("cotal p show remote-rev2 --on") && receipt.includes(`cotal spawn remote-rev2 --on ${IID2}`),
    { status: createdText.status, out: receipt.slice(-900) });
  const shownRemote = await cotal(["persona", "show", "remote-rev", "--on", IID2, "--space", space], root2);
  mustHaveRun(shownRemote, "`persona show --on` by a later caller");
  check("a later show --on is refused not-found and names the local show for the file in this root",
    shownRemote.status === 2 && /TARGET_NOT_FOUND/.test(strip(shownRemote.out)) && strip(shownRemote.out).includes("read it here with cotal p show remote-rev"),
    { status: shownRemote.status, out: strip(shownRemote.out).slice(-600) });
  const remoteListed = await cotal(["persona", "--on", IID2, "--space", space], root2);
  mustHaveRun(remoteListed, "`persona --on`");
  const remoteListing = strip(remoteListed.out);
  check("the --on listing's Next offers the local show, not a show --on that would refuse",
    remoteListed.status === 0 && /cotal p show <name>\s/.test(remoteListing) && !remoteListing.includes("cotal p show <name> --on"),
    { status: remoteListed.status, out: remoteListing.slice(-600) });

  // One compiled manager build serves a different ps output contract. Copying the compiled build
  // into the disposable root keeps this variant isolated from the normal manager and CLI imports.
  console.log("\n8. a mixed-contract class census is incomplete, not a successful seat list");
  const variant = join(dir, "variant");
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  cpSync(join(repoRoot, "implementations/manager/dist"), variant, { recursive: true });
  symlinkSync(join(repoRoot, "implementations/manager/node_modules"), join(dir, "node_modules"), "dir");
  const contractFile = join(variant, "manager-service-contract.js");
  const source = readFileSync(contractFile, "utf8");
  const oldSchema = 'const PS_OUTPUT_SCHEMA = { type: "array", items: AGENT_ROW_SCHEMA };';
  const oldSlotsSchema = 'const SLOTS_OUTPUT_SCHEMA = { type: "array", items: SLOT_ROW_SCHEMA };';
  if (source.split(oldSchema).length !== 2 || source.split(oldSlotsSchema).length !== 2) throw new Error("fixture requires the compiled ps and slots schemas in manager/dist; build before running");
  writeFileSync(contractFile, source.replace(oldSchema,
    'const PS_OUTPUT_SCHEMA = { type: "array", items: { ...AGENT_ROW_SCHEMA, properties: { ...AGENT_ROW_SCHEMA.properties, fixtureVariant: { type: "string" } } } };').replace(oldSlotsSchema,
    'const SLOTS_OUTPUT_SCHEMA = { type: "array", items: { ...SLOT_ROW_SCHEMA, properties: { ...SLOT_ROW_SCHEMA.properties, fixtureVariant: { type: "string" } } } };'));
  const { Manager: VariantManager } = await import(join(variant, "manager.js"));
  const stub = join(import.meta.dirname, "e2e-stub.mjs");
  const envFor = (o: LaunchOpts): Record<string, string> => ({
    COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? ""), COTAL_CREDS: String(o.creds),
    COTAL_ID: String(o.id), COTAL_NAME: o.name, PATH: process.env.PATH ?? "",
    ...(o.lifecycleUid ? { COTAL_LIFECYCLE_UID: o.lifecycleUid } : {}),
  });
  const connector: Connector = { kind: "connector", name: "ps-census-stub", requires: ["node"],
    buildLaunch: (o): LaunchSpec => ({ command: "node", args: [stub], env: envFor(o) }) };
  registry.register(connector);
  await m2.stop({ withAgents: true });
  const root3 = mkRoot("ws3");
  recordMesh({ space, server: SERVERS, root: root3, mode: "auth", ts: new Date().toISOString() });
  for (const [root, name] of [[root1, "census-a"], [root3, "census-b"]] as const)
    writeFileSync(join(root, ".cotal", "agents", `${name}.md`), `---\nname: ${name}\nrole: worker\n---\n`);
  const mixedManager = new VariantManager({ space, servers: SERVERS, runtime: "pty", workspaceRoot: root3 });
  m2 = mixedManager;
  await mixedManager.start();
  const seatA = await m1.startAgent({ name: "census-a", agent: "ps-census-stub", cwd: repoRoot, events: false });
  const seatB = await mixedManager.startAgent({ name: "census-b", agent: "ps-census-stub", cwd: repoRoot, events: false });
  check("both real managers started a seat", seatA.ok === true && seatB.ok === true, { seatA, seatB });
  const observed = new Set<string>();
  for (let attempt = 0; attempt < 20 && observed.size < 2; attempt++) {
    const result = await cotal(["ps", "--space", space], root1);
    mustHaveRun(result, "mixed-contract ps");
    const out = strip(result.out);
    const listed = out.includes("census-a") ? "census-a" : out.includes("census-b") ? "census-b" : "none";
    observed.add(listed);
    check(`partial census attempt ${attempt + 1} refuses success, keeps one row, and reports the two digest pairs once`,
      result.status !== 0 && listed !== "none" && !out.includes(listed === "census-a" ? "census-b" : "census-a") &&
      /Incomplete manager census/.test(out) && /Managers in this space serve different ps contracts/.test(out) &&
      !/SPEC 13\.7/.test(out) && (out.match(/requested input\/output sha256:[a-f0-9]{64} \/ sha256:[a-f0-9]{64}; served input\/output sha256:[a-f0-9]{64} \/ sha256:[a-f0-9]{64}/g) ?? []).length === 1,
      { status: result.status, out });
  }
  check("both describe orderings were observed", observed.has("census-a") && observed.has("census-b"), [...observed]);
  // The same census as one document: the rows that were read, a warning naming the instance whose
  // contract differs, and a partial outcome that exits 4 instead of a complete-looking list.
  const partialJson = await cotal(["ps", "--json", "--space", space], root1);
  mustHaveRun(partialJson, "mixed-contract `ps --json`");
  const partialEnv = envelopeOf(partialJson);
  const mismatched = partialEnv?.result?.managers.filter((m) => m.state === "contract-mismatch") ?? [];
  check("a mixed-contract ps --json is one partial envelope: exit 4, the read row, and the mismatching instance named",
    partialJson.status === 4 && partialEnv?.outcome === "partial" && partialEnv.completeness === "partial" && partialEnv.error?.code === "OPERATION_PARTIAL" &&
      partialEnv.result?.items.length === 1 && mismatched.length === 1 &&
      partialEnv.warnings.some((w) => w.code === "MANAGER_CONTRACT_MISMATCH" && w.target.managerInstanceId === mismatched[0]!.instanceId),
    { status: partialJson.status, stdout: partialJson.stdout.slice(-800) });
  // `--slots` reads static slots, and its partial census says so rather than naming seats.
  const partialSlots = await cotal(["ps", "--slots", "--space", space], root1);
  mustHaveRun(partialSlots, "mixed-contract `ps --slots`");
  check("a mixed-contract ps --slots is partial, exit 4, and names the slots that were not returned",
    partialSlots.status === 4 && /instances did not return slots\./.test(strip(partialSlots.out)) && !/did not return seats/.test(strip(partialSlots.out)),
    { status: partialSlots.status, out: strip(partialSlots.out).slice(-600) });

  // A catalog the connector could not read leaves the read partial. One the install has no way to
  // list is a connector without a catalog: complete, exit 0, with the reason shown.
  console.log("\n9. models: an unreadable catalog is partial, one the install cannot list is not");
  const catalogStub = (name: string, listModels: NonNullable<Connector["listModels"]>): Connector =>
    ({ kind: "connector", name, requires: ["node"], buildLaunch: connector.buildLaunch, listModels });
  registry.register(catalogStub("models-listed", () => ({ source: "fixture catalog", models: [{ id: "fixture-model" }] })));
  registry.register(catalogStub("models-broken", () => { throw new Error("fixture catalog could not be read"); }));
  registry.register(catalogStub("models-unlisted", () => ({ models: [], unavailable: "this fixture install lists no catalog; pass --model" })));
  type ModelsEnvelope = {
    outcome: string; completeness: string; warnings: { code: string; target: { agent?: string } }[]; error?: { code: string };
    result: { items: { agent: string; supported: boolean; models: { id: string }[]; unavailable?: string; error?: string }[] } | null;
  };
  const modelsJson = async (agent?: string): Promise<{ run: Run; env: ModelsEnvelope | undefined }> => {
    const run = await cotal(["models", ...(agent ? ["--harness", agent] : []), "--json", "--space", space], root1);
    mustHaveRun(run, `\`models${agent ? ` --harness ${agent}` : ""} --json\``);
    let env: ModelsEnvelope | undefined;
    try { env = JSON.parse(run.stdout) as ModelsEnvelope; } catch { env = undefined; }
    return { run, env };
  };
  const listed = await modelsJson("models-listed");
  check("a connector that lists its catalog is a complete read, exit 0",
    listed.run.status === 0 && listed.env?.outcome === "ok" && listed.env.completeness === "complete" &&
      listed.env.result?.items[0]?.supported === true && listed.env.result.items[0].models[0]?.id === "fixture-model" && listed.env.warnings.length === 0,
    { status: listed.run.status, stdout: listed.run.stdout.slice(-600) });
  const unlisted = await modelsJson("models-unlisted");
  check("a catalog the install cannot list is supported: false with its reason, complete, exit 0, no warning",
    unlisted.run.status === 0 && unlisted.env?.outcome === "ok" && unlisted.env.completeness === "complete" &&
      unlisted.env.result?.items[0]?.supported === false && unlisted.env.result.items[0].unavailable === "this fixture install lists no catalog; pass --model" &&
      unlisted.env.result.items[0].error === undefined && unlisted.env.warnings.length === 0,
    { status: unlisted.run.status, stdout: unlisted.run.stdout.slice(-600) });
  const broken = await modelsJson("models-broken");
  check("the one catalog --harness names could not be read: failed, exit 5, with the connector's reason",
    broken.run.status === 5 && broken.env?.outcome === "failed" && broken.env.error?.code === "OPERATION_FAILED" && /fixture catalog could not be read/.test(broken.run.stdout),
    { status: broken.run.status, stdout: broken.run.stdout.slice(-600) });
  const every = await modelsJson();
  const rowOf = (agent: string) => every.env?.result?.items.find((row) => row.agent === agent);
  check("every catalog with one unreadable is partial, exit 4, with MODEL_CATALOG_UNREADABLE naming only that one",
    every.run.status === 4 && every.env?.outcome === "partial" && every.env.completeness === "partial" &&
      rowOf("models-broken")?.error === "fixture catalog could not be read" && rowOf("models-listed")?.models[0]?.id === "fixture-model" &&
      rowOf("models-unlisted")?.supported === false &&
      every.env.warnings.filter((w) => w.code === "MODEL_CATALOG_UNREADABLE").map((w) => w.target.agent).join() === "models-broken",
    { status: every.run.status, stdout: every.run.stdout.slice(-900) });
  const unlistedHuman = await cotal(["models", "--harness", "models-unlisted", "--space", space], root1);
  mustHaveRun(unlistedHuman, "`models --harness models-unlisted`");
  check("the report gives the reason the install lists no catalog and no failure",
    unlistedHuman.status === 0 && strip(unlistedHuman.out).includes("this fixture install lists no catalog; pass --model") && !/could not be read/.test(strip(unlistedHuman.out)),
    { status: unlistedHuman.status, out: strip(unlistedHuman.out).slice(-400) });

  // A manager on installed extensions lists every connector its manifest names, so one whose package
  // cannot be loaded still has a row. That row is an unread catalog, not a connector without one.
  console.log("\n10. models: an installed connector the manager cannot load leaves the read partial");
  await m1.stop({ withAgents: true });
  await mixedManager.stop({ withAgents: true });
  process.env.XDG_CONFIG_HOME = join(home, "xdg");
  saveExtensionsManifest({
    extensions: [{
      pkg: "@fixture/models-unloadable", version: "1.0.0", spec: "@fixture/models-unloadable@1.0.0",
      provides: [{ kind: "connector", name: "models-listed" }, { kind: "connector", name: "models-unloadable" }], commands: [],
      connectors: [{ name: "models-listed", requires: ["node"] }, { name: "models-unloadable", requires: ["node"] }],
    }],
  });
  m1 = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot: mkRoot("ws4"), installedExtensions: true });
  await m1.start();
  const installed = await modelsJson();
  const installedRow = (agent: string) => installed.env?.result?.items.find((row) => row.agent === agent);
  check("an installed connector that cannot load is partial, exit 4, with MODEL_CATALOG_UNREADABLE naming only that one",
    installed.run.status === 4 && installed.env?.outcome === "partial" && installed.env.completeness === "partial" &&
      /not installed at/.test(installedRow("models-unloadable")?.error ?? "") && installedRow("models-listed")?.models[0]?.id === "fixture-model" &&
      installed.env.warnings.filter((w) => w.code === "MODEL_CATALOG_UNREADABLE").map((w) => w.target.agent).join() === "models-unloadable",
    { status: installed.run.status, stdout: installed.run.stdout.slice(-900) });
  const installedHuman = await cotal(["models", "--space", space], root1);
  mustHaveRun(installedHuman, "`models` with an unloadable installed connector");
  check("the report names the load failure under that connector, not a missing catalog",
    installedHuman.status === 4 && /models-unloadable[\s\S]*not installed at/.test(strip(installedHuman.out)) && !strip(installedHuman.out).includes("no model catalog exposed"),
    { status: installedHuman.status, out: strip(installedHuman.out).slice(-600) });

  // A manager with no agent application installed takes no unpinned launch and refuses a pinned one.
  // Both refusals carry the code a spawn in this terminal gives and name the manager and its host,
  // because the application is added where that manager runs.
  console.log("\n11. a manager with no agent application: a pinned and an unpinned spawn name it and its host");
  await m1.stop({ withAgents: true });
  saveExtensionsManifest({ extensions: [] });
  const root5 = mkRoot("ws5");
  writeFileSync(join(root5, ".cotal", "agents", "bare.md"), "---\nname: bare\nrole: worker\n---\n");
  m1 = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot: root5, installedExtensions: true });
  await m1.start();
  const IID5 = (m1 as unknown as MgrPriv).managerInstanceId;
  const onHost = `manager ${IID5} on host ${hostname()}`;
  const addThere = "add it where that manager runs, such as `cotal ext add @cotal-ai/connector-claude-code`, then restart that manager";
  const pinnedApp = await cotal(["spawn", "bare", "--detach", "--on", IID5, "--harness", "claude", "--space", space], root1);
  mustHaveRun(pinnedApp, "a pinned spawn with no agent application");
  const pinnedAppOut = strip(pinnedApp.out);
  check("a pinned spawn the manager has no connector for is DEPENDENCY_UNAVAILABLE, exit 2, naming the manager, its host and the restart",
    pinnedApp.status === 2 && /Code:\s+DEPENDENCY_UNAVAILABLE/.test(pinnedAppOut) && pinnedAppOut.includes(`no connector "claude" is installed on ${onHost}; nothing was launched`) &&
      pinnedAppOut.includes(addThere),
    { status: pinnedApp.status, out: pinnedAppOut.slice(-900) });
  const pinnedAppJson = await cotal(["spawn", "bare", "--detach", "--on", IID5, "--harness", "claude", "--space", space, "--json"], root1);
  mustHaveRun(pinnedAppJson, "a pinned spawn --json with no agent application");
  let pinnedAppEnv: { error?: { code?: string; message?: string; remedy?: string } } | undefined;
  try { pinnedAppEnv = JSON.parse(pinnedAppJson.stdout); } catch { pinnedAppEnv = undefined; }
  check("...and its --json refusal carries the same code, manager and Next",
    pinnedAppJson.status === 2 && pinnedAppEnv?.error?.code === "DEPENDENCY_UNAVAILABLE" && pinnedAppEnv.error.message?.includes(onHost) === true && pinnedAppEnv.error.remedy?.startsWith(addThere) === true,
    { status: pinnedAppJson.status, stdout: pinnedAppJson.stdout.slice(-900) });
  const unpinnedApp = await cotal(["spawn", "bare", "--detach", "--harness", "claude", "--space", space], root1);
  mustHaveRun(unpinnedApp, "an unpinned spawn with no agent application");
  const unpinnedAppOut = strip(unpinnedApp.out);
  check("an unpinned spawn no manager takes is DEPENDENCY_UNAVAILABLE, exit 2, naming the manager, its host and the restart",
    unpinnedApp.status === 2 && /Code:\s+DEPENDENCY_UNAVAILABLE/.test(unpinnedAppOut) &&
      unpinnedAppOut.includes(`no manager of yours takes unpinned launches: none has an agent application installed (${onHost}); nothing was launched`) &&
      unpinnedAppOut.includes("add one where that manager runs, such as `cotal ext add @cotal-ai/connector-claude-code`, then restart that manager"),
    { status: unpinnedApp.status, out: unpinnedAppOut.slice(-900) });

  // A second manager whose catalog lacks the persona refuses a spawn pinned to it. The refusal names
  // that manager, its host and the file to create there, and its Next pins the spawn to the live
  // manager whose catalog has the persona. A persona no manager has gets the create step alone.
  console.log("\n12. a pinned spawn of a persona the manager lacks names it, its host and file, and a manager that has it");
  const root6 = mkRoot("ws6");
  m2 = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot: root6, installedExtensions: true });
  await m2.start();
  const IID6 = (m2 as unknown as MgrPriv).managerInstanceId;
  const lacking = await cotal(["spawn", "bare", "--detach", "--on", IID6, "--harness", "claude", "--space", space, "--json"], root1);
  mustHaveRun(lacking, "a pinned spawn of a persona that manager lacks");
  let lackingEnv: { error?: { code?: string; message?: string; remedy?: string } } | undefined;
  try { lackingEnv = JSON.parse(lacking.stdout); } catch { lackingEnv = undefined; }
  check("it names the manager, its host and the catalog file to create there, and not --config or a local personas list",
    lacking.status === 2 && lackingEnv?.error?.message === `no persona "bare" in the catalog of manager ${IID6} on host ${hostname()}: ${join(root6, ".cotal", "agents", "bare.md")} not found; create it there`,
    { status: lacking.status, stdout: lacking.stdout.slice(-900) });
  check("...and its Next runs the spawn again on the live manager whose catalog has it",
    lackingEnv?.error?.remedy?.startsWith('nothing was launched; this manager of yours has persona "bare": ') === true && lackingEnv.error.remedy.includes(`--on ${IID5}`) && !lackingEnv.error.remedy.includes(IID6),
    { remedy: lackingEnv?.error?.remedy });
  const nowhere = await cotal(["spawn", "nowhere", "--detach", "--on", IID6, "--harness", "claude", "--space", space], root1);
  mustHaveRun(nowhere, "a pinned spawn of a persona no manager has");
  const nowhereOut = strip(nowhere.out);
  check("a persona no live manager has is refused with the create step on that manager's host",
    nowhere.status === 2 && nowhereOut.includes(`no persona "nowhere" in the catalog of manager ${IID6} on host ${hostname()}`) &&
      nowhereOut.includes("nothing was launched; create that file on the manager's host, then run the spawn again") && !nowhereOut.includes("--config"),
    { status: nowhere.status, out: nowhereOut.slice(-900) });

  // `--timeout` is one deadline for the call, the contract read included. Nothing serves `nosuch`, so
  // its contract read is never answered and the refusal comes when the flag's 1000ms run out. The
  // resolver used to wait a fixed 10s here whatever the flag said. The 5s bound leaves room for load.
  console.log("\n13. invoke --timeout bounds the contract read of an endpoint nothing serves");
  const unservedMessage = "no instance of nosuch answered its contract read, so nothing is serving it or none could be reached";
  let startedAt = performance.now();
  const unserved = await cotal(["invoke", "nosuch", "ping", "--timeout", "1000", "--space", space], root1);
  const unservedMs = Math.round(performance.now() - startedAt);
  mustHaveRun(unserved, "an invoke of an endpoint nothing serves");
  const unservedOut = strip(unserved.out);
  check("invoke nosuch ping --timeout 1000 is refused TARGET_UNAVAILABLE, exit 2, within 5s and with the same message",
    unserved.status === 2 && unservedMs < 5000 && /Code:\s+TARGET_UNAVAILABLE/.test(unservedOut) && unservedOut.includes(unservedMessage),
    { status: unserved.status, elapsedMs: unservedMs, out: unservedOut.slice(-900) });
  startedAt = performance.now();
  const unservedJson = await cotal(["invoke", "nosuch", "ping", "--timeout", "1000", "--space", space, "--json"], root1);
  const unservedJsonMs = Math.round(performance.now() - startedAt);
  mustHaveRun(unservedJson, "an invoke --json of an endpoint nothing serves");
  let unservedEnv: { target?: { requestId?: unknown } } | undefined;
  try { unservedEnv = JSON.parse(unservedJson.stdout); } catch { unservedEnv = undefined; }
  const expectedEnv = {
    schemaVersion: 1, command: "invoke", target: { space, endpoint: "nosuch", command: "ping", requestedInstanceId: null, requestId: "<id>", accepted: null },
    outcome: "refused", completeness: "not-checked", result: null, warnings: [],
    error: { code: "TARGET_UNAVAILABLE", message: unservedMessage, remedy: `start the service that serves nosuch, then run the command again; cotal service --space ${space} lists this space's services`, cause: { code: "deadline-exceeded" } },
  };
  check("...and its --json envelope keeps its shape, within 5s",
    unservedJson.status === 2 && unservedJsonMs < 5000 && typeof unservedEnv?.target?.requestId === "string" &&
      JSON.stringify({ ...unservedEnv, target: { ...unservedEnv.target, requestId: "<id>" } }) === JSON.stringify(expectedEnv),
    { status: unservedJson.status, elapsedMs: unservedJsonMs, stdout: unservedJson.stdout.slice(-900) });

  // The manager serves, so a contract read that runs out of `--timeout` after its describe was
  // answered is the flag's deadline, not a missing service. A budget that short can also end before
  // the describe is answered, which is cell 13's refusal, so the budget starts at 1ms and doubles
  // until the describe was answered. `invoke` and `endpoint invoke` share this path and name
  // themselves in the Next.
  console.log("\n14. invoke --timeout says it ran out during the contract read of an endpoint that is served");
  const unanswered = "no instance of manager answered its contract read, so nothing is serving it or none could be reached";
  const ranOut = async (argv: string[]): Promise<{ ms: number; run: Run }> => {
    for (let ms = 1; ; ms *= 2) {
      const run = await cotal([...argv, "--timeout", String(ms), "--space", space], root1);
      mustHaveRun(run, `\`${argv.join(" ")} --timeout ${ms}\``);
      if (ms === 1024 || run.status !== 2 || !strip(run.out).includes(unanswered)) return { ms, run };
    }
  };
  const short = await ranOut(["invoke", "manager", "ps"]);
  const shortOut = strip(short.run.out);
  check("invoke manager ps whose contract read outruns --timeout fails OPERATION_FAILED, exit 5, naming the flag, the read and a longer --timeout",
    short.run.status === 5 && /Code:\s+OPERATION_FAILED/.test(shortOut) &&
      shortOut.includes(`the ${short.ms}ms --timeout ran out during the endpoint contract read; no command was published`) &&
      /^Next\n\s+rerun it with a longer --timeout and the same other flags, such as cotal invoke manager ps --timeout 10000$/m.test(shortOut),
    { timeoutMs: short.ms, status: short.run.status, out: shortOut.slice(-900) });
  const shortJson = await ranOut(["endpoint", "invoke", "manager", "ps", "--json"]);
  let shortEnv: { target?: { requestId?: unknown } } | undefined;
  try { shortEnv = JSON.parse(shortJson.run.stdout); } catch { shortEnv = undefined; }
  const expectedShortEnv = {
    schemaVersion: 1, command: "endpoint", target: { space, endpoint: "manager", command: "ps", requestedInstanceId: null, requestId: "<id>", accepted: null },
    outcome: "failed", completeness: "not-checked", result: null, warnings: [],
    error: { code: "OPERATION_FAILED", message: `the ${shortJson.ms}ms --timeout ran out during the endpoint contract read; no command was published`, remedy: "rerun it with a longer --timeout and the same other flags, such as cotal endpoint invoke manager ps --timeout 10000", cause: { code: "deadline-exceeded" } },
  };
  check("...and endpoint invoke --json carries that failure, its Next as the remedy and the native deadline-exceeded cause",
    shortJson.run.status === 5 && typeof shortEnv?.target?.requestId === "string" &&
      JSON.stringify({ ...shortEnv, target: { ...shortEnv.target, requestId: "<id>" } }) === JSON.stringify(expectedShortEnv),
    { timeoutMs: shortJson.ms, status: shortJson.run.status, stdout: shortJson.run.stdout.slice(-900) });

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
} finally {
  await m1?.stop({ withAgents: true }).catch(() => {});
  await m2?.stop({ withAgents: true }).catch(() => {});
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
process.exit(fail === 0 ? 0 : 1);
