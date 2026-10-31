// Fails when a file under vendor/opencode/ differs from the sha256 that vendor.mjs recorded, or
// when a file there is not recorded at all. Change vendored code with a patch under patches/ and
// a rerun of vendor.mjs, never by hand.
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../vendor/opencode", import.meta.url))
const manifest = JSON.parse(fs.readFileSync(path.join(root, "UPSTREAM.json"), "utf8"))
const recorded = new Map(manifest.files.map((f) => [f.file, f.sha256]))

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
const present = walk(root).map((abs) => path.relative(root, abs).split(path.sep).join("/")).filter((f) => f !== "UPSTREAM.json")

const problems = []
for (const file of present) {
  const want = recorded.get(file)
  if (!want) problems.push(`${file} is not recorded in UPSTREAM.json`)
  else if (createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex") !== want)
    problems.push(`${file} does not match its recorded sha256`)
}
for (const file of recorded.keys()) if (!present.includes(file)) problems.push(`${file} is recorded but missing`)

if (problems.length) {
  console.error(`vendor check failed. Rerun node scripts/vendor.mjs, and put any change in a patch under patches/:\n${problems.map((p) => `  ${p}`).join("\n")}`)
  process.exit(1)
}
console.log(`  ✓ ${present.length} vendored files match UPSTREAM.json at ${manifest.commit.slice(0, 10)}`)
