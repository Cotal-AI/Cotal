/**
 * Color rule smoke (no NATS, no test runner): pnpm --filter @cotal-ai/workspace test
 *
 * `colorEnabled()` decides whether operator output gets ANSI, and every `c.*` helper asks it on
 * each call: a set `FORCE_COLOR` decides first (`0` and `false` off, anything else on), then a
 * non-empty `NO_COLOR` turns color off, and otherwise color follows `process.stdout.isTTY`. Each
 * case pins those three, then checks the rule and what `c.bold` and `color256` return. The plain
 * TTY case is the positive control: without it a helper that never colors passes every other cell.
 */
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { c, color256, colorEnabled } from "../src/colors.js";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ FAIL: ${label}`, extra === undefined ? "" : JSON.stringify(extra)); }
}

const saved = { tty: Object.getOwnPropertyDescriptor(process.stdout, "isTTY"), env: { ...process.env } };
function pin(tty: boolean, env: { FORCE_COLOR?: string; NO_COLOR?: string }): { on: boolean; bold: string; c256: string } {
  Object.defineProperty(process.stdout, "isTTY", { value: tty, configurable: true });
  delete process.env.FORCE_COLOR;
  delete process.env.NO_COLOR;
  delete process.env.NODE_DISABLE_COLORS;
  Object.assign(process.env, env);
  return { on: colorEnabled(), bold: c.bold("x"), c256: color256(208)("x") };
}

const BOLD = "\x1b[1mx\x1b[0m";
const C256 = "\x1b[38;5;208mx\x1b[0m";

try {
  console.log("1. a TTY with nothing set gets color (positive control)");
  const tty = pin(true, {});
  check("a TTY with no env colors c.bold", tty.on && tty.bold === BOLD, tty);
  check("a TTY with no env colors color256", tty.c256 === C256, tty);

  console.log("2. NO_COLOR and piped stdout turn it off");
  const noColor = pin(true, { NO_COLOR: "1" });
  check("NO_COLOR=1 on a TTY is plain", !noColor.on && noColor.bold === "x" && noColor.c256 === "x", noColor);
  const piped = pin(false, {});
  check("a non-TTY stdout is plain", !piped.on && piped.bold === "x" && piped.c256 === "x", piped);
  const empty = pin(true, { NO_COLOR: "" });
  check("an empty NO_COLOR on a TTY still colors", empty.on && empty.bold === BOLD, empty);

  console.log("3. FORCE_COLOR decides first");
  const forced = pin(false, { FORCE_COLOR: "1" });
  check("FORCE_COLOR=1 colors a non-TTY stdout", forced.on && forced.bold === BOLD, forced);
  const forcedOverNoColor = pin(false, { FORCE_COLOR: "1", NO_COLOR: "1" });
  check("FORCE_COLOR=1 wins over NO_COLOR=1", forcedOverNoColor.on && forcedOverNoColor.bold === BOLD, forcedOverNoColor);
  const forceOff = pin(true, { FORCE_COLOR: "0" });
  check("FORCE_COLOR=0 on a TTY is plain", !forceOff.on && forceOff.bold === "x", forceOff);
  const forceFalse = pin(true, { FORCE_COLOR: "false" });
  check("FORCE_COLOR=false on a TTY is plain", !forceFalse.on && forceFalse.bold === "x", forceFalse);
} finally {
  if (saved.tty) Object.defineProperty(process.stdout, "isTTY", saved.tty);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
  for (const k of ["FORCE_COLOR", "NO_COLOR", "NODE_DISABLE_COLORS"]) {
    if (saved.env[k] === undefined) delete process.env[k];
    else process.env[k] = saved.env[k];
  }
}

console.log(`\n${fail === 0 ? "COLOR-ENABLED SMOKE OK ✅" : "COLOR-ENABLED SMOKE FAILED ❌"} (${pass} passed, ${fail} failed)`);
emitSentinel({ passed: pass, failed: fail });
process.exit(fail === 0 ? 0 : 1);
