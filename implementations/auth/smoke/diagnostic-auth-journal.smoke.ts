import assert from "node:assert/strict";
import { DiagnosticAuthJournal } from "../../../packages/core/dist/diagnostic-auth-journal.js";
import { DiagnosticCalloutJournal } from "../src/diagnostic-callout-journal.js";
import { diagnosticAuthCorrelation } from "./_diagnostic-auth-correlation.js";

let passed = 0, failed = 0;
function check(cell: string, test: () => void) {
  try { test(); passed++; console.log(JSON.stringify({ cell, passed: true })); }
  catch { failed++; console.log(JSON.stringify({ cell, passed: false })); }
}
const challenge = "unit-private-challenge", instance = "unit-private-instance";
const rejection = new Error("unit-private-error");
const fields = { challenge, instance, server: "unit-private-server", clientId: 1, requestKey: "unit-private-request-key" };

check("DJ01-stock-auth-once-input-receiver-result", () => {
  const journal = new DiagnosticAuthJournal(), flight = journal.begin(instance);
  const receiver = {}, result = { auth_token: "unit-private-token" };
  let calls = 0;
  const stock = function(this: unknown, nonce?: string) { calls++; assert.equal(this, receiver); assert.equal(nonce, challenge); return result; };
  const observed = journal.authentication(flight, stock);
  assert.equal(Reflect.apply(observed, receiver, [challenge]), result);
  assert.equal(calls, 1);
  assert.deepEqual(journal.read().flights[0]?.challenges, [challenge]);
});
check("DJ02-stock-auth-original-thrown-reference", () => {
  const journal = new DiagnosticAuthJournal(), flight = journal.begin(instance);
  let calls = 0;
  const observed = journal.authentication(flight, () => { calls++; throw rejection; });
  assert.throws(() => observed(challenge), error => error === rejection);
  assert.equal(calls, 1);
  journal.settle(flight, "rejected", rejection);
  assert.equal(journal.read().flights[0]?.value, rejection);
});
check("DJ03-client-fixed-storage-and-sticky-overflow", () => {
  const journal = new DiagnosticAuthJournal(), first = journal.begin(instance);
  const auth = journal.authentication(first, () => undefined);
  for (let i = 0; i < 9; i++) auth(challenge);
  for (let i = 0; i < 8; i++) journal.begin(instance);
  const snapshot = journal.read();
  assert.equal(snapshot.flights.length, 8); assert.equal(snapshot.flightCount, 8);
  assert.equal(snapshot.flights[0]?.challenges.length, 8); assert.equal(snapshot.flights[0]?.challengeCount, 8);
  assert.equal(snapshot.saturated, true); assert.equal(journal.read().saturated, true);
});
check("DJ04-server-fixed-requests-and-stage-failure-sticky", () => {
  const journal = new DiagnosticCalloutJournal(), request = journal.begin(fields);
  journal.stage(request, "response-invoke", "entered"); journal.stage(request, "response-invoke", "threw");
  journal.stage(request, "response-invoke", "entered"); journal.stage(request, "response-invoke", "returned");
  for (let i = 0; i < 8; i++) journal.begin(fields);
  const snapshot = journal.read();
  assert.equal(snapshot.requestCount, 8); assert.equal(snapshot.requests.length, 8); assert.equal(snapshot.saturated, true);
  assert.equal(snapshot.requests[0]?.stages["response-invoke"], "threw"); assert.equal(snapshot.requests[0]?.repeatedStage, true);
});
check("DJ05-string-length-refusal-without-truncation", () => {
  const journal = new DiagnosticAuthJournal(), flight = journal.begin("x".repeat(4097));
  journal.authentication(flight, () => undefined)("x".repeat(4097));
  const server = new DiagnosticCalloutJournal(); server.begin({ ...fields, challenge: "x".repeat(4097) });
  assert.equal(journal.read().unsupported, true); assert.equal(journal.read().flights[0]?.instance, null);
  assert.deepEqual(journal.read().flights[0]?.challenges, []); assert.equal(server.read().requests[0]?.challenge, null);
  assert.equal(server.read().unsupported, true);
});
check("DJ06-private-join-exact-and-safe-export", () => {
  const client = new DiagnosticAuthJournal(), flight = client.begin(instance);
  client.authentication(flight, () => undefined)(challenge); client.settle(flight, "rejected", rejection);
  const server = new DiagnosticCalloutJournal(), request = server.begin(fields);
  server.stage(request, "actor-authorization", "threw");
  const result = diagnosticAuthCorrelation(client.read(), server.read(), rejection);
  assert.equal(result.correlation, "exact"); assert.equal(result.observations[0]?.originalErrorEqual, true);
  const output = JSON.stringify(result);
  for (const secret of [...Object.values(fields), rejection.message]) if (typeof secret === "string") assert.equal(output.includes(secret), false);
  assert.equal(result.observations[0]?.stages["actor-authorization"], "threw");
  assert.equal(diagnosticAuthCorrelation(client.read(), server.read(), new Error()).correlation, "unavailable");
});
check("DJ07-multiple-challenges-and-shared-flight-unknown", () => {
  const client = new DiagnosticAuthJournal(), flight = client.begin(instance), auth = client.authentication(flight, () => undefined);
  auth(challenge); auth("unit-second-challenge"); client.settle(flight, "rejected", rejection);
  const server = new DiagnosticCalloutJournal(); server.begin(fields);
  assert.equal(diagnosticAuthCorrelation(client.read(), server.read(), rejection).correlation, "correlated-set");
  client.sharedRebuild();
  assert.equal(diagnosticAuthCorrelation(client.read(), server.read(), rejection).correlation, "ambiguous");
});
check("DJ08-provenance-drops-uncorrelated-bounded", () => {
  const journal = new DiagnosticCalloutJournal();
  for (let i = 0; i < 9; i++) journal.drop("provenance-decode-drop");
  assert.equal(journal.read().drops["provenance-decode-drop"], 8); assert.equal(journal.read().saturated, true);
  assert.equal(journal.read().requests.length, 0);
});
check("DJ09-duplicates-and-saturation-never-exact", () => {
  const client = new DiagnosticAuthJournal(), flight = client.begin(instance);
  client.authentication(flight, () => undefined)(challenge); client.settle(flight, "rejected", rejection);
  const server = new DiagnosticCalloutJournal(); server.begin(fields); server.begin(fields);
  assert.equal(diagnosticAuthCorrelation(client.read(), server.read(), rejection).correlation, "ambiguous");
  for (let i = 0; i < 7; i++) server.begin(fields);
  const result = diagnosticAuthCorrelation(client.read(), server.read(), rejection);
  assert.equal(result.correlation, "ambiguous"); assert.equal(result.saturated, true);
  assert.equal(result.completeness, "unqualified"); assert.equal(result.observations.length, 8);
});
check("DJ10-boundary-values-and-epoch-taint", () => {
  const client = new DiagnosticAuthJournal(), flight = client.begin("x".repeat(4096));
  client.authentication(flight, () => undefined)("y".repeat(4096));
  assert.equal(client.read().unsupported, false); assert.equal(client.read().flights[0]?.challenges[0]?.length, 4096);
  const server = new DiagnosticCalloutJournal(); server.taint();
  assert.equal(server.read().unsupported, true); assert.equal(server.read().requestCount, 0);
});
console.log(`COTAL_SMOKE_SENTINEL cells=${passed + failed} passed=${passed} failed=${failed}`);
if (failed) process.exitCode = 1;
