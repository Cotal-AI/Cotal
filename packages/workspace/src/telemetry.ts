import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mkSecretDir, writeSecretFileAtomic } from "@cotal-ai/core";
import { userCotalDir } from "./mesh-registry.js";
import { CommandFailure } from "./output.js";

/**
 * The anonymous usage telemetry settings of this OS user: `telemetry.json` under
 * {@link userCotalDir}, which `COTAL_HOME` never redirects, so every workspace a person runs under
 * their own account reports one install id. The file holds the chosen level, a random install id
 * that identifies nothing but this file, and the timestamps the CLI keys its one-time notice and
 * its daily install event on. It never holds a credential.
 */

export const TELEMETRY_LEVELS = ["off", "minimal", "regular"] as const;
export type TelemetryLevel = (typeof TELEMETRY_LEVELS)[number];

export interface TelemetrySettings {
  readonly v: 1;
  readonly level: TelemetryLevel;
  /** A uuid v4 minted when the file was created. */
  readonly installId: string;
  /** When the file was created; the install event reports the days since. */
  readonly createdAt: string;
  /** When the first-run notice was printed; unset until it was. */
  readonly noticeShownAt?: string;
  /** When the last install event was sent; one per UTC day. */
  readonly lastInstallEventAt?: string;
}

/** Where the level came from: the file, or the environment variable that overrode it. */
export type TelemetrySource = "file" | "COTAL_TELEMETRY" | "DO_NOT_TRACK" | "COTAL_TELEMETRY_DISABLED";

export function telemetrySettingsPath(): string {
  return join(userCotalDir(), "telemetry.json");
}

const isLevel = (value: unknown): value is TelemetryLevel => (TELEMETRY_LEVELS as readonly unknown[]).includes(value);
const isIso = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));

function invalid(problem: string): CommandFailure {
  return new CommandFailure("refused", "SCHEMA_INVALID", `the telemetry settings file ${telemetrySettingsPath()} is invalid: ${problem}`, {
    remedy: "fix the file, or move it away and run `cotal telemetry` to create a new one",
  });
}

/** The settings as the file holds them, or `undefined` when there is no file. A file that does not
 *  validate refuses with `SCHEMA_INVALID` and is never replaced. */
function readFile(): TelemetrySettings | undefined {
  let text: string;
  try {
    text = readFileSync(telemetrySettingsPath(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw invalid(`not JSON (${(e as Error).message})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalid("not an object");
  const s = parsed as Record<string, unknown>;
  if (s.v !== 1) throw invalid("v must be 1");
  if (!isLevel(s.level)) throw invalid("level must be off, minimal or regular");
  if (typeof s.installId !== "string" || !/^[0-9a-f-]{36}$/.test(s.installId)) throw invalid("installId must be a uuid");
  if (!isIso(s.createdAt)) throw invalid("createdAt must be a date");
  if (s.noticeShownAt !== undefined && !isIso(s.noticeShownAt)) throw invalid("noticeShownAt must be a date");
  if (s.lastInstallEventAt !== undefined && !isIso(s.lastInstallEventAt)) throw invalid("lastInstallEventAt must be a date");
  for (const key of Object.keys(s)) if (!["v", "level", "installId", "createdAt", "noticeShownAt", "lastInstallEventAt"].includes(key)) throw invalid(`unknown key ${key}`);
  return s as unknown as TelemetrySettings;
}

function write(settings: TelemetrySettings): TelemetrySettings {
  mkSecretDir(userCotalDir());
  writeSecretFileAtomic(telemetrySettingsPath(), `${JSON.stringify(settings, null, 2)}\n`);
  return settings;
}

/** The settings file, created at `regular` with a fresh install id when there is none. */
export function readTelemetrySettings(): TelemetrySettings {
  return readFile() ?? write({ v: 1, level: "regular", installId: randomUUID(), createdAt: new Date().toISOString() });
}

export function setTelemetryLevel(level: TelemetryLevel): TelemetrySettings {
  return write({ ...readTelemetrySettings(), level });
}

export function markTelemetryNoticeShown(): TelemetrySettings {
  return write({ ...readTelemetrySettings(), noticeShownAt: new Date().toISOString() });
}

export function markTelemetryInstallEvent(at: Date): TelemetrySettings {
  return write({ ...readTelemetrySettings(), lastInstallEventAt: at.toISOString() });
}

const truthy = (value: string | undefined): boolean => value === "1" || value?.toLowerCase() === "true";

/** The level the environment forces, with the variable that forces it, or `undefined` when none is
 *  set. `DO_NOT_TRACK` and `COTAL_TELEMETRY_DISABLED` force `off`; `COTAL_TELEMETRY` names a level,
 *  and any other value refuses. */
export function telemetryLevelFromEnv(env: NodeJS.ProcessEnv): { level: TelemetryLevel; source: Exclude<TelemetrySource, "file"> } | undefined {
  if (truthy(env.DO_NOT_TRACK)) return { level: "off", source: "DO_NOT_TRACK" };
  if (truthy(env.COTAL_TELEMETRY_DISABLED)) return { level: "off", source: "COTAL_TELEMETRY_DISABLED" };
  const named = env.COTAL_TELEMETRY;
  if (named === undefined || named === "") return undefined;
  if (!isLevel(named)) throw new CommandFailure("refused", "USAGE_INVALID", "COTAL_TELEMETRY must be off, minimal or regular", { remedy: "unset it, or set it to one of those levels" });
  return { level: named, source: "COTAL_TELEMETRY" };
}

/** The level in force and where it comes from, with the settings file that holds the install id.
 *  The file is neither read nor created when the environment forces `off`, so a machine that opts
 *  out by environment keeps no install id. */
export function effectiveTelemetry(env: NodeJS.ProcessEnv): { level: TelemetryLevel; source: TelemetrySource; settings?: TelemetrySettings } {
  const forced = telemetryLevelFromEnv(env);
  if (forced?.level === "off") return forced;
  const settings = readTelemetrySettings();
  return forced ? { ...forced, settings } : { level: settings.level, source: "file", settings };
}
