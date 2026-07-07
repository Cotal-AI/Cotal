import { Text } from "ink";

const BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** A compact, self-scaling unicode sparkline. Renders the most-recent `width` values as block
 *  bars ▁▂▃▄▅▆▇█, each scaled to the series' own max (so a quiet mesh and a busy one both fill
 *  the bars). Fixed width — it shows only the most recent buckets, never grows with the terminal. */
export function Sparkline({
  values,
  width = 15,
  color = "cyan",
}: {
  values: number[];
  width?: number;
  color?: string;
}) {
  // Most-recent `width` buckets, left-padded with zeros so the bar is always full-width. A
  // non-finite or negative value would poison the max and skew every bar — clamp, don't trust.
  const recent = values.slice(-width).map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const padded = recent.length < width ? [...new Array(width - recent.length).fill(0), ...recent] : recent;
  const max = Math.max(0, ...padded);
  const spark = padded
    .map((v) => BARS[max <= 0 ? 0 : Math.min(BARS.length - 1, Math.round((v / max) * (BARS.length - 1)))])
    .join("");
  return <Text color={color}>{spark}</Text>;
}
