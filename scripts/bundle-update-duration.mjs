import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';
const { build } = createRequire(new URL('../extensions/connector-jcode/package.json', import.meta.url))('esbuild');
const output = process.argv[2];
assert(output);
await build({ entryPoints: ['scripts/measure-update-duration.mjs'], bundle: true, platform: 'node', format: 'esm', outfile: output,
  banner: { js: 'import {createRequire as __createRequire} from "node:module";const require=__createRequire(import.meta.url);' },
  plugins: [{ name: 'matrix-library-only', setup(builder) {
    builder.onLoad({ filter: /(?:automatic-update-platform-baseline|upgrade-matrix-plan)\.mjs$/ }, args => {
      const source = readFileSync(args.path, 'utf8');
      const marker = args.path.endsWith('upgrade-matrix-plan.mjs') ? 'if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {' : 'if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {';
      const start = source.indexOf(marker);
      assert(start > 0 && source.indexOf(marker, start + 1) === -1);
      return { contents: source.slice(0, start), loader: 'js', resolveDir: dirname(args.path) };
    });
  } }],
});
