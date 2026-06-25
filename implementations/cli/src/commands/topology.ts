import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { loadManifest, renderTopology, ManifestError } from "../lib/manifest/index.js";
import { c } from "../ui.js";

/**
 * `cotal topology view -f cotal.yaml` — validate a mesh manifest and print its access graph:
 * per-channel and per-agent subscribe/read/post (with humane labels), any persona-inherited
 * unmanaged scopes, and warnings. Read-only — it mutates nothing and needs no running broker, so
 * it's the safe way to see what `up -f` / `spawn -f` WOULD launch.
 */
export async function topology(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub !== "view") {
    console.error(c.red(`✗ unknown topology subcommand "${sub ?? ""}" — expected: view`));
    console.error(c.dim("cotal topology view -f <cotal.yaml>"));
    process.exit(1);
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { file: { type: "string", short: "f" } },
  });
  const file = values.file ?? positionals[0];
  if (!file) {
    console.error(c.red("✗ a manifest file is required — `cotal topology view -f <cotal.yaml>`"));
    process.exit(1);
  }
  try {
    const prepared = loadManifest(resolve(file));
    console.log(renderTopology(prepared));
  } catch (e) {
    failManifest(e);
  }
}

/** Print a manifest/file error as one red block (located issues for a ManifestError) and exit 1. */
export function failManifest(e: unknown): never {
  if (e instanceof ManifestError) console.error(c.red(e.message));
  else if ((e as NodeJS.ErrnoException)?.code === "ENOENT")
    console.error(c.red(`✗ manifest file not found: ${(e as NodeJS.ErrnoException).path ?? ""}`));
  else console.error(c.red(`✗ ${(e as Error).message}`));
  process.exit(1);
}
