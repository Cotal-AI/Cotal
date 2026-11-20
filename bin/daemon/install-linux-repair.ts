import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { CommandFailure } from "@cotal-ai/workspace";
import { recordedSystemdArgv } from "./install-identity.js";
import type { NativeRun, UnitReceipt } from "./install.js";

/** Only a missing runtime or CLI entry makes the recorded program a repair candidate. */
export function missingSystemdProgram(source: string): boolean {
  const argv = recordedSystemdArgv(source);
  const daemon = argv.length - (argv.at(-2) === "--daemon-home" ? 4 : 2);
  if (daemon < 2 || argv[daemon] !== "daemon" || argv[daemon + 1] !== "serve" || !isAbsolute(argv[0]!) || !isAbsolute(argv[daemon - 1]!)) {
    throw new CommandFailure("refused", "CONFLICT", "the recorded daemon unit has no readable executable and entry");
  }
  let missing = false;
  for (const path of [argv[0]!, argv[daemon - 1]!]) {
    try {
      if (!statSync(path).isFile()) throw new CommandFailure("refused", "CONFLICT", "the recorded daemon program is not a file; nothing was changed");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing = true;
    }
  }
  return missing;
}

/** Verify the loaded effective command separately from the fragment's on-disk digest. */
export function observeSystemdRepairUnit(run: NativeRun, receipt: UnitReceipt, source: string, previousSource?: string): { pid: number; settled: boolean; enabled: boolean; invocation: string } {
  const unavailable = () => new CommandFailure("refused", "TARGET_UNAVAILABLE", "the recorded systemd unit's loaded definition could not be verified; nothing was changed");
  const conflict = () => new CommandFailure("refused", "CONFLICT", "the loaded systemd unit does not prove the recorded source and command; nothing was changed");
  const fields = ["Id", "LoadState", "FragmentPath", "DropInPaths", "NeedDaemonReload", "Transient", "MainPID", "ControlPID", "ActiveState", "SubState", "UnitFileState", "InvocationID", "WorkingDirectory", "Job"];
  const read = run("systemctl", ["--user", "--no-ask-password", "--no-pager", "show", receipt.unit, "--all", ...fields.map(field => `--property=${field}`)], undefined, 5000);
  if (read.status !== 0) throw unavailable();
  const values = new Map<string, string>();
  for (const line of read.stdout.split("\n").filter(Boolean)) {
    const at = line.indexOf("="), field = line.slice(0, at), value = line.slice(at + 1);
    if (at < 1 || !fields.includes(field) || values.has(field) || /[\u0000-\u001f\u007f]/u.test(value)) throw unavailable();
    values.set(field, value);
  }
  if (values.size !== fields.length) throw unavailable();
  const needsReload = values.get("NeedDaemonReload");
  if (values.get("Id") !== receipt.unit || values.get("LoadState") !== "loaded" || values.get("FragmentPath") !== receipt.unitPath || values.get("DropInPaths") !== "" || (needsReload !== "no" && !(previousSource && needsReload === "yes")) || values.get("Transient") !== "no") throw conflict();
  if (values.get("WorkingDirectory") !== "") throw conflict();
  if (values.get("Job") !== "0" && values.get("Job") !== "") throw unavailable();
  const enabled = values.get("UnitFileState");
  const pid = Number(values.get("MainPID")), invocation = values.get("InvocationID")!;
  if (!/^(0|[1-9][0-9]*)$/.test(values.get("MainPID")!) || pid > 2_147_483_647 || values.get("ControlPID") !== "0" || !/^(?:[0-9a-f]{32})?$/.test(invocation) || !["enabled", "disabled"].includes(enabled!)) throw unavailable();
  const active = values.get("ActiveState"), sub = values.get("SubState");
  const settled = pid === 0 && ((active === "inactive" && sub === "dead") || (active === "failed" && sub === "failed"));
  if (!settled && !(pid > 0 && active === "active" && sub === "running" && invocation && !/^0+$/.test(invocation)) && !(pid === 0 && active === "activating" && sub === "auto-restart")) throw unavailable();
  const object = receipt.unit.replace(/[^a-zA-Z0-9]/g, char => `_${char.charCodeAt(0).toString(16)}`);
  const exec = run("busctl", ["--user", "--no-pager", "--timeout=5s", "--json=short", "get-property", "org.freedesktop.systemd1", `/org/freedesktop/systemd1/unit/${object}`, "org.freedesktop.systemd1.Service", "ExecStartEx", "ExecStopEx", "ExecStopPostEx"], undefined, 6000);
  if (exec.status !== 0) throw unavailable();
  let properties: ({ type?: unknown; data?: unknown } | null)[];
  try { properties = exec.stdout.trim().split("\n").map(line => JSON.parse(line)); } catch { throw unavailable(); }
  if (properties.length !== 3 || properties.some(prop => prop?.type !== "a(sasasttttuii)" || !Array.isArray(prop.data))) throw unavailable();
  if (properties.slice(1).some(prop => JSON.stringify(prop?.data) !== "[]")) throw conflict();
  const value = properties[0];
  if (value?.type !== "a(sasasttttuii)" || !Array.isArray(value.data) || value.data.length !== 1 || !Array.isArray(value.data[0]) || value.data[0].length !== 10) throw unavailable();
  const [program, args, flags] = value.data[0];
  const argv = recordedSystemdArgv(source);
  const suffix = receipt.daemonHome === undefined ? ["daemon", "serve"] : ["daemon", "serve", "--daemon-home", receipt.daemonHome];
  if (JSON.stringify(argv.slice(-suffix.length)) !== JSON.stringify(suffix)) throw conflict();
  const matches = (expected: string[]) => program === expected[0] && JSON.stringify(args) === JSON.stringify(expected.map((part, i) => i ? part.replaceAll("$", "$$$$") : part));
  if (JSON.stringify(flags) !== "[]" || (!matches(argv) && !(previousSource && settled && matches(recordedSystemdArgv(previousSource))))) throw conflict();
  // Reload can replace ExecStart while retaining MainPID from an earlier command.
  if (pid > 0 && value.data[0][7] !== pid) throw conflict();
  if (needsReload !== "no" && !settled) throw conflict();
  return { pid, settled, enabled: enabled === "enabled", invocation };
}
