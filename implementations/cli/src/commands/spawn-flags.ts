import { basename } from "node:path";
import { MANAGED_HANDOFF_FILE_ENV, oneLine, spawnNameError, type FlagSpec, type FlagValues } from "@cotal-ai/core";
import { codeSpan, CommandFailure, explicitNoInputFlag, jsonFlag, plainFlag, credsFlag, launchFlags, serverFlag, spaceFlag } from "@cotal-ai/workspace";
import { shellWord } from "../lib/endpoint-errors.js";
import { displayCmd } from "../lib/self-exec.js";

/** `cotal spawn`'s grammar: the application in this terminal by default, a manager's launch only
 *  with `--detach` or `--on`, and one positional persona or explicit persona file. Declared `as const` so the values cast
 *  below is compile-checked against exactly these specs. Foreground and detached parse the SAME
 *  flags — the old `spawn` vs `start` ability drift is structurally gone. */
export const spawnFlags = [
  spaceFlag,
  serverFlag,
  { ...credsFlag, description: "retained credential-file option; a raw file cannot authorize a managed launch" },
  ...launchFlags,
  { name: "harness", short: "H", type: "string", value: "<connector>", description: "application connector; an explicit flag wins over persona and saved defaults" },
  { name: "foreground", type: "boolean", description: "run the application in this terminal, as a spawn without --detach or --on does; terminal exit may end it" },
  { name: "restarts", type: "string", value: "<n>", description: "with --detach or --on: maximum manager-supervised restarts in the selected restart window" },
  { name: "restart-window", type: "string", value: "<ms>", description: "time window for --restarts; both flags are required together" },
  jsonFlag, plainFlag,
  { name: "detach", type: "boolean", short: "d", description: "launch through a manager, await readiness and return without attaching" },
  { name: "live-only", type: "boolean", description: "foreground only: skip the durable backstop (no read-ACL row; messages missed while disconnected are not replayed)" },
  { name: "expires-in", type: "string", value: "<seconds>", description: "foreground only, static mesh: end this seat's credential after this many seconds; omitted, it has no expiry and ends when the seat leaves cleanly" },
  { name: "expires-at", type: "string", value: "<unix-seconds>", description: "foreground only, static mesh: end this seat's credential at this time; never with --expires-in" },
  { name: "file", type: "string", short: "f", value: "<persona-file>", description: "persona file on the execution host; never a manifest deploy or implicit upload" },
  { name: "dry-run", type: "boolean", description: "preview the launch without allocation, provisioning or starting an application" },
  { name: "enrollment-file", type: "string", value: "<private-file>", description: "foreground only: protected file holding this one seat's enrollment URL; never print or forward it" },
  { name: "allow-stale", type: "string", value: "<a,b>", description: "refused: a manifest deployment option; use `cotal team deploy <file>`" },
  { name: "runtime", type: "string", value: "<name>", description: "terminal runtime for this one managed seat; omitted, the serving manager uses its own" },
  { name: "on", type: "string", value: "<instance>", description: "launch through this manager instance, by the id `ps` prints, and attach; with --detach, return once it joins" },
  { name: "expect-owner", type: "string", value: "<u_…>", description: `with ${MANAGED_HANDOFF_FILE_ENV}: the owner the managed handoff must carry` },
  { name: "expect-lifecycle-uid", type: "string", value: "<uid>", description: `with ${MANAGED_HANDOFF_FILE_ENV}: the lifecycle UID the managed handoff must carry` },
] as const satisfies readonly FlagSpec[];

/** Keep shell words on one line even when a kickoff prompt contains terminal control characters. */
export function retryWord(value: string): string {
  if (oneLine(value) === value) return shellWord(value);
  return `$'${[...value].map((ch) => oneLine(ch) !== ch ? `\\U${ch.codePointAt(0)!.toString(16).padStart(8, "0")}` : ch.replace(/[\\']/g, "\\$&")).join("")}'`;
}

/** Keep the selected persona and every explicit option except the manager pin being replaced. */
export function spawnRerun(values: FlagValues<typeof spawnFlags>, positionals: readonly string[]): { command: string } {
  return { command: spawnCommand(values, positionals, "cotal spawn", "--on <instance>") };
}

export function spawnModelRetry(values: FlagValues<typeof spawnFlags>, positionals: readonly string[], error: string | undefined): string | undefined {
  if (!error) return undefined;
  const fromHost = /^[^\n]+?: \[cotal-jcode\] fatal: Jcode launch failed \(model_prefix_rejected\):/.test(error);
  if (!fromHost && !error.startsWith("Jcode launch failed (model_prefix_rejected):")) return undefined;
  const [provider, explicitModel, extra] = values.model?.trim().split("/") ?? [];
  const model = fromHost || values.model === undefined
    ? error.match(/ Retry with `--model ([A-Za-z0-9][A-Za-z0-9._/:-]{0,255})`\.$/)?.[1]
    : provider && explicitModel?.trim() && extra === undefined ? explicitModel : undefined;
  if (!model) return undefined;
  return spawnCommand({ ...values, model }, positionals, `${values.json ? "cotal" : displayCmd()} spawn`,
    values.on === undefined ? undefined : `--on${values.on.startsWith("-") ? "=" : " "}${retryWord(values.on)}`);
}

function spawnCommand(values: FlagValues<typeof spawnFlags>, positionals: readonly string[], launcher: string, managerPin?: string): string {
  const words = [launcher];
  if (explicitNoInputFlag()) words.push("--no-input");
  const dashOperand = positionals.some((word) => word.startsWith("-"));
  if (!dashOperand) words.push(...positionals.map(retryWord));
  if (values.detach) words.push("-d");
  for (const flag of spawnFlags) {
    const name = flag.name;
    if (name === "on" || name === "detach") continue;
    // Managed launch normalizes the public flags to internal names as well.
    if ((name === "config" && values.file !== undefined) || (name === "agent" && values.harness !== undefined)) continue;
    const value = values[name];
    if (value === true) words.push(`--${name}`);
    for (const entry of typeof value === "string" ? [value] : Array.isArray(value) ? value : []) {
      const word = retryWord(entry);
      if (entry.startsWith("-")) words.push(`--${name}=${word}`);
      else words.push(`--${name}`, word);
    }
  }
  if (managerPin) words.push(managerPin);
  if (dashOperand) words.push("--", ...positionals.map(retryWord));
  return words.join(" ");
}

export function refuseDirectSpawnName(name: string, userMode: boolean, path: string, values: FlagValues<typeof spawnFlags>, positionals: readonly string[], target?: object): void {
  const problem = spawnNameError(name, { userMode });
  if (!problem) return;
  if (values.name !== undefined)
    throw new CommandFailure("refused", "USAGE_INVALID", problem, { target, ...(target === undefined ? { selfContained: true } : {}) });
  const stem = basename(path, ".md");
  const override = spawnNameError(stem, { userMode }) ? "persona_agent" : stem;
  const remedy = values["enrollment-file"] !== undefined ? "add --name with the actor named by the enrollment, before any -- separator, and retry"
    : `retry with ${codeSpan(spawnCommand({ ...values, name: override }, positionals, `${values.json ? "cotal" : displayCmd()} spawn`))}`;
  throw new CommandFailure("refused", "USAGE_INVALID", `the persona's frontmatter name cannot be used for launch: ${problem}`, { target, remedy, selfContained: true });
}

export function unsupportedVariantRemedy(flag: string | undefined, field: string | undefined, path: string): string {
  const removeField = `remove the \`variant:\` field from ${JSON.stringify(path)}`;
  return flag === undefined ? removeField : field ? `omit \`--variant\` and ${removeField}` : "omit `--variant`";
}
