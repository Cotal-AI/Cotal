import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { oneLine } from "@cotal-ai/core";
import { hostPackageDir } from "./extensions.js";

const semver = createRequire(import.meta.url)("semver") as {
  valid(version: string): string | null;
  validRange(range: string): string | null;
  satisfies(version: string, range: string, opts: { includePrerelease: boolean }): boolean;
};

function checkoutProcessEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  let dir: string;
  try {
    const resolved = realpathSync(entry);
    if (/[/\\]_npx[/\\]/.test(resolved)) return false;
    dir = dirname(resolved);
  } catch {
    return false;
  }
  for (;;) {
    const pj = join(dir, "package.json");
    if (existsSync(pj)) {
      try {
        if ((JSON.parse(readFileSync(pj, "utf8")) as { name?: unknown }).name !== "cotal-ai") return false;
      } catch {
        return false;
      }
      const parent = dirname(dir);
      return basename(dir) === "bin" && (existsSync(join(parent, "implementations")) || existsSync(join(parent, "pnpm-workspace.yaml")));
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** Why `range` cannot pair `pkg` with the host's `@cotal-ai/core`, or undefined when compatible. */
export function extensionCorePeerProblem(
  pkg: string,
  range: unknown,
  opts: { checkout?: boolean } = {},
): string | undefined {
  if (range === "*") return undefined;
  const core = "@cotal-ai/core";
  if (range === undefined) {
    return `${oneLine(pkg)} does not declare ${core} as a peerDependency - a cotal CLI extension must (its extension objects register into core's registry)`;
  }
  const coreDir = hostPackageDir(core);
  const { version } = JSON.parse(readFileSync(join(coreDir, "package.json"), "utf8")) as { version: string };
  const declaration = `${oneLine(pkg)} declares ${core} ${oneLine(JSON.stringify(range))}`;
  if (typeof range !== "string" || semver.validRange(range) === null) {
    return `${declaration}, which is not a valid version range. This CLI ships ${core} ${oneLine(version)}. Use an extension build with a valid range, or correct it in the local package.json before adding it again.`;
  }
  const parsed = semver.valid(version);
  const checkout = opts.checkout ?? (checkoutProcessEntry() || !/(^|[/\\])node_modules[/\\]/.test(coreDir));
  if ((parsed === "0.0.0" || parsed?.startsWith("0.0.0-")) && checkout) return undefined;
  if (semver.satisfies(version, range, { includePrerelease: true })) return undefined;
  return `${declaration}, but this CLI ships ${core} ${oneLine(version)}. Use an extension build that supports this core, or list CLI releases with \`npm view cotal-ai versions --json\` and choose one that satisfies the range.`;
}
