import { existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
for (const path of ["packages/core", "packages/lang", "packages/workspace", "implementations/auth", "implementations/manager", "implementations/runtime", "bin"]) {
  const configPath = join(root, path, "tsconfig.json");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new Error(`session smoke cannot read build configuration: ${path}`);
  const config = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath));
  if (!config.options.rootDir || !config.options.outDir) throw new Error(`session smoke requires explicit build roots: ${path}`);
  for (const source of config.fileNames) {
    if (!/\.(?:ts|tsx|mts|cts)$/.test(source) || /\.d\.(?:ts|mts|cts)$/.test(source)) continue;
    const output = join(config.options.outDir, relative(config.options.rootDir, source)).replace(/\.(?:ts|tsx)$/, ".js").replace(/\.mts$/, ".mjs").replace(/\.cts$/, ".cjs");
    if (!existsSync(output) || statSync(output).mtimeMs < statSync(source).mtimeMs)
      throw new Error(`session smoke build is missing or stale for ${relative(root, source)}; run pnpm build before this suite`);
  }
}
