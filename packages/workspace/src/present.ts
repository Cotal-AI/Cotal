import stringWidth from "string-width";
import { c } from "./colors.js";
import { oneLine } from "./one-line.js";
import { CommandFailure, exitCode, writeEnvelope, type Completeness, type OutputWarning } from "./output.js";

/**
 * The terminal presentation every command surface shares: one view model of a finished report,
 * rendered rich (color and marks) or plain (no ANSI, ASCII only), and the same result written as
 * the JSON envelope. A command builds the view from its result, so the three never disagree about
 * what was found. The tokens carry meaning; the renderer picks the color, and the word always stays.
 */

/** What a piece of text means. Blue for commands and the selected item, green for proven healthy
 *  or done, amber for waiting or partial, red for failed, denied or destructive. Labels and hints are
 *  subdued, titles bold. */
export type Tone = "command" | "selected" | "ok" | "waiting" | "failed" | "label" | "hint" | "title";

/** Text with a tone. `mark` is a decoration only the rich renderer draws (`●`); the text must name
 *  the state on its own, since plain output and a screen without color show only the text. */
export interface Styled {
  readonly text: string;
  readonly tone?: Tone;
  readonly mark?: string;
}

export type Cell = string | Styled;

export interface Column {
  readonly key: string;
  readonly label: string;
}

/** Rows under column labels; a terminal too narrow for them gets one labeled record per row. */
export interface Table {
  readonly kind: "table";
  readonly columns: readonly Column[];
  readonly rows: readonly Readonly<Record<string, Cell>>[];
}

/** Label and value pairs, one per line, values aligned. */
export interface Fields {
  readonly kind: "fields";
  readonly rows: readonly (readonly [label: string, value: Cell])[];
}

/** Free lines, such as hints. */
export interface Lines {
  readonly kind: "lines";
  readonly lines: readonly Cell[];
}

export type Block = Table | Fields | Lines;

export interface Section {
  readonly title?: string;
  readonly blocks: readonly Block[];
}

/** A finished report: sections in order. Every text in it is treated as untrusted and escaped with
 *  {@link oneLine}, so a name or message cannot move the cursor, restyle the screen or end its line. */
export interface Report {
  readonly sections: readonly Section[];
}

/** `rich` colors when color is on and draws marks; `plain` writes no ANSI and no marks, and draws
 *  the report's own punctuation in ASCII. */
export type Style = "rich" | "plain";

/** Which presentation a run asked for: `--json`, `--plain`, or neither. */
export type Presentation = Style | "json";

const tones: Record<Tone, (s: string) => string> = {
  command: c.blue,
  selected: c.blue,
  ok: c.green,
  waiting: c.yellow,
  failed: c.red,
  label: c.dim,
  hint: c.dim,
  title: c.bold,
};

/** The columns `text` occupies on a terminal: grapheme clusters, wide East Asian and emoji
 *  characters as two, combining marks and zero-width characters as none, ANSI sequences as none. */
export function displayWidth(text: string): number {
  return stringWidth(text);
}

/** Punctuation as plain writes it, wherever it appears, so a plain report is ASCII apart from
 *  other characters of the content itself, such as the letters of a name. */
const PLAIN_PUNCTUATION: Readonly<Record<string, string>> = { "·": "-", "…": "...", "→": "->", "↳": "->", "—": "-", "–": "-" };

const textOf = (cell: Cell, style: Style): string => {
  const text = oneLine(typeof cell === "string" ? cell : cell.text);
  return style === "plain" ? text.replace(/[·…→↳—–]/g, (glyph) => PLAIN_PUNCTUATION[glyph]!).replace(/§ ?/g, "section ") : text;
};

/** One cell as `style` draws it. The width it occupies is that of its escaped text, plus the mark
 *  and a space in rich style. */
function draw(cell: Cell, style: Style): { shown: string; width: number } {
  const text = textOf(cell, style);
  if (typeof cell !== "string" && cell.mark && !cell.text.trim()) throw new Error(`internal error: the mark ${cell.mark} names no state in words`);
  if (typeof cell === "string" || style === "plain") return { shown: text, width: displayWidth(text) };
  const marked = cell.mark ? `${oneLine(cell.mark)} ${text}` : text;
  return { shown: cell.tone ? tones[cell.tone](marked) : marked, width: displayWidth(marked) };
}

/** `text` in lines of at most `width` display columns, broken at spaces, or only between the given
 *  words. A word wider than `width` keeps a line of its own, so an identity, path or command is never
 *  split. Below 20 columns, and when the output is not a terminal, nothing is wrapped. */
export function wrapWords(text: string | readonly string[], width: number): string[] {
  const words = typeof text === "string" ? text.split(" ") : text;
  if (!(width >= 20) || displayWidth(words.join(" ")) <= width) return [words.join(" ")];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && displayWidth(next) > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  lines.push(line);
  return lines;
}

/** A cell drawn in lines that fit `width` columns, each line toned on its own. A continuation line
 *  starts under the first line's text, past its leading spaces and the mark, plus `hang` columns. */
function drawWrapped(cell: Cell, style: Style, width: number, hang = 0): string[] {
  const text = textOf(cell, style);
  const lead = /^ */.exec(text)![0];
  const markWidth = typeof cell !== "string" && cell.mark && style === "rich" ? displayWidth(oneLine(cell.mark)) + 1 : 0;
  const [first = "", ...rest] = wrapWords(text.slice(lead.length), width - lead.length - markWidth - hang);
  const piece = (words: string): Cell => (typeof cell === "string" ? words : { text: words, ...(cell.tone ? { tone: cell.tone } : {}) });
  return [
    draw(typeof cell === "string" ? lead + first : { ...cell, text: lead + first }, style).shown,
    ...rest.map((words) => " ".repeat(lead.length + markWidth + hang) + draw(piece(words), style).shown),
  ];
}

function drawPadded(cell: Cell, style: Style, width: number): string {
  const { shown, width: used } = draw(cell, style);
  return shown + " ".repeat(Math.max(0, width - used));
}

function renderTable(table: Table, style: Style, width: number, indent: string): string[] {
  const label = (column: Column): Cell => ({ text: column.label, tone: "label" });
  const cellOf = (row: Readonly<Record<string, Cell>>, column: Column): Cell => row[column.key] ?? "";
  const widths = table.columns.map((column) =>
    Math.max(draw(label(column), style).width, ...table.rows.map((row) => draw(cellOf(row, column), style).width)),
  );
  const total = indent.length + widths.reduce((sum, w) => sum + w, 0) + 2 * (widths.length - 1);
  if (total <= width) {
    // An empty last cell would leave the padding before it trailing the line.
    const line = (cells: Cell[]) =>
      (indent + cells.map((cell, i) => (i === cells.length - 1 ? draw(cell, style).shown : drawPadded(cell, style, widths[i]!))).join("  ")).replace(/ +$/, "");
    return [line(table.columns.map(label)), ...table.rows.map((row) => line(table.columns.map((column) => cellOf(row, column))))];
  }
  // Too narrow for the columns: one labeled record per row, so nothing is clipped. Its labels read
  // as the other reports' fields do, and a field the row leaves empty is left out.
  const records = table.rows.map((row) =>
    renderFields(
      { kind: "fields", rows: table.columns.filter((column) => textOf(cellOf(row, column), "plain") !== "").map((column) => [column.label.toLowerCase(), cellOf(row, column)]) },
      style,
      indent,
      width,
    ),
  );
  return records.flatMap((record, i) => (i === 0 ? record : ["", ...record]));
}

/** Each value starts after its padded label; a value too long for the line continues under itself. */
function renderFields(fields: Fields, style: Style, indent: string, width: number): string[] {
  const pad = Math.max(0, ...fields.rows.map(([name]) => displayWidth(textOf(name, style)) + 1));
  const start = indent.length + pad + 1;
  return fields.rows.flatMap(([name, value]) => {
    const [first, ...rest] = drawWrapped(value, style, width - start);
    return [`${indent}${drawPadded({ text: `${name}:`, tone: "label" }, style, pad)} ${first}`, ...rest.map((line) => " ".repeat(start) + line)];
  });
}

/** A report as lines of text, fitted to `width` columns (unbounded when output is not a terminal):
 *  tables fit or become records, and long values and lines wrap at spaces. */
export function renderReport(report: Report, style: Style, width = Number.POSITIVE_INFINITY): string {
  const out: string[] = [];
  for (const section of report.sections) {
    if (out.length) out.push("");
    const indent = section.title === undefined ? "" : "  ";
    if (section.title !== undefined) out.push(draw({ text: section.title, tone: "title" }, style).shown);
    for (const block of section.blocks) {
      if (block.kind === "table") out.push(...renderTable(block, style, width, indent));
      else if (block.kind === "fields") out.push(...renderFields(block, style, indent, width));
      else out.push(...block.lines.flatMap((line) => drawWrapped(line, style, width - indent.length).map((shown) => indent + shown)));
    }
  }
  return out.join("\n");
}

/** The columns a stream can show: its terminal's width, or unbounded when it is not a terminal. */
export function terminalWidth(stream: { readonly isTTY?: boolean; readonly columns?: number }): number {
  return stream.isTTY && stream.columns ? stream.columns : Number.POSITIVE_INFINITY;
}

/** The presentation `--json` and `--plain` ask for. Both at once is a usage error. */
export function presentationOf(values: { readonly json?: unknown; readonly plain?: unknown }): Presentation {
  if (values.json === true && values.plain === true)
    throw new CommandFailure("refused", "USAGE_INVALID", "--json and --plain choose different outputs - pass one", { remedy: "pass --json for a document or --plain for text" });
  return values.json === true ? "json" : values.plain === true ? "plain" : "rich";
}

/** One finished result in the presentation the run asked for: the envelope for `json`, otherwise the
 *  report `view` builds from the same result, fitted to the terminal stdout is, with each warning on
 *  stderr. `partial` marks a read that answered for only part of what was asked: the result keeps
 *  what was read, the outcome is `partial`, and the run exits 4. `noOp` marks a change that was
 *  already in place: the outcome is `no-op` and the run exits 0. It writes only `ok`, `no-op` and
 *  `partial`: a refusal or failure is thrown as a {@link CommandFailure} for the kernel to write. */
export function writeResult<R>(
  presentation: Presentation,
  out: {
    command: string;
    target: unknown;
    result: R;
    completeness?: Completeness;
    warnings?: readonly OutputWarning[];
    partial?: { message: string; remedy?: string };
    noOp?: boolean;
  },
  view: (result: R) => Report,
): void {
  if (out.partial && out.noOp) throw new Error("internal error: a result is partial or a no-op, not both");
  const outcome = out.partial ? "partial" : out.noOp ? "no-op" : "ok";
  const code = out.partial ? "OPERATION_PARTIAL" : undefined;
  if (presentation === "json") {
    writeEnvelope({
      schemaVersion: 1,
      command: out.command,
      target: out.target,
      outcome,
      completeness: out.completeness ?? "complete",
      result: out.result,
      warnings: out.warnings ?? [],
      ...(out.partial ? { error: { code: "OPERATION_PARTIAL" as const, message: out.partial.message, ...(out.partial.remedy === undefined ? {} : { remedy: out.partial.remedy }) } } : {}),
    });
  } else {
    console.log(renderReport(view(out.result), presentation, terminalWidth(process.stdout)));
    const errWidth = terminalWidth(process.stderr);
    const say = (cell: Styled, hang: number) => { for (const line of drawWrapped(cell, presentation, errWidth, hang)) console.error(line); };
    for (const warning of out.warnings ?? []) say({ text: `! ${warning.message}`, tone: "waiting" }, 2);
    if (out.partial) {
      say({ text: `${presentation === "plain" ? "!" : "✗"} ${out.partial.message}`, tone: "failed" }, 2);
      if (out.partial.remedy) say({ text: `  ↳ ${out.partial.remedy}`, tone: "hint" }, 2);
    }
  }
  process.exitCode = exitCode(outcome, code);
}
