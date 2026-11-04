import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
console.log(`callout-load SSH checks: ${checks}/${checks} passed`);
