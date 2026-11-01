import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

/** Read the generated payload through the same synchronous loader the connectors ship.
 *  The generator's --out uses .mts here so temporary directories need no package.json. */
export function readGeneratedDocsBundle(path) {
  const script = `
    const { loadDocsBundle } = await import(${JSON.stringify(pathToFileURL(path).href)});
    process.stdout.write(JSON.stringify(loadDocsBundle()));
  `;
  return JSON.parse(execFileSync(process.execPath, [
    "--import", require.resolve("tsx/esm"), "--input-type=module", "--eval", script,
  ], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }));
}
