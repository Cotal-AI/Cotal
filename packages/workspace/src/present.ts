import stringWidth from "string-width";
import { c } from "./colors.js";
import { oneLine } from "@cotal-ai/core";
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
  readonly header?: boolean;
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

/** Useful actions, with the command distinct from its explanation. */
export interface Commands {
  readonly kind: "commands";
  readonly items: readonly { readonly command: string; readonly description: string }[];
}

export type Block = Table | Fields | Lines | Commands;

export interface Section {
  readonly title?: string;
  readonly blocks: readonly Block[];
}

/** A finished report: sections in order. Every text in it is treated as untrusted and escaped with
 *  {@link oneLine}, so a name or message cannot move the cursor, restyle the screen or end its line. */
export interface Report {
  /** The resolved mesh, supplied by the operation rather than inferred from ambient selection. */
  readonly space?: string;
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
    Math.max(table.header === false ? 0 : draw(label(column), style).width, ...table.rows.map((row) => draw(cellOf(row, column), style).width)),
  );
  const total = indent.length + widths.reduce((sum, w) => sum + w, 0) + 2 * (widths.length - 1);
  if (total <= width) {
    // An empty last cell would leave the padding before it trailing the line.
    const line = (cells: Cell[]) =>
      (indent + cells.map((cell, i) => (i === cells.length - 1 ? draw(cell, style).shown : drawPadded(cell, style, widths[i]!))).join("  ")).replace(/ +$/, "");
    return [...(table.header === false ? [] : [line(table.columns.map(label))]), ...table.rows.map((row) => line(table.columns.map((column) => cellOf(row, column))))];
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

/** Each value starts after its padded label; a value too long for the line continues under itself.
 *  Below 48 columns each label takes a line of its own, with its value on the lines under it. */
function renderFields(fields: Fields, style: Style, indent: string, width: number): string[] {
  if (width < 48) {
    return fields.rows.flatMap(([name, value]) => [
      indent + draw({ text: name, tone: "label" }, style).shown,
      ...drawWrapped(value, style, width - indent.length - 2).map((line) => indent + "  " + line),
    ]);
  }
  const pad = Math.max(0, ...fields.rows.map(([name]) => displayWidth(textOf(name, style)) + 1));
  const start = indent.length + pad + 1;
  return fields.rows.flatMap(([name, value]) => {
    const [first, ...rest] = drawWrapped(value, style, width - start);
    return [`${indent}${drawPadded({ text: `${name}:`, tone: "label" }, style, pad)} ${first}`, ...rest.map((line) => " ".repeat(start) + line)];
  });
}

function renderCommands(block: Commands, style: Style, width: number, indent: string): string[] {
  const commands = block.items.map((item) => ({ text: item.command, tone: "command" as const }));
  const pad = Math.max(0, ...commands.map((command) => draw(command, style).width));
  // A description that would have fewer than 30 columns beside its command goes on the lines under it.
  const stacked = width - indent.length - pad - 2 < 30;
  return block.items.flatMap((item, index) => {
    const description: Cell = { text: item.description, tone: "hint" };
    if (stacked) return [
      ...drawWrapped(commands[index]!, style, width - indent.length).map((line) => indent + line),
      ...drawWrapped(description, style, width - indent.length - 2).map((line) => indent + "  " + line),
    ];
    const [first = "", ...rest] = drawWrapped(description, style, width - indent.length - pad - 2);
    return [
      indent + drawPadded(commands[index]!, style, pad) + "  " + first,
      ...rest.map((line) => " ".repeat(indent.length + pad + 2) + line),
    ];
  });
}

/** A report as lines of text, fitted to `width` columns (unbounded when output is not a terminal):
 *  tables fit or become records, and long values and lines wrap at spaces. */
export function renderReport(report: Report, style: Style, width = Number.POSITIVE_INFINITY): string {
  const out: string[] = report.space ? drawWrapped({ text: `Mesh: ${report.space}`, tone: "selected" }, style, width) : [];
  for (const section of report.sections) {
    if (out.length) out.push("");
    const indent = section.title === undefined ? "" : "  ";
    if (section.title !== undefined) out.push(draw({ text: section.title, tone: "title" }, style).shown);
    for (const block of section.blocks) {
      if (block.kind === "table") out.push(...renderTable(block, style, width, indent));
      else if (block.kind === "fields") out.push(...renderFields(block, style, indent, width));
      else if (block.kind === "commands") out.push(...renderCommands(block, style, width, indent));
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
 *  already in place: the outcome is `no-op` and the run exits 0. `failure` retains an attributed
 *  multi-member result alongside its classified error. A failure without useful result data is
 *  thrown as a {@link CommandFailure} for the kernel to write. */
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
    failure?: CommandFailure;
  },
  view: (result: R) => Report,
): void {
  if (Number(Boolean(out.partial)) + Number(Boolean(out.noOp)) + Number(Boolean(out.failure)) > 1) throw new Error("internal error: a result has one outcome classification");
  const outcome = out.failure?.outcome ?? (out.partial ? "partial" : out.noOp ? "no-op" : "ok");
  const code = out.failure?.code ?? (out.partial ? "OPERATION_PARTIAL" : undefined);
  const error = out.failure?.detail() ?? (out.partial ? { code: "OPERATION_PARTIAL" as const, message: out.partial.message, ...(out.partial.remedy === undefined ? {} : { remedy: out.partial.remedy }) } : undefined);
  if (presentation === "json") {
    writeEnvelope({
      schemaVersion: 1,
      command: out.command,
      target: out.target,
      outcome,
      completeness: out.completeness ?? "complete",
      result: out.result,
      warnings: out.warnings ?? [],
      ...(error ? { error } : {}),
      ...(out.failure?.changed === undefined ? {} : { changed: out.failure.changed }),
    });
  } else {
    const target = out.target !== null && typeof out.target === "object" && !Array.isArray(out.target) ? out.target as Record<string, unknown> : undefined;
    const report = view(out.result);
    console.log(renderReport({ ...report, ...(typeof target?.space === "string" && target.space ? { space: target.space } : {}) }, presentation, terminalWidth(process.stdout)));
    const errWidth = terminalWidth(process.stderr);
    const say = (cell: Styled, hang: number) => { for (const line of drawWrapped(cell, presentation, errWidth, hang)) console.error(line); };
    for (const warning of out.warnings ?? []) say({ text: `! ${warning.message}`, tone: "waiting" }, 2);
    if (error) {
      say({ text: `${presentation === "plain" ? "!" : "✗"} ${error.message}`, tone: outcome === "partial" || outcome === "unknown" ? "waiting" : "failed" }, 2);
      if (error.remedy) say({ text: `  ↳ ${error.remedy}`, tone: "hint" }, 2);
    }
  }
  process.exitCode = exitCode(outcome, code);
}

/** A failure report exposes only attributed target/receipt fields, never arbitrary input objects. */
export function commandFailureReport(failure: CommandFailure): Report {
  const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const fields: (readonly [string, Cell])[] = [["Outcome", { text: failure.outcome, tone: failure.outcome === "unknown" || failure.outcome === "partial" ? "waiting" : "failed" }], ["Code", failure.code]];
  const target = object(failure.target);
  const labels: readonly (readonly [string, string])[] = [["space", "Space"], ["endpoint", "Endpoint"], ["command", "Native command"], ["name", "Name"], ["deploymentId", "Deployment"], ["instanceId", "Instance"], ["requestedInstanceId", "Requested instance"], ["managerInstanceId", "Manager"], ["requestId", "Original request"], ["requestedGoalId", "Requested goal"], ["acceptedGoalId", "Accepted goal"]];
  for (const [key, label] of labels) if (typeof target?.[key] === "string" && target[key]) fields.push([label, target[key] as string]);
  const accepted = object(target?.accepted);
  if (typeof accepted?.goalId === "string") fields.push(["Accepted goal", accepted.goalId]);
  if (typeof accepted?.fingerprint === "string") fields.push(["Goal fingerprint", accepted.fingerprint]);
  const responder = object(accepted?.responder) ?? object(object(failure.native?.detail)?.responder);
  if (typeof responder?.instanceId === "string") fields.push(["Answering instance", responder.instanceId]);
  if (typeof responder?.epoch === "number") fields.push(["Answering epoch", String(responder.epoch)]);
  if (failure.native?.code) fields.push(["Native code", failure.native.code]);
  if (failure.native?.outcome) fields.push(["Native outcome", failure.native.outcome]);
  // A wrapped cause's own sentence, such as which path a check refused and why. Cells render on one line.
  if (typeof failure.native?.detail === "string" && failure.native.detail) fields.push(["Native detail", failure.native.detail]);
  const purges = (failure.changed ?? []).flatMap((item) => {
    const row = object(item);
    return typeof row?.stream === "string" && typeof row.purged === "number" ? [{ stream: row.stream, purged: String(row.purged) }] : [];
  });
  const native = object(failure.native?.detail);
  const names = (value: unknown): string[] => Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
  const nativeRows = [
    ...names(native?.acknowledged).map((name) => ({ state: "acknowledged", name })),
    ...names(native?.alreadyAbsent).map((name) => ({ state: "already absent", name })),
    ...(typeof native?.refused === "string" ? [{ state: "refused", name: native.refused }] : []),
    ...(typeof native?.unconfirmed === "string" ? [{ state: "unconfirmed", name: native.unconfirmed }] : []),
    ...names(native?.remaining).filter((name) => name !== native?.refused && name !== native?.unconfirmed).map((name) => ({ state: "remaining or unresolved", name })),
  ];
  return { ...(typeof target?.space === "string" && target.space ? { space: target.space } : {}), sections: [
    { title: failure.outcome === "unknown" ? "Outcome unconfirmed" : failure.outcome === "partial" ? "Partly completed" : failure.outcome === "refused" ? "Request refused" : "Request failed", blocks: [{ kind: "lines", lines: [{ text: failure.message, tone: failure.outcome === "unknown" || failure.outcome === "partial" ? "waiting" : "failed" }] }, { kind: "fields", rows: fields }] },
    ...(purges.length ? [{ title: "Acknowledged history changes", blocks: [{ kind: "table" as const, columns: [{ key: "stream", label: "Native stream" }, { key: "purged", label: "Messages purged" }], rows: purges }] }] : []),
    ...(nativeRows.length ? [{ title: "Native target details", blocks: [{ kind: "table" as const, columns: [{ key: "state", label: "State" }, { key: "name", label: "Target" }], rows: nativeRows.slice(0, 100) }, ...(nativeRows.length > 100 ? [{ kind: "lines" as const, lines: [`Showing 100 of ${nativeRows.length} targets; --json retains every row.`] }] : [])] }] : []),
    ...(failure.changed?.length && !purges.length && !nativeRows.length ? [{ title: "Confirmed changes", blocks: [{ kind: "lines" as const, lines: [`${failure.changed.length} change receipt(s) retained. Choose structured output before the operation to retain their data; do not repeat a mutation merely to view its receipt.`] }] }] : []),
    ...(failure.remedy ? [{ title: "Next", blocks: [{ kind: "lines" as const, lines: [failure.remedy] }] }] : []),
  ] };
}
