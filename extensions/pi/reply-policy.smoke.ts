import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piConnector } from "./src/connector.js";
import { autoReplyEnabled, maybeDeliverAutoReply } from "./src/reply-policy.js";

assert.equal(autoReplyEnabled(undefined), true, "missing setting keeps backward-compatible automatic replies");
assert.equal(autoReplyEnabled(""), true, "empty setting keeps backward-compatible automatic replies");
assert.equal(autoReplyEnabled("true"), true, "true enables automatic replies");
assert.equal(autoReplyEnabled("false"), false, "false disables automatic replies");
assert.throws(
  () => autoReplyEnabled("False", "persona autoReply"),
  /persona autoReply must be "true" or "false"/,
  "invalid persona values fail loudly",
);

const delivered: Array<{ origin: string; text: string }> = [];
const deliver = (origin: string, text: string): void => {
  delivered.push({ origin, text });
};

assert.equal(maybeDeliverAutoReply(true, "peer-a", "hello", deliver), true);
assert.deepEqual(delivered, [{ origin: "peer-a", text: "hello" }]);

assert.equal(maybeDeliverAutoReply(false, "peer-a", ".", deliver), false);
assert.equal(maybeDeliverAutoReply(true, undefined, "hello", deliver), false);
assert.equal(maybeDeliverAutoReply(true, "peer-a", undefined, deliver), false);
assert.equal(maybeDeliverAutoReply(true, "peer-a", "", deliver), false);
assert.equal(delivered.length, 1, "disabled or incomplete replies never call the delivery callback");

const dir = mkdtempSync(join(tmpdir(), "cotal-pi-reply-policy-"));
try {
  const explicitPersona = join(dir, "explicit.md");
  writeFileSync(
    explicitPersona,
    `---\nname: explicit-peer\npeerMode: interactive\nautoReply: false\n---\nExplicit DM persona.\n`,
  );
  const explicitLaunch = piConnector.buildLaunch({
    space: "reply-policy-smoke",
    name: "explicit-peer",
    configPath: explicitPersona,
  });
  assert.equal(
    explicitLaunch.env?.PI_PEER_AUTO_REPLY,
    "false",
    "persona autoReply is forwarded into the spawned Pi process",
  );

  const defaultPersona = join(dir, "default.md");
  writeFileSync(defaultPersona, `---\nname: default-peer\npeerMode: interactive\n---\nDefault persona.\n`);
  const defaultLaunch = piConnector.buildLaunch({
    space: "reply-policy-smoke",
    name: "default-peer",
    configPath: defaultPersona,
  });
  assert.equal(
    defaultLaunch.env?.PI_PEER_AUTO_REPLY,
    undefined,
    "personas without the hint retain the backward-compatible default",
  );

  const invalidPersona = join(dir, "invalid.md");
  writeFileSync(invalidPersona, `---\nname: invalid-peer\nautoReply: sometimes\n---\nInvalid persona.\n`);
  assert.throws(
    () => piConnector.buildLaunch({
      space: "reply-policy-smoke",
      name: "invalid-peer",
      configPath: invalidPersona,
    }),
    /autoReply must be "true" or "false"/,
    "invalid persona hints fail before process launch",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("✓ Pi automatic reply policy smoke passed");
