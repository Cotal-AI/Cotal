import { win32 } from "node:path";

// Keep OS installation roots. Each caller supplies new personal, config, cache and temp roots.
const osKeys = new Set([
  "PATH", "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "COMSPEC", "PATHEXT", "OS",
  "PROCESSOR_ARCHITECTURE", "PROCESSOR_ARCHITEW6432", "NUMBER_OF_PROCESSORS",
  "ALLUSERSPROFILE", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
  "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432", "PUBLIC",
  "LANG", "LC_ALL", "CI",
]);

export function coldOsEnvironment(source = process.env, platform = process.platform) {
  const env = Object.fromEntries(Object.entries(source).filter(([key, value]) => osKeys.has(key.toUpperCase()) && typeof value === "string"));
  if (platform === "win32") {
    const systemRoot = Object.entries(env).find(([key]) => key.toUpperCase() === "SYSTEMROOT")?.[1];
    if (!systemRoot) throw new Error("cold Windows setup requires the host SystemRoot");
    env.PSModulePath = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules");
  }
  return env;
}
