import { Text } from "ink";

const BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** The glyphs for the most-recent `width` values: block bars ▁▂▃▄▅▆▇█, each scaled to the series'
 *  own max (so a quiet mesh and a busy one both fill the bars), left-padded with zeros so the bar
 *  is always full-width. A non-finite or negative value would poison the max and skew every bar:
 *  clamped to zero, not trusted. Pure, so the scaling can be proven without a terminal. */
export function sparkline(values: number[], width = 15): string {
  const recent = values.slice(-width).map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const padded = recent.length < width ? [...new Array(width - recent.length).fill(0), ...recent] : recent;
  const max = Math.max(0, ...padded);
  return padded
    .map((v) => BARS[max <= 0 ? 0 : Math.min(BARS.length - 1, Math.round((v / max) * (BARS.length - 1)))])
    .join("");
}

/** A compact, self-scaling unicode sparkline (see {@link sparkline}). Fixed width: it shows only
 *  the most recent buckets, never grows with the terminal. */
export function Sparkline({
  values,
  width = 15,
  color = "cyan",
}: {
  values: number[];
  width?: number;
  color?: string;
}) {
  return <Text color={color}>{sparkline(values, width)}</Text>;
}
