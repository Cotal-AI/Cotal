import { inputDisabledByFlag } from "@cotal-ai/workspace";

/** The refusal sentence for a missing `--yes` when a command cannot ask, naming what kept it from
 *  asking: `--json`, `--no-input`, `COTAL_NO_PROMPT=1`, or no interactive terminal. */
export function yesRequired(action: string, json: boolean): string {
  const reason = json ? "--json takes no prompt"
    : inputDisabledByFlag() ? "--no-input forbids the prompt"
    : process.env.COTAL_NO_PROMPT === "1" ? "COTAL_NO_PROMPT=1 forbids the prompt"
    : "there is no interactive terminal to ask in";
  return `${action} requires --yes because ${reason}`;
}
