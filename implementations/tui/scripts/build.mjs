// Compiles vendor/ and src/ TS and TSX to dist/ with Babel and babel-preset-solid in universal
// mode against @opentui/solid, the Node path OpenTUI documents. Relative and aliased imports are
// rewritten to the compiled .js files, so dist/ runs without a loader.
import { transformAsync } from "@babel/core"
import ts from "@babel/preset-typescript"
import solid from "babel-preset-solid"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ALIASES } from "./upstream.mjs"

const pkg = fileURLToPath(new URL("..", import.meta.url))
const dist = path.join(pkg, "dist")
const roots = ["vendor", "src"]

function sourceFor(abs) {
  const base = abs.replace(/\.js$/, "")
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`])
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
  throw new Error(`cannot resolve ${abs}`)
}

const outPath = (src) => path.join(dist, path.relative(pkg, src)).replace(/\.tsx?$/, ".js")

function rewrite(spec, file) {
  let target
  if (ALIASES[spec]) target = path.join(pkg, "vendor/opencode", ALIASES[spec])
  else if (spec.startsWith(".")) target = sourceFor(path.resolve(path.dirname(file), spec))
  else return spec
  const rel = path.relative(path.dirname(outPath(file)), outPath(target))
  return rel.startsWith(".") ? rel : `./${rel}`
}

const resolver = () => ({
  visitor: {
    "ImportDeclaration|ExportNamedDeclaration|ExportAllDeclaration"(p, state) {
      // Type-only declarations are erased below and may name files that are not vendored.
      if (p.node.importKind === "type" || p.node.exportKind === "type") return
      if (p.node.source) p.node.source.value = rewrite(p.node.source.value, state.filename)
    },
    CallExpression(p, state) {
      const arg = p.node.arguments[0]
      if (p.node.callee.type === "Import" && arg?.type === "StringLiteral") arg.value = rewrite(arg.value, state.filename)
    },
  },
})

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))

fs.rmSync(dist, { recursive: true, force: true })
let compiled = 0
for (const file of roots.flatMap((r) => walk(path.join(pkg, r)))) {
  const dest = outPath(file)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  if (file.endsWith(".json")) fs.copyFileSync(file, dest)
  if (!/\.tsx?$/.test(file)) continue
  const { code } = await transformAsync(fs.readFileSync(file, "utf8"), {
    filename: file,
    babelrc: false,
    configFile: false,
    sourceMaps: false,
    plugins: [resolver],
    presets: [[solid, { moduleName: "@opentui/solid", generate: "universal" }], [ts, { onlyRemoveTypeImports: false }]],
  })
  fs.writeFileSync(dest, code)
  compiled++
}
console.log(`compiled ${compiled} files into dist/`)
