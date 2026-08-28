/**
 * Claude's SessionStart source decides where a virgin event WAL begins reading its transcript.
 *
 * A positional startup prompt is written before SessionStart reaches the connector. Generic JSONL
 * adoption therefore parks after the only record that can open the first run, and every later
 * assistant/tool record maps to nothing. Only `source: "startup"` names a genuinely new session;
 * resume, fork, clear and compact all point at retained history and must keep ordinary adopt-at-end
 * semantics.
 */
import { JsonlFileSource, type DurableSource, type SourceRead } from "@cotal-ai/connector-core";
import type { ClaudeEntry } from "./agui-map.js";

const STARTUP_TRANSCRIPT_WAIT_MS = 5_000;
const STARTUP_TRANSCRIPT_RETRY_MS = 25;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const isMissingFile = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";

export interface ClaudeTranscriptSourceOpts {
  /** Production defaults to five seconds. Tests can shorten only the fail-loud deadline. */
  startupFileWaitMs?: number;
}

class StartupClaudeTranscriptSource implements DurableSource<ClaudeEntry> {
  constructor(
    private readonly file: JsonlFileSource<ClaudeEntry>,
    private readonly waitMs: number,
  ) {}

  get kind(): string {
    return this.file.kind;
  }

  private async readFromBeginningWhenReady(): Promise<SourceRead<ClaudeEntry>> {
    const deadline = performance.now() + this.waitMs;
    for (;;) {
      try {
        return await this.file.readFromBeginning();
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          throw new Error(
            `Claude AG-UI source: startup transcript did not appear within ${this.waitMs}ms; ` +
              `refusing to lose the first run`,
            { cause: error },
          );
        }
        await delay(Math.min(STARTUP_TRANSCRIPT_RETRY_MS, remaining));
      }
    }
  }

  read(cursor: string | undefined): Promise<SourceRead<ClaudeEntry>> {
    // A recovered WAL always wins. `undefined` is only the virgin-thread case; once any source
    // cursor was durably folded, even a process launched as `startup` resumes strictly after it.
    return cursor === undefined ? this.readFromBeginningWhenReady() : this.file.read(cursor);
  }
}

/** Build the transcript source for the exact source value Claude supplied on SessionStart. */
export function createClaudeTranscriptSource(
  path: string,
  sessionSource: unknown,
  opts: ClaudeTranscriptSourceOpts = {},
): DurableSource<ClaudeEntry> {
  const file = new JsonlFileSource<ClaudeEntry>(path);
  switch (sessionSource) {
    case "startup":
      return new StartupClaudeTranscriptSource(file, opts.startupFileWaitMs ?? STARTUP_TRANSCRIPT_WAIT_MS);
    case "resume":
    case "fork":
    case "clear":
    case "compact":
      return file;
    default:
      throw new Error(
        `Claude AG-UI source: SessionStart carried unsupported source ${JSON.stringify(sessionSource)}; ` +
          `refusing to guess whether the transcript is new or retained`,
      );
  }
}
