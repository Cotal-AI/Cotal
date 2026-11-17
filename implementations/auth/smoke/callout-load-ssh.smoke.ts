import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertLoopbackListener, remoteJobCommand } from "./_callout-load-ssh.js";

let checks = 0;
const port = 4242;
assert.doesNotThrow(() => assertLoopbackListener(`LISTEN 0 128 127.0.0.1:${port} 0.0.0.0:*`, port, "fixture"));
checks++;
for (const observation of [
  "", "malformed", `LISTEN 0 128 0.0.0.0:${port} 0.0.0.0:*`,
  `LISTEN 0 128 [::]:${port} [::]:*`, `LISTEN 0 128 127.0.0.1:4243 0.0.0.0:*`,
  `LISTEN 0 128 127.0.0.1:${port} 0.0.0.0:*\nLISTEN 0 128 [::]:${port} [::]:*`,
]) {
  assert.throws(() => assertLoopbackListener(observation, port, "fixture"), /unsafe SSH listener/);
  checks++;
}
const probe = `node -e 'console.log(JSON.stringify(Object.keys(process.env).sort()))'`;
const keys = JSON.parse(execFileSync("sh", ["-c", remoteJobCommand(process.cwd(), probe)], {
  encoding: "utf8",
  env: { PATH: process.env.PATH!, HOME: process.env.HOME!, COTAL_SERVERS: "synthetic", OPENAI_API_KEY: "synthetic", ANTHROPIC_API_KEY: "synthetic", NODE_OPTIONS: "--trace-warnings" },
}).trim());
assert.deepEqual(keys, ["COTAL_TELEMETRY", "DO_NOT_TRACK", "HOME", "PATH"]);
checks++;
const launchPrefix = `sh -c 'test "$LAUNCHER_TEST" = present && exec "$@"' sh`;
const launchedKeys = JSON.parse(execFileSync("sh", ["-c", remoteJobCommand(process.cwd(), probe, launchPrefix)], {
  encoding: "utf8",
  env: { PATH: process.env.PATH!, HOME: process.env.HOME!, LAUNCHER_TEST: "present", COTAL_SERVERS: "synthetic", OPENAI_API_KEY: "synthetic" },
}).trim());
assert.deepEqual(launchedKeys, ["COTAL_TELEMETRY", "DO_NOT_TRACK", "HOME", "PATH"]);
checks++;
const root = mkdtempSync(join(tmpdir(), "callout-load-env-"));
try {
  const home = join(root, "private home'quoted");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(join(home, "tmp"), { mode: 0o700 });
  const values = `node -e 'console.log(JSON.stringify({ home: process.env.HOME, tmp: process.env.TMPDIR, cotal: process.env.COTAL_HOME, temp: require("node:os").tmpdir(), keys: Object.keys(process.env).sort() }))'`;
  for (const prefix of ["", "env HOME=/synthetic-prefix-home TMPDIR=/synthetic-prefix-tmp COTAL_HOME=/synthetic-prefix-cotal"]) {
    const actual = JSON.parse(execFileSync("sh", ["-c", remoteJobCommand(root, values, prefix, home)], {
      encoding: "utf8",
      env: { PATH: process.env.PATH!, HOME: root, COTAL_CREDS: "synthetic", OPENAI_API_KEY: "synthetic", NODE_OPTIONS: "--trace-warnings" },
    }).trim());
    assert.deepEqual(actual, { home, tmp: join(home, "tmp"), cotal: home, temp: join(home, "tmp"),
      keys: ["COTAL_HOME", "COTAL_TELEMETRY", "DO_NOT_TRACK", "HOME", "PATH", "TMPDIR"] });
    checks++;
  }
  for (const home of ["relative", "", "/bad\0home"])
    { assert.throws(() => remoteJobCommand(root, probe, "", home), /absolute path without NUL/); checks++; }
  assert.throws(() => execFileSync("sh", ["-c", remoteJobCommand(root, probe, "", join(root, "absent"))], { stdio: "pipe" }));
  checks++;
  const noTmp = join(root, "missing-tmp");
  mkdirSync(noTmp, { mode: 0o700 });
  assert.throws(() => execFileSync("sh", ["-c", remoteJobCommand(root, probe, "", noTmp)], { stdio: "pipe" }));
  checks++;
  for (const [args, diagnostic] of [
    [["--load-home"], "--load-home is required"],
    [["--load-home", "relative"], "--load-home must be an absolute path"],
    [["--load-home", ""], "--load-home must be an absolute path"],
  ] as const) {
    assert.throws(() => execFileSync(process.execPath,
      [...process.execArgv, fileURLToPath(new URL("./callout-load.smoke.ts", import.meta.url)), "--scenario", "burst", ...args],
      { env: { PATH: process.env.PATH!, HOME: home, TMPDIR: join(home, "tmp"), COTAL_HOME: home }, stdio: "pipe" }),
      (error: unknown) => {
        const failure = error as { status?: number; stderr?: Buffer };
        return failure.status !== 0 && failure.stderr?.toString().includes(diagnostic) === true;
      });
    checks++;
  }
} finally { rmSync(root, { recursive: true }); }
console.log(`callout-load SSH checks: ${checks}/${checks} passed`);
