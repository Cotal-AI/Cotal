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
 * THE FIRST VERSION OF THE FIX WROTE THAT CLASS AS A HAND LIST AND THE LIST WAS WRONG. Review
 * measured U+061C, U+2060, the variation selectors and the tag characters arriving raw through the
 * same route: every one of them is the thing the list said it closed. THE SECOND VERSION NAMED ONE
 * PROPERTY AND THAT PROPERTY WAS TOO NARROW: review then measured U+FFF9 to U+FFFB, the interlinear
 * annotation controls, arriving raw, because they are format characters that are not
 * default-ignorable. They mark a span as base text plus its gloss, so a reader whose terminal does
 * not implement them sees two runs of text concatenated into a sentence nobody sent.
 *
 * The class is now the Unicode properties `Default_Ignorable_Code_Point` and `gc=Cf`, plus DEL, the
 * C1 controls and U+2028/U+2029, which no property covers. `Bidi_Control` is not named because all
 * twelve of its members are already default-ignorable, and cell 0.10 pins that by hand so a Unicode
 * version that separated them reds rather than silently narrowing the class. The codepoints below
 * are named individually anyway, because a failure should say WHICH one. Naming is not proof that
 * the literal encodes the union it claims, so cell 0.12 sweeps every codepoint from 0 to 0x10FFFF
 * and compares what the quoter did against that union.
 *
 * WHAT IS DELIBERATELY NOT ESCAPED, and section 0 proves it: ordinary text, non-ASCII LETTERS, and
 * COMBINING MARKS (0.13 to 0.15, added after review found U+0338 raw and asked whether it belonged:
 * it makes a visible mark on a visible base, and its property is the one carrying the accent in a
 * name written in NFD).
 * A quoter that escaped every byte over 0x7f would render a refusal about an accented channel name
 * unreadable, which is the same defect pointed the other way.
 *
 * A BOUND THAT IS NOT THIS CHANGE'S, recorded so it is not read as one: a query value long
 * enough to push the request line past Node's header limit is refused by the PARSER with a
 * 431 and a non-JSON body, before any route runs. Measured at 4000 repetitions of U+2028.
 * That is the same bound any long URL meets and it predates this file.
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
/** The escaped form the quoter must emit for a codepoint, spelled the way JSON spells it: one
 *  `\uXXXX` per UTF-16 unit, so an ASTRAL codepoint is a surrogate PAIR and not the five-hex form
 *  `codePointAt` would hand you, which is not a JSON escape at all. */
const escaped = (n: number): string =>
  Array.from({ length: cp(n).length }, (_, i) => "\\u" + hex4(cp(n).charCodeAt(i))).join("");
/** Percent-encode one codepoint's UTF-8 bytes, so it can ride a query string. */
const pct = (n: number): string =>
  [...Buffer.from(cp(n), "utf8")].map((b) => "%" + b.toString(16).toUpperCase().padStart(2, "0")).join("");

/** THE CLASS, by name, so a failure says which codepoint rather than which index.
 *
 *  The nine entries after the BOM are the ones the FIRST version of this file's hand list did not
 *  have, found by the security lens on this change and by widening to the Unicode properties: the
 *  Arabic letter mark reorders exactly like the RLM beside it, the word joiner and the fillers
 *  render as nothing exactly like the zero-width characters, and the last four are ASTRAL, which
 *  the old `\uXXXX` emitter could not have spelled as valid JSON even if the class had caught them. */
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
  ["CGJ U+034F", 0x34f],
  ["ALM U+061C", 0x61c],
  ["HANGUL CHOSEONG FILLER U+115F", 0x115f],
  ["MVS U+180E", 0x180e],
  ["WJ U+2060", 0x2060],
  ["HANGUL FILLER U+3164", 0x3164],
  ["VS1 U+FE00", 0xfe00],
  ["VS16 U+FE0F", 0xfe0f],
  ["HALFWIDTH HANGUL FILLER U+FFA0", 0xffa0],
  ["SHORTHAND FORMAT U+1BCA0, astral", 0x1bca0],
  ["MUSICAL U+1D173, astral", 0x1d173],
  ["TAG U+E0001, astral", 0xe0001],
  ["VARIATION SELECTOR U+E0100, astral", 0xe0100],
  ["ANNOTATION ANCHOR U+FFF9", 0xfff9],
  ["ANNOTATION SEPARATOR U+FFFA", 0xfffa],
  ["ANNOTATION TERMINATOR U+FFFB", 0xfffb],
  ["ARABIC NUMBER SIGN U+0600", 0x600],
  ["ARABIC END OF AYAH U+06DD", 0x6dd],
  ["EGYPTIAN FORMAT U+13430, astral", 0x13430],
];

/** Both sides of every range in the class. A cell that only tests the middle of a range cannot tell
 *  a correct bound from one that is a codepoint too wide or too narrow at either end. */
const OUTSIDE: [string, number][] = [
  ["tilde U+007E, just below DEL", 0x7e],
  ["NBSP U+00A0, just above the C1 range", 0xa0],
  ["U+061B, just below the ALM", 0x61b],
  ["hair space U+200A, just below ZWSP", 0x200a],
  ["hyphen U+2010, just above RLM", 0x2010],
  ["U+2027, just below LS", 0x2027],
  ["NNBSP U+202F, just above RLO", 0x202f],
  ["U+2070, just above the word-joiner block", 0x2070],
  ["U+3163, just below the Hangul filler", 0x3163],
  ["U+FE10, just above the variation selectors", 0xfe10],
  ["U+FEFE, just below the BOM", 0xfefe],
  ["U+1BCA4, just above the shorthand controls", 0x1bca4],
  ["U+1D17B, just above the musical controls", 0x1d17b],
  ["U+E1000, just above the tag block", 0xe1000],
  ["U+FFEE, just below the U+FFF0 ignorable block", 0xffee],
  ["U+FFFC, just above the annotation terminator", 0xfffc],
  ["U+05FF, just below the Arabic number signs", 0x5ff],
  ["U+1342F, just below the Egyptian format controls", 0x1342f],
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

// ASTRAL, ON ITS OWN, because 0.4 and 0.7 would both pass a quoter that emitted `\u1d173`: that
// form reads fine on a terminal and is not a JSON escape, so the body a caller receives stops
// parsing. The pair is what JSON has, and the only way to say a codepoint above the BMP in it.
{
  const astral = [0x1bca0, 0x1d173, 0xe0001, 0xe0100];
  const wrong = astral.filter((n) => quoteForOperator(cp(n)) !== '"' + escaped(n) + '"');
  const broken = astral.filter((n) => {
    try { return JSON.parse(quoteForOperator(cp(n))) !== cp(n); } catch { return true; }
  });
  ok("0.8 an ASTRAL class member leaves as its two-unit SURROGATE PAIR and still parses back to the codepoint it was",
    wrong.length === 0 && broken.length === 0,
    { wrong: wrong.map((n) => quoteForOperator(cp(n))), broken: broken.map((n) => n.toString(16)) });
}

// The two codepoints in the class that NO Unicode property carries. They are line and paragraph
// SEPARATORS, not format characters, so a class written as properties alone drops them silently and
// every other cell here stays green while `U+2028` goes back to arriving raw.
{
  const raw = [0x2028, 0x2029].filter((n) => quoteForOperator(cp(n)) !== '"' + escaped(n) + '"');
  ok("0.9 the LINE and PARAGRAPH separators are escaped, and they are in the class by NAME because no property covers them",
    raw.length === 0, raw.map((n) => quoteForOperator(cp(n))));
}

// The reordering family, pinned by hand. The class reaches these THROUGH
// `Default_Ignorable_Code_Point` rather than by naming `Bidi_Control`, because on this runtime
// every one of the twelve is default-ignorable and naming both properties would be two names for
// one set. That is a measurement about a Unicode version, not a law, so it is asserted here: a
// version that separated them would fail this cell instead of quietly leaving a reordering
// character raw, which is the sharpest case in the whole issue.
{
  const BIDI = [0x61c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
  const raw = BIDI.filter((n) => quoteForOperator(cp(n)) !== '"' + escaped(n) + '"');
  ok("0.10 every BIDI CONTROL is escaped, including U+061C and the isolates, which the shipped hand list did not have",
    raw.length === 0, raw.map((n) => n.toString(16)));
}

// The INTERLINEAR ANNOTATION controls, which review found raw against a class that had only the
// default-ignorable property. They are `Cf` and NOT default-ignorable, and they are the clearest
// form of the harm in the whole issue: they mark a span as base text plus its gloss, so a reader
// whose terminal does not implement them sees the two runs concatenated into a sentence nobody
// wrote. Not "invisible", not "reordered", but read as something else, which is the third arm of
// the class statement and the one a single property missed.
{
  const ANNOTATION = [0xfff9, 0xfffa, 0xfffb];
  const raw = ANNOTATION.filter((n) => quoteForOperator(cp(n)) !== '"' + escaped(n) + '"');
  const sentence = "A" + cp(0xfff9) + "base" + cp(0xfffa) + "gloss" + cp(0xfffb) + "Z";
  ok("0.11 the INTERLINEAR ANNOTATION controls are escaped, so a base run and its gloss cannot arrive as one sentence nobody wrote",
    raw.length === 0 && !quoteForOperator(sentence).includes(cp(0xfff9)),
    { raw: raw.map((n) => n.toString(16)), sentence: quoteForOperator(sentence) });
}

// THE BOUNDARY ITSELF, swept rather than sampled. Every codepoint from 0 to 0x10FFFF is put through
// the quoter and compared against the union this file CLAIMS: the two properties, DEL and the C1
// range, U+2028/U+2029, and whatever `JSON.stringify` already escapes on its own.
//
// WHAT THIS PROVES AND WHAT IT DOES NOT: it proves the literal in the source is the union stated in
// its comment, so a dropped alternative, a wrong flag or a typo'd range is caught for every
// codepoint rather than for the fourteen this file names. It CANNOT prove the union is the right
// union: twice now the boundary itself was wrong, and both times a person found it by asking which
// harm the class is about. The named lists above stay because they are that question written down.
{
  const claimed = /[\p{Default_Ignorable_Code_Point}\p{gc=Cf}\u007f-\u009f\u2028\u2029]/u;
  const wrong: string[] = [];
  for (let n = 0; n <= 0x10ffff && wrong.length < 8; n++) {
    if (n >= 0xd800 && n <= 0xdfff) continue;          // lone surrogates are not codepoints a caller can send
    if (n === 0x22 || n === 0x5c) continue;            // the JSON delimiter and its escape appear in EVERY
                                                      // quoted string, so "does the output contain this
                                                      // character" cannot answer the question for these two
    const ch = cp(n);
    const shouldEscape = claimed.test(ch) || !JSON.stringify(ch).includes(ch);
    const isRaw = quoteForOperator(ch).includes(ch);
    if (isRaw === shouldEscape) wrong.push("U+" + n.toString(16).toUpperCase() + " -> " + quoteForOperator(ch));
  }
  ok("0.12 SWEPT over every codepoint: the set the quoter escapes is exactly the union this file claims, plus what JSON.stringify already closed",
    wrong.length === 0, wrong);
}

// THE BOUNDARY IN THE OTHER DIRECTION. Review found U+0338 COMBINING LONG SOLIDUS OVERLAY arriving
// raw and asked whether it belonged, which is a fair question against the harm as it was first
// stated: it does change what a reader sees. It is excluded, and these two cells are why that is a
// decision rather than an oversight. A combining mark makes a VISIBLE mark on a visible base, and
// its property `gc=Mn` is the same one carrying the acute accent in a name written in NFD, the
// Devanagari vowel signs, the Arabic and Hebrew points and the Vietnamese tones. Marks are 2543
// codepoints here and only 263 are already in the class, so escaping them takes about 2280
// codepoints of ordinary written language: 0.2's defect wearing a different hat. What a mark CAN
// do is build a confusable, and 0.15 pins the sharpest one so nobody has to take that on trust.
{
  const MARKS: Array<[string, number]> = [
    ["COMBINING LONG SOLIDUS OVERLAY, the one review asked about", 0x338],
    ["COMBINING ACUTE ACCENT, the accent in a name written in NFD", 0x301],
    ["DEVANAGARI VOWEL SIGN I", 0x93f],
    ["ARABIC FATHA", 0x64e],
    ["HEBREW POINT HIRIQ", 0x5b4],
    ["COMBINING TILDE, a Vietnamese tone", 0x303],
  ];
  const wrongly = MARKS.filter(([, n]) => !quoteForOperator(cp(n)).includes(cp(n)));
  ok("0.13 CONTROL: a COMBINING MARK is left RAW, so a refusal about a name written in NFD or in a script that writes with marks stays readable",
    wrongly.length === 0, wrongly.map(([name]) => name));
}

// The user-visible form of 0.13, because a list of codepoints is not a name a human typed.
{
  const nfd = "caf" + "e" + cp(0x301);
  ok("0.14 CONTROL: an accented name in DECOMPOSED form comes back as the name, not as the letter plus an escape",
    quoteForOperator(nfd) === '"' + nfd + '"', quoteForOperator(nfd));
}

// The reason the exclusion is a judgement and not a shrug: this is the strongest case AGAINST it,
// pinned so a later reader meets it here rather than discovering it in production. It is the same
// harm as a Cyrillic letter that looks Latin, and it has the same answer, which is not this quoter.
{
  const notEqual = "a=" + cp(0x338) + "b";
  ok("0.15 STATED, not hidden: a mark over `=` renders as a not-equals sign, so the excluded class really can mislead; it is the CONFUSABLE problem, which needs no mark to exist",
    quoteForOperator(notEqual) === '"' + notEqual + '"', quoteForOperator(notEqual));
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
      if (!r.body.toString("utf8").includes(escaped(n).replaceAll("\\", "\\\\"))) notEscaped.push(name);
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

  // ONE VALUE CARRYING BOTH KINDS. 0.2 and 0.4 test the two halves separately, and a quoter can pass
  // both while still being all-or-nothing per string. This is the shape a real refusal has: a name
  // someone typed with something nasty folded into it.
  {
    const mixed = "a" + cp(0x202e) + cp(0x7f) + cp(0x1f4a9) + "z";
    const r = await refuse([...Buffer.from(mixed, "utf8")].map((b) => "%" + b.toString(16).toUpperCase().padStart(2, "0")).join(""));
    const body = r.body.toString("utf8");
    const err = (() => { try { return (JSON.parse(body) as { error?: string }).error ?? ""; } catch { return "(not JSON)"; } })();
    ok("1.6 a MIXED value escapes only the class members and leaves the rest alone, including an astral emoji whose surrogate PAIR the class must not touch",
      err.includes('"a' + escaped(0x202e) + escaped(0x7f) + cp(0x1f4a9) + 'z"'), err);
  }

  // What a security lens asks next, answered by execution rather than by reasoning: percent escapes
  // that are not valid UTF-8. `URLSearchParams` turns each bad byte into U+FFFD, which is a VISIBLE
  // character, so the refusal stays readable and the body stays JSON. The failure this rules out is
  // a decode that throws on the refusal path, which would turn a caller's typo into a 500 or worse.
  {
    const bad: string[] = [];
    for (const [name, q] of [["lone surrogate", "%ED%A0%80"], ["overlong NUL", "%C0%80"],
                             ["bare FF", "%FF"], ["truncated 3-byte", "%E2%80"]] as [string, string][]) {
      const r = await refuse(q);
      const body = r.body.toString("utf8");
      let err = "(not JSON)";
      try { err = (JSON.parse(body) as { error?: string }).error ?? "(no error key)"; } catch { /* keep */ }
      if (r.status !== 400 || !err.includes(cp(0xfffd))) bad.push(name + " -> " + r.status + " " + JSON.stringify(err.slice(0, 60)));
    }
    ok("1.7 percent escapes that are not valid UTF-8 refuse 400 with a readable U+FFFD and a body that still parses, rather than throwing on the refusal path",
      bad.length === 0, bad);
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
  console.log("3. the third quoting site, which is reachable now that the name is validated");
  // An earlier version of this file said the class could NOT reach `channelNameFromPath`, because
  // that site only quoted a segment `decodeURIComponent` had refused, and a malformed escape is
  // ASCII. That is still true of the decode refusal, and 3.1 covers it. It stopped being the whole
  // story when the same function started refusing a name the wire would REWRITE (see
  // `channel-alias.smoke.ts`): a percent-encoded class member decodes perfectly well and is then
  // refused by name, so the third site has a real input and 3.3 is that input.
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

  {
    const raw: string[] = [];
    const unnamed: string[] = [];
    for (const [name, n] of [["RLO U+202E", 0x202e], ["ALM U+061C", 0x61c], ["TAG U+E0001", 0xe0001]] as [string, number][]) {
      log = "";
      const res = await fetch(`http://127.0.0.1:${WEB_PORT}/api/channels/abc${pct(n)}/history`);
      const body = Buffer.from(await res.arrayBuffer());
      await wait(150);
      if (res.status !== 400 || body.includes(Buffer.from(cp(n), "utf8"))) raw.push(name + " (status " + res.status + ")");
      if (!body.toString("utf8").includes(escaped(n).replaceAll("\\", "\\\\"))) unnamed.push(name);
    }
    ok("3.3 a channel name that DECODES but the wire would rewrite is refused 400 with the offending codepoint escaped, never raw",
      raw.length === 0, raw);
    ok("3.4 ...and that refusal says WHICH codepoint, as a JSON unicode escape, so the third quoting site has a real input rather than being consistency alone",
      unnamed.length === 0, unnamed);
  }

} finally {
  webChild?.kill("SIGKILL");
  release();
  broker.kill("SIGKILL");
  rmSync(store, { recursive: true, force: true });
}

console.log(failed === 0 ? `web echo escaping: ${cells} cells OK` : `web echo escaping: ${failed}/${cells} FAILED`);
process.exit(failed === 0 ? 0 : 1);
