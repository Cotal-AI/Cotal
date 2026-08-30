import { strict as assert } from "node:assert";
import { readFileSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { isolatedCommand, mergedCommand, privateLaunch } from "./src/driver.js";

// The tmux launcher contract is POSIX by construction: a bash script written 0o600 inside a
// 0o700 dir. On Windows those modes are a no-op and bash is not the shell; secret-at-rest
// hardening there is asserted by smoke:secret-fs (NTFS ACLs). Scope, loudly and counted, rather
// than fail on a contract the platform cannot express.
if (process.platform === "win32") {
  console.log("  \u2713 win32: tmux launcher contract is POSIX-scoped; NTFS hardening is asserted by smoke:secret-fs");
  process.exit(0);
}


let checks = 0;
const check = (name: string, condition: boolean): void => {
  assert.ok(condition, name);
  checks++;
  console.log(`  ✓ ${name}`);
};

const isolated = isolatedCommand({ FOO: "bar baz" }, "/bin/echo", ["hello world"]);
check("isolated command starts with env -i", isolated.startsWith("env -i "));
check("isolated command quotes env values and argv", isolated.includes("FOO='bar baz'") && isolated.includes("'hello world'"));
const merged = mergedCommand({ FOO: "bar" }, "/bin/echo", ["hello"]);
check("merged command keeps inherited environment", merged.startsWith("env ") && !merged.startsWith("env -i "));
assert.throws(() => isolatedCommand({ "BAD-NAME": "x" }, "/bin/echo", []), /unsafe env var name/);
checks++;
console.log("  ✓ unsafe env names are refused");

const secret = "tmux-package-test-secret";
const launch = privateLaunch(isolatedCommand({ TOKEN: secret }, "/bin/echo", []));
const launchPath = launch.replace(/^bash\s+'?|'?$/g, "");
try {
  check("private launcher command does not expose secret env", !launch.includes(secret));
  check("private launcher script is owner-only", (statSync(launchPath).mode & 0o777) === 0o600);
  check("secret is confined to the private launcher", readFileSync(launchPath, "utf8").includes(secret));
} finally {
  rmSync(dirname(launchPath), { recursive: true, force: true });
}

console.log(`TMUX PACKAGE TESTS: ${checks} tests executed`);
