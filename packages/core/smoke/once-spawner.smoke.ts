import assert from "node:assert/strict";
import { renderOnceTask, shownSpawner } from "../src/turn-contract.js";

let checks = 0;
const ok = (condition: unknown, message: string): void => {
  assert.equal(condition, true, message);
  checks++;
  console.log(`  ✓ ${message}`);
};

const line = (spawner?: string): string =>
  renderOnceTask({
    goalId: "g1",
    payload: JSON.stringify({ context: "do the thing" }),
    ...(spawner === undefined ? {} : { spawner }),
  }).split("\n")[0]!;

const named = "🎯 Cotal — your spawner started this seat for one task (goal g1):";
ok(line(" ") === named, "a whitespace spawner is not shown as a blank name");
ok(line("") === named, "an empty spawner is not shown as a blank name");
ok(line("\n") === named, "a newline spawner does not split the task line");
ok(line("  ") === named, "a longer whitespace spawner is not shown as a blank name");
ok(line(" ada") === "🎯 Cotal —  ada started this seat for one task (goal g1):", "a spawner with a leading space keeps that name");
ok(line("Ada") === "🎯 Cotal — Ada started this seat for one task (goal g1):", "a spawner name stays");
ok(line(undefined) === named, "a missing spawner stays your spawner");
ok(renderOnceTask({ goalId: "g1", payload: JSON.stringify({ context: "do the thing" }), spawner: "local.blank" }).includes("cotal_dm to local.blank"), "a principal spawner is who the seat is told to answer");
ok(shownSpawner(" ", "local.blank") === "local.blank", "a whitespace roster name is the principal");
ok(shownSpawner("", "local.blank") === "local.blank", "an empty roster name is the principal");
ok(shownSpawner("\n", "local.blank") === "local.blank", "a newline roster name is the principal");
ok(shownSpawner(" ada", "local.blank") === " ada", "a roster name with a leading space stays");
ok(shownSpawner(undefined, "local.blank") === "local.blank", "a missing roster name is the principal");

console.log(`once spawner: ${checks} checks passed`);
