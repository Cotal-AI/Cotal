import { cachedPreferences, resolvePreference, type Preferences } from "./preferences.js";

let colorDisabled = false;

/** `--no-color`: no ANSI color for the rest of this process, whatever the environment says. It sets
 *  no `NO_COLOR`, so the children a command starts keep their own color. Libraries that color
 *  through `node:util` (the prompts) ask the terminal stream, or a set `FORCE_COLOR` before it, so
 *  the streams report no color and `FORCE_COLOR` is dropped: a child is no longer forced into color. */
export function disableColor(): void {
  colorDisabled = true;
  delete process.env.FORCE_COLOR;
  for (const stream of [process.stdout, process.stderr]) {
    if (!stream.isTTY) continue;
    stream.getColorDepth = () => 1;
    stream.hasColors = () => false;
  }
}

/** Whether operator output gets ANSI color. `--no-color` wins. Then the `color` preference decides,
 *  through the one resolver `cotal config` shows: a set `FORCE_COLOR` (`0` or `false` is off, any
 *  other value on), a non-empty `NO_COLOR` (off), the saved preference, and `auto`, where color
 *  follows whether stdout is a terminal. Read on every call, so a process that sets these after
 *  import is still honoured. */
export function colorEnabled(): boolean {
  if (colorDisabled) return false;
  const mode = resolvePreference("color", { preferences: savedOrNone() }).value;
  return mode === "always" || (mode === "auto" && Boolean(process.stdout.isTTY));
}

/** The saved preferences for the color decision. An invalid file stops every command before it runs
 *  (the kernel reads it first), so the only output in that state is that refusal and help, which
 *  are colored as if nothing were saved. */
function savedOrNone(): Preferences {
  try {
    return cachedPreferences();
  } catch {
    return { schemaVersion: 1, revision: 0, defaults: {}, spaces: {} };
  }
}

const sgr = (code: string) => (s: string) => (colorEnabled() ? `\x1b[${code}m${s}\x1b[0m` : s);

/** ANSI color helpers for operator-facing terminal output — shared by every command surface
 *  (@cotal-ai/cli, @cotal-ai/web, the manager, the delivery daemon) so they render identically
 *  and all honour `colorEnabled`. Workstation-layer concern: the wire protocol in core never prints. */
export const c = {
  dim: sgr("2"),
  bold: sgr("1"),
  blue: sgr("34"),
  green: sgr("32"),
  cyan: sgr("36"),
  yellow: sgr("33"),
  red: sgr("31"),
  magenta: sgr("35"),
  gray: sgr("90"),
};

/** 256-color foreground wrapper (xterm color index 0-255). */
export const color256 = (n: number) => sgr(`38;5;${n}`);
