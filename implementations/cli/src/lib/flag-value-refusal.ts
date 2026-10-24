import { CommandFailure } from "@cotal-ai/workspace";

/** A usage refusal for a flag value the command checked, such as an `up --server` address it cannot
 *  serve. Its remedy gives the corrected value, so the dispatcher prints the short classified report
 *  without the command's help. */
export class FlagValueRefusal extends CommandFailure {
  constructor(message: string, remedy: string) {
    super("refused", "USAGE_INVALID", message, { remedy });
  }
}
