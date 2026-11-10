/** Scheduled-task entry marks its native launch before loading the ordinary CLI. */
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
if (process.argv[2] !== "daemon" || process.argv[3] !== "serve") throw new Error("the native daemon entry accepts only daemon serve");
const { checkDir, daemonPaths, daemonPathsFor, ensureStateDir } = await import("./daemon/endpoint.js");
const { captureNativeDaemonOutput } = await import("./daemon/native-log.js");
const at = process.argv.indexOf("--daemon-home", 4);
const home = at < 0 ? undefined : process.argv[at + 1];
if (at >= 0) {
  if (!home || !isAbsolute(home)) throw new Error("the native daemon entry needs an absolute --daemon-home directory");
  checkDir(home);
}
const paths = home === undefined ? daemonPaths() : daemonPathsFor(home);
ensureStateDir(paths);
captureNativeDaemonOutput(paths.state);
process.env.COTAL_DAEMON_NATIVE_SERVICE = "1";
const entry = new URL("./cotal.js", import.meta.url);
process.argv[1] = fileURLToPath(entry);
try { await import(entry.href); }
catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
