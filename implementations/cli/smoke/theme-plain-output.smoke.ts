/**
 * Theme plain-output smoke (no NATS, no test runner): pnpm --filter @cotal-ai/cli test
 *
 * `lib/theme.ts` reads `colorEnabled()` from @cotal-ai/workspace once, at import, and its helpers
 * emit ANSI only when that was true. The rule itself is covered by the workspace color-enabled
 * smoke; this one checks the theme follows it. Each case imports theme.ts in a fresh child with
 * stdout piped, `isTTY` pinned before the import, and FORCE_COLOR, NO_COLOR and NODE_DISABLE_COLORS
 * scrubbed so nothing inherited decides the case. The TTY case is the positive control: without it a
 * theme that never colours would pass every other cell.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { emitSentinel } from "@cotal-ai/smoke-kit";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const THEME = pathToFileURL(join(HERE, "..", "src", "lib", "theme.ts")).href;

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ FAIL: ${label}`, extra === undefined ? "" : JSON.stringify(extra)); }
}

function render(tty: boolean, pins: { FORCE_COLOR?: string; NO_COLOR?: string } = {}): { bold: string; dim: string } {
  const code = `Object.defineProperty(process.stdout, "isTTY", { value: ${tty}, configurable: true });
const t = await import(${JSON.stringify(THEME)});
process.stdout.write(JSON.stringify({ bold: t.bold("x"), dim: t.dim("x") }));`;
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  delete env.NODE_DISABLE_COLORS;
  Object.assign(env, pins);
  const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: ROOT, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`theme child exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout) as { bold: string; dim: string };
}

console.log("1. a TTY with nothing set gets ANSI (positive control)");
const tty = render(true);
check("bold wraps in SGR 1", tty.bold === "\x1b[1mx\x1b[0m", tty);
check("dim wraps in SGR 2", tty.dim === "\x1b[2mx\x1b[0m", tty);

console.log("2. NO_COLOR turns it off even on a TTY");
const noColor = render(true, { NO_COLOR: "1" });
check("NO_COLOR=1 on a TTY renders bold as plain text", noColor.bold === "x", noColor);
check("NO_COLOR=1 on a TTY renders dim as plain text", noColor.dim === "x", noColor);

console.log("3. piped output is plain");
const piped = render(false);
check("a non-TTY stdout renders bold as plain text", piped.bold === "x", piped);
check("a non-TTY stdout renders dim as plain text", piped.dim === "x", piped);

console.log("4. FORCE_COLOR reaches the theme");
const forced = render(false, { FORCE_COLOR: "1" });
check("FORCE_COLOR=1 colors a piped theme", forced.bold === "\x1b[1mx\x1b[0m", forced);
const forceOff = render(true, { FORCE_COLOR: "0" });
check("FORCE_COLOR=0 on a TTY renders the theme plain", forceOff.bold === "x", forceOff);

console.log(`\n${fail === 0 ? "THEME-PLAIN-OUTPUT SMOKE OK ✅" : "THEME-PLAIN-OUTPUT SMOKE FAILED ❌"} (${pass} passed, ${fail} failed)`);
emitSentinel({ passed: pass, failed: fail });
process.exit(fail === 0 ? 0 : 1);
