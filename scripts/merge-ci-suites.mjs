#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SUITE = /^smoke(?::[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*)?$/;

function fail(message) {
  throw new Error(message);
}

/** Parse the registry into its global header plus comment blocks attached to the suite beneath. */
export function parseRegistry(raw, label = "ci-suites.txt") {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const suiteAt = [];
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index].trim();
    if (!text || text.startsWith("#")) continue;
    if (!SUITE.test(text)) fail(`${label}:${index + 1}: not a smoke script name: ${JSON.stringify(text)}`);
    suiteAt.push(index);
  }
  if (!suiteAt.length) fail(`${label}: registry has no suites`);

  const preambleLines = lines.slice(0, suiteAt[0]);
  if (preambleLines.some((line) => line.trim() && !line.trim().startsWith("#")))
    fail(`${label}: header carries a non-comment line`);

  const entries = [];
  const names = new Set();
  let previousSuite = suiteAt[0];
  const firstName = lines[previousSuite].trim();
  names.add(firstName);
  entries.push({ name: firstName, raw: `${lines[previousSuite]}\n` });

  for (const index of suiteAt.slice(1)) {
    const between = lines.slice(previousSuite + 1, index);
    if (between.some((line) => line.trim() && !line.trim().startsWith("#")))
      fail(`${label}:${previousSuite + 2}-${index}: entry block carries a non-comment line`);
    const name = lines[index].trim();
    if (names.has(name)) fail(`${label}:${index + 1}: duplicate suite ${name}`);
    names.add(name);
    entries.push({ name, raw: `${between.concat([lines[index]]).join("\n")}\n` });
    previousSuite = index;
  }

  const trailing = lines.slice(previousSuite + 1);
  if (trailing.some((line) => line.trim())) fail(`${label}: trailing comments are not attached to a suite`);
  return {
    raw: `${lines.join("\n")}\n`,
    preamble: `${preambleLines.join("\n")}\n`,
    entries,
  };
}

function addedEntries(base, side, label) {
  if (side.preamble !== base.preamble) fail(`${label}: registry header changed; resolve this merge manually`);
  const baseByName = new Map(base.entries.map((entry) => [entry.name, entry]));
  const sideBase = side.entries.filter((entry) => baseByName.has(entry.name));
  if (sideBase.map((entry) => entry.name).join("\0") !== base.entries.map((entry) => entry.name).join("\0"))
    fail(`${label}: a pre-existing suite was removed or reordered; resolve this merge manually`);
  for (const entry of sideBase) {
    if (entry.raw !== baseByName.get(entry.name).raw)
      fail(`${label}: the comment block for pre-existing suite ${entry.name} changed; resolve this merge manually`);
  }
  return side.entries.filter((entry) => !baseByName.has(entry.name));
}

/** Merge only additive suite entries: base wholesale, then ours additions, then theirs additions. */
export function mergeRegistries(baseRaw, oursRaw, theirsRaw) {
  const base = parseRegistry(baseRaw, "base");
  const ours = parseRegistry(oursRaw, "ours");
  const theirs = parseRegistry(theirsRaw, "theirs");
  const oursAdded = addedEntries(base, ours, "ours");
  const theirsAdded = addedEntries(base, theirs, "theirs");
  const mergedEntries = oursAdded.concat(theirsAdded);
  const seen = new Map();
  const appended = [];
  for (const entry of mergedEntries) {
    const prior = seen.get(entry.name);
    if (prior !== undefined) {
      if (prior !== entry.raw) fail(`both sides added ${entry.name} with different comment blocks`);
      continue;
    }
    seen.set(entry.name, entry.raw);
    appended.push(entry.raw);
  }
  return base.raw + appended.join("");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , basePath, oursPath, theirsPath] = process.argv;
  if (!basePath || !oursPath || !theirsPath) {
    console.error("usage: merge-ci-suites.mjs <base> <ours> <theirs> [path]");
    process.exit(2);
  }
  try {
    const merged = mergeRegistries(
      readFileSync(basePath, "utf8"),
      readFileSync(oursPath, "utf8"),
      readFileSync(theirsPath, "utf8"),
    );
    writeFileSync(oursPath, merged);
  } catch (error) {
    console.error(`ci-suites merge refused: ${error.message}`);
    process.exit(1);
  }
}
