import { CommandFailure } from "@cotal-ai/workspace";

/** A usage refusal for the flags a run that asks nothing left out. It names each missing flag, and
 *  its remedy is the scripted form, so the dispatcher prints them without the command's help. */
export class MissingFlags extends CommandFailure {
  constructor(message: string, remedy: string, target?: unknown) {
    super("refused", "USAGE_INVALID", message, { remedy, target });
  }
}
