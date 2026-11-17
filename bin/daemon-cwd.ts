/** LaunchAgent entry: set the directory carried by its verified argv before loading the CLI. */
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const [directory, ...command] = process.argv.slice(2);
if (!directory || !isAbsolute(directory) || command[0] !== "daemon" || command[1] !== "serve") {
  throw new Error("the daemon service entry needs an absolute directory followed by daemon serve");
}
const stat = lstatSync(directory);
if (!stat.isDirectory() || stat.isSymbolicLink() || typeof process.getuid !== "function" || stat.uid !== process.getuid()) {
  throw new Error("the daemon service directory must be a real directory owned by this user");
}
process.chdir(directory);
const entry = new URL("./cotal.js", import.meta.url);
process.argv = [process.execPath, fileURLToPath(entry), ...command];
await import(entry.href);
