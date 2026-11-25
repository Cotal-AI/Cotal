import { existsSync } from "node:fs";
import { JsonlFileSource, type OrderedSource, type SourceRead } from "@cotal-ai/connector-core";
import type { PiSessionEntry } from "./agui-map.js";

/** The cursor at the beginning of the file a fresh session will write. */
const FIRST_FILE = "pi:first-file";

/** Pi creates the physical JSONL only when it saves the first assistant message. */
export class PiSessionSource implements OrderedSource<PiSessionEntry> {
  readonly kind = "pi-native-session-jsonl";
  private readonly file: JsonlFileSource<PiSessionEntry>;
  constructor(readonly path: string) {
    this.file = new JsonlFileSource(path);
  }
  /** A fresh session's first reply streams before Pi creates the file, so its beginning reads as
   *  empty until then. */
  async read(cursor: string | undefined): Promise<SourceRead<PiSessionEntry>> {
    if (cursor === FIRST_FILE) return existsSync(this.path) ? this.file.readFromBeginning() : { records: [], cursor };
    if (cursor !== undefined) return this.file.read(cursor);
    return this.file.read(undefined);
  }
  end(): Promise<string> {
    return this.file.end();
  }
  /** The position a delta is journaled at: the file's end, or its beginning before Pi created it. */
  anchor(): string {
    return existsSync(this.path) ? this.file.endSync() : FIRST_FILE;
  }
  compare(a: string, b: string): number {
    if (a !== FIRST_FILE && b !== FIRST_FILE) return this.file.compare(a, b);
    return (a === FIRST_FILE ? 0 : JsonlFileSource.offsetOf(a)) - (b === FIRST_FILE ? 0 : JsonlFileSource.offsetOf(b));
  }
}
