// Subprocess fixture only: never invokes systemd or changes linger. Records operation names, not argv.
import { spawnSync } from "node:child_process";
import { readFileSync, appendFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { basename } from "node:path";
const context = JSON.parse(readFileSync(process.env.DAEMON_UNIT_FIXTURE, "utf8"));
const args = process.argv.slice(2);
function rememberFileState(state) {
  context.unitFileState = state;
  writeFileSync(process.env.DAEMON_UNIT_FIXTURE, `${JSON.stringify(context)}\n`);
}
function changeDuringLinger(phase) {
  if (context.changeSourceDuringLinger === phase) writeFileSync(context.publication[0], "changed unit\n");
  if (context.changeDirectoryDuringLinger === phase) chmodSync(context.config, 0o777);
}
let operation;
if (basename(process.argv[1]) === "loginctl") {
  if (args[0] === "show-user") {
    operation = "linger-read";
    console.log(context.lingerFile ? readFileSync(context.lingerFile, "utf8") : "Linger=yes");
    if (context.changeDirectoryOnLingerRead) chmodSync(context.changeDirectoryOnLingerRead, 0o777);
    if (context.lingerFile && readFileSync(context.lingerFile, "utf8") === "Linger=yes\n") changeDuringLinger("read");
  } else if (args[0] === "enable-linger" && context.lingerFile) {
    operation = "enable-linger";
    // Installation must already be recoverable before this persistent change is submitted.
    if (!context.publication.every((path) => existsSync(path))) process.exit(90);
    appendFileSync(context.calls, JSON.stringify({ operation }) + "\n");
    if (context.denyLinger) process.exit(1);
    writeFileSync(context.lingerFile, "Linger=yes\n");
    changeDuringLinger("enable");
    process.exit(0);
  } else process.exit(88);
} else if (args.includes("show-environment")) {
  if (context.failShowEnvironment) process.exit(1);
  operation = "directory-read";
  console.log(context.environmentOutput ?? `HOME=${context.home}\nXDG_CONFIG_HOME=${context.config}`);
} else if (args.includes("show")) {
  const unit = args[args.indexOf("show") + 1];
  if (unit === "*") {
    operation = "all-units-read";
    appendFileSync(context.calls, JSON.stringify({ operation }) + "\n");
    if (context.failAllUnitsShow) process.exit(1);
    if (typeof context.allUnitsOutput === "string") {
      console.log(context.allUnitsOutput);
      process.exit(0);
    }
    const rows = context.units.map((u) => `Id=${u}\nNeedDaemonReload=${context.needDaemonReload ?? "no"}`);
    rows.push(`Id=other-user.service\nNeedDaemonReload=${context.otherUnitNeedDaemonReload ?? "no"}`);
    console.log(rows.join("\n\n"));
    process.exit(0);
  }
  operation = "unit-read";
  if (!context.units.includes(unit)) process.exit(89);
  const fields = {
    Id: unit,
    LoadState: "loaded",
    FragmentPath: `${context.config}/systemd/user/${unit}`,
    DropInPaths: context.dropInPaths ?? "",
    NeedDaemonReload: context.needDaemonReload ?? "no",
    OOMPolicy: context.oomPolicy ?? "stop",
    UnitFileState: context.unitFileState ?? (context.denyLinger ? "disabled" : "enabled"),
  };
  const requested = args.filter((arg) => arg.startsWith("--property=")).map((arg) => arg.slice(11));
  if (args.includes("--value") && requested.length === 1 && requested[0] === "UnitFileState") operation = "autostart-read";
  if (args.includes("--value") && requested.length === 1 && requested[0] in fields) console.log(fields[requested[0]]);
  else if (requested.length) { for (const key of requested) if (key in fields) console.log(`${key}=${fields[key]}`); }
  else console.log(`Id=${unit}\nLoadState=loaded\nFragmentPath=${fields.FragmentPath}\nDropInPaths=${fields.DropInPaths}\nNeedDaemonReload=${fields.NeedDaemonReload}`);
} else {
  operation = ["daemon-reload", "enable", "disable", "start", "stop"].find((op) => args.includes(op));
  if (!operation || (operation !== "daemon-reload" && !context.units.includes(args.at(-1)))) process.exit(89);
  if (operation === "daemon-reload" && context.failDaemonReload) {
    appendFileSync(context.calls, JSON.stringify({ operation }) + "\n");
    process.exit(1);
  }
  if (operation === "enable" || operation === "disable") rememberFileState(operation === "enable" ? "enabled" : "disabled");
  if (operation === "stop" && context.changeSourceDuringStop) appendFileSync(context.changeSourceDuringStop, "\n# changed during stop\n");
  if (operation === "start" && context.nativeEntry) {
    spawnSync(process.execPath, [context.nativeEntry, "daemon", "serve"], {
      cwd: context.home,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))), HOME: context.home, COTAL_HOME: context.cotal, XDG_CONFIG_HOME: context.config, XDG_RUNTIME_DIR: context.rt, DO_NOT_TRACK: "1" },
      stdio: "ignore",
      timeout: 10_000,
    });
  }
}
appendFileSync(context.calls, JSON.stringify({ operation }) + "\n");
