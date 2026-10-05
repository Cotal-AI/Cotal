/**
 * Cotal brand palette for the terminal setup flow. Colors match the web dashboard
 * (implementations/cli/src/web/index.html): brand blue #58a6ff, success green #3fb950.
 *
 * Rendering gates (same as the rest of the CLI's color story):
 *   - `colorEnabled()` is false            → plain text, no ANSI (no TTY, NO_COLOR, FORCE_COLOR=0)
 *   - COLORTERM truecolor/24bit            → 24-bit ANSI (exact brand color)
 *   - otherwise                            → 16-color fallback
 */
import * as p from "@clack/prompts";
import { colorEnabled } from "@cotal-ai/workspace";

const USE_ANSI = colorEnabled();
const TRUECOLOR =
  USE_ANSI && (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit");

const BRAND = [88, 166, 255] as const; // #58a6ff
const GREEN = [63, 185, 80] as const; // #3fb950

function rgb([r, g, b]: readonly [number, number, number], s: string, bold = false): string {
  if (!USE_ANSI) return s;
  if (TRUECOLOR) return `\x1b[${bold ? "1;" : ""}38;2;${r};${g};${b}m${s}\x1b[0m`;
  return `\x1b[${bold ? "1;" : ""}34m${s}\x1b[0m`; // 16-color blue/green fallback
}

export const brand = (s: string) => rgb(BRAND, s);
export const brandBold = (s: string) => rgb(BRAND, s, true);
export const ok = (s: string) => (USE_ANSI ? (TRUECOLOR ? rgb(GREEN, s) : `\x1b[32m${s}\x1b[0m`) : s);
export const dim = (s: string) => (USE_ANSI ? `\x1b[2m${s}\x1b[0m` : s);
export const bold = (s: string) => (USE_ANSI ? `\x1b[1m${s}\x1b[0m` : s);

/** Multi-line strings get colored line-by-line so the SGR reset doesn't bleed across
 *  clack's `│` gutter prefix. Used as the `format` callback for `note()` bodies. */
export const brandBody = (s: string): string =>
  s
    .split("\n")
    .map((line) => (line.length ? brand(line) : line))
    .join("\n");

/** Elapsed-time suffix for spinners: `47s` under a minute, `2m 34s` above. */
export function fmtDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

/** Truncate to the terminal width (minus a gutter) so live-pane lines never wrap. */
export function fit(s: string, gutter = 4): string {
  const width = Math.max(20, (process.stdout.columns ?? 80) - gutter);
  return s.length > width ? `${s.slice(0, width - 1)}…` : s;
}

/** A branded `p.note` (body in brand color). */
export function note(message: string, title?: string): void {
  p.note(message, title, { format: brandBody });
}

const WORDMARK = String.raw`
            _        _
   ___ ___ | |_ __ _| |
  / __/ _ \| __/ _` + "`" + String.raw`| |
 | (_| (_) | || (_| | |
  \___\___/ \__\__,_|_|`;

/** First-run splash: brand wordmark + tagline + rule. No-op detail when ANSI is off
 *  still prints the plain wordmark so piped logs stay legible. */
export function splash(): void {
  const rule = "─".repeat(Math.min(44, (process.stdout.columns ?? 80) - 2));
  process.stdout.write(`${brand(WORDMARK)}\n\n   ${dim("the web for agents")}\n  ${brand(rule)}\n\n`);
}
