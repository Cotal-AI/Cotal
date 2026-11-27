import assert from "node:assert/strict";
import { commitPlugin, registry, stagePlugin } from "@cotal-ai/core";
import registerClaude, { claudeConnector, claudeSetupProvider } from "../src/index.js";

assert.deepEqual(claudeConnector.setup, { kind: "connector-setup", name: "claude" }, "Claude connector declares its provider ref");
assert.equal(claudeSetupProvider.kind, "connector-setup", "Claude setup provider uses the declared registry kind");
assert(!registry.has("connector", "claude") && !registry.has("connector-setup", "claude"), "import leaves both providers unregistered");
const scope = commitPlugin(registry, await stagePlugin(registry, registerClaude));
assert.equal(registry.resolve("connector", "claude"), claudeConnector);
assert.equal(registry.resolve("connector-setup", "claude"), claudeSetupProvider);
scope.dispose();
assert(!registry.has("connector", "claude") && !registry.has("connector-setup", "claude"), "disposal removes both providers");
console.log("setup-provider.smoke: 6 checks passed");
