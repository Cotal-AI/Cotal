/**
 * Boundary guard: nothing under `packages/core/src/**` may import `@cotal-ai/workspace`.
 *
 * `@cotal-ai/core` is the wire standard; the machine-local workstation layer (`@cotal-ai/workspace`)
 * depends on core, never the reverse. A core→workspace import would re-fuse the two faces this split
 * exists to separate — and introduce a dependency cycle. Keeps the boundary honest, not decorative.
 * Broker-free; runs in the `check` gate and CI.
 * Run: pnpm smoke:core-boundary
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const coreSrc = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const files = tsFiles(coreSrc);
const offenders = files.filter((f) => /["']@cotal-ai\/workspace["']/.test(readFileSync(f, "utf8")));

if (offenders.length) {
  console.error("✗ core must not import @cotal-ai/workspace — the dependency runs workspace → core:");
  for (const f of offenders) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`core-boundary smoke: ${files.length} core/src files scanned, 0 import @cotal-ai/workspace`);
process.exit(0);
