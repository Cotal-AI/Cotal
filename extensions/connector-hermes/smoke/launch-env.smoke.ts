/**
 * Hermes launch environment contract. The default boundary carries only named provider keys and
 * OS execution inputs. spawn.env deliberately adds one named value and does not replace required
 * provider inputs.
 *
 * Run: pnpm --filter @cotal-ai/connector-hermes test
 */
import { strict as assert } from "node:assert";
import { HERMES_PROVIDER_KEYS, hermesConnector } from "../src/extension.js";

if (process.platform === "win32") {
  console.log("✓ launch-env smoke skipped on Windows (the Hermes connector is Unix-only; buildLaunch throws)");
  process.exit(0);
}

const PER_SESSION = [
  "COTAL_LAUNCH_MATERIAL", "COTAL_CREDS", "COTAL_SERVERS", "COTAL_CONTROL_TOKEN",
  "COTAL_LIFECYCLE_UID", "COTAL_ROLE", "COTAL_EVENTS", "COTAL_CODEX_HOME",
] as const;
const UNRELATED = ["SSH_AUTH_SOCK", "GH_TOKEN", "GITHUB_TOKEN", "SOME_UNRELATED_SECRET"] as const;

for (const key of HERMES_PROVIDER_KEYS) process.env[key] = `provider-${key}`;
for (const key of PER_SESSION) process.env[key] = `parent-${key}`;
for (const key of UNRELATED) process.env[key] = `unrelated-${key}`;

const defaultEnv = hermesConnector.buildLaunch({ space: "smoke", name: "hermes-default" }).env ?? {};
for (const key of HERMES_PROVIDER_KEYS)
  assert.equal(defaultEnv[key], `provider-${key}`, `${key} is a connector-declared provider input`);
for (const key of UNRELATED)
  assert.equal(defaultEnv[key], undefined, `${key} is absent by default`);
for (const key of PER_SESSION)
  assert.equal(defaultEnv[key], undefined, `${key} cannot cross from an ambient parent session`);
assert.equal(defaultEnv.COTAL_SPACE, "smoke");
assert.equal(defaultEnv.COTAL_NAME, "hermes-default");

const optedIn = hermesConnector.buildLaunch({
  space: "smoke", name: "hermes-opt-in", envAllow: ["SSH_AUTH_SOCK"],
}).env ?? {};
assert.equal(optedIn.SSH_AUTH_SOCK, "unrelated-SSH_AUTH_SOCK", "explicit spawn.env adds SSH_AUTH_SOCK");
assert.equal(optedIn.GH_TOKEN, undefined, "explicitly adding one name does not add an unrelated one");
for (const key of HERMES_PROVIDER_KEYS)
  assert.equal(optedIn[key], `provider-${key}`, `${key} remains available after an extra-env opt-in`);

const empty = hermesConnector.buildLaunch({ space: "smoke", name: "hermes-empty", envAllow: [] }).env ?? {};
assert.equal(empty.SSH_AUTH_SOCK, undefined, "an empty spawn.env adds no ambient names");
assert.equal(empty.PATH, process.env.PATH, "the fixed OS execution allow-list remains available");

assert.throws(
  () => hermesConnector.buildLaunch({ space: "smoke", name: "hermes-prompt", prompt: "hello" }),
  /initial prompt/,
);
console.log(`launch-env smoke: ${HERMES_PROVIDER_KEYS.length} provider keys, ${UNRELATED.length} withheld defaults, explicit opt-in held`);
