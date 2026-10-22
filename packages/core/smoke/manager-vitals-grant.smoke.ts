import { strict as assert } from "node:assert";
import { permissionsFor } from "../src/provision.js";
import { MANAGER_VITALS_SCOPE } from "../src/endpoint-grants.js";

const SPACE = "vitals_scope";
const OWNER = `u_${"a".repeat(26)}`;
const ACTOR = "web";
const UID = "a".repeat(26);
const IID = "b".repeat(26);
const principal = { owner: OWNER, actor: ACTOR, connId: "vitalscheck", lifecycleUid: UID };
const rows = (scope: string[]) => ((permissionsFor("manager-caller", SPACE, principal, {
  capabilities: scope, lifecycleUid: UID, managerInstanceId: IID,
}) as { pub?: { allow?: string[] } }).pub?.allow ?? []);
const commands = (scope: string[]) => rows(scope).flatMap((row) => {
  const match = /\.ep(?:\.v1)?\.inst\.manager\.([^.]+)\.([^.]+)\./.exec(row);
  return match ? [{ instanceId: match[1], command: match[2] }] : [];
});

let passed = 0;
const cell = (name: string, ok: boolean, seen?: unknown) => {
  if (ok) { passed++; console.log(`PASS ${name}`); return; }
  console.log(`FAIL ${name} - ${JSON.stringify(seen)}`); process.exitCode = 1;
};
const vitals = commands([MANAGER_VITALS_SCOPE]);
cell("machine-vitals grants one exact pinned vitals row", vitals.filter((row) => row.command === "vitals" && row.instanceId === IID).length === 1, vitals);
cell("machine-vitals adds no Manager command besides describe, baseline self calls and vitals",
  vitals.every((row) => ["describe", "stop", "turn-pending", "turn-yield", "run-answer", "vitals"].includes(row.command)), vitals);
for (const scope of [[], ["spawn"], ["run"], ["admin"], ["spawn", "run", "admin"]])
  cell(`${scope.join("+") || "no scope"} does not imply vitals`, commands(scope).every((row) => row.command !== "vitals"), commands(scope));
cell("vitals scope does not add spawn, run, ps, slots or admin commands",
  vitals.every((row) => !["spawn", "run-start", "run-resume", "ps", "slots", "purge", "launch"].includes(row.command)), vitals);
cell("every machine-vitals Manager row is pinned to the selected instance", vitals.every((row) => row.instanceId === IID), vitals);
assert.equal(passed, 9);
console.log(`manager vitals grant smoke: ${passed} passed, ${9 - passed} failed, 9 total`);
