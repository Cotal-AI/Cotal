// Subprocess fixture only: never invokes systemd or changes linger. Records operation names, not argv.
import { readFileSync, appendFileSync } from "node:fs";
import { basename } from "node:path";
const context = JSON.parse(readFileSync(process.env.DAEMON_UNIT_FIXTURE, "utf8"));
const args = process.argv.slice(2);
let operation;
if (basename(process.argv[1]) === "loginctl") {
  if (args[0] !== "show-user") process.exit(88);
  operation = "linger-read";
  console.log("Linger=yes");
} else if (args.includes("show-environment")) {
  operation = "directory-read";
  console.log(`HOME=${context.home}\nXDG_CONFIG_HOME=${context.config}`);
} else {
  operation = ["daemon-reload", "enable", "disable", "start", "stop"].find((op) => args.includes(op));
  if (!operation || (operation !== "daemon-reload" && !context.units.includes(args.at(-1)))) process.exit(89);
}
appendFileSync(context.calls, JSON.stringify({ operation }) + "\n");
