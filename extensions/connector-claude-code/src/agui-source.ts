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

class StartupClaudeTranscriptSource implements DurableSource<ClaudeEntry> {
  constructor(private readonly file: JsonlFileSource<ClaudeEntry>) {}

  get kind(): string {
    return this.file.kind;
  }

  read(cursor: string | undefined): Promise<SourceRead<ClaudeEntry>> {
    // A recovered WAL always wins. `undefined` is only the virgin-thread case; once any source
    // cursor was durably folded, even a process launched as `startup` resumes strictly after it.
    return cursor === undefined ? this.file.readFromBeginning() : this.file.read(cursor);
  }
}

/** Build the transcript source for the exact source value Claude supplied on SessionStart. */
export function createClaudeTranscriptSource(path: string, sessionSource: unknown): DurableSource<ClaudeEntry> {
  const file = new JsonlFileSource<ClaudeEntry>(path);
  switch (sessionSource) {
    case "startup":
      return new StartupClaudeTranscriptSource(file);
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
