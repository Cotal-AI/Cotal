import { submitSystemdUnitControl, submitSystemdUnitRegistration, systemdUserUnitDirectory } from "@cotal-ai/cli";
import { checkDir, daemonRuntimeEnvironment } from "./endpoint.js";
import { nativeRun } from "./install-native-run.js";

/** The user manager must answer while the inferred runtime still passes its protection checks. */
export function daemonSystemdUnitDirectory(): string {
  const env = daemonRuntimeEnvironment();
  const directory = systemdUserUnitDirectory(env);
  if (env) checkDir(env.XDG_RUNTIME_DIR);
  return directory;
}

export function daemonSystemdRegistration(step: "reload" | "enable" | "disable", unit: string): void {
  submitSystemdUnitRegistration(step, unit, daemonRuntimeEnvironment());
}

export function daemonSystemdControl(operation: "start" | "stop", unit: string): void {
  submitSystemdUnitControl(operation, unit, daemonRuntimeEnvironment());
}

export function daemonSystemctl(args: readonly string[]) {
  return nativeRun("systemctl", args, daemonRuntimeEnvironment());
}
