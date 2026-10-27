import type { Command, ParsedArgs } from "@cotal-ai/core";
import { c } from "./colors.js";

/** The release that removes the deprecated daemon entries. One value for all four, recorded under
 *  "Deprecated daemon entries" in docs/UPGRADING.md. */
export const DAEMON_ENTRY_REMOVAL_RELEASE = "1.0.0";

/** Each deprecated daemon entry and the service preset that replaces it. */
export const DEPRECATED_DAEMON_PRESETS = {
  deliver: "delivery",
  "auth-service": "auth-service",
  "feedback-intake": "feedback-intake",
} as const;

/** The manager's daemon entry. A manager has its own commands, so `cotal manager start` replaces it
 *  rather than a bare preset. */
export const DEPRECATED_MANAGER_ENTRY = "supervise";

/** The `supervise` flags `cotal manager start` has no form for yet. A run that names one is told
 *  to keep `supervise` for it, not pointed at a replacement that would drop the flag. */
export const SUPERVISE_ONLY_FLAGS = ["execution", "spawn", "seat-cap", "resume-attempt", "resume-commit-token", "resume-commit-file", "resume-commit-sha256"] as const;

/** The `deliver` flags the `delivery` service preset has no form for yet: the preset starts one
 *  space's daemon, and `--spaces` serves several from one process. */
export const DELIVER_ONLY_FLAGS = ["spaces"] as const;

/** Per entry, the flags its replacement has no form for. */
const ENTRY_ONLY_FLAGS: Partial<Record<keyof typeof DEPRECATED_DAEMON_PRESETS | typeof DEPRECATED_MANAGER_ENTRY, readonly string[]>> = {
  [DEPRECATED_MANAGER_ENTRY]: SUPERVISE_ONLY_FLAGS,
  deliver: DELIVER_ONLY_FLAGS,
};

/** The hidden twin `up` launches for each deprecated entry it still starts, and the manager's daemon
 *  entry. A twin is the entry's own declaration and runner without the warning, so only a persisted
 *  caller sees the warning. */
export const DAEMON_ENTRY_TWINS = {
  deliver: "__daemon-deliver",
  "auth-service": "__daemon-auth-service",
  [DEPRECATED_MANAGER_ENTRY]: "__daemon-manager",
} as const;

/** A deprecated daemon entry, or the `deliver pending` read the `deliver` entry also carries. */
export type DeprecatedDaemonEntry = keyof typeof DEPRECATED_DAEMON_PRESETS | typeof DEPRECATED_MANAGER_ENTRY | "deliver pending";

/** The line a deprecated daemon entry prints on every run. It names the replacement and the removal
 *  release; the entry keeps its argv, behavior and exit code. `kept` names the flags of this run the
 *  replacement has no form for, so the line says to keep the entry for them instead. */
export function deprecatedDaemonEntryWarning(entry: DeprecatedDaemonEntry, kept: readonly string[] = []): string {
  if (kept.length) {
    const lacking = entry === DEPRECATED_MANAGER_ENTRY ? "cotal manager start" : entry === "deliver pending" ? "cotal pending" : `cotal service start ${DEPRECATED_DAEMON_PRESETS[entry]}`;
    return `! cotal ${entry} is deprecated and will be removed in ${DAEMON_ENTRY_REMOVAL_RELEASE}. ${lacking} has no ${kept.map((flag) => `--${flag}`).join(", ")} yet, so keep cotal ${entry} for this run until it does.`;
  }
  const replacement = entry === "deliver pending"
    ? "cotal pending <agent>"
    : entry === DEPRECATED_MANAGER_ENTRY
      ? "cotal manager start, or cotal manager start --foreground to keep it in this terminal"
      : `cotal service start ${DEPRECATED_DAEMON_PRESETS[entry]}, which names any option it needs`;
  return `! cotal ${entry} is deprecated and will be removed in ${DAEMON_ENTRY_REMOVAL_RELEASE}. Use ${replacement}.`;
}

/** The summary the entry's own help shows: marked deprecated, with its removal release and the
 *  service preset that replaces it. */
export function deprecatedDaemonEntrySummary(entry: keyof typeof DEPRECATED_DAEMON_PRESETS | typeof DEPRECATED_MANAGER_ENTRY, summary: string): string {
  const use = entry === DEPRECATED_MANAGER_ENTRY ? "cotal manager start" : `the ${DEPRECATED_DAEMON_PRESETS[entry]} service preset`;
  return `(deprecated, removed in ${DAEMON_ENTRY_REMOVAL_RELEASE}; use ${use}) ${summary}`;
}

/** Print {@link deprecatedDaemonEntryWarning} to stderr, leaving stdout to the entry itself. */
export function warnDeprecatedDaemonEntry(entry: DeprecatedDaemonEntry, kept: readonly string[] = []): void {
  console.error(c.yellow(deprecatedDaemonEntryWarning(entry, kept)));
}

/** The deprecated public entry over its hidden twin: the twin's declaration under the entry's name,
 *  with a run that warns once and then calls the twin's runner. `warning` picks the line for a mode
 *  that names its own replacement, such as `deliver pending`. */
export function deprecatedDaemonEntry(
  entry: keyof typeof DAEMON_ENTRY_TWINS,
  twin: Command,
  warning: (args: ParsedArgs) => DeprecatedDaemonEntry = () => entry,
): Command {
  return { ...twin, name: entry, summary: deprecatedDaemonEntrySummary(entry, twin.summary), run: (args) => {
    const shown = warning(args);
    // A mode with its own replacement, such as `deliver pending`, keeps nothing of the entry's.
    const kept = shown === entry ? (ENTRY_ONLY_FLAGS[entry] ?? []).filter((flag) => args.values[flag] !== undefined) : [];
    warnDeprecatedDaemonEntry(shown, kept);
    return twin.run(args);
  } };
}
