import { createHash } from "node:crypto";
import { delimiter, isAbsolute, join } from "node:path";
import { token } from "@cotal-ai/core";
import { CommandFailure, localRecordName, serviceOperationId } from "@cotal-ai/workspace";

interface LaunchdUnitInput {
  space: string;
  definition: string;
  instanceId: string;
  controlHome: string;
  privateHome: string;
  workingDirectory: string;
  searchPath: string;
  cli: readonly string[];
}

function bounded(value: string): string {
  if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value) || [...value].some((scalar) => {
    const cp = scalar.codePointAt(0)!;
    return cp >= 0xd800 && cp <= 0xdfff || cp === 0xfffe || cp === 0xffff;
  })) throw new CommandFailure("refused", "USAGE_INVALID", "the launch agent needs bounded XML text without control or invalid Unicode characters");
  return value;
}

function absolute(value: string): string {
  if (!isAbsolute(bounded(value))) throw new CommandFailure("refused", "USAGE_INVALID", "the launch agent needs absolute executable, working, log and private-state paths");
  return value;
}

function xml(value: string): string {
  return bounded(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

/** A stable locator only; a saved receipt and unchanged source bytes must establish ownership. */
export function launchdServiceLabel(space: string, name: string, id: string): string {
  if (token(space) !== space) throw new CommandFailure("refused", "USAGE_INVALID", "the launch agent needs one exact space token");
  const definition = localRecordName(name), instanceId = serviceOperationId(id);
  const digest = createHash("sha256").update(space).update("\0").update(definition).update("\0").update(instanceId).digest("hex");
  return `ai.cotal.${digest}`;
}

/** Render a user LaunchAgent candidate. No file, native job or autostart state is changed. */
export function renderLaunchdServiceUnit(input: LaunchdUnitInput) {
  const definition = localRecordName(input.definition), instanceId = serviceOperationId(input.instanceId);
  const controlHome = absolute(input.controlHome), privateHome = absolute(input.privateHome), workingDirectory = absolute(input.workingDirectory);
  const searchPath = bounded(input.searchPath);
  if (searchPath.split(delimiter).some((entry) => !isAbsolute(entry))) throw new CommandFailure("refused", "USAGE_INVALID", "the launch agent needs an absolute pinned PATH without empty entries");
  if (input.cli.length !== 2) throw new CommandFailure("refused", "UNSUPPORTED", "the launch agent needs the durable two-token Node and CLI entry");
  const label = launchdServiceLabel(input.space, definition, instanceId);
  const argv = [...input.cli.map(absolute), "__service-unit", "--control-home", controlHome, "--space", input.space, "--definition", definition, "--instance", instanceId];
  const str = (value: string) => `<string>${xml(value)}</string>`;
  const entry = (key: string, value: string) => `<key>${key}</key>${str(value)}`;
  const bytes = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    entry("Label", label),
    `<key>ProgramArguments</key><array>${argv.map(str).join("")}</array>`,
    entry("WorkingDirectory", workingDirectory),
    '<key>EnvironmentVariables</key><dict>',
    entry("PATH", searchPath),
    entry("COTAL_HOME", controlHome),
    entry("XDG_CONFIG_HOME", join(privateHome, "config")),
    entry("COTAL_SKIP_CONNECTOR_SEED", "1"),
    "</dict>",
    entry("StandardOutPath", join(privateHome, "stdout.log")),
    entry("StandardErrorPath", join(privateHome, "stderr.log")),
    "<key>RunAtLoad</key><true/>",
    "<key>KeepAlive</key><false/>",
    "</dict></plist>",
    "",
  ].join("\n");
  if (Buffer.byteLength(bytes) > 64 * 1024) throw new CommandFailure("refused", "USAGE_INVALID", "the launch agent exceeds its bounded source size");
  return { unit: label, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}
