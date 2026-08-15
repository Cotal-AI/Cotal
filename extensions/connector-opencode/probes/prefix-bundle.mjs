/**
 * Build the PRE-FIX arm of the real-host probe: a copy of the shipped `dist/plugin.bundle.js` with
 * the adapter's `resolveOrThrow` reverted to the flattening it used to do (a refusal returned as an
 * ordinary `"⚠ …"` string instead of thrown).
 *
 * IT FAILS CLOSED. If the anchor is absent, or present more than once, it refuses to write rather
 * than mutating a line it did not mean to — a mutant you are going to cite must be the mutant you
 * described. Nothing here touches the tree: the mutant is written to the path you name.
 *
 * Usage: node probes/prefix-bundle.mjs <out.js> [in.js]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const out = process.argv[2];
if (!out) throw new Error("usage: node probes/prefix-bundle.mjs <out.js> [in.js]");
const src = process.argv[3] ?? fileURLToPath(new URL("../dist/plugin.bundle.js", import.meta.url));
if (!existsSync(src)) throw new Error(`no bundle at ${src} — build the connector first`);

const FROM = `function resolveOrThrow(r) {\n  if (r.isError) throw new Error(r.text);\n  return r.text;\n}`;
const TO = `function resolveOrThrow(r) {\n  return r.isError ? "⚠ " + r.text : r.text;\n}`;

const bundle = readFileSync(src, "utf8");
const hits = bundle.split(FROM).length - 1;
if (hits !== 1)
  throw new Error(
    `REFUSING to write a mutant: the anchor matched ${hits} times in ${src} (want exactly 1). ` +
      `A mutation that silently changed nothing — or changed a line it did not name — is worse than no mutation.`,
  );
writeFileSync(out, bundle.replace(FROM, TO));
console.log(`pre-fix bundle written to ${out} (1 anchored substitution)`);
