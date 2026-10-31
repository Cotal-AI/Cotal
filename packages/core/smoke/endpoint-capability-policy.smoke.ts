import nodeAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { endpointCapabilitiesWithin, parseEndpointCapabilities, validateEndpointCapabilities } from "../src/endpoint-capability-policy.js";
import type { EpCapability } from "../src/endpoint-grants.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;

const space = "endpoint-policy-smoke";
const owner = "u_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const parent = { owner, actor: "parent", uid: "p".repeat(32) };
const child = { owner, actor: "child", uid: "c".repeat(32) };
const call: EpCapability = { endpoint: "org.example.orders", command: "read" };
const within = (requested: EpCapability[], ceiling: EpCapability[], samePrincipal = false) => endpointCapabilitiesWithin({
  space, child: { caller: samePrincipal ? parent : child, capabilities: requested }, parent: { caller: parent, capabilities: ceiling },
});
assert.deepEqual(parseEndpointCapabilities([call, { ...call, routes: ["one"], journal: false }]), [{ ...call, routes: ["one"] }]);
assert.equal(within([call], [call]), true);
assert.equal(within([{ ...call, routes: ["all"] }], [call]), false);
assert.equal(within([call], [{ ...call, routes: ["one", "all"] }]), true);
assert.equal(within([{ ...call, journal: true }], [call]), false);
assert.equal(within([call], [{ ...call, journal: true }]), true);
assert.equal(within([{ ...call, instanceId: "1".repeat(32), instanceOnly: true }], [{ ...call, instanceId: "1".repeat(32) }]), true);
assert.equal(within([call], [{ ...call, instanceId: "1".repeat(32), instanceOnly: true }]), false);
assert.equal(within([{ ...call, instanceId: "2".repeat(32), instanceOnly: true }], [{ ...call, instanceId: "1".repeat(32), instanceOnly: true }]), false);
assert.equal(within([{ ...call, target: { mode: "self" } }], [{ ...call, target: { mode: "self" } }]), false);
assert.equal(within([{ ...call, target: { mode: "self" } }], [{ ...call, target: { mode: "self" } }], true), true);
assert.equal(within([{ ...call, target: { mode: "owner", tOwner: owner } }], [{ ...call, target: { mode: "owner", tOwner: owner } }]), true);
assert.equal(within([{ ...call, target: { mode: "any", tOwner: owner } }], [{ ...call, target: { mode: "any", tOwner: "*" } }]), true);
assert.equal(within([{ ...call, target: { mode: "any", tOwner: "*" } }], [{ ...call, target: { mode: "any", tOwner: owner } }]), false);
assert.throws(() => parseEndpointCapabilities([{ ...call, target: { mode: "invented", tOwner: owner } }]), /unsupported standing/);
assert.throws(() => parseEndpointCapabilities([{ ...call, target: { mode: "self", tOwner: owner } }]), /no owner/);
assert.throws(() => parseEndpointCapabilities([{ ...call, target: { mode: "owner", tOwner: "*" } }]), /cannot use wildcard/);
assert.throws(() => parseEndpointCapabilities([{ ...call, target: { mode: "handle", tOwner: owner } }]), /unsupported standing/);
assert.throws(() => parseEndpointCapabilities([{ ...call, profile: "agent" }]), /unsupported field/);
assert.throws(() => parseEndpointCapabilities([{ ...call, routes: ["one", "one"] }]), /distinct/);
assert.throws(() => parseEndpointCapabilities([{ ...call, instanceOnly: true }]), /requires an instanceId/);
assert.throws(() => parseEndpointCapabilities([{ ...call, instanceOnly: true, instanceId: "1".repeat(32), routes: ["all"] }]), /cannot carry class/);
assert.throws(() => validateEndpointCapabilities(space, [{ ...call, target: { mode: "any", tOwner: "*" } }], child, { allowOperatorTargets: false }), /operator authority/);
assert.doesNotThrow(() => validateEndpointCapabilities(space, [{ ...call, target: { mode: "any", tOwner: "*" } }], child, { allowOperatorTargets: true }));
assert.throws(() => validateEndpointCapabilities(space, [{ ...call, target: { mode: "owner", tOwner: "u_bbbbbbbbbbbbbbbbbbbbbbbbbb" } }], child, { allowOperatorTargets: false }));
console.log("endpoint capability policy: route, instance, target, journal and provenance-neutral containment passed");
emitSentinel({ passed: counted.cells(), failed: 0 });
