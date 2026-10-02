import { JsonlFileSource, type DurableSource, type SourceRead } from "@cotal-ai/connector-core";
import type { PiSessionEntry } from "./agui-map.js";

/** Pi creates the physical JSONL only when it saves the first assistant message. */
export class PiSessionSource implements DurableSource<PiSessionEntry> {
  readonly kind = "pi-native-session-jsonl";
  private readonly file: JsonlFileSource<PiSessionEntry>;
  constructor(readonly path: string) {
    this.file = new JsonlFileSource(path);
  }
  async read(cursor: string | undefined): Promise<SourceRead<PiSessionEntry>> {
    if (cursor === "pi:first-file") return this.file.readFromBeginning();
    if (cursor !== undefined) return this.file.read(cursor);
    return this.file.read(undefined);
  }
}
