import { useEffect, useReducer, useRef, useState } from "react";
import { select } from "d3-selection";
import { zoom, zoomIdentity, type D3ZoomEvent, type ZoomTransform } from "d3-zoom";
import type { TopoModel, TopoNode } from "../../lib/topology.js";
import { characterMarkup } from "../Avatar.tsx";
import { ForceLayout, pillWidth } from "./layout.js";

/** The two browser calls the frame loop makes, read from `globalThis` when called. Only an effect
 *  calls them, and a server render never runs one, so the Node-side smoke program (which has no DOM
 *  lib, to keep a render from reaching `window`) can still import this file. */
const frames = {
  request: (cb: () => void): number => (globalThis as unknown as { requestAnimationFrame(cb: () => void): number }).requestAnimationFrame(cb),
  cancel: (id: number): void => (globalThis as unknown as { cancelAnimationFrame(id: number): void }).cancelAnimationFrame(id),
};

/** The line a link draws as: a class for its kind, dashed also for an offline agent's links, and
 *  `ui-tl-hot` while a message is flowing on its channel. The CSS gives each class its look. */
function linkClass(kind: TopoModel["links"][number]["kind"], hot: boolean, sourceOffline: boolean): string {
  return ["ui-tl", `ui-tl-${kind}`, sourceOffline ? "ui-tl-off" : "", hot ? "ui-tl-hot" : ""].filter(Boolean).join(" ");
}

/** One agent: its character, its roster name, and for a reader of every channel the "all channels"
 *  badge in place of a link to each channel. An offline agent is greyscale at half opacity. */
function AgentNode({ node, x, y, size }: { node: TopoNode; x: number; y: number; size: number }) {
  const status = node.status ?? "idle";
  const badge = 8 + "all channels".length * 5.2;
  return (
    <g className={status === "offline" ? "ui-ta ui-ta-off" : "ui-ta"} data-node={node.id} transform={`translate(${x} ${y})`}>
      <svg
        x={-size / 2}
        y={-size / 2}
        width={size}
        height={size}
        viewBox="-2 -4 112 112"
        overflow="visible"
        dangerouslySetInnerHTML={{ __html: characterMarkup(node.vendor, status) }}
      />
      <text y={size / 2 + 13} textAnchor="middle" className="ui-ta-name">{node.label}</text>
      {node.wide && (
        <g className="ui-wide" transform={`translate(0 ${size / 2 + 26})`}>
          <rect x={-badge / 2} y={-8} width={badge} height={16} rx={6} />
          <text y={3.5} textAnchor="middle">all channels</text>
        </g>
      )}
    </g>
  );
}

/** One channel, as the mock's rounded `#name` pill. It is outlined in the hot colour while a message flows on it. */
function ChannelNode({ node, x, y, hot }: { node: TopoNode; x: number; y: number; hot: boolean }) {
  const w = pillWidth(node.label);
  return (
    <g className={hot ? "ui-tn ui-tn-hot" : "ui-tn"} data-node={node.id} transform={`translate(${x} ${y})`}>
      <rect x={-w / 2} y={-12} width={w} height={24} rx={8} />
      <text y={4} textAnchor="middle">#{node.label}</text>
    </g>
  );
}

/** The mesh as a force-directed graph: agents are their characters, channels are `#name` pills,
 *  and a link is hot while a message flows on its channel.
 *
 *  React draws the SVG. The positions live in a layout that is not state: a `requestAnimationFrame`
 *  loop ticks it and bumps a counter to redraw, and stops when the layout comes to rest. The layout
 *  heats again only when the set of nodes or links changes, so a link going hot or cold, a status or
 *  a new label moves nothing. The first draw is already at rest. `d3-zoom` on the SVG pans and zooms.
 *
 *  `width` and `height` are the drawing's own coordinates (its `viewBox`); CSS scales it to its box. */
export function TopologyGraph({ model, width = 400, height = 420 }: { model: TopoModel; width?: number; height?: number }) {
  const layoutRef = useRef<ForceLayout | null>(null);
  if (layoutRef.current === null) {
    layoutRef.current = new ForceLayout(width, height);
    layoutRef.current.sync(model);
    layoutRef.current.warm();
  }
  const layout = layoutRef.current;

  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const frame = useRef(0);
  const run = () => {
    if (frame.current !== 0 || layout.settled) return;
    const step = () => {
      frame.current = 0;
      layout.tick();
      redraw();
      if (!layout.settled) frame.current = frames.request(step);
    };
    frame.current = frames.request(step);
  };

  useEffect(() => {
    if (layout.sync(model)) layout.reheat();
    run();
  });

  useEffect(
    () => () => {
      frames.cancel(frame.current);
      frame.current = 0;
    },
    [],
  );

  const svg = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<ZoomTransform>(zoomIdentity);
  useEffect(() => {
    const el = svg.current!;
    select(el).call(zoom<SVGSVGElement, unknown>().scaleExtent([0.4, 4]).on("zoom", (e: D3ZoomEvent<SVGSVGElement, unknown>) => setView(e.transform)));
    return () => void select(el).on(".zoom", null);
  }, []);

  const place = (id: string) => layout.at(id) ?? { x: width / 2, y: height / 2 };
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const hotChannels = new Set(model.links.filter((l) => l.hot).map((l) => l.target));
  const size = Math.min(40, width / 10);
  return (
    <svg ref={svg} className="ui-topo-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Mesh topology">
      <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
        {model.links.map((l) => {
          const a = place(l.source);
          const b = place(l.target);
          return (
            <line
              key={`${l.source}\u0000${l.target}`}
              data-link={`${l.source}>${l.target}`}
              className={linkClass(l.kind, l.hot, byId.get(l.source)?.status === "offline")}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
            />
          );
        })}
        {model.nodes.filter((n) => n.kind === "channel").map((n) => (
          <ChannelNode key={n.id} node={n} {...place(n.id)} hot={hotChannels.has(n.id)} />
        ))}
        {model.nodes.filter((n) => n.kind === "agent").map((n) => (
          <AgentNode key={n.id} node={n} {...place(n.id)} size={size} />
        ))}
      </g>
    </svg>
  );
}
