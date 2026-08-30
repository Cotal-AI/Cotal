import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

type Classification = "honest-text" | "presence-only-glyph/count" | "command-ack" | "non-render/control";
type CandidateKind = "status-token" | "derived-output" | "indexed-map" | "renderer-call";
type Entry = {
  path: string;
  kind: CandidateKind;
  anchor: string;
  class: Classification;
  rationale: string;
  proof?: { path: string; anchor: string };
};
type Renderer = { name: string; path: string; anchor: string; rationale: string };
type Manifest = {
  expected: Record<"total" | Classification, number>;
  renderers: Renderer[];
  entries: Entry[];
};
type Candidate = { path: string; kind: CandidateKind; anchor: string };

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const self = fileURLToPath(import.meta.url);
const manifestPath = join(dirname(self), "fixtures", "presence-render-sinks.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
const renderRoots = [
  join(root, "packages/core/src/resolve.ts"),
  join(root, "extensions/connector-core/src"),
  join(root, "implementations/cli/src"),
  join(root, "implementations/web/src"),
];
const skipDirs = new Set(["dist", "smoke", "test", "tests", "fixtures", "node_modules"]);
const sourceExt = /\.(?:ts|tsx|js|mjs|mts)$/;
const statusTokens = new Set(["working", "waiting", "idle", "offline"]);
const probeDir = join(root, "implementations/cli/src/commands");
const PROBES = [
  ["direct-interpolation", "direct-interpolation.ts", "derived-output", 'export const probe = (p: any) => `${p.status}`;\n'],
  ["status-word", "status-word.ts", "indexed-map", 'const STATUS: any = {}; export const probe = (p: any) => STATUS[p.status].word;\n'],
  ["helper-call", "helper-call.ts", "renderer-call", 'const statusBadge = (x: any) => x; export const probe = (p: any) => statusBadge(p.status);\n'],
  ["literal-branch", "literal-branch.ts", "status-token", 'export const probe = (mesh: string) => mesh === "working" ? "working" : mesh;\n'],
  ["table-map", "table-map.ts", "indexed-map", 'const label: any = { working: "working", waiting: "waiting", idle: "idle" }; export const probe = (p: any, el: any) => { el.textContent = label[p.status]; };\n'],
  ["alias-jsx", "alias-jsx.tsx", "derived-output", 'export const probe = (p: any) => { const state = p.status; return <span>{state}</span>; };\n'],
] as const;

/** Honest boundary: this is broad finite-syntax enumeration, not arbitrary semantic dataflow. It
 * covers the AST classes below and proves them with adversarial shipped-root probes. A new syntax
 * class still requires extending this reader and its probe corpus. */
function* shippedSources(path: string): Generator<string> {
  const stat = statSync(path);
  if (stat.isFile()) {
    if (sourceExt.test(path) && !/\.generated\./.test(path) && !/\.d\.ts$/.test(path)) yield path;
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || skipDirs.has(entry.name)) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) yield* shippedSources(child);
    else if (sourceExt.test(entry.name) && !/\.generated\./.test(entry.name) && !/\.d\.ts$/.test(entry.name) && statSync(child).size < 2_000_000) yield child;
  }
}

function scriptKind(path: string): ts.ScriptKind {
  return /\.(tsx|jsx)$/.test(path) ? ts.ScriptKind.TSX : /\.(js|mjs)$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

function uniqueNodeAnchor(body: string, node: ts.Node): string {
  let before = 0, after = 0;
  for (let attempt = 0; attempt < 30; attempt++) {
    const start = Math.max(0, node.getStart() - before);
    const end = Math.min(body.length, node.getEnd() + after);
    const anchor = body.slice(start, end);
    if (body.split(anchor).length - 1 === 1) return anchor;
    before += 24;
    after += 24;
  }
  throw new Error(`candidate cannot be given a unique stable anchor near ${node.getText().slice(0, 80)}`);
}

const unwrap = (node: ts.Expression): ts.Expression => {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current))
    current = current.expression;
  return current;
};

function directStatusSource(expr: ts.Expression): boolean {
  const node = unwrap(expr);
  if (ts.isIdentifier(node)) return node.text === "status" || node.text === "mesh";
  if (ts.isPropertyAccessExpression(node)) return node.name.text === "status" || node.name.text === "mesh";
  if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression))
    return node.argumentExpression.text === "status" || node.argumentExpression.text === "mesh";
  return false;
}

function expressionUsesTaint(expr: ts.Expression, tainted: Set<string>): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isExpression(node) && directStatusSource(node)) { found = true; return; }
    if (ts.isIdentifier(node) && tainted.has(node.text)) { found = true; return; }
    ts.forEachChild(node, visit);
  };
  visit(expr);
  return found;
}

function bindingNames(name: ts.BindingName, statusOnly = false): string[] {
  if (ts.isIdentifier(name)) return statusOnly || name.text === "status" || name.text === "mesh" ? [name.text] : [];
  const out: string[] = [];
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    const property = element.propertyName && (ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName))
      ? element.propertyName.text : undefined;
    out.push(...bindingNames(element.name, statusOnly || property === "status" || property === "mesh"));
  }
  return out;
}

function taintedNames(scope: ts.Node): Set<string> {
  const tainted = new Set(["status", "mesh"]);
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: ts.Node): void => {
      if (node !== scope && ts.isFunctionLike(node)) return;
      if (ts.isVariableDeclaration(node) && node.initializer && expressionUsesTaint(node.initializer, tainted)) {
        for (const name of bindingNames(node.name, true)) if (!tainted.has(name)) { tainted.add(name); changed = true; }
      }
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
        for (const name of bindingNames(node.name)) if (!tainted.has(name)) { tainted.add(name); changed = true; }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && expressionUsesTaint(node.right, tainted) && !tainted.has(node.left.text)) {
        tainted.add(node.left.text); changed = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(scope);
  }
  return tainted;
}

function calleeName(expr: ts.LeftHandSideExpression): string | undefined {
  const node = unwrap(expr as ts.Expression);
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return undefined;
}

const outputCall = /^(?:print|log|error|warn|info|ok|err|esc|render|format|label|badge|status|notify|write|push|setText|text)$/i;
const rendererNames = new Set(manifest.renderers.map((renderer) => renderer.name));

function collectCandidates(file: string): Candidate[] {
  const body = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, body, ts.ScriptTarget.Latest, true, scriptKind(file));
  const path = relative(root, file).split("\\").join("/");
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (kind: CandidateKind, node: ts.Node): void => {
    const anchor = uniqueNodeAnchor(body, node);
    const key = `${kind}\u0000${anchor}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path, kind, anchor });
  };

  const scopes: ts.Node[] = [source];
  const findScopes = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) scopes.push(node);
    ts.forEachChild(node, findScopes);
  };
  ts.forEachChild(source, findScopes);

  const owner = new Map<ts.Node, ts.Node>();
  const markOwner = (node: ts.Node, scope: ts.Node): void => {
    owner.set(node, scope);
    ts.forEachChild(node, (child) => markOwner(child, child !== node && ts.isFunctionLike(child) ? child : scope));
  };
  markOwner(source, source);
  const taintByScope = new Map(scopes.map((scope) => [scope, taintedNames(scope)]));
  const usesTaint = (expr: ts.Expression): boolean => expressionUsesTaint(expr, taintByScope.get(owner.get(expr) ?? source) ?? new Set());

  const containsIndexedStatusMap = (expr: ts.Expression): boolean => {
    let found = false;
    const inspect = (node: ts.Node): void => {
      if (found) return;
      if (ts.isElementAccessExpression(node) && node.argumentExpression && usesTaint(node.argumentExpression)) {
        found = true;
        return;
      }
      ts.forEachChild(node, inspect);
    };
    inspect(expr);
    return found;
  };
  const directlyTainted = (expr: ts.Expression): boolean => {
    const node = unwrap(expr);
    return directStatusSource(node) || (ts.isIdentifier(node) && (taintByScope.get(owner.get(node) ?? source) ?? new Set()).has(node.text));
  };
  const registeredRendererCall = (node: ts.CallExpression): boolean => {
    const name = calleeName(node.expression);
    return Boolean(name && rendererNames.has(name));
  };

  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) && statusTokens.has(node.text)) add("status-token", node);

    if (ts.isElementAccessExpression(node) && node.argumentExpression && usesTaint(node.argumentExpression)) {
      const map = unwrap(node.expression);
      const statusTable = ts.isIdentifier(map) && map.text === "STATUS";
      if (statusTable) add("indexed-map", node);
      if (!statusTable) add("indexed-map", node);
    }

    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (registeredRendererCall(node)) add("renderer-call", node);
      else if (node.arguments.some((arg) => directlyTainted(arg)) && name && outputCall.test(name)) add("derived-output", node);
    }

    if (ts.isTemplateExpression(node) && node.templateSpans.some((span) => usesTaint(span.expression) && !containsIndexedStatusMap(span.expression))) add("derived-output", node);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken && (!node.parent || !ts.isBinaryExpression(node.parent) || node.parent.operatorToken.kind !== ts.SyntaxKind.PlusToken) && !containsIndexedStatusMap(node) && (usesTaint(node.left) || usesTaint(node.right))) add("derived-output", node);
    if (ts.isJsxExpression(node) && node.expression && usesTaint(node.expression) && !containsIndexedStatusMap(node.expression)) add("derived-output", node);
    if (ts.isJsxAttribute(node) && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression && usesTaint(node.initializer.expression) && !containsIndexedStatusMap(node.initializer.expression)) add("derived-output", node);
    if (ts.isReturnStatement(node) && node.expression && directlyTainted(node.expression)) add("derived-output", node);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left) && ["textContent", "innerHTML", "innerText"].includes(node.left.name.text) && usesTaint(node.right) && !containsIndexedStatusMap(node.right)) add("derived-output", node);

    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

// Child spawns get a COTAL_-stripped copy of the ambient env: whatever runs this suite may be a
// managed agent session, and spreading its environment would hand the probe child a live credential
// and a live broker URL (bin/smoke/suite-ambient-env.smoke.ts). The children read only their own
// COTAL_PRESENCE_RENDER_* controls, set explicitly per spawn.
const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(cleanEnv)) if (key.startsWith("COTAL_")) delete cleanEnv[key];

const selectedProbe = process.env.COTAL_PRESENCE_RENDER_PROBE_CASE;
if (selectedProbe) {
  const probe = PROBES.find(([id]) => id === selectedProbe);
  assert.ok(probe, `unknown presence-render probe case: ${selectedProbe}`);
  const [, name, expectedKind, source] = probe;
  const path = join(probeDir, `presence-render-probe-${name}`);
  const rel = relative(root, path).split("\\").join("/");
  try {
    writeFileSync(path, source);
    const scan = spawnSync("pnpm", ["exec", "tsx", self], {
      cwd: root,
      env: { ...cleanEnv, COTAL_PRESENCE_RENDER_PROBE_CASE: "", COTAL_PRESENCE_RENDER_SINGLE_PROBE: rel, COTAL_PRESENCE_RENDER_EXPECT_KIND: expectedKind },
      encoding: "utf8",
      timeout: 120_000,
    });
    const output = `${scan.stdout ?? ""}${scan.stderr ?? ""}`;
    assert.equal(scan.status, 0, output);
  } finally {
    rmSync(path, { force: true });
  }
  console.log(`presence-render probe case passed: ${selectedProbe}`);
  process.exit(0);
}

const probeOnly = process.env.COTAL_PRESENCE_RENDER_SINGLE_PROBE;
const probeKind = process.env.COTAL_PRESENCE_RENDER_EXPECT_KIND as CandidateKind | undefined;
const activeRenderRoots = probeOnly ? [join(root, probeOnly)] : renderRoots;
const candidates = activeRenderRoots.flatMap((path) => [...shippedSources(path)]).flatMap(collectCandidates);
if (probeOnly) {
  assert.ok(candidates.some((candidate) => candidate.kind === probeKind), `AST probe scanner missed ${probeKind} in shipped presence renderer: ${probeOnly}`);
  process.exit(0);
}
if (process.env.COTAL_DUMP_PRESENCE_RENDER_CANDIDATES === "1") {
  process.stdout.write(JSON.stringify(candidates, null, 2) + "\n");
  process.exit(0);
}
const candidateKey = (candidate: Candidate): string => `${candidate.path}\u0000${candidate.kind}\u0000${candidate.anchor}`;
const candidateKeys = new Set(candidates.map(candidateKey));
assert.equal(candidateKeys.size, candidates.length, "AST census produced a duplicate path+kind+anchor candidate");
assert.ok(candidates.length > 0, "presence render census found no shipped-source candidates; the scanner is broken");

for (const renderer of manifest.renderers) {
  assert.ok(renderer.rationale.trim().length >= 12, `renderer rationale is missing or too short: ${renderer.name}`);
  const body = readFileSync(join(root, renderer.path), "utf8");
  assert.equal(body.split(renderer.anchor).length - 1, 1, `renderer declaration anchor must exist exactly once: ${renderer.path}: ${renderer.anchor}`);
  const uses = candidates.filter((candidate) => candidate.kind === "renderer-call" && new RegExp(`\\b${renderer.name}\\s*\\(`).test(candidate.anchor));
  assert.ok(uses.length > 0, `renderer declaration has no scanned call sites: ${renderer.name}`);
}

const sharedStatusBadgeAnchor = 'return c.green("● working · progress unknown");';
const connectorHonestStatusAnchor = 'status === "working" ? "working · progress unknown" : status;';
const connectorRosterProgressAnchor = 'const progress = p.status === "working" ? "working · progress unknown" : p.status;';
const inkDetailStatusAnchor = '<Text color={s.color}>{s.dot + " " + s.word + (status === "working" ? " · progress unknown" : "")}</Text>';
const inkRosterProgressAnchor = 'return progressSignal(undefined, Date.now()).kind === "unknown" ? "progress unknown" : "progress observed";';
const webMonitorProgressAnchor = 'const progress = p.status === "working" && p.progress?.kind === "unknown" ? "working · progress unknown" : p.status;';
const webGraphProgressAnchor = '<div class="d-status ${sel.status}"><span class="dot"></span>${esc(sel.status === "working" && sel.progress?.kind === "unknown" ? "working · progress unknown" : sel.status)}</div>';
const proofAnchors = new Map<string, string>([
  ["extensions/connector-core/src/orientation.ts", connectorHonestStatusAnchor],
  ["extensions/connector-core/src/tool-specs.ts", connectorRosterProgressAnchor],
  ["implementations/cli/src/ui.ts", sharedStatusBadgeAnchor],
  ["implementations/cli/src/console/ui/Detail.tsx", inkDetailStatusAnchor],
  ["implementations/cli/src/console/ui/Roster.tsx", inkRosterProgressAnchor],
  ["implementations/web/src/web/app.js", webMonitorProgressAnchor],
  ["implementations/web/src/web/graph.js", webGraphProgressAnchor],
]);

const entryKeys = new Set<string>();
const counts: Record<Classification, number> = { "honest-text": 0, "presence-only-glyph/count": 0, "command-ack": 0, "non-render/control": 0 };
for (const entry of manifest.entries) {
  assert.ok(entry.rationale.trim().length >= 12, `manifest rationale is missing or too short for ${entry.path}: ${entry.anchor}`);
  const key = candidateKey(entry);
  assert.ok(!entryKeys.has(key), `manifest duplicates candidate ${entry.path}: ${entry.anchor}`);
  entryKeys.add(key);
  const body = readFileSync(join(root, entry.path), "utf8");
  assert.equal(body.split(entry.anchor).length - 1, 1, `manifest anchor must exist exactly once in ${entry.path}: ${entry.anchor}`);
  assert.ok(candidateKeys.has(key), `manifest entry is stale or no longer an AST census candidate: ${entry.path}: ${entry.anchor}`);
  counts[entry.class]++;
  if (entry.class === "honest-text") {
    assert.ok(entry.proof, `honest-text entry lacks output/shared-renderer proof: ${entry.path}: ${entry.anchor}`);
    const proofBody = readFileSync(join(root, entry.proof!.path), "utf8");
    assert.equal(proofBody.split(entry.proof!.anchor).length - 1, 1, `honest-text proof anchor must exist exactly once in ${entry.proof!.path}: ${entry.proof!.anchor}`);
    if (entry.proof!.path.includes("/smoke/")) assert.ok(/assert|check|ok\(/.test(entry.proof!.anchor), `smoke proof is not an output assertion: ${entry.proof!.path}: ${entry.proof!.anchor}`);
    else assert.equal(proofAnchors.get(entry.proof!.path), entry.proof!.anchor, `honest-text source proof is not a checked honest renderer: ${entry.proof!.path}: ${entry.proof!.anchor}`);
  } else assert.equal(entry.proof, undefined, `${entry.class} entry must not carry honest-text proof: ${entry.path}: ${entry.anchor}`);
}

const unclassified = candidates.filter((candidate) => !entryKeys.has(candidateKey(candidate)));
assert.deepEqual(unclassified, [], `unclassified shipped presence-render candidate(s):\n${unclassified.map((candidate) => `  ${candidate.path} [${candidate.kind}]`).join("\n")}\nClassify each narrow sink in ${relative(root, manifestPath)}.`);
const actual = { total: candidates.length, ...counts };
assert.deepEqual(actual, manifest.expected, "presence render census count drifted; classify every candidate before updating the reviewed totals");
console.log(`presence-render AST census: ${actual.total} candidates (${actual["honest-text"]} honest-text, ${actual["presence-only-glyph/count"]} presence-only-glyph/count, ${actual["command-ack"]} command-ack, ${actual["non-render/control"]} non-render/control)`);

if (process.env.COTAL_PRESENCE_RENDER_PROBE_CHILD !== "1") {
  for (const [, name, expectedKind, source] of PROBES) {
    const path = join(probeDir, `presence-render-probe-${name}`);
    try {
      writeFileSync(path, source);
      const rel = relative(root, path).split("\\").join("/");
      const scan = spawnSync("pnpm", ["exec", "tsx", self], {
        cwd: root,
        env: { ...cleanEnv, COTAL_PRESENCE_RENDER_SINGLE_PROBE: rel, COTAL_PRESENCE_RENDER_EXPECT_KIND: expectedKind },
        encoding: "utf8",
        timeout: 120_000,
      });
      assert.equal(scan.status, 0, `${scan.stdout ?? ""}${scan.stderr ?? ""}`);
      const run = spawnSync("pnpm", ["exec", "tsx", self], { cwd: root, env: { ...cleanEnv, COTAL_PRESENCE_RENDER_PROBE_CHILD: "1" }, encoding: "utf8", timeout: 120_000 });
      const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
      assert.notEqual(run.status, 0, `adversarial presence-render probe unexpectedly escaped the AST census: ${rel}`);
      assert.match(output, new RegExp(rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `probe failure did not name its new shipped path: ${rel}`);
    } finally {
      rmSync(path, { force: true });
    }
  }
}
console.log("PRESENCE-RENDER-CENSUS: 17 checks passed");
