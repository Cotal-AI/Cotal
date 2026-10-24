import { CommandFailure } from "@cotal-ai/workspace";

/** A usage refusal for a file the command was given but cannot use, such as a directory or text
 *  that is not UTF-8. It names the path and the reason. The flag itself was given correctly, so the
 *  dispatcher reports it as it reports a file that does not exist, without the command's help. It
 *  keeps that only while its target names a space or names none in a run that resolved no space,
 *  because `inOperationSpace` passes such a target through unchanged. */
export class UnusableFile extends CommandFailure {
  constructor(message: string, target: { file: string; space?: string }, remedy?: string) {
    super("refused", "USAGE_INVALID", message, { target, ...(remedy ? { remedy } : {}) });
  }
}
