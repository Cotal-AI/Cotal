import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join } from "node:path";
import { JsonlFileSource, type DurableSource, type EventWal, type SourceRead } from "@cotal-ai/connector-core";
import type { JcodeJournalRecord, PositionedJcodeJournalRecord } from "./agui-map.js";

const JOURNAL_WAIT_MS = 5_000;
const RETRY_INITIAL_MS = 25;
const RETRY_MAX_MS = 250;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const isMissing = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";

export function jcodeJournalPath(jcodeHome: string, sessionId: string): string {
  return join(jcodeHome, "sessions", `${sessionId}.journal.jsonl`);
}

async function captureJcodeJournalCursor(path: string, waitMs = JOURNAL_WAIT_MS): Promise<string> {
  const file = new JsonlFileSource<JcodeJournalRecord>(path);
  const deadline = performance.now() + waitMs;
  let retryMs = RETRY_INITIAL_MS;
  for (;;) {
    try {
      return (await file.read(undefined)).cursor;
    } catch (error) {
      if (!isMissing(error)) throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0)
        throw new Error(`Jcode AG-UI source: session journal did not appear within ${waitMs}ms`, { cause: error });
      await delay(Math.min(retryMs, remaining));
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    }
  }
}

/**
 * Persist where the public event stream begins before its first turn can start. A restart always
 * trusts the WAL's acknowledged cursor and never captures a later end, so output appended after this
 * boundary remains replayable even if the process dies before its first pump.
 */
export async function initializeJcodeEventBoundary(path: string, wal: EventWal): Promise<string> {
  const acknowledged = wal.frontier.sourceCursor;
  if (acknowledged !== undefined) return acknowledged;
  const boundary = await captureJcodeJournalCursor(path);
  await wal.advanceCursorOnly(boundary);
  return boundary;
}

/**
 * A Jcode session journal appears only when the first durable turn output is persisted. Wait for
 * that first complete file read, then use ordinary append-only JSONL cursor semantics forever.
 */
export class JcodeJournalSource implements DurableSource<JcodeJournalRecord> {
  readonly kind = "jcode-session-journal";
  private readonly file: JsonlFileSource<JcodeJournalRecord>;
  private snapshotMessages = 0;

  constructor(
    readonly path: string,
    private readonly waitMs = JOURNAL_WAIT_MS,
  ) {
    this.file = new JsonlFileSource<JcodeJournalRecord>(path);
  }

  async read(cursor: string | undefined): Promise<SourceRead<JcodeJournalRecord>> {
    if (cursor !== undefined) {
      try {
        const read = await this.file.read(cursor);
        this.snapshotMessages = await this.snapshotMessageCount();
        return read;
      } catch (error) {
        const replacement = await this.foldedSince();
        if (replacement === undefined) throw error;
        return {
          cursor: replacement,
          records: [{
            cursor: replacement,
            value: { journal_fold: { lost_records: 0 } },
          }],
        };
      }
    }
    const deadline = performance.now() + this.waitMs;
    let retryMs = RETRY_INITIAL_MS;
    for (;;) {
      try {
        await access(this.path, constants.R_OK);
        const read = cursor === undefined
          ? await this.file.readFromBeginning()
          : await this.file.read(cursor);
        this.snapshotMessages = await this.snapshotMessageCount();
        return read;
      } catch (error) {
        if (!isMissing(error)) throw error;
        const remaining = deadline - performance.now();
        if (remaining <= 0)
          throw new Error(
            `Jcode AG-UI source: session journal did not appear within ${this.waitMs}ms; refusing to lose the first run`,
            { cause: error },
          );
        await delay(Math.min(retryMs, remaining));
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      }
    }
  }

  private async snapshotMessageCount(): Promise<number> {
    const snapshot = join(dirname(this.path), `${basename(this.path, ".journal.jsonl")}.json`);
    try {
      if ((await stat(snapshot)).size === 0) return 0;
      const parsed: unknown = JSON.parse(await readFile(snapshot, "utf8"));
      if (parsed === null || typeof parsed !== "object" || !Array.isArray((parsed as { messages?: unknown }).messages)) return 0;
      return (parsed as { messages: unknown[] }).messages.length;
    } catch (error) {
      if (isMissing(error)) return 0;
      throw error;
    }
  }

  private async foldedSince(): Promise<string | undefined> {
    const deadline = performance.now() + this.waitMs;
    let retryMs = RETRY_INITIAL_MS;
    for (;;) {
      const messages = await this.snapshotMessageCount();
      if (messages > this.snapshotMessages) {
        try {
          const cursor = await this.file.cursorAtBeginning();
          this.snapshotMessages = messages;
          return cursor;
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) return undefined;
      await delay(Math.min(retryMs, remaining));
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    }
  }
}

export function positionedJcodeJournalSource(
  source: DurableSource<JcodeJournalRecord>,
): DurableSource<PositionedJcodeJournalRecord> {
  return {
    kind: source.kind,
    async read(cursor) {
      const read = await source.read(cursor);
      return {
        cursor: read.cursor,
        records: read.records.map((record) => ({
          cursor: record.cursor,
          value: { cursor: record.cursor, record: record.value },
        })),
      };
    },
  };
}
