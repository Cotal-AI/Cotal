import { CommandFailure } from "@cotal-ai/workspace";

/** A usage refusal for a missing `--yes` outside an interactive terminal. Its remedy is the whole
 *  fix, so the dispatcher prints its line and remedy without the command's help. It keeps that
 *  only while its target names a space, which `inOperationSpace` passes through unchanged. */
export class ConfirmationRequired extends CommandFailure {
  constructor(message: string, opts: { remedy: string; target: { space: string } & Record<string, unknown> }) {
    super("refused", "USAGE_INVALID", message, opts);
  }
}
