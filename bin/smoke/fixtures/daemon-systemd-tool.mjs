// Subprocess fixture only: never invokes systemd or changes linger. Records operation names, not argv.
import { readFileSync, appendFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { basename } from "node:path";
const context = JSON.parse(readFileSync(process.env.DAEMON_UNIT_FIXTURE, "utf8"));
const args = process.argv.slice(2);
let operation;
if (basename(process.argv[1]) === "loginctl") {
  if (args[0] === "show-user") {
    operation = "linger-read";
    console.log(context.lingerFile ? readFileSync(context.lingerFile, "utf8") : "Linger=yes");
    if (context.changeDirectoryOnLingerRead) chmodSync(context.changeDirectoryOnLingerRead, 0o777);
  } else if (args[0] === "enable-linger" && context.lingerFile) {
    operation = "enable-linger";
    // Installation must already be recoverable before this persistent change is submitted.
    if (!context.publication.every((path) => existsSync(path))) process.exit(90);
    appendFileSync(context.calls, JSON.stringify({ operation }) + "\n");
    if (context.denyLinger) process.exit(1);
    writeFileSync(context.lingerFile, "Linger=yes\n");
    process.exit(0);
  } else process.exit(88);
} else if (args.includes("show-environment")) {
  operation = "directory-read";
  console.log(`HOME=${context.home}\nXDG_CONFIG_HOME=${context.config}`);
} else {
  operation = ["daemon-reload", "enable", "disable", "start", "stop"].find((op) => args.includes(op));
  if (!operation || (operation !== "daemon-reload" && !context.units.includes(args.at(-1)))) process.exit(89);
}
appendFileSync(context.calls, JSON.stringify({ operation }) + "\n");
