import { access, open } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join } from "node:path";
import { JsonlFileSource, JsonlFileResetError, type DurableSource, type EventWal, type SourceRead } from "@cotal-ai/connector-core";
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

/** Read native journal appends and report checkpoints as explicit event discontinuities. */
export class JcodeJournalSource implements DurableSource<JcodeJournalRecord> {
  readonly kind = "jcode-session-journal";
  private readonly file: JsonlFileSource<JcodeJournalRecord>;

  constructor(
    readonly path: string,
    private readonly waitMs = JOURNAL_WAIT_MS,
  ) {
    this.file = new JsonlFileSource<JcodeJournalRecord>(path);
  }

  async read(cursor: string | undefined): Promise<SourceRead<JcodeJournalRecord>> {
    if (cursor !== undefined) {
      try {
        return await this.file.read(cursor);
      } catch (error) {
        // A malformed cursor, invalid complete record or access refusal is not a checkpoint.
        if (!isMissing(error) && !(error instanceof JsonlFileResetError)) throw error;
        const fresh = await this.foldedSince();
        if (fresh === undefined) throw error;
        if (fresh === null) {
          // A checkpoint can remove the journal until a long tool finishes. Keep the previous
          // cursor while marking the gap, then read the new file from its first complete record.
          return { cursor, records: [{ cursor, value: { journal_fold: {} } }] };
        }
        return {
          cursor: fresh.fresh.cursor,
          records: [
            { cursor: fresh.beginning, value: { journal_fold: {} } },
            ...fresh.fresh.records,
          ],
        };
      }
    }
    const deadline = performance.now() + this.waitMs;
    let retryMs = RETRY_INITIAL_MS;
    for (;;) {
      try {
        await access(this.path, constants.R_OK);
        return await this.file.readFromBeginning();
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

  private async hasSessionSnapshot(): Promise<boolean> {
    const sessionId = basename(this.path, ".journal.jsonl");
    const snapshot = join(dirname(this.path), `${sessionId}.json`);
    try {
      const file = await open(snapshot, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        if (!(await file.stat()).isFile()) throw new Error("Jcode AG-UI source: session snapshot is not a regular file");
        const parsed: unknown = JSON.parse(await file.readFile("utf8"));
        if (parsed === null || typeof parsed !== "object" ||
            (parsed as { id?: unknown }).id !== sessionId || !Array.isArray((parsed as { messages?: unknown }).messages))
          throw new Error("Jcode AG-UI source: checkpoint snapshot does not identify this session");
        return true;
      } finally {
        await file.close();
      }
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  private async foldedSince(): Promise<{ beginning: string; fresh: SourceRead<JcodeJournalRecord> } | null | undefined> {
    const deadline = performance.now() + this.waitMs;
    let retryMs = RETRY_INITIAL_MS;
    for (;;) {
      // Message-count growth is not a generation fence: a reader can observe the new snapshot
      // before the old journal is unlinked. Bind to the actual session, and report any lost prefix.
      if (await this.hasSessionSnapshot()) {
        try {
          const beginning = await this.file.cursorAtBeginning();
          const fresh = await this.file.read(beginning);
          return { beginning, fresh };
        } catch (error) {
          if (!isMissing(error) && !(error instanceof JsonlFileResetError)) throw error;
          return null;
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
