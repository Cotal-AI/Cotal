/**
 * A REFUSAL THAT NAMES THE CALLER'S VALUE HAS TO RENDER IT, AND `JSON.stringify` DOES NOT DO THAT
 * JOB.
 *
 * The dashboard echoes a caller-supplied value in two places: the 400 body, and the `console.error`
 * line the request frame writes when it refuses. Both were built with `JSON.stringify`, which was
 * doing double duty. It is a JSON serializer and it is good at that; it is not a renderer for a
 * human reading a terminal and has never claimed to be.
 *
 * MEASURED BEFORE THIS EXISTED (Cotal #711), against the SHIPPED `web()` entry over a local broker,
 * driving `/api/activity?limit=` with each codepoint percent-encoded and reading the answer as
 * BYTES. Reading it through `res.json()` would decode the very thing under test and hand the input
 * back whatever the server wrote, so every case would have looked identical.
 *
 *   ESC 0x1b, LF 0x0a   escaped, both places. `JSON.stringify` closes all of C0, so the
 *                       terminal-escape-sequence class was already shut before this change.
 *   DEL U+007F          RAW in the body AND raw in the operator's line.
 *   U+0085, U+009B      RAW. The C1 controls, which the issue did not name.
 *   U+202E              RAW. Right-to-left override: it does not vanish, it REVERSES the rendering
 *                       of the text after it, which is the "what the operator reads is not what the
 *                       caller sent" defect in its strongest form.
 *   U+2028, U+2029      RAW.
 *
 * So the issue's list of three was a sample, not the class. The class is: codepoints that render as
 * nothing, render as something else, or reorder their neighbours, and that `JSON.stringify` passes
 * through. The fix escapes that class at the QUOTING site rather than at the two exits, because the
 * untrusted thing is the value and the message is derived from it.
 *
 * WHAT IS DELIBERATELY NOT ESCAPED, and section 0 proves it: ordinary text, and non-ASCII LETTERS.
 * A quoter that escaped every byte over 0x7f would render a refusal about an accented channel name
 * unreadable, which is the same defect pointed the other way.
 *
 * Needs nats-server on PATH. Run: pnpm smoke:web-echo-escaping
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net, { type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { isReachable, setupSpaceStreams } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { quoteForOperator } from "../src/web.js";

let cells = 0, failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown): void => {
  cells++;
  if (cond) return;
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = async (): Promise<number> => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
});

/** Built at runtime, never typed into this file: a suite about invisible characters that contains
 *  them is a suite whose own source cannot be reviewed by eye. */
const cp = (n: number): string => String.fromCodePoint(n);
const hex4 = (n: number): string => n.toString(16).padStart(4, "0");
/** The escaped form the quoter must emit for a codepoint, spelled the way JSON spells it. */
const escaped = (n: number): string => "\\u" + hex4(n);
/** Percent-encode one codepoint's UTF-8 bytes, so it can ride a query string. */
const pct = (n: number): string =>
  [...Buffer.from(cp(n), "utf8")].map((b) => "%" + b.toString(16).toUpperCase().padStart(2, "0")).join("");

/** THE CLASS, by name, so a failure says which codepoint rather than which index. */
const CLASS: [string, number][] = [
  ["DEL", 0x7f],
  ["NEL U+0085", 0x85],
  ["CSI U+009B", 0x9b],
  ["C1 top U+009F", 0x9f],
  ["SHY U+00AD", 0xad],
  ["ZWSP U+200B", 0x200b],
  ["ZWJ U+200D", 0x200d],
  ["LRM U+200E", 0x200e],
  ["RLM U+200F", 0x200f],
  ["LS U+2028", 0x2028],
  ["PS U+2029", 0x2029],
  ["LRE U+202A", 0x202a],
  ["RLO U+202E", 0x202e],
  ["LRI U+2066", 0x2066],
  ["PDI U+2069", 0x2069],
  ["BOM U+FEFF", 0xfeff],
];

/** Both sides of every range in the class. A cell that only tests the middle of a range cannot tell
 *  a correct bound from one that is a codepoint too wide or too narrow at either end. */
const OUTSIDE: [string, number][] = [
  ["tilde U+007E, just below DEL", 0x7e],
  ["NBSP U+00A0, just above C1", 0xa0],
  ["hair space U+200A, just below ZWSP", 0x200a],
  ["hyphen U+2010, just above RLM", 0x2010],
  ["U+2027, just below LS", 0x2027],
  ["NNBSP U+202F, just above RLO", 0x202f],
  ["U+2065, just below LRI", 0x2065],
  ["U+206A, just above PDI", 0x206a],
  ["U+FEFE, just below the BOM", 0xfefe],
];

// ---- 0. the quoter, directly ------------------------------------------------------------------
console.log("0. the quoter renders for a human, and is not a second escape-everything");

ok("0.1 CONTROL: ordinary text is returned unchanged, so this is not an escape-everything",
  quoteForOperator("abc 123") === '"abc 123"', quoteForOperator("abc 123"));

// The mirror of the defect. Escaping every non-ASCII byte would "fix" #711 and break every refusal
// about a name a human actually typed, which is the same complaint pointed the other way.
ok("0.2 CONTROL: a non-ASCII LETTER stays a readable letter, never a unicode escape",
  quoteForOperator(cp(0xe9) + cp(0x4e2d)) === '"' + cp(0xe9) + cp(0x4e2d) + '"',
  quoteForOperator(cp(0xe9) + cp(0x4e2d)));

// Without this the section below reads as "the quoter escapes things", when the point is that it
// escapes the things `JSON.stringify` LEFT, and that C0 was never the gap.
ok("0.3 CONTROL: what `JSON.stringify` already closed stays closed - every C0 control",
  quoteForOperator(cp(0x1b)) === '"\\u001b"' && quoteForOperator("\n") === '"\\n"'
    && quoteForOperator(cp(0x00)) === '"\\u0000"' && quoteForOperator("\t") === '"\\t"',
  { esc: quoteForOperator(cp(0x1b)), lf: quoteForOperator("\n") });

{
  const missed = CLASS.filter(([, n]) => quoteForOperator(cp(n)) !== '"' + escaped(n) + '"');
  ok("0.4 every codepoint in the class comes back as a JSON unicode escape, none of them raw",
    missed.length === 0, missed.map(([name, n]) => [name, quoteForOperator(cp(n))]));
}

// The delta, asserted rather than described. Without it 0.4 could be read as a restatement of what
// `JSON.stringify` already did, and the whole change would look like a no-op.
{
  const alreadyFine = CLASS.filter(([, n]) => !JSON.stringify(cp(n)).includes(cp(n)));
  ok("0.5 ...and JSON.stringify ALONE leaves every one of them raw, which is why 0.4 is a fix",
    alreadyFine.length === 0, alreadyFine.map(([name]) => name));
}

{
  const wrong = OUTSIDE.filter(([, n]) => quoteForOperator(cp(n)) !== '"' + cp(n) + '"');
  ok("0.6 the bounds are exact: the codepoint on each side of every range is left alone",
    wrong.length === 0, wrong.map(([name, n]) => [name, quoteForOperator(cp(n))]));
}

// The one that stops a future "fix" from mangling the value on its way to being readable: the
// escaped form must still be JSON, and parsing it must return exactly what the caller sent.
{
  const all = CLASS.map(([, n]) => cp(n)).join("") + "abc" + cp(0xe9);
  let parsed: unknown;
  try { parsed = JSON.parse(quoteForOperator(all)); } catch { parsed = "(not valid JSON)"; }
  ok("0.7 the quoted form is still valid JSON and round-trips to the ORIGINAL value",
    parsed === all, { round: parsed === all, quoted: quoteForOperator(all).slice(0, 80) });
}

// ---- the live server --------------------------------------------------------------------------
const PORT = await freePort();
const SPACE = "echoesc";
const SERVER = `nats://127.0.0.1:${PORT}`;
const store = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-p", String(PORT), "-js", "-sd", store, "-a", "127.0.0.1"], { stdio: "ignore" });
const release = teardownOnSignal(broker, store);
let webChild: ReturnType<typeof spawn> | undefined;
try {
  let up = false;
  for (let i = 0; i < 80; i++) { if (await isReachable(SERVER)) { up = true; break; } await wait(150); }
  if (!up) throw new Error("nats-server did not start");
  await setupSpaceStreams({ servers: SERVER, space: SPACE });

  const WEB_PORT = await freePort();
  let log = "";
  webChild = spawn(process.execPath, [
    "--import", "tsx", fileURLToPath(new URL("./run-web.mts", import.meta.url)),
    "--server", SERVER, "--space", SPACE, "--port", String(WEB_PORT), "--no-open",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  webChild.stdout?.on("data", (d: Buffer) => { log += d.toString(); });
  webChild.stderr?.on("data", (d: Buffer) => { log += d.toString(); });

  let served = false;
  for (let i = 0; i < 200; i++) {
    const r = await fetch(`http://127.0.0.1:${WEB_PORT}/api/roster`).catch(() => undefined);
    if (r?.status === 200) { served = true; break; }
    await wait(250);
  }

  console.log("1. the shipped routes echo the value, and what they echo is readable");
  ok("1.0 the shipped `web` entry point serves at all", served, log.slice(-300));

  /** The operator line's ECHOED SEGMENT, not the whole line.
   *
   *  This distinction is load-bearing and cell 1.4 proves it: `c.yellow` wraps the line in
   *  `ESC [ 3 3 m` ... `ESC [ 0 m` and the line ends in a newline, so a search of the WHOLE line for
   *  a raw ESC or LF finds the FRAMING and reports every request as raw, whatever the server wrote.
   *  An instrument that answers the same way regardless of the code under test is not an
   *  instrument. */
  const segment = (s: string): string =>
    s.includes("received ") ? s.slice(s.lastIndexOf("received ") + "received ".length).split(cp(0x1b) + "[0m")[0] : "";

  /** One refusal: the 400 body as BYTES and the operator line it wrote. */
  const refuse = async (queryValue: string): Promise<{ status: number; body: Buffer; line: string }> => {
    log = "";
    const res = await fetch(`http://127.0.0.1:${WEB_PORT}/api/activity?limit=${queryValue}`);
    const body = Buffer.from(await res.arrayBuffer());
    await wait(150);
    return { status: res.status, body, line: log };
  };

  {
    const r = await refuse("abc");
    ok("1.1 CONTROL: an ordinary malformed limit still refuses 400 and NAMES the value readably",
      r.status === 400 && r.body.toString("utf8").includes('received \\"abc\\"') && segment(r.line).includes('"abc"'),
      { status: r.status, body: r.body.toString("utf8").slice(0, 120), seg: segment(r.line) });
  }

  {
    const rawInBody: string[] = [];
    const rawInLine: string[] = [];
    const notEscaped: string[] = [];
    for (const [name, n] of CLASS) {
      const r = await refuse(pct(n));
      if (r.status !== 400) { rawInBody.push(name + " (status " + r.status + ")"); continue; }
      if (r.body.includes(Buffer.from(cp(n), "utf8"))) rawInBody.push(name);
      if (Buffer.from(segment(r.line), "utf8").includes(Buffer.from(cp(n), "utf8"))) rawInLine.push(name);
      if (!r.body.toString("utf8").includes(escaped(n).replace("\\", "\\\\"))) notEscaped.push(name);
    }
    ok("1.2 the 400 BODY the caller receives carries no raw codepoint from the class",
      rawInBody.length === 0, rawInBody);
    ok("1.3 the OPERATOR's line carries no raw codepoint from the class either",
      rawInLine.length === 0, rawInLine);
    ok("1.5 ...and the body says which codepoint it was, as a JSON unicode escape",
      notEscaped.length === 0, notEscaped);
  }

  // The instrument's own control. If this cell ever goes green-by-accident the two cells above stop
  // meaning anything, because they would be searching the colour codes rather than the value.
  {
    const r = await refuse(pct(0x2028));
    const wholeLineHasEsc = r.line.includes(cp(0x1b));
    const segmentHasEsc = segment(r.line).includes(cp(0x1b));
    ok("1.4 INSTRUMENT: the whole line DOES contain a raw ESC (its colour framing) while the echoed segment does not, which is why 1.3 reads the segment",
      wholeLineHasEsc && !segmentHasEsc, { wholeLineHasEsc, segmentHasEsc });
  }

  console.log("2. the other caller-controlled thing on that same line");
  // `req.url` is interpolated into the operator line with no escaping of any kind. That is only
  // safe if a raw byte cannot get into a request target, so ask, with a hand-rolled socket: `fetch`
  // percent-encodes for you and would answer a question this cell is not asking.
  const rawTarget = (target: Buffer): Promise<string> => new Promise((resolve) => {
    const sock = net.connect(WEB_PORT, "127.0.0.1", () => {
      sock.write(Buffer.concat([Buffer.from("GET "), target, Buffer.from(" HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")]));
    });
    let out = "";
    sock.on("data", (d) => { out += d.toString("latin1"); });
    sock.on("close", () => resolve(out));
    sock.on("error", (e) => resolve("SOCKET ERROR: " + e.message));
    setTimeout(() => { sock.destroy(); resolve(out || "TIMEOUT"); }, 5000);
  });

  {
    log = "";
    const res = await rawTarget(Buffer.from("/api/activity?limit=abc"));
    await wait(200);
    ok("2.1 CONTROL: a hand-rolled request DOES reach the handler - route 400, JSON body, one line logged",
      res.includes("400 Bad Request") && res.includes("application/json") && segment(log).includes('"abc"'),
      res.slice(0, 90));
  }

  {
    const offenders: string[] = [];
    for (const [name, n] of [["DEL", 0x7f], ["ESC", 0x1b], ["LS U+2028", 0x2028], ["RLO U+202E", 0x202e]] as [string, number][]) {
      log = "";
      const res = await rawTarget(Buffer.concat([Buffer.from("/api/activity?limit=a"), Buffer.from(cp(n), "utf8"), Buffer.from("b")]));
      await wait(200);
      // The parser's refusal and ours are distinguishable BY SHAPE, which is what makes this a
      // statement about who refused rather than about a status code both of them use: Node answers
      // a bare 400 with no content-type and no body, and the handler never runs, so nothing is
      // logged. A route 400 carries `application/json` and a line.
      const parserRefused = res.includes("400 Bad Request") && !res.includes("content-type") && log.trim() === "";
      if (!parserRefused) offenders.push(name + " -> " + JSON.stringify(res.slice(0, 70)) + " log=" + JSON.stringify(log.trim().slice(0, 70)));
    }
    ok("2.2 a RAW byte in the request target never reaches the handler: Node's parser refuses it with a bare 400 and no line is ever written, so `req.url` cannot carry one",
      offenders.length === 0, offenders);
  }
  console.log("3. the third quoting site, and an honest statement of what reaches it");
  // `channelNameFromPath` uses the same quoter, and this class CANNOT reach it today. It quotes the
  // path segment as RECEIVED, still percent-encoded, and only when `decodeURIComponent` throws; a
  // malformed escape is ASCII, and 2.2 shows a raw byte never gets past Node's parser. So the third
  // site is consistency, not coverage: no mutation can prove it, because no input can exercise it.
  // Stated here rather than left for a reader to discover, and the route is still exercised so the
  // refusal itself cannot rot.
  {
    log = "";
    const res = await fetch(`http://127.0.0.1:${WEB_PORT}/api/channels/%zz/history`);
    const body = await res.text();
    await wait(150);
    ok("3.1 the channel-name refusal is a 400 that NAMES the segment it could not decode",
      res.status === 400 && body.includes("%zz") && body.includes("percent-encoded"),
      { status: res.status, body: body.slice(0, 120) });
    ok("3.2 CONTROL: a well-formed name that simply does not exist is NOT a 400, so 3.1 is about the decode",
      (await fetch(`http://127.0.0.1:${WEB_PORT}/api/channels/nosuchchannel/history`)).status === 200);
  }

} finally {
  webChild?.kill("SIGKILL");
  release();
  broker.kill("SIGKILL");
  rmSync(store, { recursive: true, force: true });
}

console.log(failed === 0 ? `web echo escaping: ${cells} cells OK` : `web echo escaping: ${failed}/${cells} FAILED`);
process.exit(failed === 0 ? 0 : 1);
