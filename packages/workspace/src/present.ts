import stringWidth from "string-width";
import { c } from "./colors.js";
import { oneLine } from "./one-line.js";
import { CommandFailure, writeEnvelope, type Completeness, type OutputWarning } from "./output.js";

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

/** `rich` colors when color is on and draws marks; `plain` writes no ANSI and no marks. */
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

const textOf = (cell: Cell): string => oneLine(typeof cell === "string" ? cell : cell.text);

/** One cell as `style` draws it. The width it occupies is that of its escaped text, plus the mark
 *  and a space in rich style. */
function draw(cell: Cell, style: Style): { shown: string; width: number } {
  const text = textOf(cell);
  if (typeof cell !== "string" && cell.mark && !cell.text.trim()) throw new Error(`internal error: the mark ${cell.mark} names no state in words`);
  if (typeof cell === "string" || style === "plain") return { shown: text, width: displayWidth(text) };
  const marked = cell.mark ? `${oneLine(cell.mark)} ${text}` : text;
  return { shown: cell.tone ? tones[cell.tone](marked) : marked, width: displayWidth(marked) };
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
    const line = (cells: Cell[]) =>
      indent + cells.map((cell, i) => (i === cells.length - 1 ? draw(cell, style).shown : drawPadded(cell, style, widths[i]!))).join("  ");
    return [line(table.columns.map(label)), ...table.rows.map((row) => line(table.columns.map((column) => cellOf(row, column))))];
  }
  // Too narrow for the columns: one labeled record per row, so nothing is clipped.
  const records = table.rows.map((row) => renderFields({ kind: "fields", rows: table.columns.map((column) => [column.label, cellOf(row, column)]) }, style, indent));
  return records.flatMap((record, i) => (i === 0 ? record : ["", ...record]));
}

function renderFields(fields: Fields, style: Style, indent: string): string[] {
  const pad = Math.max(0, ...fields.rows.map(([name]) => displayWidth(oneLine(name)) + 1));
  return fields.rows.map(([name, value]) => `${indent}${drawPadded({ text: `${name}:`, tone: "label" }, style, pad)} ${draw(value, style).shown}`);
}

/** A report as lines of text, fitted to `width` columns (unbounded when output is not a terminal). */
export function renderReport(report: Report, style: Style, width = Number.POSITIVE_INFINITY): string {
  const out: string[] = [];
  for (const section of report.sections) {
    if (out.length) out.push("");
    const indent = section.title === undefined ? "" : "  ";
    if (section.title !== undefined) out.push(draw({ text: section.title, tone: "title" }, style).shown);
    for (const block of section.blocks) {
      if (block.kind === "table") out.push(...renderTable(block, style, width, indent));
      else if (block.kind === "fields") out.push(...renderFields(block, style, indent));
      else out.push(...block.lines.map((line) => indent + draw(line, style).shown));
    }
  }
  return out.join("\n");
}

/** The presentation `--json` and `--plain` ask for. Both at once is a usage error. */
export function presentationOf(values: { readonly json?: unknown; readonly plain?: unknown }): Presentation {
  if (values.json === true && values.plain === true)
    throw new CommandFailure("refused", "USAGE_INVALID", "--json and --plain choose different outputs - pass one", { remedy: "pass --json for a document or --plain for text" });
  return values.json === true ? "json" : values.plain === true ? "plain" : "rich";
}

/** One finished result in the presentation the run asked for: the envelope for `json`, otherwise the
 *  report `view` builds from the same result, fitted to the terminal stdout is, with each warning on
 *  stderr. */
export function writeResult<R>(
  presentation: Presentation,
  out: { command: string; target: unknown; result: R; completeness?: Completeness; warnings?: readonly OutputWarning[] },
  view: (result: R) => Report,
): void {
  if (presentation === "json") {
    writeEnvelope({ schemaVersion: 1, command: out.command, target: out.target, outcome: "ok", completeness: out.completeness ?? "complete", result: out.result, warnings: out.warnings ?? [] });
    return;
  }
  const width = process.stdout.isTTY ? process.stdout.columns : Number.POSITIVE_INFINITY;
  console.log(renderReport(view(out.result), presentation, width));
  for (const warning of out.warnings ?? []) console.error(draw({ text: `! ${warning.message}`, tone: "waiting" }, presentation).shown);
}
