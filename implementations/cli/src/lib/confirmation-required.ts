import { inputDisabledByFlag } from "@cotal-ai/workspace";
import { shellWord } from "./endpoint-errors.js";

/** The refusal sentence for a missing `--yes` when a command cannot ask, naming what kept it from
 *  asking: `--json`, `--no-input`, `COTAL_NO_PROMPT=1`, or no interactive terminal. */
export function yesRequired(action: string, json: boolean): string {
  const reason = json ? "--json takes no prompt"
    : inputDisabledByFlag() ? "--no-input forbids the prompt"
    : process.env.COTAL_NO_PROMPT === "1" ? "COTAL_NO_PROMPT=1 forbids the prompt"
    : "there is no interactive terminal to ask in";
  return `${action} requires --yes because ${reason}`;
}

/** The command that confirms a refused service action. It names the space and keeps the instance and
 *  `--with-agents` as given, so it acts on the target the refused command picked, not on the
 *  selected space's service of that name. */
export function serviceConfirmCommand(verb: string, name: string, space: string, values: { instance?: unknown; "with-agents"?: unknown }): string {
  const instance = values.instance === undefined ? "" : ` --instance ${shellWord(String(values.instance))}`;
  return `cotal svc ${verb} ${shellWord(name)} --space ${shellWord(space)}${instance}${values["with-agents"] === true ? " --with-agents" : ""} --yes`;
}

/** The `--space`, `--server` and `--creds` a refused command was given, for the confirming command
 *  it prints: without them that command acts on the selected space instead (#7564). */
export function targetWords(values: { space?: unknown; server?: unknown; creds?: unknown }): string {
  return (["space", "server", "creds"] as const).map((name) => values[name] === undefined ? "" : ` --${name} ${shellWord(String(values[name]))}`).join("");
}
