import { spawnSync } from "node:child_process";
import type { ParsedArgs } from "@cotal-ai/core";

export const DETACHED_SUPERVISION_DOC_SECTION = "Supervising the detached stack";

interface SystemctlResult {
  status: number | null;
  stdout?: string | Buffer;
  error?: Error;
}

export type SystemctlRunner = (args: readonly string[]) => SystemctlResult;

interface UnitProperties {
  Id?: string;
  InvocationID?: string;
  Type?: string;
  RemainAfterExit?: string;
  MainPID?: string;
}

function unitRecords(stdout: string): UnitProperties[] {
  return stdout
    .split(/\n\s*\n/)
    .map((block) => Object.fromEntries(
      block
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const equals = line.indexOf("=");
          return equals < 0 ? [line, ""] : [line.slice(0, equals), line.slice(equals + 1)];
        }),
    ) as UnitProperties)
    .filter((record) => Object.keys(record).length > 0);
}

const realSystemctl: SystemctlRunner = (args) => {
  const result = spawnSync("systemctl", [...args], {
    encoding: "utf8",
    timeout: 1_500,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    error: result.error,
  };
};

function invocationUnit(invocationId: string, runner: SystemctlRunner): UnitProperties | undefined {
  for (const scope of [[], ["--user"]] as const) {
    const result = runner([
      ...scope,
      "show",
      "*",
      "--property=Id",
      "--property=InvocationID",
      "--property=Type",
      "--property=RemainAfterExit",
      "--property=MainPID",
    ]);
    if (result.error || result.status !== 0) continue;
    const stdout = typeof result.stdout === "string" ? result.stdout : result.stdout?.toString("utf8") ?? "";
    const unit = unitRecords(stdout).find((record) => record.InvocationID === invocationId);
    if (unit) return unit;
  }
  return undefined;
}

/**
 * Warn when background up is the current main process of a systemd service. The native
 * invocation and main PID must both match; inherited terminal/scope metadata is not ownership.
 * Inspection failure leaves this advisory unavailable and never changes startup or a unit.
 */
export function detachedSystemdSupervisionWarning(
  env: NodeJS.ProcessEnv = process.env,
  runner: SystemctlRunner = realSystemctl,
  pid: number = process.pid,
): string | undefined {
  const invocationId = env.INVOCATION_ID?.trim();
  if (!invocationId || !/^[0-9a-f]{32}$/i.test(invocationId) || !Number.isSafeInteger(pid) || pid <= 0) return undefined;

  const unit = invocationUnit(invocationId, runner);
  if (!unit?.Id || !/^[-A-Za-z0-9_.@:]+[.]service$/.test(unit.Id) || !unit.MainPID || !/^[1-9][0-9]*$/.test(unit.MainPID) || Number(unit.MainPID) !== pid) return undefined;

  const shape = unit.Type === "oneshot" && unit.RemainAfterExit === "yes" ? " is Type=oneshot with RemainAfterExit=yes and" : "";
  return `! systemd unit ${unit.Id}${shape} tracks this background launcher; its exit is not a stack-liveness receipt. Use cotal up --foreground when this unit must own the native stack lifetime. See "${DETACHED_SUPERVISION_DOC_SECTION}" in docs/run-a-mesh.md.`;
}

/**
 * The public `up` command's advisory: every background run, a refresh of a running stack included.
 * A foreground run already holds the unit's lifetime, a dry run starts nothing and manifest boot
 * has no foreground form to name.
 */
export function upSystemdSupervisionWarning(
  values: ParsedArgs["values"],
  env: NodeJS.ProcessEnv = process.env,
  runner: SystemctlRunner = realSystemctl,
  pid: number = process.pid,
): string | undefined {
  if (values.foreground === true || values["dry-run"] === true || values.file !== undefined) return undefined;
  return detachedSystemdSupervisionWarning(env, runner, pid);
}
