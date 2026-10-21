import type { Command, ParsedArgs } from "@cotal-ai/core";
import { c } from "./colors.js";

/** The release that removes the deprecated daemon entries. One value for all four, recorded under
 *  "Deprecated daemon entries" in docs/UPGRADING.md. */
export const DAEMON_ENTRY_REMOVAL_RELEASE = "1.0.0";

/** Each deprecated daemon entry and the service preset that replaces it. */
export const DEPRECATED_DAEMON_PRESETS = {
  supervise: "manager",
  deliver: "delivery",
  "auth-service": "auth-service",
  "feedback-intake": "feedback-intake",
} as const;

/** The hidden twin `up` launches for each deprecated entry it still starts. A twin is the entry's own
 *  declaration and runner without the warning, so only a persisted caller sees the warning. */
export const DAEMON_ENTRY_TWINS = {
  supervise: "__daemon-manager",
  deliver: "__daemon-deliver",
  "auth-service": "__daemon-auth-service",
} as const;

/** A deprecated daemon entry, or the `deliver pending` read the `deliver` entry also carries. */
export type DeprecatedDaemonEntry = keyof typeof DEPRECATED_DAEMON_PRESETS | "deliver pending";

/** The line a deprecated daemon entry prints on every run. It names the replacement and the removal
 *  release; the entry keeps its argv, behavior and exit code. */
export function deprecatedDaemonEntryWarning(entry: DeprecatedDaemonEntry): string {
  const replacement = entry === "deliver pending"
    ? "cotal pending <agent>"
    : `cotal service add <name> --preset ${DEPRECATED_DAEMON_PRESETS[entry]} --help, then cotal service start <name>`;
  return `! cotal ${entry} is deprecated and will be removed in ${DAEMON_ENTRY_REMOVAL_RELEASE}. Use ${replacement}.`;
}

/** Print {@link deprecatedDaemonEntryWarning} to stderr, leaving stdout to the entry itself. */
export function warnDeprecatedDaemonEntry(entry: DeprecatedDaemonEntry): void {
  console.error(c.yellow(deprecatedDaemonEntryWarning(entry)));
}

/** The deprecated public entry over its hidden twin: the twin's declaration under the entry's name,
 *  with a run that warns once and then calls the twin's runner. `warning` picks the line for a mode
 *  that names its own replacement, such as `deliver pending`. */
export function deprecatedDaemonEntry(
  entry: keyof typeof DAEMON_ENTRY_TWINS,
  twin: Command,
  warning: (args: ParsedArgs) => DeprecatedDaemonEntry = () => entry,
): Command {
  return { ...twin, name: entry, run: (args) => { warnDeprecatedDaemonEntry(warning(args)); return twin.run(args); } };
}
