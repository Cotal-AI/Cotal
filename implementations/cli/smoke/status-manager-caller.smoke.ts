import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Source lock: user-mode manager health must use the spawn control call. Publishing
// with the login bearer is what the broker refuses, and the view's reply grant is the
// issued rail of the connection that minted it.

test("user-mode manager status uses the spawn control call, not the login bearer", () => {
  const status = readFileSync(new URL("../src/commands/status.ts", import.meta.url), "utf8");
  assert.match(status, /async function userManagerStatus\(/);
  assert.match(status, /resolveControlTarget\(/);
  assert.match(status, /"control-caller-privileged"/);
  assert.match(status, /"managerStatus"/);
  assert.match(status, /control\.auth/);
  assert.doesNotMatch(status, /credential\.kind === "user" \? \{ bearer: credential\.bearer/);
  assert.doesNotMatch(status, /userManagerStatusAuth/);
  assert.doesNotMatch(status, /userViewAuth\(conn, "manager-caller"\)/);
});
