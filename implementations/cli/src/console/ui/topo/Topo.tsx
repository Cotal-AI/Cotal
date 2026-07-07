import { useEffect, useMemo } from "react";
import { Box, Text, useFocus } from "ink";
import type { MembershipSnapshot, Presence } from "@cotal-ai/core";
import type { FeedEntry, FocusId } from "../../mesh.js";
import { foldTopo, membershipFreshness } from "./model.js";
import { Sequence } from "./Sequence.js";
import { Matrix } from "./Matrix.js";
import { RingMap } from "./Map.js";

export type TopoVariant = 0 | 1 | 2;
const VARIANTS = ["sequence", "matrix", "map"] as const;
const MARKS = ["①", "②", "③"] as const;

/**
 * The topology lens (`t`) — who-talks-to-whom, three comparable renditions of the same
 * folded graph: ① sequence (swimlanes over time), ② matrix (adjacency heat), ③ map
 * (ring node-link). `v` / `1-3` switch variants; each variant owns its own cursor.
 */
export function Topo({
  feed,
  agents,
  membership,
  channels,
  nameOf,
  variant,
  width,
  height,
  blocked,
  onFocus,
  onOpenAgent,
  onOpenMessage,
}: {
  feed: FeedEntry[];
  agents: Presence[];
  membership?: MembershipSnapshot;
  channels: { channel: string; messages: number }[];
  /** Id → display name from the shared model (resolves endpoints and silent members too). */
  nameOf?: (id: string) => string;
  variant: TopoVariant;
  width: number;
  height: number;
  blocked: boolean;
  onFocus: (id: FocusId) => void;
  onOpenAgent: (p: Presence) => void;
  onOpenMessage: (e: FeedEntry) => void;
}) {
  const { isFocused } = useFocus({ id: "topo" });
  useEffect(() => {
    if (isFocused) onFocus("topo");
  }, [isFocused, onFocus]);

  // The 1s age tick in App re-renders this tree, so `now` stays fresh between snapshots.
  const knownChannels = channels.map((c) => c.channel);
  const graph = useMemo(
    () => foldTopo(feed, agents, { membership, knownChannels: channels.map((c) => c.channel), nameOf }),
    [feed, agents, membership, nameOf, knownChannels.join(",")], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const msgs = graph.edges.reduce((n, e) => n + e.count, 0);
  const fresh = membershipFreshness(graph.now, graph.membership);
  const active = isFocused && !blocked;
  const innerW = Math.max(8, width - 4); // border + paddingX
  const innerH = Math.max(1, height - 3); // border + title row

  const body =
    variant === 0 ? (
      <Sequence feed={feed} graph={graph} width={innerW} height={innerH} active={active} onOpenMessage={onOpenMessage} />
    ) : variant === 1 ? (
      <Matrix feed={feed} graph={graph} width={innerW} height={innerH} active={active} onOpenMessage={onOpenMessage} />
    ) : (
      <RingMap graph={graph} agents={agents} width={innerW} height={innerH} active={active} onOpenAgent={onOpenAgent} />
    );

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="round"
      borderColor={isFocused ? "cyan" : "gray"}
      paddingX={1}
    >
      <Text wrap="truncate-end">
        <Text bold>topology</Text>
        {VARIANTS.map((name, i) => (
          <Text key={name}>
            <Text dimColor>{i === 0 ? " · " : "  "}</Text>
            <Text color={i === variant ? "cyan" : undefined} bold={i === variant} dimColor={i !== variant}>
              {MARKS[i] + " " + name}
            </Text>
          </Text>
        ))}
        <Text dimColor>{" · window " + Math.round(graph.windowMs / 60_000) + "m · " + msgs + " msgs · "}</Text>
        <Text dimColor>membership: </Text>
        <Text color={fresh.color} dimColor={!fresh.color}>{fresh.label}</Text>
      </Text>
      {body}
    </Box>
  );
}
