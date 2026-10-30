import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { epRequestObservationFilter, epRequestSubject, subjectMatches } from "@cotal-ai/core";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { servedRunRequestSubjects, servedRunCancelRequestSubject } from "../src/authority-client.js";
import { hasIssuedRailLiteral, issuedRailSourceCensus } from "./prototypes/issued-profile-census.js";

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; } catch (error) { console.error(`FAIL: ${name}`); throw error; }
}
for (const [name, source, expected] of [
  ["ordinary code", "const x = 1;", false],
  ["line comment", "// ep.v1\nconst x = 1;", false],
  ["block comment", "/* ep.v1 */ const x = 1;", false],
  ["JSDoc", "/** ep.v1 */ export function x() {}", false],
  ["single-quoted subject", "const x = 'cotal.x.ep.v1.one';", true],
  ["double-quoted subject", 'const x = "cotal.x.ep.v1.one";', true],
  ["escaped subject", 'const x = "cotal.x.ep\\u002ev1.one";', true],
  ["plain template", "const x = `cotal.x.ep.v1.one`;", true],
  ["template head", "const x = `ep.v1.${name}`;", true],
  ["template tail", "const x = `${name}.ep.v1`;", true],
  ["template middle", "const x = `${name}.ep.v1.${verb}`;", true],
  ["nested expression", "const x = `${fn('ep.v1')}`;", true],
  ["comment inside template expression", "const x = `${/* ep.v1 */ name}`;", false],
  ["comment-like string", "const x = '/* ep.v1 */';", true],
  ["slash-like string", "const x = '// ep.v1';", true],
  ["regex literal", "const x = /ep.v1/;", true],
  ["other rail", "const x = 'ep.v2';", false],
] as const) check(`literal parser: ${name}`, () => assert.equal(hasIssuedRailLiteral(source), expected));

const root = fileURLToPath(new URL("../../..", import.meta.url));
check("the full census source inventory has no outside builder", () => {
  const { files, unexpected } = issuedRailSourceCensus(root);
  assert.deepEqual(unexpected, []);
  assert.ok(files.length > 100, `only ${files.length} sources scanned`);
  assert.ok(files.some((file) => /function epRequestSubject/.test(readFileSync(file, "utf8"))));
  assert.ok(files.some((file) => file.endsWith("/bin/cotal.ts") || file.endsWith("\\bin\\cotal.ts")));
  console.log(`shipped source files checked: ${files.length}`);
});

const space = "observerproof", endpoint = "manager", command = "run-start";
const uid = "u".repeat(26), instanceId = "i".repeat(26), nonce = "n".repeat(22);
for (const issued of [false, true]) {
  const caller = { owner: "local", actor: "caller", uid, ...(issued ? { generation: "a".repeat(32) } : {}) };
  for (const route of ["one", "inst"] as const) {
    check(`observer filter tracks the real request builder: ${issued}/${route}`, () => {
      const filter = epRequestObservationFilter(space, { route, endpoint, command, issued });
      const requestRoute = route === "inst" ? { mode: "inst" as const, instanceId } : { mode: "one" as const };
      const request = { route: requestRoute, endpoint, command, caller, nonce };
      assert.ok(subjectMatches(filter, epRequestSubject(space, request)));
      assert.ok(subjectMatches(filter, epRequestSubject(space, { ...request, target: { mode: "self" } })));
      assert.equal(subjectMatches(filter, epRequestSubject(space, { ...request, command: "other" })), false);
      assert.equal(subjectMatches(filter, epRequestSubject(space, { ...request, endpoint: "other" })), false);
      assert.equal(subjectMatches(filter, epRequestSubject("other", request)), false);
      assert.equal(subjectMatches(filter, epRequestSubject(space, { ...request, route: { mode: "all" } })), false);
      const otherCaller = issued ? { owner: "local", actor: "caller", uid } : { ...caller, generation: "a".repeat(32) };
      assert.equal(subjectMatches(filter, epRequestSubject(space, { ...request, caller: otherCaller })), false);
    });
  }
}
check("observer construction refuses unsupported routes and ambiguous rails", () => {
  for (const route of ["all", "bad", undefined])
    assert.throws(() => epRequestObservationFilter(space, { route, endpoint, command, issued: true } as never));
  for (const issued of [undefined, "v1", 1])
    assert.throws(() => epRequestObservationFilter(space, { route: "one", endpoint, command, issued } as never));
  assert.throws(() => epRequestObservationFilter(space, { route: "one", endpoint, command: ">", issued: true }));
});
check("observation does not permit wildcard instance ids in actual requests", () => {
  assert.throws(() => epRequestSubject(space, { route: { mode: "inst", instanceId: "*" }, endpoint, command, caller: { owner: "local", actor: "caller", uid }, nonce }));
});
check("host run observers retain their exact command, route and rail selection", () => {
  const requests = servedRunRequestSubjects(space);
  const expected = ["run-start", "run-resume", "run-answer", "run-start-keyed", "run-submission-status"].flatMap((name) => [
    `cotal.observerproof.ep.v1.inst.manager.*.${name}.>`, `cotal.observerproof.ep.v1.one.manager.${name}.>`,
  ]);
  expected.push("cotal.observerproof.ep.inst.manager.*.run-answer.>", "cotal.observerproof.ep.one.manager.run-answer.>");
  assert.deepEqual(requests, expected);
  assert.equal(servedRunCancelRequestSubject(space), "cotal.observerproof.ep.v1.inst.manager.*.run-cancel.>");
  assert.equal(new Set(requests).size, 12);
});
check("all focused cells ran", () => assert.equal(passed, 25));
emitSentinel({ passed, failed: 0 });
