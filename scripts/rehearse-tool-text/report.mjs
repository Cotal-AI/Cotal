#!/usr/bin/env node
// Turn a rehearsal's results into one table: node scripts/rehearse-tool-text/report.mjs <out-dir>
//
// Reads every <label>-<harness>-<scenario>/ run under <out-dir>, grades it again from the files it
// kept, so every run is read by the same checks whenever it ran, and writes report.md there: a
// pass/fail grid per scenario, the scenarios the baseline already passes (they prove nothing about
// the revised text), the runs that ended in an error, and the counts per run. A run that recorded an
// error, such as a sandbox it could not remove, fails whatever its checks say. Each get-help brief the
// check counted is quoted in full, because the check finds it by keywords.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { counts, grade, loadRecord } from "./grade.mjs";

const out = resolve(process.argv[2] ?? "");
if (!process.argv[2] || !existsSync(out)) throw new Error("usage: report.mjs <out-dir>");
const { scenarios } = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "scenarios.json"), "utf8"));

const runs = new Map();
for (const d of readdirSync(out)) {
  const dir = join(out, d);
  const m = /^([a-z0-9-]+?)-(claude|jcode)-(.+)$/.exec(d);
  if (!m || !existsSync(join(dir, "result.json"))) continue;
  const saved = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
  // An older run kept a teardown failure apart from its result; it is an error all the same.
  const error = [saved.error, saved.teardownError].filter(Boolean).join("\n") || undefined;
  let graded = {};
  if (existsSync(join(dir, "record.json"))) {
    const record = loadRecord(dir);
    graded = { ...grade(m[3], record), counts: counts(record) };
  }
  runs.set(`${m[1]}|${m[2]}|${m[3]}`, { ...graded, error, pass: !error && graded.pass === true });
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

// The get-help check finds the brief by the PR's name and material, which a post that is not a brief
// can also carry, so every brief it counted is quoted for a reader to confirm.
const briefs = [...runs].sort().filter(([k, r]) => k.endsWith("|get-help") && r.pass).flatMap(([k, r]) =>
  (r.checks?.[0]?.detail?.briefs ?? []).map((b) => `### ${k.split("|").slice(0, 2).join(" ")}, #${b.channel} at ${b.ts}\n\n${b.text.split("\n").map((l) => `> ${l}`).join("\n")}\n`));

const errors = [...runs].sort().filter(([, r]) => r.error).map(([k, r]) => `- ${k.split("|").join(" ")}: ${r.error.split("\n")[0]}`);

const countRows = [];
for (const [k, r] of [...runs].sort()) {
  const [label, h, id] = k.split("|");
  const c = r.counts ?? {};
  countRows.push(`| ${id} | ${label} | ${h} | ${JSON.stringify(c.alicePosts ?? {})} | ${c.aliceDms ?? "-"} | ${c.anycasts ?? "-"} | ${c.spawns ?? "-"} | ${c.despawns ?? "-"} | ${c.personasSaved ?? "-"} | ${(c.refusedCalls ?? []).join(", ") || "-"} |`);
}

writeFileSync(join(out, "report.md"), [
  "# Tool text rehearsal", "",
  ...lines, "",
  "A get-help pass is not proof on its own that alice's post was the brief. The check finds the brief by",
  "the PR's name and material, which a post that is not a brief can also carry, so each brief it counted",
  "is quoted below for a reader to confirm.", "",
  "## Scenarios the baseline already passes", "",
  ...(already.length ? already : ["- none"]), "",
  "## Revised runs that fail", "",
  ...(failing.length ? failing : ["- none"]), "",
  "## Get help briefs the check counted", "",
  ...(briefs.length ? briefs : ["- none"]), "",
  "## Runs that ended in an error", "",
  ...(errors.length ? errors : ["- none"]), "",
  "## Counts per run", "",
  "| Scenario | Text | Harness | alice's posts | DMs | anycasts | spawns | despawns | personas saved | refused calls |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...countRows, "",
].join("\n"));
console.log(join(out, "report.md"));
