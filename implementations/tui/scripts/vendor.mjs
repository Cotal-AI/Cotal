// Copies the seeds from upstream.mjs and every file they import at the pinned commit into
// vendor/opencode/, applies patches/*.patch in name order, and records each file's sha256 in
// vendor/opencode/UPSTREAM.json. Rerunning it produces the same tree.
// Usage: node scripts/vendor.mjs [--upstream <opencode clone>]   (default: .upstream/opencode, cloned on demand)
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ALIASES, COMMIT, NOTICES, REPO, SEEDS, TYPE_SHIMS } from "./upstream.mjs"

const pkg = fileURLToPath(new URL("..", import.meta.url))
const out = path.join(pkg, "vendor/opencode")
const patchDir = path.join(pkg, "patches")
const flag = process.argv.indexOf("--upstream")
const upstream = path.resolve(flag > 0 ? process.argv[flag + 1] : path.join(pkg, ".upstream/opencode"))

const git = (...args) => execFileSync("git", ["-C", upstream, ...args], { maxBuffer: 1 << 28 })

if (!fs.existsSync(upstream)) {
  fs.mkdirSync(path.dirname(upstream), { recursive: true })
  execFileSync("git", ["clone", "--filter=blob:none", "--no-checkout", REPO, upstream], { stdio: "inherit" })
}
try {
  git("cat-file", "-e", `${COMMIT}^{commit}`)
} catch {
  git("fetch", "--filter=blob:none", "origin", COMMIT)
}

const tree = new Set(git("ls-tree", "-r", "--name-only", COMMIT).toString().split("\n").filter(Boolean))
const resolveRelative = (from, spec) => {
  const base = path.posix.join(path.posix.dirname(from), spec).replace(/\.js$/, "")
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((c) => tree.has(c))
}

// Type-only imports are followed too, so the typecheck sees every type the vendored code names.
const importRe = /^\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gms
const blobs = new Map()
const external = new Set()
const problems = []
const queue = [...SEEDS]
while (queue.length) {
  const file = queue.pop()
  if (blobs.has(file)) continue
  if (!tree.has(file)) throw new Error(`${file} does not exist at ${COMMIT}`)
  const data = git("show", `${COMMIT}:${file}`)
  blobs.set(file, data)
  if (!/\.tsx?$/.test(file)) continue
  for (const m of data.toString().matchAll(importRe)) {
    const spec = m[2] ?? m[3] ?? m[4]
    if (m[1] && TYPE_SHIMS.includes(spec)) continue
    if (spec.startsWith(".")) {
      const hit = resolveRelative(file, spec)
      if (hit) queue.push(hit)
      else problems.push(`${file} imports ${spec}, which does not exist at ${COMMIT}`)
    } else if (ALIASES[spec]) queue.push(ALIASES[spec])
    else if (spec.startsWith("@opencode/") || spec.startsWith("#")) problems.push(`${file} imports ${spec}, which has no alias`)
    else if (!m[1]) external.add(spec)
  }
}
if (problems.length) throw new Error(`the vendored set is not closed:\n${problems.join("\n")}`)
for (const notice of NOTICES) blobs.set(notice, git("show", `${COMMIT}:${notice}`))

fs.rmSync(out, { recursive: true, force: true })
for (const [file, data] of blobs) {
  fs.mkdirSync(path.dirname(path.join(out, file)), { recursive: true })
  fs.writeFileSync(path.join(out, file), data)
}
const patches = fs.readdirSync(patchDir).filter((f) => f.endsWith(".patch")).sort()
for (const p of patches) execFileSync("patch", ["-p1", "--forward", "--no-backup-if-mismatch", "-d", out, "-i", path.join(patchDir, p)], { stdio: "inherit" })

const sha256 = (data) => createHash("sha256").update(data).digest("hex")
const files = [...blobs.keys()].sort().map((file) => {
  const vendored = fs.readFileSync(path.join(out, file))
  const upstreamSha256 = sha256(blobs.get(file))
  const record = { file, sha256: sha256(vendored) }
  return record.sha256 === upstreamSha256 ? record : { ...record, upstreamSha256 }
})
fs.writeFileSync(path.join(out, "UPSTREAM.json"), JSON.stringify({ repo: REPO, commit: COMMIT, patches, files }, null, 2) + "\n")
console.log(`vendored ${files.length} files at ${COMMIT.slice(0, 10)} with ${patches.length} patch(es)`)
console.log(`external specifiers at the pinned commit: ${[...external].sort().join(", ")}`)
