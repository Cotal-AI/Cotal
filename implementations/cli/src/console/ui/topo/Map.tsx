import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Presence } from "@cotal-ai/core";
import { agentColor, STATUS } from "../theme.js";
import { heatLevel, nodeLabel, type TopoGraph, type TopoNode } from "./model.js";
import { blankGrid, stamp, toSegments, type CellStyle } from "./raster.js";

const MIN_W = 60;
const MIN_H = 14;

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s);

/** Bresenham walk from (x0,y0) to (x1,y1), each step carrying its slope glyph. */
function walk(x0: number, y0: number, x1: number, y1: number): { x: number; y: number; ch: string }[] {
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  const pts: { x: number; y: number; ch: string }[] = [];
  while (!(x === x1 && y === y1) && pts.length < 500) {
    const e2 = 2 * err;
    let mx = false;
    let my = false;
    if (e2 >= dy) (err += dy), (x += sx), (mx = true);
    if (e2 <= dx) (err += dx), (y += sy), (my = true);
    pts.push({ x, y, ch: mx && my ? (sx === sy ? "╲" : "╱") : mx ? "─" : "│" });
  }
  return pts;
}

/**
 * Variant ③ — ring node-link map. Agents sit on an ellipse (name-sorted, so positions
 * don't churn when statuses flip); channels/roles stack in a hub box at the center.
 * Edges rasterize into the char grid, weighted by recency (hot = bold color, stale =
 * dotted dim, gone after ~60s). j/k selects a node and spotlights its incident edges.
 */
export function RingMap({
  graph,
  agents,
  width,
  height,
  active,
  onOpenAgent,
}: {
  graph: TopoGraph;
  agents: Presence[];
  width: number;
  height: number;
  active: boolean;
  onOpenAgent: (p: Presence) => void;
}) {
  const ring = graph.nodes.filter((n) => n.kind === "agent").sort((a, b) => a.name.localeCompare(b.name));
  const hubs = graph.nodes.filter((n) => n.kind !== "agent");
  const selectable = [...ring, ...hubs];

  const [selIdx, setSelIdx] = useState(-1); // -1 = nothing spotlighted
  const sel = selIdx >= 0 && selIdx < selectable.length ? selectable[selIdx] : undefined;

  useInput(
    (input, key) => {
      const n = selectable.length;
      if (!n) return;
      if (key.downArrow || input === "j") setSelIdx((s) => (s + 1) % n);
      else if (key.upArrow || input === "k") setSelIdx((s) => (s <= 0 ? n - 1 : s - 1));
      else if (key.return && sel?.kind === "agent") {
        const p = agents.find((a) => a.card.name === sel.name);
        if (p) onOpenAgent(p);
      }
    },
    { isActive: active },
  );

  if (width < MIN_W || height < MIN_H)
    return (
      <Box flexGrow={1} alignItems="center" justifyContent="center">
        <Text dimColor>(terminal too small for the map - try ② matrix)</Text>
      </Box>
    );
  if (!ring.length) return <Text dimColor>(no agents in the space yet)</Text>;

  // Geometry: labels live on an ellipse, the hub box at the center.
  const labelOf = (n: TopoNode) => {
    const role = n.role && n.role !== n.name ? "/" + n.role : "";
    return STATUS[n.status ?? "offline"].dot + " " + trunc(n.name + role, 22);
  };
  const maxLabel = Math.max(...ring.map((n) => labelOf(n).length));
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  const rx = Math.max(8, Math.floor(width / 2) - Math.ceil(maxLabel / 2) - 1);
  const ry = Math.max(3, Math.floor((height - 2) / 2) - 1);
  const pos = new Map<string, { x: number; y: number }>();
  ring.forEach((n, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / ring.length;
    pos.set(n.key, {
      x: Math.max(1, Math.min(width - 2, Math.round(cx + rx * Math.cos(a)))),
      y: Math.max(0, Math.min(height - 1, Math.round(cy + ry * Math.sin(a)))),
    });
  });
  const hubW = hubs.length ? Math.max(...hubs.map((n) => nodeLabel(n).length)) + 4 : 0;
  const hubH = hubs.length + 2;
  const hubX = cx - Math.floor(hubW / 2);
  const hubY = cy - Math.floor(hubH / 2);
  const hubRow = (key: string) => hubY + 1 + hubs.findIndex((n) => n.key === key);

  const grid = blankGrid(width, height);

  // Edges — ascending by rate so hot traffic overdraws cool; spotlight the selection.
  for (const e of graph.edges) {
    let lvl: number = heatLevel(e.rate);
    if (sel) lvl = e.src === sel.key || e.dst === sel.key ? Math.max(lvl, 2) : lvl - 1;
    if (lvl <= 0) continue;
    const srcNode = graph.byKey.get(e.src);
    const from = pos.get(e.src);
    if (!srcNode || !from) continue;
    let to: { x: number; y: number };
    let head: string;
    if (graph.byKey.get(e.dst)?.kind !== "agent") {
      // Into the hub box: aim at the hub's own line, stop at the nearer border.
      const row = hubRow(e.dst);
      if (from.x < hubX) (to = { x: hubX - 1, y: row }), (head = "▶");
      else if (from.x > hubX + hubW - 1) (to = { x: hubX + hubW, y: row }), (head = "◀");
      else (to = { x: cx, y: from.y < cy ? hubY - 1 : hubY + hubH }), (head = from.y < cy ? "▼" : "▲");
    } else {
      const p = pos.get(e.dst);
      if (!p) continue;
      to = p;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      head = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "▶" : "◀") : dy >= 0 ? "▼" : "▲";
    }
    const style: CellStyle =
      lvl === 1 ? { dim: true } : { color: agentColor(srcNode.name), bold: lvl >= 3 };
    const pts = walk(from.x, from.y, to.x, to.y);
    pts.forEach((p, i) => {
      if (p.y < 0 || p.y >= height) return;
      if (lvl === 1 && i % 2 === 1) return; // stale edges go dotted
      stamp(grid[p.y], p.x, i === pts.length - 1 ? head : p.ch, style);
    });
  }

  // Hub box over the edges, labels over everything.
  if (hubs.length) {
    stamp(grid[hubY], hubX, "┌" + "─".repeat(hubW - 2) + "┐", { dim: true });
    hubs.forEach((n, i) => {
      const row = grid[hubY + 1 + i];
      const selected = sel?.key === n.key;
      stamp(row, hubX, "│", { dim: true });
      stamp(row, hubX + hubW - 1, "│", { dim: true });
      stamp(row, hubX + 2, nodeLabel(n).padEnd(hubW - 4), {
        color: selected ? "cyan" : n.kind === "channel" ? "cyan" : "magenta",
        inverse: selected,
        bold: selected,
      });
    });
    stamp(grid[hubY + hubH - 1], hubX, "└" + "─".repeat(hubW - 2) + "┘", { dim: true });
  }
  for (const n of ring) {
    const p = pos.get(n.key)!;
    const label = labelOf(n);
    const x = Math.max(0, Math.min(width - label.length, p.x - Math.floor(label.length / 2)));
    if (sel?.key === n.key) {
      stamp(grid[p.y], x, label, { color: "cyan", inverse: true, bold: true });
    } else {
      stamp(grid[p.y], x, label.slice(0, 1), { color: STATUS[n.status ?? "offline"].color });
      stamp(grid[p.y], x + 1, label.slice(1), { color: agentColor(n.name), dim: n.lastTs === 0 });
    }
  }

  return (
    <Box flexDirection="column">
      {grid.map((row, y) => (
        <Text key={y} wrap="truncate-end">
          {toSegments(row).map((s, i) => (
            <Text key={i} color={s.color} dimColor={s.dim} bold={s.bold} inverse={s.inverse}>
              {s.text}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}
