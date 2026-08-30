import assert from "node:assert/strict";
import { claudeConnector } from "../src/extension.js";
import { claudeSetupProvider } from "../src/setup.js";

assert.deepEqual(claudeConnector.setup, { kind: "connector-setup", name: "claude" }, "Claude connector declares its provider ref");
assert.equal(claudeSetupProvider.kind, "connector-setup", "Claude setup provider uses the declared registry kind");
console.log("setup-provider.smoke: 2 checks passed");
