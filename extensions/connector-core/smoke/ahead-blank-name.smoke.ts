import assert from "node:assert/strict";
import { aheadNote } from "../src/tool-specs.js";

const item = (fromName: string, fromId = "local.blank") => ({ fromName, fromId } as never);
let checks = 0;
const ok = (cond: boolean, message: string, extra?: string): void => {
  assert.ok(cond, extra === undefined ? message : `${message}\n${extra}`);
  checks++;
  console.log(`  ✓ ${message}`);
};

const space = aheadNote([item(" ")]);
ok(space.includes("from local.blank ") && !space.includes("from   "), "a whitespace withheld sender is the id", space);
ok(aheadNote([item("")]).includes("from local.blank "), "an empty withheld sender is the id");
const newline = aheadNote([item("\n")]);
ok(newline.includes("from local.blank ") && !newline.includes("\n"), "a newline withheld sender stays on one line as the id", newline);
const kept = aheadNote([item(" ada")]);
ok(kept.includes("from  ada ") && !kept.includes("local.blank"), "a withheld sender with a leading space stays", kept);
ok(aheadNote([item("ada")]).includes("from ada "), "a withheld sender name stays");
ok(aheadNote([item(" ", " ")]).includes("from (unnamed) "), "a blank sender name and id is unnamed");
ok(aheadNote([item("Ada]")]).includes("from Ada "), "a bracket in a real sender name is still neutralized");

console.log(`inbox ahead blank: ${checks} checks passed`);
