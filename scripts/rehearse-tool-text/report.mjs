#!/usr/bin/env node
// Turn a rehearsal's results into one table: node scripts/rehearse-tool-text/report.mjs <out-dir>
//
// Reads every <label>-<harness>-<scenario>/result.json under <out-dir> and writes report.md there:
// a pass/fail grid per scenario, the scenarios the baseline already passes (they prove nothing about
// the revised text), and the counts per run.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const out = resolve(process.argv[2] ?? "");
if (!process.argv[2] || !existsSync(out)) throw new Error("usage: report.mjs <out-dir>");
const { scenarios } = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "scenarios.json"), "utf8"));

const runs = new Map();
for (const d of readdirSync(out)) {
  const f = join(out, d, "result.json");
  if (!existsSync(f)) continue;
  const m = /^([a-z0-9-]+?)-(claude|jcode)-(.+)$/.exec(d);
  if (m) runs.set(`${m[1]}|${m[2]}|${m[3]}`, JSON.parse(readFileSync(f, "utf8")));
}
const harnesses = [...new Set([...runs.keys()].map((k) => k.split("|")[1]))].sort();
const cell = (label, h, id) => {
  const r = runs.get(`${label}|${h}|${id}`);
  if (!r) return "not run";
  if (r.error) return "error";
  return r.pass ? "pass" : "fail";
};

const cols = harnesses.flatMap((h) => [`baseline ${h}`, `revised ${h}`]);
const lines = [`| Scenario | ${cols.join(" | ")} |`, `|---|${cols.map(() => "---").join("|")}|`];
for (const s of scenarios) lines.push(`| ${s.title} | ${harnesses.flatMap((h) => [cell("baseline", h, s.id), cell("revised", h, s.id)]).join(" | ")} |`);

const already = scenarios.filter((s) => harnesses.some((h) => cell("baseline", h, s.id) === "pass"))
  .map((s) => `- ${s.title}: baseline passes on ${harnesses.filter((h) => cell("baseline", h, s.id) === "pass").join(" and ")}`);
const failing = scenarios.flatMap((s) => harnesses.filter((h) => cell("revised", h, s.id) !== "pass").map((h) => {
  const r = runs.get(`revised|${h}|${s.id}`);
  const why = r?.error ? r.error.split("\n")[0] : (r?.checks ?? []).filter((c) => !c.ok).map((c) => c.check).join("; ");
  return `- ${s.title} on ${h}: ${why || "not run"}`;
}));

const countRows = [];
for (const [k, r] of [...runs].sort()) {
  const [label, h, id] = k.split("|");
  const c = r.counts ?? {};
  countRows.push(`| ${id} | ${label} | ${h} | ${JSON.stringify(c.alicePosts ?? {})} | ${c.aliceDms ?? "-"} | ${c.anycasts ?? "-"} | ${c.spawns ?? "-"} | ${c.despawns ?? "-"} | ${c.personasSaved ?? "-"} | ${(c.refusedCalls ?? []).join(", ") || "-"} |`);
}

writeFileSync(join(out, "report.md"), [
  "# Tool text rehearsal", "",
  ...lines, "",
  "## Scenarios the baseline already passes", "",
  ...(already.length ? already : ["- none"]), "",
  "## Revised runs that fail", "",
  ...(failing.length ? failing : ["- none"]), "",
  "## Counts per run", "",
  "| Scenario | Text | Harness | alice's posts | DMs | anycasts | spawns | despawns | personas saved | refused calls |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...countRows, "",
].join("\n"));
console.log(join(out, "report.md"));
