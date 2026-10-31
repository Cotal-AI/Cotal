import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Read the generated payload through the same synchronous loader the connectors ship.
 *  The generator's --out uses .mts here so temporary directories need no package.json. */
export function readGeneratedDocsBundle(path) {
  const script = `
    import { pathToFileURL } from "node:url";
    const { loadDocsBundle } = await import(pathToFileURL(process.argv[1]).href);
    process.stdout.write(JSON.stringify(loadDocsBundle()));
  `;
  return JSON.parse(execFileSync(process.execPath, [
    "--import", require.resolve("tsx/esm"), "--input-type=module", "--eval", script, path,
  ], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }));
}
