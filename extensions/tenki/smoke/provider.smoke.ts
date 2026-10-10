import assert from "node:assert/strict";
import { registry, type EnvironmentProvisionProfile } from "@cotal-ai/core";
import { tenkiCreateOptions, tenkiObservation, openTenki } from "../src/index.js";

const profile: EnvironmentProvisionProfile = {
  name: "test", provider: "tenki", image: `workspace/agent@sha256:${"a".repeat(64)}`,
  resources: { cpus: 2, memoryMiB: 4096, diskGiB: 30 }, maxDurationMs: 300_000,
  providerOptions: { allowDomains: ["cloud.example.com"], pauseRetentionMs: 60_000, secretPolicies: ["model-requests"],
    env: { MODEL_TOKEN: "secrets://MODEL_TOKEN" }, secretFiles: [{ path: "/home/tenki/agent/key", secret: "AGENT_KEY" }] },
};
const options = tenkiCreateOptions(profile, "a".repeat(64));
assert.equal(options.image, profile.image);
assert.ok(options.name!.length <= 64, "Tenki session name fits its provisioner's 64-character bound");
assert.equal(options.allowInbound, false);
assert.equal(options.sticky, false);
assert.equal(options.waitReady, false);
assert.equal(options.env?.MODEL_TOKEN, "secrets://MODEL_TOKEN");
assert.deepEqual(options.secretFiles, [{ path: "/home/tenki/agent/key", raw: { name: "AGENT_KEY" } }]);
assert.equal(registry.has("environment-provider", "tenki"), true);
assert.equal(tenkiObservation("id", "PAUSED").state, "paused");
assert.equal(tenkiObservation("id", "USER_SHUTDOWN").state, "unknown");
assert.equal(tenkiObservation("id", "TERMINATING").state, "terminating");
assert.equal(tenkiObservation("id", "TERMINATED").state, "terminated");
for (const patch of [
  { image: "workspace/agent:latest" }, { maxDurationMs: 0 },
  { resources: { cpus: 0, memoryMiB: 4096, diskGiB: 30 } },
  { providerOptions: { allowDomains: [], pauseRetentionMs: 60_000, sticky: true } },
  { providerOptions: { allowDomains: [], pauseRetentionMs: 60_000, env: { TENKI_API_KEY: "forbidden" } } },
  { providerOptions: { allowDomains: ["*"], pauseRetentionMs: 60_000 } },
  { providerOptions: { allowDomains: [], pauseRetentionMs: 60_000, secretFiles: [{ path: "/home/tenki/../escape", secret: "KEY" }] } },
]) assert.throws(() => tenkiCreateOptions({ ...profile, ...patch }, "a".repeat(64)));
assert.equal(tenkiCreateOptions({ ...profile, providerOptions: { allowDomains: [], pauseRetentionMs: 60_000 } }, "a".repeat(64)).allowOutbound, false);
assert.throws(() => openTenki({ apiKey: "", timeoutMs: 1000 }));
console.log("PASS Tenki configuration and state mapping (inspection, no provider calls)");
