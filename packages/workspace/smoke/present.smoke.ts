/**
 * The shared terminal presentation in `@cotal-ai/workspace` (`present.ts`): display width by
 * grapheme, escaping of untrusted terminal content, tables aligned by display width that become
 * labeled records when the terminal is too narrow, rich and plain styles of one report, state words
 * that survive without color, and one result written as the envelope or as its report. Broker-free.
 *
 * Run: pnpm smoke:present
 */
process.env.FORCE_COLOR = "1"; // the rich style must have color to withhold; read per call

const {
  displayWidth,
  disableColor,
  oneLine,
  isCommandFailure,
  presentationOf,
  renderReport,
  writeResult,
} = await import("@cotal-ai/workspace");
import type { Report } from "@cotal-ai/workspace";

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.log(`  ✗ ${name}${extra === undefined ? "" : ` (${JSON.stringify(extra)})`}`);
  }
}

console.log("PRESENT SMOKE");
const ansi = /\x1b\[/;

// Display width counts what a terminal draws, not code units.
const widths: [string, string, number][] = [
  ["ascii", "abc", 3],
  ["a CJK character", "古", 2],
  ["a combining accent", "é", 1],
  ["a ZWJ emoji sequence", "👩‍💻", 2],
  ["a flag", "🇨🇭", 2],
  ["ANSI sequences", "\x1b[31mred\x1b[0m", 3],
];
for (const [what, text, want] of widths) check(`${what} is ${want} column(s) wide`, displayWidth(text) === want, displayWidth(text));

// Untrusted content cannot move the cursor, restyle the screen, end the line or reorder text.
check("ESC is escaped", oneLine("\x1b[2J") === "\\u001b[2J", oneLine("\x1b[2J"));
check("a carriage return is escaped", oneLine("a\rb") === "a\\u000db");
check("a C1 control is escaped", oneLine("\u009b31m") === "\\u009b31m");
check("DEL is escaped", oneLine("\u007f") === "\\u007f");
check("a line separator is escaped", oneLine("a b") === "a\\u2028b");
check("a bidi override is escaped", oneLine("abc‮def") === "abc\\u202edef");
check("printable text is kept as it is", oneLine("古 👩‍💻 é seat-1") === "古 👩‍💻 é seat-1");

const report: Report = {
  sections: [
    {
      title: "Seats",
      blocks: [
        {
          kind: "table",
          columns: [
            { key: "name", label: "NAME" },
            { key: "state", label: "STATE" },
            { key: "note", label: "NOTE" },
          ],
          rows: [
            { name: "古い席", state: { text: "working", tone: "ok", mark: "●" }, note: "fine" },
            { name: "seat-2", state: { text: "failed", tone: "failed", mark: "⨯" }, note: "\x1b[2Jspoof" },
          ],
        },
      ],
    },
    { blocks: [{ kind: "fields", rows: [["space", "alpha"], ["selected", { text: "yes", tone: "selected" }]] }, { kind: "lines", lines: [{ text: "run cotal ps", tone: "hint" }] }] },
  ],
};

const plain = renderReport(report, "plain");
const rich = renderReport(report, "rich");
check("plain has no ANSI even when color is forced", !ansi.test(plain), plain);
check("rich colors when color is on", ansi.test(rich), rich);
check("plain draws no marks", !plain.includes("●") && !plain.includes("⨯"), plain);
check("rich draws the marks", rich.includes("●") && rich.includes("⨯"), rich);
for (const word of ["working", "failed", "NAME", "space:", "alpha", "yes", "run cotal ps"])
  check(`plain keeps the word ${word}`, plain.includes(word), plain);
check("untrusted cell content is escaped in plain", plain.includes("\\u001b[2Jspoof") && !plain.includes("\x1b[2J"), plain);
check("untrusted cell content is escaped in rich", rich.includes("\\u001b[2Jspoof") && !rich.includes("\x1b[2J"), rich);

// Columns line up by display width: each column starts at the same terminal column on every row.
const lines = plain.split("\n").slice(1, 4);
const starts = (line: string, word: string) => displayWidth(line.slice(0, line.indexOf(word)));
check(
  "a CJK cell does not shift the next column",
  starts(lines[0]!, "STATE") === starts(lines[1]!, "working") && starts(lines[1]!, "working") === starts(lines[2]!, "failed"),
  lines,
);
check("the last column is not padded", lines.every((line) => !line.endsWith(" ")), lines);
const richLines = rich.replace(/\x1b\[[0-9;]*m/g, "").split("\n").slice(1, 4);
check(
  "rich columns line up with their marks",
  starts(richLines[0]!, "NOTE") === starts(richLines[1]!, "fine") && starts(richLines[1]!, "fine") === starts(richLines[2]!, "\\u001b"),
  richLines,
);

// Too narrow for the table: one labeled record per row, nothing clipped.
const narrow = renderReport(report, "plain", 20);
check("a narrow terminal gets labeled records", /NAME: +古い席/.test(narrow) && /STATE: +failed/.test(narrow), narrow);
check("a record keeps every value", ["古い席", "seat-2", "working", "failed", "fine", "spoof"].every((word) => narrow.includes(word)), narrow);
check("a table that fits stays a table", renderReport(report, "plain", 80) === plain);

let threw = false;
try {
  renderReport({ sections: [{ blocks: [{ kind: "lines", lines: [{ text: " ", tone: "ok", mark: "●" }] }] }] }, "rich");
} catch {
  threw = true;
}
check("a mark with no state word is refused", threw);

// --json and --plain choose the presentation; both at once is a usage refusal.
check("--json selects json", presentationOf({ json: true }) === "json");
check("--plain selects plain", presentationOf({ plain: true }) === "plain");
check("neither selects rich", presentationOf({}) === "rich");
let both: unknown;
try {
  presentationOf({ json: true, plain: true });
} catch (e) {
  both = e;
}
check("--json with --plain is a USAGE_INVALID refusal", isCommandFailure(both) && both.code === "USAGE_INVALID" && both.outcome === "refused", String(both));

// One result: the envelope under json, its report otherwise, and each warning on stderr.
function capture(fn: () => void): { out: string; err: string } {
  let out = "";
  let err = "";
  const write = process.stdout.write;
  const error = console.error;
  process.stdout.write = ((chunk: string) => ((out += chunk), true)) as typeof process.stdout.write;
  console.error = (s?: unknown) => void (err += `${s}\n`);
  try {
    fn();
  } finally {
    process.stdout.write = write;
    console.error = error;
  }
  return { out, err };
}
const result = { seats: ["a"] };
const view = (r: typeof result): Report => ({ sections: [{ blocks: [{ kind: "lines", lines: r.seats }] }] });
const warnings = [{ code: "SCOPE_DENIED", target: { space: "beta" }, message: "beta could not be read" }];
const asJson = capture(() => writeResult("json", { command: "ps", target: { space: "alpha" }, result, completeness: "partial", warnings }, view));
const env = JSON.parse(asJson.out);
check("json writes one envelope with the result", asJson.out.split("\n").filter(Boolean).length === 1 && JSON.stringify(env.result) === JSON.stringify(result) && env.completeness === "partial" && env.warnings[0].code === "SCOPE_DENIED", asJson.out);
check("json writes nothing on stderr", asJson.err === "", asJson.err);
const asPlain = capture(() => writeResult("plain", { command: "ps", target: null, result, warnings }, view));
check("plain writes the report", asPlain.out === "a\n", asPlain.out);
check("plain writes each warning on stderr", asPlain.err.includes("beta could not be read") && !ansi.test(asPlain.err), asPlain.err);

// --no-color keeps the rich layout and drops its color.
disableColor();
const noColor = renderReport(report, "rich");
check("rich under --no-color has no ANSI", !ansi.test(noColor), noColor);
check("rich under --no-color still draws its marks", noColor.includes("●"), noColor);

if (failed) {
  console.log(`PRESENT SMOKE: ${failed} failed`);
  process.exit(1);
}
console.log("PRESENT SMOKE: all passed");
