import assert from "node:assert/strict";
import { epServeGrantRows, permissionsFor, mintLifecycleUid } from "@cotal-ai/core";
const endpoint = "test.example.shared", space = "ceilingtest", instanceId = mintLifecycleUid(), uid = mintLifecycleUid();
let count = 0;
function cell(name: string, test: () => void) { try { test(); } catch (cause) { throw new Error(name, { cause }); } count++; console.log(JSON.stringify({ cell: name, passed: true, scope: "shipped-compiler-component" })); }
const rows = epServeGrantRows(space, { endpoint, instanceId, epoch: 0, ephemeralCommands: ["increment"], routes: { kind: "instance" } });
for (const rail of ["ep", "ep.v1"]) {
  cell(`SC-serve-${rail}-increment-exact`, () => assert.ok(rows.sub.includes(`cotal.${space}.${rail}.inst.test_example_shared.${instanceId}.increment.>`)));
  cell(`SC-serve-${rail}-describe-exact`, () => assert.ok(rows.sub.includes(`cotal.${space}.${rail}.inst.test_example_shared.${instanceId}.describe.>`)));
  cell(`SC-serve-${rail}-no-class`, () => assert.ok(!rows.sub.some(row => row.includes(`.${rail}.one.`))));
  cell(`SC-serve-${rail}-no-scatter`, () => assert.ok(!rows.sub.some(row => row.includes(`.${rail}.all.`))));
}
const principal = { owner: "u_caller", actor: "cli", connId: "nativeconn", lifecycleUid: uid };
const opts = { endpointCaller: { endpoint, instanceId, capabilities: [{ endpoint, command: "increment" }] }, issued: { generation: "a".repeat(32), acceptedToken: "b".repeat(32) } };
const permissions = permissionsFor("endpoint-caller", space, principal, opts) as { pub: { allow: string[] }; sub: { allow: string[] } };
cell("SC-caller-explicit-issued-describe", () => assert.ok(permissions.pub.allow.some(row => row.includes(`.ep.v1.inst.test_example_shared.${instanceId}.describe.`))));
cell("SC-caller-explicit-issued-operation", () => assert.ok(permissions.pub.allow.some(row => row.includes(`.ep.v1.inst.test_example_shared.${instanceId}.increment.`))));
cell("SC-caller-no-class-scatter-or-legacy", () => assert.ok(!permissions.pub.allow.some(row => /\.ep\.(one|all|inst)\.|\.ep\.v1\.(one|all)\./.test(row))));
cell("SC-caller-no-manager-baseline", () => assert.ok(!permissions.pub.allow.some(row => row.includes(".manager.") || row.includes(".chat.") || row.includes(".dm."))));
cell("SC-caller-requires-issued-generation", () => assert.throws(() => permissionsFor("endpoint-caller", space, principal, { endpointCaller: opts.endpointCaller }), /issued/));
cell("SC-caller-requires-exact-instance", () => assert.throws(() => permissionsFor("endpoint-caller", space, principal, { ...opts, endpointCaller: { ...opts.endpointCaller, instanceId: "*" } }), /instanceId/));
cell("SC-caller-refuses-foreign-endpoint-capability", () => assert.throws(() => permissionsFor("endpoint-caller", space, principal, { ...opts, endpointCaller: { ...opts.endpointCaller, capabilities: [{ endpoint: "other.example.service", command: "increment" }] } }), /endpoint/));
cell("SC-caller-refuses-journal-capability", () => assert.throws(() => permissionsFor("endpoint-caller", space, principal, { ...opts, endpointCaller: { ...opts.endpointCaller, capabilities: [{ endpoint, command: "increment", journal: true }] } }), /journal/));
assert.equal(count, 16);
console.log(JSON.stringify({ assertions: count + 1, nativeAuthorityAssertions: 0, scope: "shipped-compiler-component" }));
