// Fails when a file under vendor/opencode/, patches/ or types/ differs from the sha256 that
// vendor.mjs recorded, is not recorded, or is recorded but missing. Change vendored code with a
// patch under patches/ and a rerun of vendor.mjs, never by hand, and rerun vendor.mjs after editing
// a patch or a type excerpt.
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const pkg = fileURLToPath(new URL("..", import.meta.url))
const manifestFile = "vendor/opencode/UPSTREAM.json"
const manifest = JSON.parse(fs.readFileSync(path.join(pkg, manifestFile), "utf8"))
const recorded = new Map([
  ...manifest.files.map((f) => [`vendor/opencode/${f.file}`, f.sha256]),
  ...manifest.patches.map((p) => [p.file, p.sha256]),
  ...manifest.typeExcerpts.map((t) => [t.file, t.sha256]),
])

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
const present = ["vendor/opencode", "patches", "types"]
  .flatMap((dir) => walk(path.join(pkg, dir)))
  .map((abs) => path.relative(pkg, abs).split(path.sep).join("/"))
  .filter((f) => f !== manifestFile)

const problems = []
for (const file of present) {
  const want = recorded.get(file)
  if (!want) problems.push(`${file} is not recorded in UPSTREAM.json`)
  else if (createHash("sha256").update(fs.readFileSync(path.join(pkg, file))).digest("hex") !== want)
    problems.push(`${file} does not match its recorded sha256`)
}
for (const file of recorded.keys()) if (!present.includes(file)) problems.push(`${file} is recorded but missing`)

if (problems.length) {
  console.error(`vendor check failed. Rerun node scripts/vendor.mjs, and put any change to vendored code in a patch under patches/:\n${problems.map((p) => `  ${p}`).join("\n")}`)
  process.exit(1)
}
console.log(`  ✓ ${manifest.files.length} vendored files, ${manifest.patches.length} patch(es) and ${manifest.typeExcerpts.length} type excerpt(s) match UPSTREAM.json at ${manifest.commit.slice(0, 10)}`)
