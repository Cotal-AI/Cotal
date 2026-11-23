/**
 * A harness's own durable source with its {@link DeltaJournal} read in among its records.
 *
 * **The order is a function of the two files, never of when they were read.** Each journal line
 * carries the harness position it was written at, and goes before the first harness record that
 * ends after that position. The cursor after a journal line names that position on the harness
 * side, so a read from any record's cursor, in this process or after a restart, answers the same
 * records under the same cursor strings: which is what the emitter's terminal placement compares.
 */
import { JsonlFileSource, type DurableSource, type OrderedSource, type SourceGap, type SourceRead, type SourceRecord } from "./durable-source.js";
import { assertDeltaRecord, type DeltaRecord, type StreamDelta } from "./delta-journal.js";
import type { BracketState } from "./agui.js";
import type { StreamSeed } from "./streamed-parts.js";

/** One record of a {@link DeltaMergedSource}: a harness record, or one journal line, whose `ends` names
 *  the streams the harness abandoned. */
export type Merged<T> = { harness: T } | { deltas: StreamDelta[]; timestamp: number; ends?: string[] };

const pack = (harness: string, journal: string): string => JSON.stringify([harness, journal]);

/**
 * The two halves of a merged cursor. A cursor that is not a JSON array is a harness cursor alone,
 * as a WAL written before its connector journaled deltas holds one; its journal half is absent.
 * A harness whose own cursors begin with `[` cannot be merged.
 */
function unpack(cursor: string): { harness: string; journal?: string } {
  if (!cursor.startsWith("[")) return { harness: cursor };
  let v: unknown;
  try {
    v = JSON.parse(cursor);
  } catch {
    v = undefined;
  }
  if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== "string" || typeof v[1] !== "string" || pack(v[0], v[1]) !== cursor)
    throw new Error(`DeltaMergedSource: malformed cursor ${JSON.stringify(cursor)} (want [<harness>, <journal>])`);
  return { harness: v[0], journal: v[1] };
}

export class DeltaMergedSource<T> implements DurableSource<Merged<T>> {
  readonly kind: string;
  private readonly journal: JsonlFileSource<DeltaRecord>;

  /** @param journalPath The journal the connector opened with {@link DeltaJournal.open}; it must exist. */
  constructor(
    private readonly harness: OrderedSource<T>,
    private readonly journalPath: string,
  ) {
    this.kind = `${harness.kind}+deltas`;
    this.journal = new JsonlFileSource<DeltaRecord>(journalPath);
  }

  /** The merged cursor at a harness position, with the journal at its end now. A connector stores it
   *  where it stored the harness cursor alone. */
  start(harnessCursor: string): string {
    return pack(harnessCursor, this.journal.endSync());
  }

  /** The harness half of a cursor this source gave, or of a harness cursor stored alone. */
  harnessOf(cursor: string): string {
    return unpack(cursor).harness;
  }

  /** The journal's end first, then the harness's: every line up to the first is anchored at or before
   *  the second. */
  async end(): Promise<string> {
    const journal = this.journal.endSync();
    return pack(await this.harness.end(), journal);
  }

  /**
   * The harness is read before the journal. A line anchored past the harness read's end was written
   * after a record this read does not hold yet, so it waits for a later read. A line anchored before
   * the read's harness start was journaled after a reader had passed its anchor, which only a harness
   * in another process can cause, and goes where the read starts.
   */
  async read(cursor: string | undefined): Promise<SourceRead<Merged<T>>> {
    const from = cursor === undefined ? undefined : unpack(cursor);
    const h = await this.harness.read(from?.harness);
    const journalFrom = from?.journal ?? this.journal.endSync();
    const j = await this.journal.read(journalFrom);
    j.records.forEach((r) => assertDeltaRecord(r.value, `the line before ${this.journalPath} cursor ${r.cursor}`));
    const records: SourceRecord<Merged<T>>[] = [];
    let hPos = from?.harness ?? h.cursor;
    let jPos = journalFrom;
    let k = 0;
    const line = (r: SourceRecord<DeltaRecord>): void => {
      if (this.harness.compare(r.value.anchor, hPos) > 0) hPos = r.value.anchor;
      jPos = r.cursor;
      records.push({ value: { deltas: r.value.deltas, timestamp: r.value.ts, ...(r.value.ends ? { ends: r.value.ends } : {}) }, cursor: pack(hPos, jPos) });
    };
    for (const rec of h.records) {
      while (k < j.records.length && this.harness.compare(j.records[k]!.value.anchor, rec.cursor) < 0) line(j.records[k++]!);
      hPos = rec.cursor;
      records.push({ value: { harness: rec.value }, cursor: pack(hPos, jPos) });
    }
    while (k < j.records.length && this.harness.compare(j.records[k]!.value.anchor, h.cursor) <= 0) line(j.records[k++]!);
    const unreadable: SourceGap[] = [...(h.unreadable ?? []), ...(j.unreadable ?? []).map((g) => ({ ...g, file: this.journalPath }))];
    return {
      records,
      cursor: pack(h.cursor, k < j.records.length ? jPos : j.cursor),
      ...(unreadable.length > 0 ? { unreadable } : {}),
    };
  }
}

/**
 * The stream state a restarted mapper resumes with: the journal is read up to the cursor's journal
 * half, a key the WAL's brackets hold open resumes with the text it streamed, and every other key
 * seen there is closed, a key a line ended before it streamed included. A cursor with no journal
 * half streamed nothing.
 */
export async function streamSeed(journalPath: string, cursor: string | undefined, brackets: BracketState | null): Promise<StreamSeed> {
  const upTo = cursor === undefined ? undefined : unpack(cursor).journal;
  if (upTo === undefined) return { open: [], closed: [] };
  const journal = new JsonlFileSource<DeltaRecord>(journalPath);
  const read = await journal.read(await journal.cursorAtBeginning());
  const streamed = new Map<string, { kind: StreamDelta["kind"]; text: string }>();
  const ended = new Set<string>();
  for (const r of read.records) {
    if (journal.compare(r.cursor, upTo) > 0) break;
    assertDeltaRecord(r.value, `the line before ${journalPath} cursor ${r.cursor}`);
    for (const d of r.value.deltas) {
      const s = streamed.get(d.key);
      if (s) s.text += d.text;
      else streamed.set(d.key, { kind: d.kind, text: d.text });
    }
    for (const key of r.value.ends ?? []) ended.add(key);
  }
  const open = new Set([...(brackets?.text ?? []), ...(brackets?.reasoning ?? [])]);
  const seed: StreamSeed = { open: [], closed: [] };
  for (const [key, s] of streamed) {
    if (open.has(key)) seed.open.push({ key, ...s });
    else seed.closed.push(key);
  }
  for (const key of ended) if (!streamed.has(key)) seed.closed.push(key);
  return seed;
}
