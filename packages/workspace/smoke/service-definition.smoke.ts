import assert from "node:assert/strict";
import { isAbsolute, resolve } from "node:path";
import { MAX_SERVICE_DEFINITION_BYTES, parseServiceDefinitionInput, serviceDefinitionName } from "../src/service-definition.js";

const cwd = resolve(".");
const base = { schemaVersion: 1, space: "service-test", launch: { type: "process", executable: "node", args: ["-e", "0"], cwd }, readiness: { type: "process", timeoutMs: 1000 } };
const adapter = { ...base, launch: { type: "adapter", adapter: "com.example.test", options: {} }, readiness: { type: "adapter", timeoutMs: 1000 } };
const http = { type: "http", url: "http://127.0.0.1:7788/health", expectedStatus: 200, timeoutMs: 1000 };
let passed = 0;
function accepts(name: string, value: unknown): void {
  assert.deepEqual(parseServiceDefinitionInput(JSON.stringify(value), base.space), value, name);
  console.log(`  ✓ ${name}`); passed++;
}
function refuses(name: string, value: unknown): void {
  assert.throws(() => parseServiceDefinitionInput(JSON.stringify(value), base.space), /^Error: service definition:/, name);
  console.log(`  ✓ ${name}`); passed++;
}
accepts("process input is returned without changing argv", base);
accepts("adapter input is parsed without resolving or importing the adapter", adapter);
accepts("literal IPv4 loopback HTTP input", { ...base, readiness: http });
accepts("literal IPv6 loopback HTTP input", { ...base, readiness: { ...http, url: "http://[::1]:7788/health" } });
accepts("default HTTP port with an explicit path", { ...base, readiness: { ...http, url: "http://127.0.0.1/" } });
accepts("explicit environment references are names, not resolved values", { ...base, envRefs: { INPUT: "SELECTED_INPUT" } });
accepts("an absolute credential reference is parsed without opening it", { ...base, credentialRef: { kind: "file", path: resolve("not-opened") } });
for (const [name, value] of [
  ["unknown root property", { ...base, secretUnknownField: true }],
  ["unknown launch property", { ...base, launch: { ...base.launch, extra: true } }],
  ["wrong schema version", { ...base, schemaVersion: 2 }],
  ["empty space", { ...base, space: "" }],
  ["selected-space disagreement", { ...base, space: "different" }],
  ["empty executable", { ...base, launch: { ...base.launch, executable: "" } }],
  ["NUL executable", { ...base, launch: { ...base.launch, executable: "node\0" } }],
  ["NUL argument", { ...base, launch: { ...base.launch, args: ["x\0"] } }],
  ["relative process cwd", { ...base, launch: { ...base.launch, cwd: "relative" } }],
  ["too many arguments", { ...base, launch: { ...base.launch, args: Array(257).fill("arg") } }],
  ["oversized argument", { ...base, launch: { ...base.launch, args: ["a".repeat(8193)] } }],
  ["process with adapter readiness", { ...base, readiness: adapter.readiness }],
  ["adapter with process readiness", { ...adapter, readiness: base.readiness }],
  ["adapter with HTTP readiness", { ...adapter, readiness: http }],
  ["zero timeout", { ...base, readiness: { ...base.readiness, timeoutMs: 0 } }],
  ["oversized timeout", { ...base, readiness: { ...base.readiness, timeoutMs: 120001 } }],
  ["protected child environment name", { ...base, envRefs: { COTAL_HOME: "INPUT" } }],
  ["protected selected environment name", { ...base, envRefs: { INPUT: "CLAUDECODE" } }],
  ["too many environment references", { ...base, envRefs: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`X${i}`, "INPUT"])) }],
  ["remote HTTP readiness", { ...base, readiness: { ...http, url: "http://example.test/health" } }],
  ["HTTP URL requires an explicit path", { ...base, readiness: { ...http, url: "http://127.0.0.1" } }],
  ["invalid URL port", { ...base, readiness: { ...http, url: "http://127.0.0.1:65536/health" } }],
  ["zero URL port", { ...base, readiness: { ...http, url: "http://127.0.0.1:0/health" } }],
  ["zero-padded zero URL port", { ...base, readiness: { ...http, url: "http://127.0.0.1:00000/health" } }],
  ["URL credentials", { ...base, readiness: { ...http, url: "http://user:password@127.0.0.1/health" } }],
  ["HTTP status outside range", { ...base, readiness: { ...http, expectedStatus: 99 } }],
  ["literal credential bytes instead of a reference", { ...base, credentialRef: { kind: "inline", value: "private-value" } }],
  ["relative credential reference", { ...base, credentialRef: { kind: "file", path: "relative" } }],
  ["unknown readiness property", { ...base, readiness: { ...http, authorization: "private-value" } }],
] as const) refuses(name, value);
for (const raw of ["not json", " ".repeat(MAX_SERVICE_DEFINITION_BYTES + 1), "é".repeat(MAX_SERVICE_DEFINITION_BYTES / 2 + 1)]) {
  assert.throws(() => parseServiceDefinitionInput(raw, base.space), /^Error: service definition:/); passed++;
}
for (const space of ["", "space.dot", "space name", "../space", "x\n", "a".repeat(201)]) {
  assert.throws(() => parseServiceDefinitionInput(JSON.stringify({ ...base, space }), space), /^Error: service definition:/); passed++;
}
for (const name of ["Reviews", "reviews_1", "r".repeat(64)]) { assert.equal(serviceDefinitionName(name), name); passed++; }
for (const name of ["", "../reviews", "reviews.test", "-reviews", "r".repeat(65), "reviews\n"]) {
  assert.throws(() => serviceDefinitionName(name), /^Error: service definition:/); passed++;
}
assert.ok(isAbsolute(cwd));
const secret = "do-not-print-this-input";
assert.throws(() => parseServiceDefinitionInput(JSON.stringify({ ...base, [secret]: true }), base.space), (error: unknown) => error instanceof Error && !error.message.includes(secret)); passed++;
console.log(`service-definition input smoke: ${passed} checks passed`);
