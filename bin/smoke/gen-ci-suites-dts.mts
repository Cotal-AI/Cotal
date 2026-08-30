import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export const DECLARATIONS = [
  {
    module: fileURLToPath(new URL("./ci-suites.mjs", import.meta.url)),
    declaration: fileURLToPath(new URL("./ci-suites.d.mts", import.meta.url)),
  },
  {
    module: fileURLToPath(new URL("./shard-stability.mjs", import.meta.url)),
    declaration: fileURLToPath(new URL("./shard-stability.d.mts", import.meta.url)),
  },
  {
    module: fileURLToPath(new URL("../../scripts/live-job-conclusion.mjs", import.meta.url)),
    declaration: fileURLToPath(new URL("../../scripts/live-job-conclusion.d.mts", import.meta.url)),
  },
] as const;

function options(): ts.CompilerOptions {
  const configPath = fileURLToPath(new URL("../../tsconfig.json", import.meta.url));
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, " "));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath));
  if (parsed.errors.length) throw new Error(ts.flattenDiagnosticMessageText(parsed.errors[0].messageText, " "));
  return { ...parsed.options, allowJs: true, checkJs: true, declaration: true, declarationMap: false, sourceMap: false, emitDeclarationOnly: true };
}

const banner = (modulePath: string) => `// Generated from ${modulePath.split("/").pop()} by gen-ci-suites-dts.mts. Do not edit: run \`pnpm gen:ci-suites-dts\`.\n// The .mjs module is the only source of truth; \`pnpm smoke:ci-declarations\` fails if this drifts.\n\n`;

export function renderDeclaration(modulePath: string): string {
  let emitted: string | undefined;
  const program = ts.createProgram({ rootNames: [modulePath], options: options() });
  const errors = ts.getPreEmitDiagnostics(program).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length) throw new Error(`${modulePath} does not typecheck: ${errors.slice(0, 5).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")).join("; ")}`);
  program.emit(undefined, (_fileName, text) => { emitted = text; });
  if (emitted === undefined) throw new Error(`no declaration emitted for ${modulePath}`);
  emitted = emitted.replace(/^#![^\n]*\n/, "");
  return banner(modulePath) + emitted;
}

export function committed(path: string): string | undefined {
  try { return readFileSync(path, "utf8").replace(/\r\n/g, "\n"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const entry of DECLARATIONS) {
    const text = renderDeclaration(entry.module);
    writeFileSync(entry.declaration, text);
    console.log(`wrote ${entry.declaration} (${text.length} bytes)`);
  }
}
