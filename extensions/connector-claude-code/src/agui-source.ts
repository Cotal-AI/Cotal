/**
 * Claude's SessionStart source decides where a virgin event WAL begins reading its transcript.
 *
 * A positional startup prompt is written before SessionStart reaches the connector. Generic JSONL
 * adoption therefore parks after the only record that can open the first run, and every later
 * assistant/tool record maps to nothing. Only `source: "startup"` names a genuinely new session;
 * resume, fork, clear and compact all point at retained history and must keep ordinary adopt-at-end
 * semantics.
 *
 * A forked session (`--resume <id> --fork-session`) is retained history in a NEW file: Claude
 * copies the parent transcript under the fork's own session id after its SessionStart hook has
 * fired. Measured live with a manager-launched seat, the connector's first flush reached the source
 * before that copy existed, `open` threw ENOENT, and the holder, terminal on its first error, took
 * the whole session dark with one stderr line the harness does not retain. So `fork` waits for the
 * real file with the same bounded wait the startup path uses, and then still adopts at the end of
 * it: the copied history is the parent's, never republished here.
 */
import { JsonlFileSource, type DurableSource, type SourceRead } from "@cotal-ai/connector-core";
import type { ClaudeEntry } from "./agui-map.js";

const STARTUP_TRANSCRIPT_WAIT_MS = 5_000;
const STARTUP_TRANSCRIPT_RETRY_INITIAL_MS = 25;
const STARTUP_TRANSCRIPT_RETRY_MAX_MS = 250;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const isMissingFile = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";

export interface ClaudeTranscriptSourceOpts {
  /** Production defaults to five seconds for both the startup and the fork wait. Tests can shorten
   *  only the fail-loud deadline. */
  startupFileWaitMs?: number;
}

class StartupTranscriptTimeout extends Error {}

export async function readStartupTranscriptWhenReady<T>(
  read: () => Promise<SourceRead<T>>,
  opts: { waitMs: number; sleep?: (ms: number) => Promise<void> },
): Promise<SourceRead<T>> {
  const sleep = opts.sleep ?? delay;
  const deadline = performance.now() + opts.waitMs;
  let retryMs = STARTUP_TRANSCRIPT_RETRY_INITIAL_MS;
  const timeout = (cause?: unknown): StartupTranscriptTimeout =>
    new StartupTranscriptTimeout(
      `Claude AG-UI source: session transcript did not appear within ${opts.waitMs}ms; ` +
        `refusing to lose the first run`,
      { cause },
    );

  for (;;) {
    const beforeRead = deadline - performance.now();
    if (beforeRead <= 0) throw timeout();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(timeout()), beforeRead);
        }),
      ]);
    } catch (error) {
      if (error instanceof StartupTranscriptTimeout) throw error;
      if (!isMissingFile(error)) throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw timeout(error);
      await sleep(Math.min(retryMs, remaining));
      retryMs = Math.min(retryMs * 2, STARTUP_TRANSCRIPT_RETRY_MAX_MS);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

class StartupClaudeTranscriptSource implements DurableSource<ClaudeEntry> {
  constructor(
    private readonly file: JsonlFileSource<ClaudeEntry>,
    private readonly waitMs: number,
    /** Where a virgin thread adopts once the file exists: byte zero for a new session, the current
     *  complete-record boundary for a fork whose file is a copy of retained history. */
    private readonly virginRead: "from-beginning" | "adopt-at-end",
  ) {}

  get kind(): string {
    return this.file.kind;
  }

  private readWhenReady(): Promise<SourceRead<ClaudeEntry>> {
    const read = this.virginRead === "from-beginning" ? () => this.file.readFromBeginning() : () => this.file.read(undefined);
    return readStartupTranscriptWhenReady(read, { waitMs: this.waitMs });
  }

  read(cursor: string | undefined): Promise<SourceRead<ClaudeEntry>> {
    // A recovered WAL always wins. `undefined` is only the virgin-thread case; once any source
    // cursor was durably folded, even a process launched as `startup` resumes strictly after it.
    return cursor === undefined ? this.readWhenReady() : this.file.read(cursor);
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
      return new StartupClaudeTranscriptSource(file, opts.startupFileWaitMs ?? STARTUP_TRANSCRIPT_WAIT_MS, "from-beginning");
    case "fork":
      return new StartupClaudeTranscriptSource(file, opts.startupFileWaitMs ?? STARTUP_TRANSCRIPT_WAIT_MS, "adopt-at-end");
    case "resume":
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
