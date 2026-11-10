/** Scheduled-task entry marks its native launch before loading the ordinary CLI. */
import { fileURLToPath } from "node:url";
if (process.argv[2] !== "daemon" || process.argv[3] !== "serve") throw new Error("the native daemon entry accepts only daemon serve");
process.env.COTAL_DAEMON_NATIVE_SERVICE = "1";
const entry = new URL("./cotal.js", import.meta.url);
process.argv[1] = fileURLToPath(entry);
await import(entry.href);
