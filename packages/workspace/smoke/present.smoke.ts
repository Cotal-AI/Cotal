/**
 * The shared terminal presentation in `@cotal-ai/workspace` (`present.ts`): display width by
 * grapheme, escaping of untrusted terminal content, tables aligned by display width that become
 * labeled records when the terminal is too narrow, rich and plain styles of one report, state words
 * that survive without color, and one result written as the envelope or as its report. Broker-free.
 *
 * Run: pnpm smoke:present
 */
process.env.FORCE_COLOR = "1"; // the rich style must have color to withhold; read per call
process.env.LC_ALL = "C.UTF-8"; // the rich style draws marks under a UTF-8 locale; read per call

const {
  displayWidth,
  disableColor,
  oneLine,
  isCommandFailure,
  presentationOf,
  renderReport,
  codeSpan,
  commandFailureReport,
  CommandFailure,
  heldSpaceNote,
  wrapWords,
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
process.env.LC_ALL = "C";
const asciiRich = renderReport(report, "rich");
const saved = { LC_ALL: "C.UTF-8", LC_CTYPE: process.env.LC_CTYPE, LANG: process.env.LANG };
for (const key of ["LC_ALL", "LC_CTYPE", "LANG"]) delete process.env[key];
const unsetRich = renderReport(report, "rich");
for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
check("under a locale that is not UTF-8, rich keeps its color and is otherwise plain", ansi.test(asciiRich) && asciiRich.replace(/\x1b\[[0-9;]*m/g, "") === plain, asciiRich);
check("with no locale variable set, rich draws the marks", unsetRich === rich, unsetRich);
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
const emptyLast = renderReport({ sections: [{ blocks: [{ kind: "table", columns: [{ key: "a", label: "A" }, { key: "b", label: "B" }], rows: [{ a: "long value", b: "" }, { a: "x", b: "y" }] }] }] }, "plain");
check("an empty last cell leaves no trailing padding", emptyLast.split("\n").every((line) => !line.endsWith(" ")), emptyLast);
const richLines = rich.replace(/\x1b\[[0-9;]*m/g, "").split("\n").slice(1, 4);
check(
  "rich columns line up with their marks",
  starts(richLines[0]!, "NOTE") === starts(richLines[1]!, "fine") && starts(richLines[1]!, "fine") === starts(richLines[2]!, "\\u001b"),
  richLines,
);

// Too narrow for the table: one labeled record per row, nothing clipped. Below 48 columns each label
// takes a line of its own, with its value on the line under it.
const narrow = renderReport(report, "plain", 20);
check("a narrow terminal gets labeled records", /^ *name\n +古い席$/m.test(narrow) && /^ *state\n +failed$/m.test(narrow), narrow);
const narrowEmpty = renderReport({ sections: [{ blocks: [{ kind: "table", columns: [{ key: "a", label: "NAME" }, { key: "b", label: "NOTE" }], rows: [{ a: "long value here", b: "" }] }] }] }, "plain", 20);
check("a record leaves out a field its row leaves empty", /^ *name\n +long value here$/m.test(narrowEmpty) && !/^ *note$/im.test(narrowEmpty), narrowEmpty);
check("a record keeps every value", ["古い席", "seat-2", "working", "failed", "fine", "spoof"].every((word) => narrow.includes(word)), narrow);
check("a table that fits stays a table", renderReport(report, "plain", 80) === plain);

let threw = false;
try {
  renderReport({ sections: [{ blocks: [{ kind: "lines", lines: [{ text: " ", tone: "ok", mark: "●" }] }] }] }, "rich");
} catch {
  threw = true;
}
check("a mark with no state word is refused", threw);

// Long text wraps at spaces to the width it is given, and a word that cannot fit is never split.
const wrapped = wrapWords("aaa bbb ccc ddd eee fff ggg", 20);
check("wrapWords breaks at spaces within the width", JSON.stringify(wrapped) === JSON.stringify(["aaa bbb ccc ddd eee", "fff ggg"]), wrapped);
const longWord = wrapWords(`${"x".repeat(30)} end`, 20);
check("a word wider than the line keeps a line of its own, unsplit", JSON.stringify(longWord) === JSON.stringify(["x".repeat(30), "end"]), longWord);
check("below 20 columns nothing is wrapped", wrapWords("a b c d e f g h i j k l m n o p", 10).length === 1, wrapWords("a b c d e f g h i j k l m n o p", 10));
// Broken at its spaces, "[--server" would still fit on the first line and leave "<url>]" alone.
const kept = wrapWords(["[--a <x>]", "[--server <url>]"], 20);
check("given words are kept whole", JSON.stringify(kept) === JSON.stringify(["[--a <x>]", "[--server <url>]"]), kept);
// A command in backticks wraps as one word, so a copied line never holds part of one. With a long
// space name, "cotal reset store" used to end one line and the name start the next.
const longName = `b541_${"x".repeat(56)}_la`;
const named = wrapWords(`remove its stored streams with \`cotal reset store ${longName} --yes\`, or remove only the local record with \`cotal space forget ${longName}\``, 78);
check("a command a line names in backticks wraps as one word, to its closing backtick",
  JSON.stringify(named) === JSON.stringify(["remove its stored streams with", `\`cotal reset store ${longName} --yes\`,`, "or remove only the local record with", `\`cotal space forget ${longName}\``]), named);
// An argument is whatever word it is: a persona named "with", or a quoted path with "from" in it.
const proseName = wrapWords("change it with `cotal persona edit with`, or remove it with `cotal persona remove with` first", 78);
check("a command whose argument is a word of prose stays whole",
  JSON.stringify(proseName) === JSON.stringify(["change it with `cotal persona edit with`, or remove it with", "`cotal persona remove with` first"]), proseName);
const spacedPath = wrapWords("add them to the running stack with `cotal team deploy '/srv/proj/data from s3/team.yaml'`, or stop it", 56);
check("a quoted path inside a command is never split",
  JSON.stringify(spacedPath) === JSON.stringify(["add them to the running stack with", "`cotal team deploy '/srv/proj/data from s3/team.yaml'`,", "or stop it"]), spacedPath);
// A step that changes folder first starts with `cd`; it is one word to its closing backtick too. It
// used to break inside "cotal manager start" at 80 columns.
const cdStep = wrapWords("start the manager from /tmp/rig-0123456789/proj/rt, the folder that hosts space \"rt\": `cd /tmp/rig-0123456789/proj/rt && cotal manager start`", 78);
check("a command that starts with cd wraps as one word, to its closing backtick",
  JSON.stringify(cdStep) === JSON.stringify(["start the manager from /tmp/rig-0123456789/proj/rt, the folder that hosts", "space \"rt\": `cd /tmp/rig-0123456789/proj/rt && cotal manager start`"]), cdStep);
// A path can hold a backtick. Such a command goes between double backticks, as Markdown writes it, and
// wraps whole to the matching pair. The path's own backtick used to close it and split the path.
check("a command names itself between backticks, or between a longer run when it holds one",
  codeSpan("cotal up") === "`cotal up`" && codeSpan("cotal team deploy '/srv/tick`q/team.yaml'") === "``cotal team deploy '/srv/tick`q/team.yaml'``");
const tickedPath = wrapWords(`add them to the running stack with ${codeSpan(`cotal team deploy '/srv/tick\`q "dq" $(x)/team.yaml'`)}, or stop it`, 56);
check("a command between double backticks wraps whole past a backtick in its quoted path",
  JSON.stringify(tickedPath) === JSON.stringify(["add them to the running stack with", "``cotal team deploy '/srv/tick`q \"dq\" $(x)/team.yaml'``,", "or stop it"]), tickedPath);
const bare = wrapWords("run cotal down --yes then cotal up", 24);
check("a command outside backticks wraps at its spaces", JSON.stringify(bare) === JSON.stringify(["run cotal down --yes", "then cotal up"]), bare);
const ticked = wrapWords("the restore left it stopped; start it with `cotal up --space restored-space` in its folder", 30);
check("a command in backticks wraps as one word", JSON.stringify(ticked) === JSON.stringify(["the restore left it stopped;", "start it with", "`cotal up --space restored-space`", "in its folder"]), ticked);
const quoted = wrapWords("it refuses with `this would migrate the machine-wide store` and stops", 30);
check("a quote in backticks that is no command wraps at its spaces", JSON.stringify(quoted) === JSON.stringify(["it refuses with `this would", "migrate the machine-wide", "store` and stops"]), quoted);
const usage = wrapWords("cotal up [--foreground|--detach] [--open] [--space <s>]", 40);
check("a line that starts with a command, as a usage line does, wraps at its spaces", JSON.stringify(usage) === JSON.stringify(["cotal up [--foreground|--detach]", "[--open] [--space <s>]"]), usage);
const listed = renderReport({ sections: [{ title: "Verdict", blocks: [{ kind: "commands", items: [{ command: `cotal reset store ${longName} --yes`, description: "Remove only this stopped store" }] }] }] }, "plain", 80).split("\n");
check("a command in a command list keeps one line, however wide", listed.includes(`  cotal reset store ${longName} --yes`) && listed.includes("    Remove only this stopped store"), listed);
const fits = (text: string, width: number) => text.split("\n").every((line) => displayWidth(line) <= width);
// A Next and the stopped-space note name their command in backticks after other words, so at 80
// columns it keeps one line. Named bare, these split after `cotal`, as the control shows.
const nextLines = (remedy: string) => renderReport(commandFailureReport(new CommandFailure("refused", "TARGET_UNAVAILABLE", "nothing answered", { remedy })), "plain", 80).split("\n");
for (const [remedy, command] of [
  ["rerun it with a longer --timeout and the same other flags, such as `cotal invoke manager ps --timeout 10000`", "`cotal invoke manager ps --timeout 10000`"],
  ["start the service that serves nosuch, then run the command again; `cotal service --space stoppedspace-1028` lists this space's services", "`cotal service --space stoppedspace-1028`"],
] as const) {
  const lines = nextLines(remedy), bareLines = nextLines(remedy.replaceAll("`", ""));
  check(`a Next keeps ${command} on one line at 80 columns, which it splits named bare`,
    lines.some((line) => line.includes(command)) && fits(lines.join("\n"), 80) && !bareLines.some((line) => line.includes(command.replaceAll("`", ""))), { lines, bareLines });
}
const heldNote = renderReport({ sections: [{ blocks: [{ kind: "lines", lines: [{ text: heldSpaceNote({ space: "stoppedspace-1028", root: "/nonexistent-cotal-root", state: "stopped" }), tone: "hint" }] }] }] }, "plain", 80).split("\n");
check("the stopped-space note keeps `cotal up` on one line at 80 columns", heldNote.length === 2 && heldNote[1] === "`cotal up`", heldNote);
// A command wider than the line runs past it on one line. The exec-endpoint `next:` command and the
// remedy of its refusal broke before `--handler <file>`; a remedy that starts with a command and goes
// on as prose still wraps at its spaces.
const wide = "cotal service add <name> --preset exec-endpoint --contract <file> --handler <file>";
const wideNext = renderReport({ sections: [{ title: "Services", blocks: [{ kind: "table", columns: [{ key: "name", label: "Service" }, { key: "state", label: "State" }, { key: "next", label: "Next" }], rows: [{ name: { text: "exec-endpoint", tone: "command" }, state: "not started", next: { text: wide, tone: "command" } }] }] }] }, "plain", 80).split("\n");
check(`an ${wide.length}-column next: command keeps one line at 80 columns`, wideNext.some((line) => line.trim() === wide) && wideNext.filter((line) => line.includes("--handler")).length === 1, wideNext);
const wideRemedy = nextLines(wide);
const commandRemedy = renderReport(commandFailureReport(new CommandFailure("refused", "USAGE_INVALID", "the exec-endpoint preset needs --contract, --handler", { remedy: wide, remedyIsCommand: true })), "plain", 80).split("\n");
check(`a refusal whose remedy is one ${wide.length}-column command keeps it on one line under Next at 80 columns; the same text without remedyIsCommand wraps`,
  commandRemedy.at(-1) === `  ${wide}` && commandRemedy.at(-2) === "Next" && !wideRemedy.some((line) => line.includes(wide)), { commandRemedy, wideRemedy });
const prose = nextLines("cotal status shows whether this space's manager answers; a stack manager that runs but does not answer is named there with its pid");
check("a remedy that starts with a command and goes on as prose wraps at its spaces", prose.slice(prose.indexOf("Next") + 1).length > 1 && fits(prose.join("\n"), 80), prose);
const longFields = { sections: [{ blocks: [{ kind: "fields" as const, rows: [["id", "x"], ["server", "nats://broker.example.com:4222 with a note that runs well past the line"]] as [string, string][] }] }] };
const longField = renderReport(longFields, "plain", 60);
check("a long field value fits the width", fits(longField, 60), longField);
check("a long field value continues under itself", longField.split("\n").slice(2).every((line) => /^ {8}\S/.test(line)) && longField.split("\n").length > 2, longField);
const stacked = renderReport(longFields, "plain", 40).split("\n");
check(
  "below 48 columns a label takes its own line and its value continues under it",
  stacked[2] === "server" && stacked.slice(3).every((line) => /^ {2}\S/.test(line)) && stacked.length > 4 && fits(stacked.join("\n"), 40),
  stacked,
);
// An identity beside a long label used to run past the line; it starts under its label instead.
const identity = "local.UAAONG2N3PW6ELUSJILJICOMJTEZ3JQST25C7LF6YBYRAGXU3YQBGDSP";
const wideWord = renderReport({ sections: [{ blocks: [{ kind: "fields", rows: [["observed membership", "live subscription"], ["identity", identity]] }] }] }, "plain", 80).split("\n");
check(
  "a value with a word too wide beside its label starts on the line under it, and a value that fits stays beside its label",
  wideWord.includes("identity:") && wideWord.includes(`  ${identity}`) && wideWord.includes("observed membership: live subscription") && fits(wideWord.join("\n"), 80),
  wideWord,
);
const longLine = renderReport({ sections: [{ blocks: [{ kind: "lines", lines: [{ text: "working on a task with a description long enough to wrap", tone: "ok", mark: "●" }, { text: "    a note indented by four spaces, long enough to wrap", tone: "hint" }] }] }] }, "rich", 30).replace(/\x1b\[[0-9;]*m/g, "");
check("a long line fits the width", fits(longLine, 30), longLine);
const [markLine, ...afterMark] = longLine.split("\n");
const noteAt = afterMark.findIndex((line) => line.startsWith("    a note"));
check(
  "a wrapped line continues under its text, past its mark and its leading spaces",
  markLine!.startsWith("● working") && noteAt > 0 && afterMark.slice(0, noteAt).every((line) => /^ {2}\S/.test(line)) && afterMark.slice(noteAt + 1).every((line) => /^ {4}\S/.test(line)) && afterMark.length > noteAt + 1,
  longLine,
);

// Plain draws a report's punctuation in ASCII; the content's own letters are kept.
const punctuated: Report = { sections: [{ title: "Docs", blocks: [{ kind: "fields", rows: [["→ launches", "none installed · cotal ext seed"], ["space", "alpha"]] }, { kind: "lines", lines: ["a long nam…", "§14 Workflows — the run", "古い席"] }] }] };
const plainPunct = renderReport(punctuated, "plain");
check(
  "plain draws the report's punctuation in ASCII",
  !/[^\x00-\x7f]/.test(plainPunct.replace("古い席", "")) && ["-> launches:", "none installed - cotal ext seed", "a long nam...", "section 14 Workflows - the run", "古い席"].every((s) => plainPunct.includes(s)),
  plainPunct,
);
check("rich keeps the punctuation", ["→ launches:", "·", "…", "§14", "—"].every((s) => renderReport(punctuated, "rich").includes(s)), renderReport(punctuated, "rich"));
const valueAt = (line: string, value: string) => line.indexOf(value);
const [launches, spaceRow] = plainPunct.split("\n").slice(1, 3);
check("plain field values line up after an ASCII-drawn label", valueAt(launches!, "none") === valueAt(spaceRow!, "alpha") && valueAt(launches!, "none") > 0, [launches, spaceRow]);

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
const plainPartial = capture(() => writeResult("plain", { command: "ps", target: null, result, completeness: "partial", partial: { message: "1 of 2 catalogs could not be read", remedy: "reread one" } }, view));
check("plain writes a partial result's line and remedy in ASCII", plainPartial.err === "! 1 of 2 catalogs could not be read\n  -> reread one\n", plainPartial.err);
// A warning on a 40-column terminal fits it; one written to a pipe stays one line whatever the
// stream reports as its columns.
const longWarning = [{ code: "SCOPE_DENIED", target: { space: "beta" }, message: "beta could not be read because this identity has no grant for its channels" }];
function onStderr(isTTY: boolean): { out: string; err: string } {
  const saved = (["isTTY", "columns"] as const).map((key) => [key, Object.getOwnPropertyDescriptor(process.stderr, key)] as const);
  Object.defineProperty(process.stderr, "isTTY", { value: isTTY, configurable: true });
  Object.defineProperty(process.stderr, "columns", { value: 40, configurable: true });
  try {
    return capture(() => writeResult("plain", { command: "ps", target: null, result, warnings: longWarning }, view));
  } finally {
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(process.stderr, key, descriptor);
      else delete (process.stderr as unknown as Record<string, unknown>)[key];
  }
}
const onTty = onStderr(true).err.trimEnd();
check("a long warning on a terminal fits its width", fits(onTty, 40) && onTty.split("\n").length > 1, onTty);
check("its continuation lines start under the text", onTty.split("\n").slice(1).every((line) => /^ {2}\S/.test(line)), onTty);
const onPipe = onStderr(false).err;
check("a long warning to a pipe stays one line", onPipe === `! ${longWarning[0]!.message}\n`, onPipe);

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
