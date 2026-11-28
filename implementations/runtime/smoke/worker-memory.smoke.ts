/**
 * A workflow run's memory is bounded, and reaching the bound ends the run and never the process,
 * through the `cotal` binary's `run start --local` against a real broker.
 *
 * The compiled engine runs each program in its own worker thread, created with a fixed heap limit.
 * A thread that reaches the limit is ended by node and its run fails; the process carries on. That
 * holds only while the heap grows in steps the collector sees coming: one very large allocation
 * made near the limit ends the whole process instead. So the language also bounds every array and
 * string a program builds, and a value over the bound is refused (L4016) before it is built.
 *
 * Every start runs in its own child process, so a process that ends shows as its exit code and
 * signal instead of ending this suite.
 *
 * Cells:
 *   1. control: a program building a few megabytes completes, exit 0;
 *   2. a process started with a V8 heap flag that replaces the thread's limit refuses to run a
 *      program at all, naming the heap limit; the control is every other cell, which runs under no
 *      such flag and whose thread therefore reports the engine's own limits;
 *   3. four `range(30000000)` calls are refused L4016 naming `range`, the start fails, and the
 *      process exits on its own rather than aborting;
 *   4. doubling an array by spread until it is too large is refused the same way;
 *   5. a string over the bound is refused L4016 naming `repeat`;
 *   6. the largest allowed `range`, repeated until the heap limit, fails the run at the memory limit
 *      and the process exits on its own;
 *   7. the same for the largest allowed two-byte string;
 *   8. that run's record says failed, naming the memory limit;
 *   9. a record built field by field in a loop is refused at the record bound (L4016, a member write
 *      that adds a field), at a size well under the one that ends the process;
 *  10. every refusal in REFUSALS on both engines (the engine through the binary, the walker in a
 *      child), each naming its code and operation, and neither process ending on an abort;
 *  10b. in-bound programs in BEHAVES give main's value on both engines: spreads copied when
 *      evaluated, converted counts, exact `$`` and `$'` lengths, string destructuring by pattern,
 *      repeated keys counted once;
 *  10c. a spread in a primitive's arguments is refused L1029 before the run starts;
 *  10d. the walker refuses a callable `then` before the next property runs, as main's did;
 *  10e. what leaves the thread is bounded: 400 lines of the largest string complete under a 512 MB
 *      host heap, and one line of 120 references to one string is refused L4016;
 *  11. a replace whose result would pass the bound is refused before it is built;
 *  12. a raising heap flag releases the run, and a lowering one still runs.
 *
 * Run: pnpm smoke:runtime-worker-memory   (needs nats-server on PATH and a built `bin/dist`)
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@nats-io/transport-node";
import {
  isReachable, createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity, standaloneConnectOpts,
  openRecordsBucket, readRunRecord,
} from "@cotal-ai/core";
import { authDir, recordMesh, saveSpaceAuth } from "@cotal-ai/workspace";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, emitSentinel, teardownOnSignal } from "@cotal-ai/smoke-kit";

const COTAL = fileURLToPath(new URL("../../../bin/dist/cotal.js", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "cotal-wmem-home-"));
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
process.env.COTAL_HOME = home;

const SPACE = "wmem";
const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}wmem-`));
const auth = await createSpaceAuth(SPACE);
writeFileSync(join(sd, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(sd, "js") }));
const broker = spawn("nats-server", ["-c", join(sd, "server.conf")], { stdio: "ignore" });
teardownOnSignal(broker);
const servers = `nats://127.0.0.1:${PORT}`;
const root = mkdtempSync(join(tmpdir(), "cotal-wmem-root-"));


/** One value over a bound through each operation: [name, program, code, words in the failure, and "engine" for a bound only the engine's thread has]. */
const REFUSALS: readonly (readonly [string, string, string, string, string?])[] = [
  ["repeat with a converted count", 'const s = "\u0436".repeat("300000000");\n', "L4016", "repeat: a string of"],
  ["padStart with a converted length", 'const s = "x".padStart("300000000");\n', "L4016", "padStart: a string of"],
  ["padEnd with a converted length", 'const s = "x".padEnd("300000000");\n', "L4016", "padEnd: a string of"],
  ["range with a converted count", 'const xs = range("40000000");\n', "L4016", "range: an array of"],
  ["replaceAll growing past the bound", 'const r = "a".repeat(3999999).replaceAll("a", "aa");\n', "L4016", "replaceAll: a string of"],
  ["the free replace growing past the bound", 'const r = replace("a".repeat(3999999), "a", "aa");\n', "L4016", "replace: a string of"],
  ["replace with $` past the bound", 'const r = ("x".repeat(2000001) + "Y").replace("Y", "$`$`");\n', "L4016", "replace: a string of 6000003"],
  ["replace with $\' past the bound", 'const r = ("Y" + "x".repeat(2000001)).replace("Y", "$\'$\'");\n', "L4016", "replace: a string of 6000003"],
  ["split with a large limit", 'const xs = "x".repeat(4000000).split("", 1000000000);\n', "L4016", "split: an array of"],
  ["split with a negative limit", 'const xs = "x".repeat(4000000).split("", -1);\n', "L4016", "split: an array of"],
  ["split with no limit", 'const xs = "x".repeat(1000001).split("");\n', "L4016", "split: an array of 1000001"],
  ["the free split", 'const xs = split("x".repeat(1000001), "");\n', "L4016", "split: an array of 1000001"],
  ["json.parse of a long array", 'const t = "[" + "0,".repeat(1000000) + "0]";\nconst xs = json.parse(t);\n', "L4016", "json.parse: an array of"],
  ["json.parse of a record with too many fields", 'const xs = range(250001);\nconst t = "{" + join(map(xs, (i) => `"a${i}":0`), ",") + "}";\nconst o = json.parse(t);\n', "L4016", "json.parse: 250001 record fields"],
  ["json.stringify past the bound", 'const s = "y".repeat(3000000);\nconst t = json.stringify([s, s]);\n', "L4016", "json.stringify: a string of"],
  ["merge past the bound", 'const xs = range(200000);\nconst big = json.parse("{" + join(map(xs, (i) => `"a${i}":0`), ",") + "}");\nconst big2 = json.parse("{" + join(map(xs, (i) => `"b${i}":0`), ",") + "}");\nconst m = merge(big, big2);\n', "L4016", "merge: 400000 record fields"],
  ["an array spread past the bound", 'const a = range(600000);\nconst b = [...a, ...a];\n', "L4016", "this spread: an array of 1200000"],
  ["a string spread past the bound", 'const s = "x".repeat(1000001);\nconst b = [...s];\n', "L4016", "spreading this string: an array of 1000001"],
  ["a call spread past the bound", 'const a = range(600000);\nconst f = (...r) => len(r);\nconst n = f(...a, ...a);\n', "L4016", "this spread: an array of 1200000"],
  ["a record spread past the bound", 'const xs = range(200000);\nconst a = json.parse("{" + join(map(xs, (i) => `"a${i}":0`), ",") + "}");\nconst b = json.parse("{" + join(map(xs, (i) => `"b${i}":0`), ",") + "}");\nconst c = { ...a, ...b };\n', "L4016", "this record spread: 400000"],
  ["an array rest pattern past the bound", 'const s = "x".repeat(1000002);\nconst [a, ...r] = s;\n', "L4016", "this rest element: an array of 1000001"],
  ["a template past the bound by its trailing text", 'const s = "y".repeat(3999999);\nconst t = `${s}zz`;\n', "L4016", "this template: a string of 4000001"],
  ["+ past the bound", 'const s = "y".repeat(3999999);\nconst t = s + "zz";\n', "L4016", "`+`: a string of 4000001"],
  ["+= past the bound", 'let s = "y".repeat(3999999);\ns += "zz";\n', "L4016", "`+`: a string of 4000001"],
  ["sum over strings past the bound", 'const s = "y".repeat(4000000);\nconst t = sum(range(130).map(() => s));\n', "L4016", "sum: a string of 4000001"],
  ["concat past the bound", 'const a = range(600000);\nconst b = a.concat(a);\n', "L4016", "concat: an array of 1200000"],
  ["the free concat past the bound", 'const a = range(1000000);\nconst b = concat(a, 1);\n', "L4016", "concat: an array of 1000001"],
  ["string concat past the bound", 'const s = "y".repeat(3999999);\nconst t = s.concat("zz");\n', "L4016", "concat: a string of 4000001"],
  ["flat past the bound", 'const a = range(600000);\nconst b = [a, a].flat();\n', "L4016", "flat: an array of 1200000"],
  ["flatMap past the bound", 'const a = range(600000);\nconst b = [1, 2].flatMap(() => a);\n', "L4016", "flatMap: an array of 1200000"],
  ["join past the bound", 'const s = "y".repeat(3000000);\nconst t = [s, s].join("");\n', "L4016", "join: a string of 6000000"],
  ["the free join past the bound", 'const s = "y".repeat(3000000);\nconst t = join([s, s], "");\n', "L4016", "join: a string of 6000000"],
  ["toUpperCase past the bound", 'const s = "\\u00df".repeat(2000001);\nconst t = s.toUpperCase();\n', "L4016", "toUpperCase: a string of 4000002"],
  ["upper past the bound", 'const s = "\\u00df".repeat(2000001);\nconst t = upper(s);\n', "L4016", "upper: a string of 4000002"],
  ["an index write past the bound", 'const xs = range(1000000);\nxs[1000000] = 1;\n', "L4016", "this index write:"],
  ["a member write adding a field past the bound", 'const o = json.parse("{" + join(map(range(250000), (i) => `"a${i}":0`), ",") + "}");\no.extra = 1;\n', "L4016", "this field write: 250001 record fields"],
  ["push past the bound", 'const xs = range(1000000);\nxs.push(1);\n', "L4016", "push:"],
  ["unshift past the bound", 'const xs = range(1000000);\nxs.unshift(1);\n', "L4016", "unshift:"],
  ["splice past the bound", 'const xs = range(1000000);\nxs.splice(0, 0, 1);\n', "L4016", "splice:"],
  ["a log line past the crossing bound", 'const s = "y".repeat(4000000);\nlog(range(3).map(() => s));\n', "L4016", "this log line is more than the 8004096 bytes", "engine"],
  ["effect arguments past the crossing bound", 'const s = "y".repeat(4000000);\nconst c = channel("c1");\nawait wait(message(c, { matches: [s, s, s] }), { name: "w", timeout: "1s" });\n', "L4016", "the arguments of `wait` is more than the 8004096 bytes"],
];

/**
 * In-bound programs whose result both engines must give, and which main gave. Each program ends with
 * `log("value", json.stringify(v))`, so both engines print the same canonical text. [name, program,
 * the canonical JSON of `v`].
 */
const BEHAVES: readonly (readonly [string, string, string])[] = [
  ["an array spread is copied when it is evaluated", 'const xs = [1];\nconst v = [...xs, xs.push(2)];\n', "[1,2]"],
  ["a record spread is copied when it is evaluated", 'const o = { a: 1 };\nconst v = { ...o, b: (o.c = 3) };\n', '{"a":1,"b":3}'],
  ["a call spread is copied when it is evaluated", 'const xs = [1, 1];\nconst f = (...r) => r;\nconst v = f(...xs, xs.pop());\n', "[1,1,1]"],
  ["a converted count is the host's count", 'const v = ["x".repeat("3"), range("3"), (1.5).toFixed("2"), (255).toString("16"), abs("-3"), floor(true)];\n', '["xxx",[0,1,2],"1.50","ff",3,1]'],
  ["$` in a replacement is the text before the match", 'const v = len("x".repeat(2000001).replace("x", "$`"));\n', "2000000"],
  ["$\' in a replacement is the text after the match", 'const v = len("x".repeat(2000001).replace("x", "$\'"));\n', "4000000"],
  ["$& and $$ in a replacement", 'const v = "abc".replaceAll("b", "[$&$$]");\n', '"a[b$]c"'],
  ["destructuring a long string takes what the pattern names", 'const s = "y".repeat(1000001);\nconst [a, b] = s;\nconst v = a + b;\n', '"yy"'],
  ["merge of a record with itself counts each key once", 'const a = json.parse("{" + join(map(range(200000), (i) => `"a${i}":0`), ",") + "}");\nconst v = [len(keys(merge(a, a))), len(keys({ ...a, ...a }))];\n', "[200000,200000]"],
  ["json.parse of a repeated key counts it once", 'const o = json.parse("{" + "\\"k\\":0,".repeat(300000) + "\\"k\\":1}");\nconst v = o.k;\n', "1"],
];
const DECLARED = 9 + REFUSALS.length * 2 - REFUSALS.filter((r) => r[4] === "engine").length + BEHAVES.length * 2 + 3 + 5;
let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.error("  ✗ FAIL:", n, extra ?? ""); } };
const done = () => {
  try { broker.kill("SIGKILL"); } catch { /* already gone */ }
  for (const d of [sd, home, root]) rmSync(d, { recursive: true, force: true });
};
process.on("exit", done);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let up = false;
for (let i = 0; i < 60 && !up; i += 1) {
  up = await isReachable(servers, { creds: await mintCreds(auth, newIdentity(), "probe") }).catch(() => false);
  if (!up) await wait(100);
}
if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
await setupSpaceStreams({ servers, space: SPACE, creds: await mintCreds(auth, newIdentity(), "provisioner") });
mkdirSync(join(root, ".cotal"), { recursive: true });
saveSpaceAuth(authDir(root), auth);
recordMesh({ space: SPACE, server: servers, root, mode: "auth", ts: new Date().toISOString() });

const EP = "manager";
const record = async (runId: string) => {
  const creds = await mintCreds(auth, newIdentity(), "run-operator", { runOperator: { endpoint: EP, runId, takeoverId: "t1" } });
  const nc = await connect({ servers, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  try { return await readRunRecord(await openRecordsBucket(nc, SPACE), EP, runId); } finally { await nc.drain().catch(() => {}); }
};

interface Started { code: number | null; signal: NodeJS.Signals | null; out: string; runId: string }
/** `cotal run start <file> --local` in its own process, as an operator types it. Any heap flag the
 *  suite was started with is dropped, so each run gets the engine's own limits unless `nodeOptions`
 *  says otherwise. */
const start = (name: string, source: string, nodeOptions?: string): Promise<Started> => {
  const file = join(sd, `${name}.cotal.js`);
  writeFileSync(file, source);
  const child = spawn(process.execPath, [COTAL, "run", "start", file, "--local", "--admit-read", "none", "--admit-publish", "none", "--space", SPACE, "--server", servers],
    { cwd: root, env: { ...process.env, COTAL_SKIP_CONNECTOR_SEED: "1", NODE_OPTIONS: nodeOptions ?? "" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { out += d.toString(); });
  return new Promise((resolve) => child.once("exit", (code, signal) =>
    resolve({ code, signal, out, runId: /starting run (run-[0-9a-f]+)/.exec(out)?.[1] ?? "" })));
};
/** The process ended on its own with the CLI's failure code: no signal, no V8 abort. */
const exitedOnItsOwn = (r: Started) => r.signal === null && r.code !== null && r.code !== 134 && !r.out.includes("FATAL ERROR");
/** The failure the run record keeps whole; the start's own report carries only the code's title. */
const failureOf = async (r: Started) => (r.runId === "" ? "" : (await record(r.runId))?.status?.value.failure?.message ?? "");

// ── 1) control ───────────────────────────────────────────────────────────────────────────────
{
  const r = await start("small", 'const xs = [];\nfor (let i = 0; i < 20; i += 1) {\n  xs.push(range(10000));\n}\nlog("built", len(xs));\n');
  c("a program building a few megabytes completes, exit 0", r.code === 0 && r.out.includes(`run ${r.runId}: completed`), r);
}

// ── 2) the heap limit itself ─────────────────────────────────────────────────────────────────
// A V8 heap flag on the process replaces the limits a thread is created with. The engine thread
// checks the limits it reports before any run exists, so a replaced limit refuses the run instead of
// running it unbounded. Every other cell runs with no flag and gets past this check, so they read the
// same check from the other side.
{
  const r = await start("heap", 'log("ran");\n', "--max-old-space-size=4096");
  c("a process whose heap flag replaces the engine thread's limit refuses to run the program, naming the limit",
    r.code !== 0 && !r.out.includes("log ran") && r.out.includes("heap limit is") && exitedOnItsOwn(r), { code: r.code, signal: r.signal, out: r.out.slice(-600) });
}

// ── 3) four very large ranges ────────────────────────────────────────────────────────────────
{
  const r = await start("ranges", "const a = range(30000000);\nconst b = range(30000000);\nconst c = range(30000000);\nconst d = range(30000000);\n");
  c("four range(30000000) calls are refused L4016 naming range, and the process exits on its own",
    r.code !== 0 && r.out.includes("L4016") && /range: an array of 30000000 elements/.test(await failureOf(r)) && exitedOnItsOwn(r), { code: r.code, signal: r.signal, out: r.out.slice(-400) });
}

// ── 4) doubling by spread ────────────────────────────────────────────────────────────────────
{
  const r = await start("doubling", "let xs = [1];\nconst keep = [];\nwhile (true) {\n  xs = [...xs, ...xs];\n  keep.push(xs);\n}\n");
  c("doubling an array by spread is refused L4016 at the spread, and the process exits on its own",
    r.code !== 0 && r.out.includes("L4016") && /this spread: an array of \d+ elements/.test(await failureOf(r)) && exitedOnItsOwn(r), { code: r.code, signal: r.signal, out: r.out.slice(-400) });
}

// ── 5) a string over the bound ───────────────────────────────────────────────────────────────
{
  const r = await start("repeat", 'const s = "ab".repeat(30000000);\n');
  c("a string over the bound is refused L4016 naming repeat", r.code !== 0 && r.out.includes("L4016") && /repeat: a string of 60000000 units/.test(await failureOf(r)) && exitedOnItsOwn(r), { code: r.code, out: r.out.slice(-400) });
}

// ── 6, 7, 8) the largest allowed values, repeated until the limit ───────────────────────────
let lastLimited = "";
{
  const r = await start("max-range", "const keep = [];\nwhile (true) {\n  keep.push(range(1000000));\n}\n");
  c("the largest allowed range, repeated, fails the run at the memory limit and the process exits on its own",
    r.code !== 0 && r.out.includes("memory limit of 512 MB") && exitedOnItsOwn(r), { code: r.code, signal: r.signal, out: r.out.slice(-400) });
}
{
  const r = await start("max-string", 'const keep = [];\nlet i = 0;\nwhile (true) {\n  const s = "\\u0101".repeat(3999990) + `${i}`;\n  if (s.includes("q")) {\n    log("never");\n  }\n  keep.push(s);\n  i += 1;\n}\n');
  lastLimited = r.runId;
  c("the largest allowed two-byte string, repeated, fails the run at the memory limit and the process exits on its own",
    r.code !== 0 && r.out.includes("memory limit of 512 MB") && exitedOnItsOwn(r), { code: r.code, signal: r.signal, out: r.out.slice(-400) });
}
{
  const status = (await record(lastLimited))?.status?.value;
  c("that run is recorded failed with a message naming the engine's memory limit",
    status?.state === "failed" && /memory limit of 512 MB/.test(status.failure?.message ?? ""), status);
}

// ── 9) a record built field by field ───────────────────────────────────────────────────────────
// A member write that adds a field is held to the record bound, so the loop is refused at 250,001
// fields, before the step budget and well under the size that ended the process (about 6,000,000
// fields, under a raised step budget).
{
  const r = await start("fields", 'const o = {};\nlet i = 0;\nwhile (true) {\n  o[`k${i}`] = i;\n  i += 1;\n}\n');
  c("a record built field by field is refused at the record bound (L4016, this field write), and the process exits on its own",
    r.code !== 0 && /this field write: 250001 record fields/.test(await failureOf(r)) && exitedOnItsOwn(r), { code: r.code, signal: r.signal, out: r.out.slice(-400) });
}

// ── 10) every refusal, on both engines ───────────────────────────────────────────────────────
// Each program builds one value over a bound through one operation, or passes a non-number count.
// The compiled engine runs it through the binary; the walker runs it in a child process. Both must
// refuse with the named code and operation, and neither process may end on a V8 abort.
const WALKER = fileURLToPath(new URL("./_walker-run.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
const onWalker = (name: string, source: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }> => {
  const file = join(sd, `${name}.walker.cotal.js`);
  writeFileSync(file, source);
  const child = spawn(TSX, [WALKER, file], { cwd: root, env: { ...process.env, NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { out += d.toString(); });
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal, out })));
};
for (const [name, source, code, words, only] of REFUSALS) {
  const r = await start(`refuse-${name}`, source);
  const failure = await failureOf(r);
  c(`engine: ${name} is refused ${code} naming ${words}`, r.code !== 0 && failure.startsWith(code) && failure.includes(words) && exitedOnItsOwn(r), { code: r.code, signal: r.signal, failure: failure.slice(0, 200), out: r.out.slice(-200) });
  // The walker replays version-1 records and hands its log lines on as they are (spec §5.4), so a
  // bound that only the engine's thread has is not graded on it.
  if (only === "engine") continue;
  const w = await onWalker(name, source);
  const result = JSON.parse(/RESULT (.*)/.exec(w.out)?.[1] ?? "{}") as { ok?: boolean; code?: string; message?: string };
  c(`walker: ${name} is refused ${code} naming ${words}`, w.signal === null && result.ok === false && result.code === code && (result.message ?? "").includes(words), { code: w.code, signal: w.signal, result, out: w.out.slice(-200) });
}

// ── 10b) in-bound programs keep their meaning, on both engines ─────────────────────────────
// Each program's value is logged as its canonical JSON, a string, which the binary prints as written
// and the walker's child reports as the line's values.
const loggedLine = (out: string): string | undefined => /RESULT (.*)/.exec(out)?.[1] !== undefined ? (JSON.parse(/RESULT (.*)/.exec(out)![1]!) as { logs?: string[] }).logs?.[0] : undefined;
for (const [name, source, value] of BEHAVES) {
  const program = `${source}log("value", json.stringify(v));\n`;
  const r = await start(`behave-${name}`, program);
  const printed = r.out.split("\n").find((l) => l.includes(": log value "))?.split(": log value ")[1];
  c(`engine: ${name}`, r.code === 0 && printed === value, { code: r.code, printed, expected: value, out: r.out.slice(-300) });
  const w = await onWalker(`behave-${name}`, program);
  c(`walker: ${name}`, w.signal === null && loggedLine(w.out) === JSON.stringify(["value", value]), { got: loggedLine(w.out), expected: value, out: w.out.slice(-300) });
}

// ── 10c) a primitive's arguments are positional ───────────────────────────────────────────────
// Refused by the validator: `cotal run validate` names L1029, and a start fails before any step.
{
  const source = 'const xs = ["1s"];\nawait sleep(...xs);\nlog("slept");\n';
  const file = join(sd, "primitive-spread-validate.cotal.js");
  writeFileSync(file, source);
  const v = await new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, [COTAL, "run", "validate", file], { cwd: root, env: { ...process.env, COTAL_SKIP_CONNECTOR_SEED: "1", NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    child.once("exit", (code) => resolve({ code, out }));
  });
  const r = await start("primitive-spread", source);
  c("a spread in a primitive's arguments is refused L1029 by validate, and its start fails before the program runs",
    v.code !== 0 && v.out.includes("L1029") && r.code !== 0 && !r.out.includes("log slept") && exitedOnItsOwn(r), { validate: v.out.slice(-300), out: r.out.slice(-300) });
}

// ── 10d) the walker refuses a callable `then` before the next property runs ───────────────────
// The order main's walker had, so a version-1 record that caught this refusal replays as recorded.
{
  const w = await onWalker("then-order", 'let ran = 0;\nconst bump = () => { ran += 1; return 1; };\ntry {\n  const r = { then: () => 1, a: bump() };\n} catch (e) {\n  log(e.code, ran);\n}\n');
  c("walker: a callable then is refused before the next property runs", w.signal === null && loggedLine(w.out) === '["L4021",0]', { got: loggedLine(w.out), out: w.out.slice(-300) });
}

// ── 10e) what leaves the thread is bounded, and the host stays small ─────────────────────────
// The host process is started with a 512 MB heap of its own, so a host that holds copies of what a
// run sends it aborts here rather than growing. Measured before the bound: 400 lines of one
// 3,999,999-unit two-byte string took the host to 6 GB; 120 references to one string in one log
// line to 1.1 GB.
{
  const r = await start("log-pileup", 'const s = "\\u0101".repeat(3999999);\nfor (let i = 0; i < 400; i += 1) {\n  log(s);\n}\nlog("after");\n', "--max-old-space-size=512");
  c("400 log lines of the largest string complete under a 512 MB host heap, each line printed cut", r.code === 0 && r.out.includes(": log after") && /… \(3999999 characters\)/.test(r.out) && exitedOnItsOwn(r), { code: r.code, signal: r.signal, out: r.out.slice(-300) });
}
{
  const r = await start("log-refs", 'const s = "y".repeat(4000000);\ntry {\n  log(range(120).map(() => s));\n} catch (e) {\n  log("caught", e.code);\n}\n', "--max-old-space-size=512");
  c("one log line of 120 references to one large string is refused L4016, catchably, under a 512 MB host heap", r.code === 0 && r.out.includes(": log caught L4016") && exitedOnItsOwn(r), { code: r.code, signal: r.signal, out: r.out.slice(-300) });
}

// ── 10f) the replace measure is exact ────────────────────────────────────────────────────────
// Checked against the host's own replace and replaceAll on every pattern form at every match
// position, both ways: never under what the host builds, and never over it.
{
  const { replacedUnits } = (await import(new URL("../../../packages/lang/dist/limits.js", import.meta.url).href)) as { replacedUnits: (s: string, from: string, to: string, all: boolean) => number };
  const subjects = ["", "a", "abc", "aXbXc", "XXX", "Xab", "abX", "\u0436X\u0436"];
  const froms = ["", "X", "XX", "b", "nope"];
  const tos = ["", "-", "$$", "$&", "$`", "$'", "$1", "$", "[$`|$&|$']", "$$$&$`$'$"];
  const off: string[] = [];
  for (const s of subjects) for (const from of froms) for (const to of tos) for (const all of [false, true]) {
    const built = all ? s.replaceAll(from, to) : s.replace(from, to);
    const measured = replacedUnits(s, from, to, all);
    if (measured !== built.length) off.push(`${JSON.stringify([s, from, to, all])}: ${measured} vs ${built.length}`);
  }
  c("replacedUnits gives the host's exact length for $$, $&, $`, $', $1 and a bare $, on replace and replaceAll", off.length === 0, off.slice(0, 5));
}

// ── 11) values a program cannot reach past the bound through repetition ───────────────────────
{
  // The replace result the earlier estimate missed, flattened, then the heap filled: the run must end
  // at the memory limit or the bound, never with the process.
  const r = await start("replace-flatten", 'const r = "a".repeat(3990100).replaceAll("a", "\\u0436".repeat(100));\nconst k = [];\nlog(r.includes("q"));\nfor (let i = 0; i < 900; i += 1) {\n  k.push(range(100000));\n}\n');
  c("a replace whose result would be over the bound is refused before it is built, and the process exits on its own",
    r.code !== 0 && /replaceAll: a string of \d+ units/.test(await failureOf(r)) && exitedOnItsOwn(r), { code: r.code, signal: r.signal, out: r.out.slice(-300) });
}

// ── 12) the heap refusal releases the run instead of failing it ──────────────────────────────
{
  const r = await start("heap-release", 'log("ran");\n', "--max-old-space-size=4096");
  const status = (await record(r.runId))?.status?.value;
  c("a run whose host carries a raising heap flag is released, not failed, so `cotal run resume --local` on a correctly started host continues it",
    status?.state === "released" && !r.out.includes("log ran") && exitedOnItsOwn(r), { status, out: r.out.slice(-300) });
}
{
  const r = await start("heap-tighter", 'log("ran");\n', "--max-old-space-size=256");
  c("a tighter heap flag still runs the program", r.code === 0 && r.out.includes("log ran"), { code: r.code, out: r.out.slice(-300) });
}

console.log(`worker-memory: ${ok} ok, ${fail} failed`);
emitSentinel({ passed: ok, failed: fail, cells: DECLARED });
if (ok + fail !== DECLARED) {
  console.log(`SUITE INCOMPLETE: ran ${ok + fail} of ${DECLARED} cells; a partial run is not a pass`);
  process.exit(1);
}
process.exit(fail === 0 ? 0 : 1);
