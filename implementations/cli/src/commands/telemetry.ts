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
  /** The account hash sent at `regular` (see docs/telemetry.md); `null` otherwise. */
  readonly account: string | null;
  readonly url: string;
  readonly file: string;
}

export function validateTelemetryArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  if (args.positionals.length > 1) throw new CommandFailure("refused", "USAGE_INVALID", "use telemetry [off|minimal|regular] [--json|--plain]");
}

/** `cotal telemetry [off|minimal|regular]`: show the level in force, or set the file's level. A level
 *  the environment forces still wins over the file, and the report says so. */
export async function telemetry(args: ParsedArgs): Promise<void> {
  const presentation = presentationOf(args.values);
  const wanted = args.positionals[0] as TelemetryLevel | undefined;
  const before = effectiveTelemetry(process.env);
  const noOp = wanted !== undefined && before.settings?.level === wanted;
  if (wanted !== undefined && !noOp) setTelemetryLevel(wanted);
  const state = wanted === undefined || noOp ? before : effectiveTelemetry(process.env);
  const result: TelemetryResult = {
    kind: "telemetry",
    level: state.level,
    source: state.source,
    installId: state.level === "off" ? null : state.settings?.installId ?? null,
    account: state.level === "regular" ? accountHash() : null,
    url: telemetryUrl(),
    file: telemetrySettingsPath(),
  };
  writeResult(presentation, { command: "telemetry", target: null, result, noOp }, view);
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
              ["sent to", r.url],
              ["file", r.file],
            ],
          },
          { kind: "lines", lines: [`Levels: ${TELEMETRY_LEVELS.join(", ")}. Details: https://docs.cotal.ai/telemetry`] },
        ],
      },
    ],
  };
}
