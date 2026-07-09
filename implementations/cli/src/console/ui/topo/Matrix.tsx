import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { FeedEntry } from "../../mesh.js";
import { agentColor, ago, fmtTime, STATUS } from "../theme.js";
import { HEAT, heatLevel, edgeEntries, nodeLabel, type TopoEdge, type TopoGraph, type TopoNode } from "./model.js";

const CELL_W = 7;
const FOOTER_H = 3; // separator/summary + 2 recent messages

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s);

function hubColor(n: TopoNode): string | undefined {
  return n.kind === "channel" ? "cyan" : n.kind === "service" ? "magenta" : agentColor(n.name);
}

/**
 * Variant ② — adjacency heat matrix. Rows = agents (senders), columns = anything with
 * inbound traffic in the window (agents, #channels, @roles). A cell is heat-glyph + count,
 * brightness by recency; the footer inspects the selected pair's recent messages.
 */
export function Matrix({
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
  const rows = graph.nodes.filter((n) => n.kind === "agent");
  const inbound = new Set(graph.edges.map((e) => e.dst));
  const cols = graph.nodes.filter((n) => inbound.has(n.key));
  const edgeOf = new Map<string, TopoEdge>(graph.edges.map((e) => [e.key, e]));

  const [cur, setCur] = useState({ r: 0, c: 0 });
  const r = Math.min(cur.r, Math.max(0, rows.length - 1));
  const c = Math.min(cur.c, Math.max(0, cols.length - 1));
  const selEdge = rows[r] && cols[c] ? edgeOf.get(rows[r].key + "→" + cols[c].key) : undefined;

  useInput(
    (input, key) => {
      if (key.upArrow || input === "k") setCur((s) => ({ ...s, r: Math.max(0, r - 1) }));
      else if (key.downArrow || input === "j") setCur((s) => ({ ...s, r: Math.min(rows.length - 1, r + 1) }));
      else if (key.leftArrow || input === "h") setCur((s) => ({ ...s, c: Math.max(0, c - 1) }));
      else if (key.rightArrow || input === "l") setCur((s) => ({ ...s, c: Math.min(cols.length - 1, c + 1) }));
      else if (key.return && selEdge) {
        const entries = edgeEntries(feed, selEdge, graph);
        if (entries.length) onOpenMessage(entries[entries.length - 1]);
      }
    },
    { isActive: active },
  );

  if (!rows.length || !cols.length)
    return <Text dimColor>(no traffic in the window - waiting for peer messages)</Text>;

  // Viewports: rows under header + footer; columns follow the cursor.
  const labelW = Math.min(18, Math.max(10, ...rows.map((n) => n.name.length + 2)) + 1);
  const visCols = Math.max(1, Math.floor((width - labelW) / CELL_W));
  const colTop = Math.max(0, Math.min(c - visCols + 1, cols.length - visCols));
  const visRows = Math.max(1, height - 1 - FOOTER_H);
  const rowTop = Math.max(0, Math.min(r - visRows + 1, rows.length - visRows));
  const shownCols = cols.slice(colTop, colTop + visCols);
  const shownRows = rows.slice(rowTop, rowTop + visRows);
  const moreCols = cols.length - colTop - shownCols.length;

  const cellStyle = (e: TopoEdge) => {
    const age = graph.now - e.lastTs;
    return age < 10_000 ? { bold: true } : age < 30_000 ? {} : { dimColor: true };
  };

  const footer = selEdge ? (
    (() => {
      const entries = edgeEntries(feed, selEdge, graph).slice(-2);
      const srcN = graph.byKey.get(selEdge.src);
      const dstN = graph.byKey.get(selEdge.dst);
      const head = `── ${srcN ? nodeLabel(srcN) : "?"} → ${dstN ? nodeLabel(dstN) : "?"} · ${selEdge.count} msgs · last ${ago(selEdge.lastTs)} `;
      return (
        <Box flexDirection="column">
          <Text wrap="truncate-end">
            <Text dimColor>{head.padEnd(width, "─")}</Text>
          </Text>
          {entries.map((e) => (
            <Text key={e.id} wrap="truncate-end">
              <Text dimColor>{" " + fmtTime(e.ts) + "  "}</Text>
              <Text>{e.text}</Text>
            </Text>
          ))}
        </Box>
      );
    })()
  ) : (
    <Box flexDirection="column">
      <Text dimColor wrap="truncate-end">{"".padEnd(width, "─")}</Text>
      <Text dimColor>(no traffic on this pair - h/j/k/l to move, Enter opens the latest message)</Text>
    </Box>
  );

  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text dimColor>{"from \\ to".padEnd(labelW)}</Text>
        {shownCols.map((n) => (
          <Text key={n.key} color={hubColor(n)}>
            {trunc(nodeLabel(n), CELL_W - 1).padEnd(CELL_W)}
          </Text>
        ))}
        {moreCols > 0 ? <Text dimColor>{"→+" + moreCols}</Text> : null}
      </Text>
      {shownRows.map((row, ri) => {
        const glyph = STATUS[row.status ?? "offline"];
        return (
          <Text key={row.key} wrap="truncate-end">
            <Text color={glyph.color}>{glyph.dot + " "}</Text>
            <Text color={agentColor(row.name)}>{trunc(row.name, labelW - 3).padEnd(labelW - 2)}</Text>
            {shownCols.map((col, ci) => {
              const selected = active && rowTop + ri === r && colTop + ci === c;
              if (row.key === col.key)
                return (
                  <Text key={col.key} dimColor inverse={selected}>
                    {"".padEnd(CELL_W)}
                  </Text>
                );
              const e = edgeOf.get(row.key + "→" + col.key);
              if (!e)
                return (
                  <Text key={col.key} dimColor inverse={selected} color={selected ? "cyan" : undefined}>
                    {"  ·".padEnd(CELL_W)}
                  </Text>
                );
              const lvl = heatLevel(e.rate);
              const txt = (HEAT[Math.max(1, lvl)] + " " + e.count).padEnd(CELL_W);
              if (selected)
                return (
                  <Text key={col.key} inverse bold color="cyan">
                    {txt}
                  </Text>
                );
              return (
                <Text key={col.key} {...cellStyle(e)}>
                  {txt}
                </Text>
              );
            })}
          </Text>
        );
      })}
      <Box flexGrow={1} />
      {footer}
    </Box>
  );
}
