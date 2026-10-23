import { CommandFailure, inputDisabledByFlag } from "@cotal-ai/workspace";

/** The refusal sentence for a missing `--yes` when a command cannot ask, naming what kept it from
 *  asking: `--json`, `--no-input`, `COTAL_NO_PROMPT=1`, or no interactive terminal. */
export function yesRequired(action: string, json: boolean): string {
  const reason = json ? "--json takes no prompt"
    : inputDisabledByFlag() ? "--no-input forbids the prompt"
    : process.env.COTAL_NO_PROMPT === "1" ? "COTAL_NO_PROMPT=1 forbids the prompt"
    : "there is no interactive terminal to ask in";
  return `${action} requires --yes because ${reason}`;
}

/** A usage refusal for a missing `--yes` outside an interactive terminal. Its remedy is the whole
 *  fix, so the dispatcher prints its line and remedy without the command's help. It keeps that
 *  only while its target names a space, which `inOperationSpace` passes through unchanged. */
export class ConfirmationRequired extends CommandFailure {
  constructor(message: string, opts: { remedy: string; target: { space: string } & Record<string, unknown> }) {
    super("refused", "USAGE_INVALID", message, opts);
  }
}
