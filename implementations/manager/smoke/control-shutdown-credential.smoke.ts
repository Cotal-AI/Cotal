/** Manager shutdown client credential split, isolated from runtimes and the broker. */
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import type { MeshAgent } from "../../../extensions/connector-core/src/agent.js";
import { startControlServer } from "../../../extensions/connector-core/src/control.js";
import { controlEndpoint } from "../../../extensions/connector-core/src/runtime.js";
import { controlShutdown } from "../src/control-shutdown.js";

const binding = { bindingId: "binding-manager-shutdown", controllerEpoch: 11 } as const;
const endpoint = {
  ...controlEndpoint("credential-split", "manager-shutdown"),
  management: { token: randomBytes(32).toString("base64url"), binding },
};
let shutdowns = 0;
const server = startControlServer(
  {} as MeshAgent,
  endpoint,
  async () => ({ handled: true }),
  { onShutdown: () => shutdowns++, authorizeManagement: () => true },
);
await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
try {
  controlShutdown(endpoint);
  for (let i = 0; i < 80 && shutdowns === 0; i++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(shutdowns, 1, "controlShutdown sends the separate management token and Binding fence");
  console.log("  ✓ controlShutdown sends the separate management token and Binding fence");

  assert.throws(
    () => controlShutdown({ path: endpoint.path }),
    /control shutdown BLOCKED: the endpoint carries no separate management credential/,
    "controlShutdown must not fall back to the hook token",
  );
  console.log("  ✓ controlShutdown fails BLOCKED instead of falling back to a hook credential");
} finally {
  server.close();
}

console.log("\nMANAGER CONTROL SHUTDOWN CREDENTIAL TESTS PASSED ✅  (2 checks)");
