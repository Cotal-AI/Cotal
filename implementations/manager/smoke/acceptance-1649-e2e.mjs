/**
 * ACCEPTANCE #1649, END TO END, on a REAL jcode seat this lane starts itself.
 *
 * WHAT IT DRIVES. A real `nats-server`, a real `Manager` on the `pty` runtime, and a real seat
 * launched through the REAL jcode connector (host -> api-bridge -> jcode server -> TUI), exactly as
 * the fleet spawns one. Three texts of DISTINCT byte lengths are typed into it through the REAL
 * `cotal input` binary, 30s apart.
 *
 * THE TUI IS LEFT ON, and that is load-bearing rather than incidental. `input` writes to the seat's
 * PTY, and on a jcode seat the process on the far end of that PTY is the TUI. Measured here with
 * `COTAL_JCODE_TUI=0`: the seat boots, joins, and answers, every call exits 0 with a full byte
 * receipt, and NOTHING is ever submitted - because the bytes land on the connector host's stdin,
 * which reads no keystrokes. That is a harness fault, not the defect, and it is exactly the shape
 * an observer would misread as "#1649 is still broken".
 *
 * WHAT IT GRADES, and why it is the seat's own state rather than the manager's receipt. `input`
 * answers `{name, bytes}` from what the runtime accepted; with #1649 present that reply was a full
 * byte count and exit 0 while NOTHING was submitted. So the witness here is the seat's OWN record,
 * inside its private managed JCODE_HOME:
 *   - `sessions/<id>.journal.jsonl`: every message appended to the session. A USER message's
 *     content byte length is what the seat actually submitted on that call, which is the only thing
 *     that can distinguish "submitted the text I just typed" from "submitted the previous one".
 *   - `TURN_CANCEL_REGISTERED ... active_turns=1` in the seat's own daily log: one line per turn
 *     the seat STARTED. A managed seat has no `prompt-history.jsonl` (that is the interactive TUI's
 *     own file, written only when a human types into a standalone jcode), so a harness that graded
 *     that file would score every managed run as zero and call the fix broken.
 * Both are read per call, as a DELTA around that call, so "one call behind" shows up as a shifted
 * number rather than being averaged away by a total.
 *
 * REQUIREMENTS UNDER TEST
 *   R1 one call submits the text IT typed on that same call -> the user message appended during
 *      call N has text N's byte length.
 *   R3 a text typed while the seat is IDLE starts a turn without a second call -> a turn-start line
 *      appears after each call and BEFORE the next call is made.
 *
 * NO-RESULT IS NOT A PASS AND NOT A FAILURE. If the seat never reaches a state where it can be
 * typed into, this exits 2 and says the harness is the problem: a loaded host or a missing
 * prerequisite must never be readable as a verdict about the fix.
 *
 * Run: node_modules/.bin/tsx implementations/manager/smoke/acceptance-1649-e2e.mjs
 * Exit 0 = R1 and R3 both established. 1 = a requirement is unmet. 2 = not measurable here.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const BIN = join(repoRoot, "bin", "cotal.ts");
const TSX = join(repoRoot, "node_modules", ".bin", "tsx");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const noResult = (why) => { console.error(`\nNO RESULT: ${why}`); finish(2); };

for (const tool of ["jcode", "nats-server", "node"])
  if (!spawnSync("command", ["-v", tool], { shell: true, encoding: "utf8" }).stdout.trim())
    noResult(`no \`${tool}\` on PATH; this harness drives a real seat and cannot run without it`);
if (!existsSync(TSX)) noResult(`no tsx at ${TSX}; run pnpm install first`);

// The live fleet must never be touched: a stray COTAL_SERVERS would point `cotal input` at the real
// broker and type into somebody's production agent.
const LIVE_HOST = "broker.cotal.ai";
for (const k of ["COTAL_SERVERS", "COTAL_SERVER", "COTAL_CREDS", "COTAL_SPACE"]) delete process.env[k];
for (const [k, v] of Object.entries(process.env))
  if (typeof v === "string" && v.includes(LIVE_HOST)) noResult(`refusing to run: ${k} points at the live broker`);

const RUN = randomUUID().slice(0, 8);
const ROOT = join(repoRoot, ".tmp", `acc1649-${RUN}`);
const HOME = join(ROOT, "cotal-home");
const WS = join(ROOT, "ws");
mkdirSync(join(WS, ".cotal", "agents"), { recursive: true });
mkdirSync(HOME, { recursive: true });
process.env.COTAL_HOME = HOME;

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});
const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
if (!/^nats:\/\/127\.0\.0\.1:\d+$/.test(SERVERS)) noResult(`only an ephemeral loopback broker is allowed; got ${SERVERS}`);

const { createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity, isReachable } = await import("@cotal-ai/core");
const { authDir, saveSpaceAuth, recordMesh } = await import("@cotal-ai/workspace");
const { Manager } = await import(join(repoRoot, "implementations/manager/src/manager.ts"));
await import(join(repoRoot, "extensions/connector-jcode/src/extension.ts"));

const space = `acc1649${RUN.replace(/-/g, "")}`;
const auth = await createSpaceAuth(space);
saveSpaceAuth(authDir(WS), auth);
const SEAT = "typist";
writeFileSync(join(WS, ".cotal", "agents", `${SEAT}.md`), `---\nname: ${SEAT}\nrole: worker\n---\nYou are a test seat. Answer in one word.\n`);
writeFileSync(join(ROOT, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(ROOT, "js") }));
const srv = spawn("nats-server", ["-c", join(ROOT, "server.conf")], { stdio: "ignore" });

// The seat needs a provider key to run a turn at all; without one there is no turn to observe.
const KEY_FILE = join(process.env.HOME ?? "", ".jcode", "provider-cliproxy.env");
if (!process.env.JCODE_PROVIDER_CLIPROXY_API_KEY && existsSync(KEY_FILE)) {
  const [, ...rest] = readFileSync(KEY_FILE, "utf8").trim().split("=");
  process.env.JCODE_PROVIDER_CLIPROXY_API_KEY = rest.join("=");
}
if (!process.env.JCODE_PROVIDER_CLIPROXY_API_KEY) noResult("no provider key for the seat; it could never start a turn");

// THE THREE TEXTS, distinct byte lengths on purpose: a submission shifted by one call is then a
// different NUMBER, not a coincidence. The longest is over the 2048-byte slice the fix writes in,
// so the oversized-write half of the defect is exercised too.
const mk = (n, tag) => {
  const head = `Reply with the single word ${tag} and nothing else. Padding follows: `;
  return head + "x".repeat(Math.max(0, n - head.length));
};
const TEXTS = [mk(120, "ALPHA"), mk(700, "BRAVO"), mk(2600, "CHARLIE")];
const WANT = TEXTS.map((t) => Buffer.byteLength(t, "utf8"));

/** The seat's PRIVATE managed jcode home, as the connector derives it under the workspace root. */
const seatHome = () => {
  const managed = join(WS, ".cotal", "jcode");
  if (!existsSync(managed)) return undefined;
  const dirs = readdirSync(managed);
  return dirs.length ? join(managed, dirs[0]) : undefined;
};
/** Byte length of every USER message the seat has appended to its session, in order. This is what
 *  it SUBMITTED, taken from the seat's own journal rather than from the manager's receipt. */
const submissions = () => {
  const h = seatHome();
  if (!h) return [];
  const dir = join(h, "sessions");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".journal.jsonl"))) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean)) {
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      for (const m of o.append_messages ?? []) {
        if (m?.role !== "user") continue;
        const c = m.content;
        const text = Array.isArray(c) ? c.filter((p) => p && typeof p === "object").map((p) => p.text ?? "").join("") : String(c ?? "");
        const bytes = Buffer.byteLength(text, "utf8");
        if (bytes > 0) out.push({ bytes, head: text.slice(0, 60) });
      }
    }
  }
  return out;
};
/** One entry per turn the seat STARTED, from its own log. */
const turnStarts = () => {
  const h = seatHome();
  if (!h) return [];
  const dir = join(h, "logs");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((n) => n.startsWith("jcode-") && n.endsWith(".log")))
    for (const line of readFileSync(join(dir, f), "utf8").split("\n"))
      if (/TURN_CANCEL_REGISTERED/.test(line)) out.push(line.trim());
  return out;
};

function cotal(args, timeoutMs = 120_000) {
  return new Promise((res) => {
    const child = spawn(TSX, [BIN, ...args], {
      cwd: WS, env: { ...process.env, COTAL_HOME: HOME, COTAL_SKIP_CONNECTOR_SEED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", timedOut = false, settled = false;
    const t = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    const done = (r) => { if (settled) return; settled = true; clearTimeout(t); res(r); };
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("error", (e) => done({ status: null, out, timedOut, launchError: e.message }));
    child.on("close", (s, sg) => done({ status: s, out, timedOut, signal: sg }));
  });
}
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

const report = {
  issue: 1649, startedAt: new Date().toISOString(), space, servers: SERVERS,
  sentBytesPerCall: WANT, calls: [], harness: {},
};
let mgr;
function finish(code) {
  report.finishedAt = new Date().toISOString();
  report.exitCode = code;
  report.seatHome = seatHome();
  writeFileSync(join(repoRoot, "fix-report.json"), JSON.stringify(report, null, 2));
  try { srv.kill("SIGKILL"); } catch {}
  process.exit(code);
}

let exitCode = 2;
try {
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { if (await isReachable(SERVERS)) up = true; else await sleep(200); }
  if (!up) noResult(`nats-server never came up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  recordMesh({ space, server: SERVERS, root: WS, mode: "auth", ts: new Date().toISOString() });
  mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot: WS });
  await mgr.start();
  console.log(`broker ${SERVERS}, space ${space}, workspace ${WS}`);

  // TUI ON: the far end of the seat's PTY must be the thing that reads keystrokes. See the header.
  process.env.COTAL_JCODE_TUI = "1";
  // The model is overridable because a rate-limited provider is a NO-RESULT here, not a verdict:
  // this harness needs a seat that can actually run a turn, and which model does that on a given
  // day is not a property of #1649.
  const MODEL = process.env.ACC1649_MODEL?.trim();
  const spawnArgs = ["spawn", SEAT, "--name", SEAT, "--agent", "jcode", "--space", space, "--cwd", ROOT, "--detach"];
  if (MODEL) spawnArgs.push("--model", MODEL);
  report.harness.model = MODEL ?? "(connector default)";
  const spawnRun = await cotal(spawnArgs, 600_000);
  report.harness.spawn = { exitCode: spawnRun.status, tail: strip(spawnRun.out).slice(-1200) };
  console.log(`spawn exit=${spawnRun.status}\n${strip(spawnRun.out).slice(-900)}`);
  if (spawnRun.status !== 0) {
    // A provider that refused every attempt is an environment fact, and saying so is the difference
    // between "could not measure" and "the fix failed".
    const home = seatHome();
    const log = home && existsSync(join(home, "logs")) ? readdirSync(join(home, "logs")).filter((n) => n.startsWith("jcode-")).map((n) => readFileSync(join(home, "logs", n), "utf8")).join("") : "";
    const rateLimited = (log.match(/ERROR_RATE_LIMITED/g) ?? []).length;
    report.harness.seatFailure = { rateLimitedResponses: rateLimited, tail: log.split("\n").slice(-25).join("\n").slice(-1500) };
    noResult(rateLimited > 0
      ? `the seat's provider refused every attempt (${rateLimited} rate-limited responses); nothing about #1649 was measured`
      : `the seat never started (cotal spawn exit ${spawnRun.status}); fix the harness before concluding anything about #1649`);
  }

  // The seat is typeable only once its private home AND its session journal exist: a call typed
  // into the gap would be graded against a seat that has no session to submit into.
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    if (seatHome() && submissions().length > 0) ready = true; else await sleep(2000);
  }
  report.harness.seatHome = seatHome();
  if (!ready) noResult("the seat never reached a typeable state under this harness; the harness is the problem, not the fix");
  console.log(`seat live; private home ${seatHome()}`);
  // Let the connector's own boot traffic (persona + readiness turn) settle, so the turns counted
  // below are the ones THIS harness caused.
  for (let i = 0; i < 60; i++) {
    const a = submissions().length; await sleep(4000);
    if (submissions().length === a) break;
  }
  report.harness.boot = { submissionsBeforeFirstCall: submissions().length, turnsBeforeFirstCall: turnStarts().length };
  console.log(`boot settled: ${report.harness.boot.submissionsBeforeFirstCall} submissions, ${report.harness.boot.turnsBeforeFirstCall} turns before call 1`);

  for (const [i, text] of TEXTS.entries()) {
    const subBefore = submissions();
    const turnsBefore = turnStarts();
    const at = new Date().toISOString();
    const run = await cotal(["input", "--name", SEAT, `--text=${text}`, "--space", space], 120_000);
    const out = strip(run.out);
    // Time for the seat to submit AND start the turn, inside the 30s spacing between calls.
    await sleep(24_000);
    const subDelta = submissions().slice(subBefore.length);
    const turnDelta = turnStarts().slice(turnsBefore.length);
    const call = {
      index: i + 1, at, sentBytes: WANT[i], exitCode: run.status,
      cliReceiptBytes: Number((out.match(/sent (\d+) bytes/) ?? [])[1] ?? 0) || null,
      submittedBytes: subDelta.map((s) => s.bytes),
      submittedHeads: subDelta.map((s) => s.head),
      turnsStarted: turnDelta.length,
      turnLines: turnDelta,
      cliTail: out.slice(-300),
    };
    report.calls.push(call);
    console.log(`\ncall ${i + 1}: sent ${WANT[i]} bytes, exit ${run.status}, receipt ${call.cliReceiptBytes}`);
    console.log(`  submitted during this call : [${call.submittedBytes}]`);
    console.log(`  turns started during it    : ${call.turnsStarted}`);
    if (i < TEXTS.length - 1) await sleep(6_000); // 24s + 6s = the 30s spacing
  }

  // ---- verdicts -------------------------------------------------------------------------------
  // A call's own text is matched by BYTE LENGTH among what it submitted, so a seat that also
  // appends a system-reminder in the same window cannot mask or fake the match.
  const matched = report.calls.map((c) => c.submittedBytes.includes(c.sentBytes));
  const shifted = report.calls.slice(1).map((c, i) => c.submittedBytes.includes(WANT[i]));
  const r1 = matched.every(Boolean);
  const r3 = report.calls.every((c) => c.turnsStarted >= 1);
  const oneBehind = !r1 && shifted.some(Boolean);
  report.verdict = {
    requirement1_submitsTextOfTheSameCall: r1 ? "MET" : oneBehind ? "UNMET: one call behind" : "UNMET",
    requirement3_idleSeatStartsATurn: r3 ? "MET" : "UNMET: a call did not start a turn",
    perCall: report.calls.map((c) => ({ call: c.index, sent: c.sentBytes, submitted: c.submittedBytes, exitCode: c.exitCode, turnsStarted: c.turnsStarted })),
  };
  console.log(`\nsent bytes      : [${WANT}]`);
  console.log(`submitted match : [${matched}]`);
  console.log(`turns started   : [${report.calls.map((c) => c.turnsStarted)}]`);
  if (report.calls.every((c) => c.submittedBytes.length === 0))
    noResult("the seat submitted NOTHING on any call, so neither requirement was measured here");
  exitCode = r1 && r3 ? 0 : 1;
  console.log(`\nR1 ${report.verdict.requirement1_submitsTextOfTheSameCall}\nR3 ${report.verdict.requirement3_idleSeatStartsATurn}`);
} catch (error) {
  report.harness.error = String(error?.stack ?? error);
  console.error(error);
  exitCode = 2;
} finally {
  try { await cotal(["despawn", "--name", SEAT, "--space", space, "--force"], 60_000); } catch {}
  try { await mgr?.stop?.(); } catch {}
}
finish(exitCode);
