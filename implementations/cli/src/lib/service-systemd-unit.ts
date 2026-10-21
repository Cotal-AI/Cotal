import { createHash } from "node:crypto";
import { delimiter, isAbsolute } from "node:path";
import { token } from "@cotal-ai/core";
import { CommandFailure, localRecordName, serviceOperationId } from "@cotal-ai/workspace";

interface UnitInput {
  space: string;
  definition: string;
  instanceId: string;
  controlHome: string;
  workingDirectory: string;
  environmentFile: string;
  cli: readonly string[];
}

function bounded(value: string): string {
  if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) throw new CommandFailure("refused", "USAGE_INVALID", "the owned unit needs bounded arguments without terminal controls; no unit bytes were prepared");
  return value;
}

function path(value: string): string {
  if (!isAbsolute(bounded(value))) throw new CommandFailure("refused", "USAGE_INVALID", "the owned unit needs absolute controller, working, executable and environment paths");
  return value;
}

/** systemd unquotes a whole item, then expands specifiers and ExecStart variables. */
function unitValue(value: string, exec = false): string {
  if (exec && value === ";") return "\\;";
  const escaped = bounded(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  return `"${exec ? escaped.replaceAll("$", "$$") : escaped}"`;
}

/** A name is a locator, not ownership evidence; the receipt binds the full source bytes. */
export function systemdServiceUnitName(space: string, name: string, id: string): string {
  if (token(space) !== space) throw new CommandFailure("refused", "USAGE_INVALID", "the owned unit needs one exact space token");
  const definition = localRecordName(name), instanceId = serviceOperationId(id);
  const digest = createHash("sha256").update(space).update("\0").update(definition).update("\0").update(instanceId).digest("hex");
  return `cotal-${digest}.service`;
}

/** Render the exact direct-process entry. This prepares no file, receipt, private store or
 *  supervisor action; a caller must establish those before enabling this unit. */
export function renderSystemdServiceEnvironment(input: { controlHome: string; configHome: string; searchPath: string }) {
  const controlHome = path(input.controlHome), configHome = path(input.configHome);
  const searchPath = bounded(input.searchPath);
  if (searchPath.split(delimiter).some((entry) => !isAbsolute(entry))) throw new CommandFailure("refused", "USAGE_INVALID", "the private unit environment needs an absolute, pinned PATH; relative or empty entries were not inherited");
  const assignment = (name: string, value: string) => `${name}="${bounded(value).replace(/["\\`$]/g, "\\$&")}"`;
  const bytes = ["# cotal private service environment", assignment("PATH", searchPath), assignment("COTAL_HOME", controlHome), assignment("XDG_CONFIG_HOME", configHome), assignment("COTAL_SKIP_CONNECTOR_SEED", "1"), ""].join("\n");
  if (Buffer.byteLength(bytes) > 64 * 1024) throw new CommandFailure("refused", "USAGE_INVALID", "the private unit environment exceeds its bounded source size");
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function renderSystemdServiceUnit(input: UnitInput) {
  const definition = localRecordName(input.definition), instanceId = serviceOperationId(input.instanceId);
  const controlHome = path(input.controlHome), workingDirectory = path(input.workingDirectory);
  const environmentFile = path(input.environmentFile);
  if (input.cli.length !== 2) throw new CommandFailure("refused", "UNSUPPORTED", "the owned unit needs the durable two-token Node and CLI entry; a transient loader or extra launch flag was not pinned");
  const cli = input.cli.map((part) => path(part));
  if (cli[0]!.includes("$")) throw new CommandFailure("refused", "UNSUPPORTED", "the native executable path contains a systemd variable marker; the installer did not guess its first-token expansion");
  const unit = systemdServiceUnitName(input.space, definition, instanceId);
  const argv = [...cli, "__service-unit", "--control-home", controlHome, "--space", input.space, "--definition", definition, "--instance", instanceId];
  const bytes = [
    "[Unit]",
    "Description=Cotal managed service",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${unitValue(workingDirectory)}`,
    `EnvironmentFile=${unitValue(environmentFile)}`,
    `ExecStart=${argv.map((part) => unitValue(part, true)).join(" ")}`,
    "Restart=no",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  if (Buffer.byteLength(bytes) > 64 * 1024) throw new CommandFailure("refused", "USAGE_INVALID", "the owned unit exceeds its bounded source size");
  return { unit, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}
