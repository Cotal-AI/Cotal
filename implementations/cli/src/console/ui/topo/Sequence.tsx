import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { FeedEntry } from "../../mesh.js";
import { agentColor, fmtTime, STATUS } from "../theme.js";
import { targetsOf, type TopoGraph } from "./model.js";
import { blankRow, stamp, toSegments, type Cell, type CellStyle } from "./raster.js";

const MIN_LANE_W = 13;
const FOLD = "__fold__";

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s);

/**
 * Variant ① — sequence/swimlanes. One lane per active agent, time flowing down; each
 * message is a row with an arrow spanning sender → target lane (`├──▶`), channel/role
 * sends running to the right edge (`├──▶` + label in the annotation column). Rows dim
 * with age; surplus lanes fold into a `…+k` lane. j/k select, Enter opens the message.
 */
export function Sequence({
  feed,
  graph,
  width,
  height,
  active,
  onOpenMessage,
}: {
  feed: FeedEntry[];
  graph: TopoGraph;
  width: number;
  height: number;
  active: boolean;
  onOpenMessage: (e: FeedEntry) => void;
}) {
  const entries = feed.filter((e) => e.ts >= graph.now - graph.windowMs);
  const lanes = graph.nodes.filter((n) => n.kind === "agent" && n.lastTs > 0);

  // Lane geometry: keep the busiest lanes, fold the rest into one dim `…+k` column.
  const annotW = Math.min(46, Math.max(16, Math.floor(width * 0.38)));
  const laneRegionW = width - annotW - 1;
  const maxLanes = Math.max(2, Math.floor(laneRegionW / MIN_LANE_W));
  const folded = lanes.length > maxLanes ? lanes.length - (maxLanes - 1) : 0;
  const kept = folded
    ? [...lanes].sort((a, b) => b.lastTs - a.lastTs).slice(0, maxLanes - 1)
    : lanes;
  const keptOrdered = lanes.filter((n) => kept.includes(n));
  const laneKeys = [...keptOrdered.map((n) => n.key), ...(folded ? [FOLD] : [])];
  const laneW = Math.max(1, Math.floor(laneRegionW / Math.max(1, laneKeys.length)));
  const centerOf = (key: string) => {
    let i = laneKeys.indexOf(key);
    if (i < 0) i = laneKeys.length - 1; // not kept → the fold lane
    return i * laneW + Math.floor(laneW / 2);
  };

  // Selection follows the tail (like the feed) unless the user moved off it.
  const [sel, setSel] = useState(0);
  const prevLen = useRef(0);
  useEffect(() => {
    if (entries.length !== prevLen.current) {
      setSel((s) => (s >= prevLen.current - 1 ? Math.max(0, entries.length - 1) : Math.min(s, entries.length - 1)));
      prevLen.current = entries.length;
    }
  }, [entries.length]);
  const selClamped = Math.min(sel, Math.max(0, entries.length - 1));

  useInput(
    (input, key) => {
      if (key.upArrow || input === "k") setSel(Math.max(0, selClamped - 1));
      else if (key.downArrow || input === "j") setSel(Math.min(entries.length - 1, selClamped + 1));
      else if (input === "g" || key.home) setSel(0);
      else if (input === "G" || key.end) setSel(Math.max(0, entries.length - 1));
      else if (key.return && entries.length) onOpenMessage(entries[selClamped]);
    },
    { isActive: active },
  );

  if (!entries.length || !lanes.length)
    return <Text dimColor>(no traffic in the window - waiting for peer messages)</Text>;

  const room = Math.max(1, height - 1); // header row
  const top = Math.max(0, Math.min(selClamped - room + 1, entries.length - room));
  const visible = entries.slice(top, top + room);

  // Header: one cell per lane — status glyph + colored name.
  const header = blankRow(laneRegionW);
  for (const n of keptOrdered) {
    const glyph = STATUS[n.status ?? "offline"];
    const x = centerOf(n.key) - Math.floor(Math.min(laneW - 1, n.name.length + 2) / 2);
    stamp(header, x, glyph.dot, { color: glyph.color });
    stamp(header, x + 2, trunc(n.name, laneW - 3), { color: agentColor(n.name) });
  }
  if (folded) stamp(header, centerOf(FOLD) - 1, "…+" + folded, { dim: true });

  const rowFor = (e: FeedEntry): { cells: Cell[]; plain: string } => {
    const aged = graph.now - e.ts > 45_000;
    const cells = blankRow(laneRegionW);
    for (const key of laneKeys) stamp(cells, centerOf(key), "│", { dim: true });
    const style: CellStyle = { color: agentColor(e.from.name), dim: aged, bold: graph.now - e.ts < 10_000 };
    const s = centerOf("a:" + e.from.name);
    if (e.delivery === "unicast") {
      const targets = targetsOf(e).map((t) => centerOf(t.key));
      const lo = Math.min(s, ...targets);
      const hi = Math.max(s, ...targets);
      for (let x = lo; x <= hi; x++) stamp(cells, x, "─", style);
      stamp(cells, s, targets.every((t) => t < s) ? "┤" : "├", style);
      for (const t of targets) stamp(cells, t, t > s ? "▶" : "◀", style);
    } else {
      // multicast / anycast: run to the right edge, label lands in the annotation column.
      for (let x = s + 1; x < laneRegionW - 1; x++) stamp(cells, x, "─", style);
      stamp(cells, s, "├", style);
      stamp(cells, laneRegionW - 1, "▶", style);
    }
    return { cells, plain: cells.map((c) => c.ch).join("") };
  };

  const annotFor = (e: FeedEntry) => {
    const label =
      e.delivery === "multicast"
        ? { text: "#" + (e.channel ?? "?"), color: "cyan" }
        : e.delivery === "anycast"
          ? { text: "@" + (e.toService ?? "?"), color: "magenta" }
          : undefined;
    const burst = e.count && e.count > 1 ? ` (${e.count}×)` : "";
    return { label, time: fmtTime(e.ts), text: e.text + burst };
  };

  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">{toSegments(header).map((s, i) => (
        <Text key={i} color={s.color} dimColor={s.dim} bold={s.bold}>
          {s.text}
        </Text>
      ))}</Text>
      {visible.map((e, i) => {
        const selected = active && top + i === selClamped;
        const { cells, plain } = rowFor(e);
        const a = annotFor(e);
        if (selected)
          return (
            <Text key={e.id} inverse bold color="cyan" wrap="truncate-end">
              {plain + " " + a.time + " " + (a.label ? a.label.text + " " : "") + a.text}
            </Text>
          );
        return (
          <Text key={e.id} wrap="truncate-end">
            {toSegments(cells).map((s, j) => (
              <Text key={j} color={s.color} dimColor={s.dim} bold={s.bold}>
                {s.text}
              </Text>
            ))}
            <Text dimColor>{" " + a.time + " "}</Text>
            {a.label ? <Text color={a.label.color}>{a.label.text + " "}</Text> : null}
            <Text dimColor={graph.now - e.ts > 45_000}>{a.text}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
