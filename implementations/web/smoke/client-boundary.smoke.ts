/**
 * THE CLIENT'S BOUNDARY: WHAT ITS MODULES MAY LOAD AND TOUCH.
 *
 * The smoke suites import the client's `lib/`, `state/` and `art/` modules under Node, where there
 * is no DOM, and the client ships with nothing from `@cotal-ai/*` in its bundle. Two halves:
 *
 * 1. Loading. `lib/md.ts` and the character art seam `art/index.ts` import under Node without
 *    throwing, and the seam draws: `body("claude")` is Claude's SVG body and `mark(fill)` a whole
 *    `<svg>` in that fill.
 * 2. The census. Every file under `client/src` is parsed (TypeScript's own parser, not a pattern),
 *    and two rules are checked on the syntax tree:
 *    - `@cotal-ai/*` is imported for types only: `import type`, or specifiers that are all
 *      `type`, so nothing from those packages is loaded at runtime or bundled;
 *    - no module under `lib/`, `state/` or `art/` names `window`, `document`, `fetch` or
 *      `EventSource`. The exceptions are named below with their reason.
 *
 * Run: pnpm smoke:web-client-boundary
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

let cells = 0;
let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown): void => {
  cells++;
  if (cond) {
    console.log(`  ok ${name}`);
    return;
  }
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ── 1. LOADING UNDER NODE ────────────────────────────────────────────────────────────────────────
// Each import is caught, so a module that throws on load fails its own cell instead of the suite.
let md: typeof import("../client/src/lib/md.js") | undefined;
let mdError: unknown;
try { md = await import("../client/src/lib/md.js"); } catch (err) { mdError = err; }
ok("1.1 lib/md.ts imports under Node, where there is no DOM", typeof md?.renderMarkdown === "function", { error: mdError && why(mdError) });

let art: typeof import("../client/src/art/index.js") | undefined;
let artError: unknown;
try { art = await import("../client/src/art/index.js"); } catch (err) { artError = err; }
ok("1.2 the art seam imports under Node", typeof art?.body === "function" && typeof art?.mark === "function", { error: artError && why(artError) });

// Claude is the pill in Claude's blue (#4663E7); a vendor the file does not know is the teal guest.
// The second half is the control that makes the first depend on the vendor reaching the drawing.
const claude = art?.body("claude") ?? "";
const guest = art?.body("nobody-we-know") ?? "";
ok("1.3 art.body(\"claude\") returns Claude's SVG body: the pill in Claude's blue",
  claude.startsWith("<g ") && claude.includes('<g fill="#4663E7"') && claude.includes('rx="32"') && claude.includes('<g class="eyes">'),
  { claude: claude.slice(0, 160) });
ok("1.4 CONTROL: an unknown vendor draws the guest, not Claude",
  guest.includes('<g fill="#8FD0C8"') && !guest.includes("#4663E7"), { guest: guest.slice(0, 160) });
const mark = art?.mark("#202B43") ?? "";
ok("1.5 art.mark(fill) returns a whole <svg> with every path in that fill",
  mark.startsWith("<svg ") && mark.endsWith("</svg>") && (mark.match(/<path /g) ?? []).length > 0
    && (mark.match(/<path /g) ?? []).length === (mark.match(/fill="#202B43"/g) ?? []).length,
  { mark: mark.slice(0, 160) });

// ── 2. THE CENSUS ────────────────────────────────────────────────────────────────────────────────
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "client", "src");
const DOM_NAMES = new Set(["window", "document", "fetch", "EventSource"]);
/** The directories whose modules the suites import under Node. `art/` counts as `lib/`. */
const NODE_SIDE = /^(?:lib|state|art)\//;
/** Who may name a DOM global anyway, and which. Each is a reason, not a convenience. */
const DOM_EXCEPTIONS: Record<string, Set<string> | "all"> = {
  // Markdown is sanitized by DOMPurify, which needs a DOM. The purifier is made on first render.
  "lib/md.ts": "all",
  // The brand's file, kept byte for byte with brand/characters.js: it publishes `window.CotalArt`.
  "art/characters.js": new Set(["window"]),
  // The seam that lets that file load under Node by giving it a `window` to write to.
  "art/index.ts": new Set(["window"]),
};

interface Finding { file: string; line: number; text: string }

/** Every import of `@cotal-ai/*` that loads a value: a value import, a side-effect import, a
 *  re-export of values, or a dynamic import. */
function valueImports(file: string, sf: ts.SourceFile): Finding[] {
  const out: Finding[] = [];
  const at = (node: ts.Node) => ({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: node.getText(sf).slice(0, 120) });
  const ours = (spec: ts.Expression | undefined) => !!spec && ts.isStringLiteralLike(spec) && spec.text.startsWith("@cotal-ai/");
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ours(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const typesOnly = clause !== undefined && (clause.isTypeOnly
        || (clause.name === undefined && named !== undefined && ts.isNamedImports(named)
          && named.elements.length > 0 && named.elements.every((el) => el.isTypeOnly)));
      if (!typesOnly) out.push(at(node));
    }
    if (ts.isExportDeclaration(node) && ours(node.moduleSpecifier)) {
      const clause = node.exportClause;
      const typesOnly = node.isTypeOnly
        || (clause !== undefined && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((el) => el.isTypeOnly));
      if (!typesOnly) out.push(at(node));
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ours(node.arguments[0])) out.push(at(node));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Every identifier spelled as a DOM global, in any position: a reference, a property
 *  (`globalThis.fetch`) or a declaration. A comment or a string is not an identifier. */
function domNames(file: string, sf: ts.SourceFile, allowed: Set<string> | "all" | undefined): Finding[] {
  if (allowed === "all") return [];
  const out: Finding[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && DOM_NAMES.has(node.text) && !allowed?.has(node.text))
      out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: node.text });
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const kindOf = (file: string) =>
  file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".ts") ? ts.ScriptKind.TS : file.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
const parse = (file: string, text: string) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kindOf(file));

const walked: string[] = [];
const imports: Finding[] = [];
const touches: Finding[] = [];
for (const entry of readdirSync(SRC, { recursive: true })) {
  const file = String(entry).replaceAll("\\", "/");
  if (!/\.(?:tsx?|jsx?|mts|mjs)$/.test(file)) continue;
  const sf = parse(file, readFileSync(join(SRC, file), "utf8"));
  walked.push(file);
  imports.push(...valueImports(file, sf));
  if (NODE_SIDE.test(file)) touches.push(...domNames(file, sf, DOM_EXCEPTIONS[file]));
}

ok("2.1 CONTROL: the census walked the client source, lib, state and art included",
  walked.some((f) => f.startsWith("lib/")) && walked.some((f) => f.startsWith("state/")) && walked.some((f) => f.startsWith("art/")) && walked.includes("Shell.tsx"),
  walked);
ok("2.2 no client module loads a value from @cotal-ai/*: only `import type`, or type-only specifiers", imports.length === 0, imports);
ok("2.3 no module under lib/, state/ or art/ names window, document, fetch or EventSource, outside the named exceptions", touches.length === 0, touches);

// The checks themselves, on known input, so 2.2 and 2.3 cannot pass by finding nothing anywhere.
const probe = (text: string, file = "lib/probe.ts") => ({
  imports: valueImports(file, parse(file, text)).length,
  dom: domNames(file, parse(file, text), DOM_EXCEPTIONS[file]).length,
});
ok("2.4 CONTROL: a value import, a side-effect import, a value re-export and a dynamic import of @cotal-ai/core are each found",
  [
    'import { parseSubject } from "@cotal-ai/core";',
    'import "@cotal-ai/core";',
    'import core, { type X } from "@cotal-ai/core";',
    'export { parseSubject } from "@cotal-ai/core";',
    'const core = await import("@cotal-ai/core");',
  ].every((t) => probe(t).imports === 1));
ok("2.5 CONTROL: `import type` and all-type specifiers are not",
  ['import type { CotalMessage } from "@cotal-ai/core";', 'import { type CotalMessage, type Presence } from "@cotal-ai/core";',
    'export type { CotalMessage } from "@cotal-ai/core";'].every((t) => probe(t).imports === 0));
ok("2.6 CONTROL: a call to fetch, globalThis.fetch, document and new EventSource are each found, and a comment or string is not",
  probe('fetch("/api/meta");').dom === 1 && probe("globalThis.fetch(url);").dom === 1 && probe("document.title = t;").dom === 1
    && probe('new EventSource("/feed");').dom === 1 && probe('// fetch(\nconst s = "window";').dom === 0);

console.log(`\nweb client-boundary smoke: ${cells - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
