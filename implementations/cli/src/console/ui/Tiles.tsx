import { Box, Text } from "ink";
import type { StatusCounts } from "../../view/mesh-view.js";
import { STATUS, ago } from "./theme.js";

/** Golden-signal strip (one row): working/waiting/idle/offline counts + the stalest live
 *  heartbeat. That last one is a LIVENESS signal ("is a peer going quiet?"), not a
 *  blocked-duration — presence carries no status-transition time, so how long an agent has
 *  been waiting is not knowable. Label it as what it is.
 *  Pure chrome — reads mesh.signals straight, reuses STATUS colors/glyphs. */
export function Tiles({
  counts,
  stalestLiveTs,
  width,
}: {
  counts: StatusCounts;
  stalestLiveTs?: number;
  width: number;
}) {
  const order: (keyof StatusCounts)[] = ["working", "waiting", "idle", "offline"];
  return (
    <Box width={width} paddingX={1}>
      <Text wrap="truncate-end">
        {order.map((k, i) => (
          <Text key={k} color={STATUS[k].color}>
            {(i > 0 ? "   " : "") + STATUS[k].dot + " " + counts[k] + " " + STATUS[k].word}
          </Text>
        ))}
        <Text dimColor>{"      stalest live heartbeat "}</Text>
        <Text color={stalestLiveTs ? "yellow" : "gray"}>
          {stalestLiveTs ? ago(stalestLiveTs) : "-"}
        </Text>
      </Text>
    </Box>
  );
}
