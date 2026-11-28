import { CommandFailure } from "@cotal-ai/workspace";

/** A self-contained usage refusal that explains which flags to supply without printing command help. */
export class MissingFlags extends CommandFailure {
  constructor(message: string, remedy: string, target?: unknown) {
    super("refused", "USAGE_INVALID", message, { remedy, target, selfContained: true });
  }
}
