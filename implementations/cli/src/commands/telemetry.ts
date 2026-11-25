import type { FlagSpec, ParsedArgs } from "@cotal-ai/core";
import {
  CommandFailure,
  effectiveTelemetry,
  jsonFlag,
  plainFlag,
  presentationOf,
  setTelemetryLevel,
  telemetrySettingsPath,
  TELEMETRY_LEVELS,
  writeResult,
  type Report,
  type TelemetryLevel,
  type TelemetrySource,
} from "@cotal-ai/workspace";
import { accountHash, telemetryUrl } from "../telemetry.js";

export const telemetryFlags = [jsonFlag, plainFlag] as const satisfies readonly FlagSpec[];

/** What `cotal telemetry` reports: the level in force, where it comes from, and the install id,
 *  which is `null` when nothing is sent. */
export interface TelemetryResult {
  readonly kind: "telemetry";
  readonly level: TelemetryLevel;
  readonly source: TelemetrySource;
  readonly installId: string | null;
  /** The account hash sent at `regular` (see docs/telemetry.mdx); `null` otherwise. */
  readonly account: string | null;
  readonly url: string | null;
  readonly file: string;
}

export function validateTelemetryArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  if (args.positionals.length > 1) throw new CommandFailure("refused", "USAGE_INVALID", "use telemetry [off|minimal|regular] [--json|--plain]");
}

/** `cotal telemetry [off|minimal|regular]`: show the level in force, or set the file's level. A level
 *  the environment forces still wins over the file, and the report says so. Under an environment
 *  opt-out the file is neither read nor created, so a level is not saved: the run is a no-op that
 *  says so. A run that creates the file changed it, even at the default level. */
export async function telemetry(args: ParsedArgs): Promise<void> {
  const presentation = presentationOf(args.values);
  const wanted = args.positionals[0] as TelemetryLevel | undefined;
  // Check the intake before the settings can be created or changed. Off does not require a valid
  // intake, even when the environment selects another level over the saved level.
  const current = effectiveTelemetry(process.env, false);
  const optedOut = current.source !== "file" && current.level === "off";
  const intakeOptional = optedOut || (wanted ?? current.level) === "off";
  let url: string | null = null;
  try {
    url = telemetryUrl();
  } catch (error) {
    if (!intakeOptional || !(error instanceof CommandFailure) || error.code !== "USAGE_INVALID") throw error;
  }
  const before = current.settings || optedOut ? current : effectiveTelemetry(process.env);
  const noOp = wanted !== undefined && (optedOut || (!before.created && before.settings?.level === wanted));
  if (wanted !== undefined && !noOp) setTelemetryLevel(wanted);
  const state = wanted === undefined || noOp ? before : effectiveTelemetry(process.env);
  const result: TelemetryResult = {
    kind: "telemetry",
    level: state.level,
    source: state.source,
    installId: state.level === "off" ? null : state.settings?.installId ?? null,
    account: state.level === "regular" ? accountHash() : null,
    url,
    file: telemetrySettingsPath(),
  };
  const warnings = optedOut && wanted !== undefined
    ? [{ code: "ENVIRONMENT_OPT_OUT", target: { file: result.file }, message: `${before.source} keeps telemetry off and the settings file untouched, so ${wanted} was not saved; unset ${before.source} to save a level` }]
    : [];
  writeResult(presentation, { command: "telemetry", target: null, result, noOp, warnings }, view);
}

const SOURCE_TEXT: Record<TelemetrySource, string> = {
  file: "settings file",
  COTAL_TELEMETRY: "COTAL_TELEMETRY in the environment",
  DO_NOT_TRACK: "DO_NOT_TRACK in the environment",
  COTAL_TELEMETRY_DISABLED: "COTAL_TELEMETRY_DISABLED in the environment",
};

function view(r: TelemetryResult): Report {
  return {
    sections: [
      {
        title: "Anonymous usage telemetry",
        blocks: [
          {
            kind: "fields",
            rows: [
              ["level", { text: r.level, tone: r.level === "off" ? "hint" : "selected" }],
              ["set by", SOURCE_TEXT[r.source]],
              ["install id", r.installId ?? { text: "none", tone: "hint" }],
              ["account", r.account ?? { text: "none", tone: "hint" }],
              ...(r.url === null ? [] : [["sent to", r.url] as [string, string]]),
              ["file", r.file],
            ],
          },
          { kind: "lines", lines: [`Levels: ${TELEMETRY_LEVELS.join(", ")}. Details: https://docs.cotal.ai/telemetry`] },
        ],
      },
    ],
  };
}
