/**
 * Theme plain-output smoke (no NATS, no test runner): pnpm --filter @cotal-ai/cli test
 *
 * `lib/theme.ts` decides once, at import, whether its helpers emit ANSI: only when stdout is a TTY
 * and `NO_COLOR` is unset or empty. Each case imports it in a fresh child with stdout piped and
 * `isTTY` pinned before the import, then reports what `bold` and `dim` returned. The TTY case is
 * the positive control: without it a theme that never colours would pass every other cell.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const THEME = pathToFileURL(join(HERE, "..", "src", "lib", "theme.ts")).href;

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ FAIL: ${label}`, extra === undefined ? "" : JSON.stringify(extra)); }
}

function render(tty: boolean, noColor: string | undefined): { bold: string; dim: string } {
  const code = `Object.defineProperty(process.stdout, "isTTY", { value: ${tty} });
const t = await import(${JSON.stringify(THEME)});
process.stdout.write(JSON.stringify({ bold: t.bold("x"), dim: t.dim("x") }));`;
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NO_COLOR;
  if (noColor !== undefined) env.NO_COLOR = noColor;
  const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: ROOT, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`theme child exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout) as { bold: string; dim: string };
}

console.log("1. a TTY with NO_COLOR unset gets ANSI (positive control)");
const tty = render(true, undefined);
check("bold wraps in SGR 1", tty.bold === "\x1b[1mx\x1b[0m", tty);
check("dim wraps in SGR 2", tty.dim === "\x1b[2mx\x1b[0m", tty);

console.log("2. NO_COLOR turns it off even on a TTY");
const noColor = render(true, "1");
check("NO_COLOR=1 on a TTY renders bold as plain text", noColor.bold === "x", noColor);
check("NO_COLOR=1 on a TTY renders dim as plain text", noColor.dim === "x", noColor);

console.log("3. piped output is plain");
const piped = render(false, undefined);
check("a non-TTY stdout renders bold as plain text", piped.bold === "x", piped);
check("a non-TTY stdout renders dim as plain text", piped.dim === "x", piped);

console.log("4. an empty NO_COLOR does not count as set");
const empty = render(true, "");
check("NO_COLOR= on a TTY still colours", empty.bold === "\x1b[1mx\x1b[0m", empty);

console.log(`\n${fail === 0 ? "THEME-PLAIN-OUTPUT SMOKE OK ✅" : "THEME-PLAIN-OUTPUT SMOKE FAILED ❌"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
