import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Use a private shell and native tools even when the host ignores login profiles. */
export function desktopNativeFixture(root: string) {
  const native = join(root, "native");
  assert.ok(isAbsolute(native) && !native.includes(delimiter), "the recording directory must be a single absolute PATH entry");
  mkdirSync(native, { mode: 0o700 });
  const calls = join(root, "native-calls.jsonl");
  const unit = "cotal-daemon.service";
  const config = join(root, "config");
  const context = join(root, "native-context.json");
  writeFileSync(context, JSON.stringify({ home: join(root, "home"), config, calls, units: [unit] }), { mode: 0o600 });
  const recorder = readFileSync(new URL("daemon-systemd-tool.mjs", import.meta.url), "utf8");
  for (const tool of ["systemctl", "loginctl"]) {
    writeFileSync(join(native, tool), `#!${process.execPath}\n${recorder}`, { mode: 0o700 });
  }
  const shell = join(root, "login-shell");
  writeFileSync(shell, '#!/bin/sh\n[ "$#" -eq 2 ] && [ "$1" = "-ilc" ] || exit 1\nPATH=${0%/*}/native\nexport PATH\nexec /bin/sh -c "$2"\n', { mode: 0o700 });
  const preload = join(root, "login-shell.mjs");
  writeFileSync(preload, `import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
const userInfo = os.userInfo;
os.userInfo = options => ({ ...userInfo(options), shell: ${JSON.stringify(shell)} });
syncBuiltinESMExports();
`, { mode: 0o600 });
  return {
    preload: pathToFileURL(preload).href,
    env: { PATH: native, DAEMON_UNIT_FIXTURE: context },
    unitPath: join(config, "systemd", "user", unit),
    operations: (): string[] => existsSync(calls)
      ? readFileSync(calls, "utf8").trim().split("\n").map(line => (JSON.parse(line) as { operation: string }).operation)
      : [],
  };
}
