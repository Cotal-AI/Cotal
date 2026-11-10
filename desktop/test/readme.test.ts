import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("the desktop terminal workflow requests registration before connecting", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const controls = readme.split("\n").find((line) => line.startsWith("The equivalent terminal controls are "));
  assert.ok(controls, "the desktop README must document its terminal controls");
  assert.deepEqual([...controls.matchAll(/`(cotal daemon [^`]+)`/g)].map((match) => match[1]), [
    "cotal daemon install",
    "cotal daemon start",
    "cotal daemon login --idp <url>",
    "cotal daemon spaces --refresh",
    "cotal daemon register --space <space>",
    "cotal daemon service-connect --space <space>",
  ]);
});
