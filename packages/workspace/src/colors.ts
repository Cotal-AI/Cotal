let colorDisabled = false;

/** `--no-color`: no ANSI color for the rest of this process, whatever the environment says. It is
 *  process state rather than `NO_COLOR`, so it does not reach the children a command starts. */
export function disableColor(): void {
  colorDisabled = true;
}

/** Whether operator output gets ANSI color. `--no-color` wins. Then a set `FORCE_COLOR` is checked,
 *  the order Node uses: `0` or `false` turns color off and any other value turns it on. Otherwise a
 *  non-empty `NO_COLOR` turns it off (no-color.org), and color follows whether stdout is a terminal.
 *  Read on every call, so a process that sets these after import is still honoured. */
export function colorEnabled(): boolean {
  if (colorDisabled) return false;
  const force = process.env.FORCE_COLOR;
  if (force !== undefined) return force !== "0" && force !== "false";
  if (process.env.NO_COLOR) return false;
  return Boolean(process.stdout.isTTY);
}

const sgr = (code: string) => (s: string) => (colorEnabled() ? `\x1b[${code}m${s}\x1b[0m` : s);

/** ANSI color helpers for operator-facing terminal output — shared by every command surface
 *  (@cotal-ai/cli, @cotal-ai/web, the manager, the delivery daemon) so they render identically
 *  and all honour `colorEnabled`. Workstation-layer concern: the wire protocol in core never prints. */
export const c = {
  dim: sgr("2"),
  bold: sgr("1"),
  green: sgr("32"),
  cyan: sgr("36"),
  yellow: sgr("33"),
  red: sgr("31"),
  magenta: sgr("35"),
  gray: sgr("90"),
};

/** 256-color foreground wrapper (xterm color index 0-255). */
export const color256 = (n: number) => sgr(`38;5;${n}`);
