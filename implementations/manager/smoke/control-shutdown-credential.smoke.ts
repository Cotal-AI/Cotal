/** Manager shutdown client credential split, isolated from runtimes and the broker. */
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import type { MeshAgent } from "../../../extensions/connector-core/src/agent.js";
import { startControlServer } from "../../../extensions/connector-core/src/control.js";
import { controlEndpoint } from "../../../extensions/connector-core/src/runtime.js";
import { controlShutdown } from "../src/control-shutdown.js";
import { controlSession } from "../src/control-session.js";

const fence = { resourceId: "resource-manager-shutdown", bindingId: "binding-manager-shutdown", controllerEpoch: 11 } as const;
const rawToken = randomBytes(32).toString("base64url");
const minted = controlEndpoint("credential-split", "manager-shutdown", undefined, fence, rawToken);
const endpoint = { path: minted.path, token: minted.token, management: { token: rawToken, fence } };
const serverEndpoint = { path: minted.path, token: minted.token, managementVerifier: { tokenDigest: minted.management!.verifier.tokenDigest, fence } };
let shutdowns = 0;
let sessions = 0;
const server = startControlServer(
  {} as MeshAgent,
  serverEndpoint,
  async () => ({ handled: true }),
  { onShutdown: () => shutdowns++, onSession: () => ((sessions++), "manager-session"), authorizeManagement: () => true },
);
await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
try {
  controlShutdown(endpoint);
  for (let i = 0; i < 80 && shutdowns === 0; i++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(shutdowns, 1, "controlShutdown sends the separate management token and Binding fence");
  console.log("  ✓ controlShutdown sends the separate management token and Binding fence");

  assert.equal(await controlSession(endpoint), "manager-session", "controlSession sends the separate management token and Binding fence");
  assert.equal(sessions, 1);
  console.log("  ✓ controlSession sends the separate management token and Binding fence");

  assert.throws(
    () => controlShutdown({ path: endpoint.path }),
    /control shutdown BLOCKED: the endpoint carries no separate management credential/,
    "controlShutdown must not fall back to the hook token",
  );
  console.log("  ✓ controlShutdown fails BLOCKED instead of falling back to a hook credential");
  await assert.rejects(
    controlSession({ path: endpoint.path }),
    /control session BLOCKED: the endpoint carries no separate management credential/,
    "controlSession must not fall back to the hook token",
  );
  console.log("  ✓ controlSession fails BLOCKED instead of falling back to a hook credential");
} finally {
  server.close();
}

console.log("\nMANAGER CONTROL CLIENT CREDENTIAL TESTS PASSED ✅  (4 checks)");
