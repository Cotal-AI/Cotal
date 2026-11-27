// Subprocess fixture only: answers the account profile reads a default install makes on Windows.
// It never reads the real profile or registry. The profile path comes from the fixture file.
import { readFileSync } from "node:fs";
const context = JSON.parse(readFileSync(process.env.DAEMON_UNIT_FIXTURE, "utf8"));
const args = process.argv.slice(2);
const file = process.argv[1].replaceAll("\\", "/").toLowerCase();
const tool = file.endsWith(".mjs") ? file.slice(0, -4) : file;
if (tool.endsWith("/whoami") || tool.endsWith("/whoami.exe")) {
  process.stdout.write(`"host\\user","${context.sid}"\r\n`);
} else if ((tool.endsWith("/reg") || tool.endsWith("/reg.exe")) && args[0] === "query" && args.includes("ProfileImagePath")) {
  process.stdout.write(`\r\n    ProfileImagePath    REG_SZ    ${context.profile}\r\n`);
} else if ((tool.endsWith("/reg") || tool.endsWith("/reg.exe")) && args[0] === "query" && args[1] === "HKCU\\Environment") {
  const name = args[args.indexOf("/v") + 1];
  const value = context.accountEnv?.[name];
  if (value === undefined) process.exit(1);
  process.stdout.write(`\r\n    ${name}    REG_SZ    ${value}\r\n`);
} else process.exit(87);
