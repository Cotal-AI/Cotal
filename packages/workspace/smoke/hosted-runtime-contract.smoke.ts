import { strict as assert } from "node:assert";
import {
  sameSecretStoreIdentity,
  type SecretStore,
} from "@cotal-ai/core";
import {
  type HostedContextInputs,
  type HostedServiceHandle,
  type HostedServiceState,
} from "../src/index.js";

const store: SecretStore = {
  identity: { kind: "injected", coordinate: "test-assigned-space" },
  get: async () => undefined,
  put: async () => {},
  delete: async () => {},
};
const context: HostedContextInputs = {
  context: { accountPublicKey: "ADUMMY", lifecycleUid: "fixture-uid" },
  space: "fixture",
  servers: "nats://127.0.0.1:1",
  store,
  storeIdentity: { kind: "injected", coordinate: "test-assigned-space" },
  stateDir: "fixture-state",
};
let stopped = false;
const handle: HostedServiceHandle = {
  readiness(): HostedServiceState {
    return stopped
      ? { state: "unavailable", context: context.context, cause: "closed" }
      : { state: "ready", context: context.context };
  },
  async drain() { stopped = true; },
  async close() { stopped = true; },
};

assert(sameSecretStoreIdentity(context.storeIdentity, store.identity!));
assert(!sameSecretStoreIdentity(context.storeIdentity, { kind: "injected", coordinate: "foreign" }));
assert.equal((await handle.readiness()).state, "ready");
await handle.drain();
assert.deepEqual(await handle.readiness(), { state: "unavailable", context: context.context, cause: "closed" });
await handle.close();
console.log("hosted runtime type surface and identity controls: 4 assertions passed");
