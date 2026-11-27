import { nativeRun } from "./install-native-run.js";

/** Read the attribute as bytes in hex. An observation error is not proof of absence. */
export function readRuntimeQuarantine(path: string): string | undefined {
  const tool = "/usr/bin/xattr", name = "com.apple.quarantine";
  const listed = nativeRun(tool, [path], undefined, 5000);
  if (listed.status !== 0) throw new Error("could not inspect macOS PTY runtime quarantine");
  if (!listed.stdout.split(/\r?\n/).includes(name)) return undefined;
  const value = nativeRun(tool, ["-px", name, path], undefined, 5000);
  if (value.status !== 0) throw new Error("could not read macOS PTY runtime quarantine");
  return value.stdout.replace(/\s/g, "");
}

/** Copy into unpublished staging with the source's quarantine and signed bytes intact. */
export function copyQuarantinedRuntimeNode(source: string, destination: string): void {
  const result = nativeRun("/usr/bin/ditto", ["--extattr", "--qtn", source, destination], undefined, 45_000);
  if (result.status !== 0) throw new Error("could not retain the quarantined macOS PTY host Node");
}
