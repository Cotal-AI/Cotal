import { spawnSync } from "node:child_process";

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
    ]);
    if (result.error || result.status !== 0) continue;
    const stdout = typeof result.stdout === "string" ? result.stdout : result.stdout?.toString("utf8") ?? "";
    const unit = unitRecords(stdout).find((record) => record.InvocationID === invocationId);
    if (unit) return unit;
  }
  return undefined;
}

/**
 * Warn when `up --detach` is itself the ExecStart of the systemd shape that caused #1332.
 * INVOCATION_ID makes the probe opt-in to systemd-launched processes. Failure to inspect the unit
 * is deliberately silent: this is a best-effort operator warning and never changes startup.
 */
export function detachedSystemdSupervisionWarning(
  env: NodeJS.ProcessEnv = process.env,
  runner: SystemctlRunner = realSystemctl,
): string | undefined {
  const invocationId = env.INVOCATION_ID?.trim();
  if (!invocationId) return undefined;

  const unit = invocationUnit(invocationId, runner);
  if (unit?.Type !== "oneshot" || unit.RemainAfterExit !== "yes") return undefined;

  const name = unit.Id ? ` ${unit.Id}` : "";
  return `! systemd unit${name} is Type=oneshot with RemainAfterExit=yes; it monitors only this launcher, not the detached stack. See \"${DETACHED_SUPERVISION_DOC_SECTION}\" in docs/run-a-mesh.md.`;
}
