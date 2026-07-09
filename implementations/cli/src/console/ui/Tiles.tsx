import { Box, Text } from "ink";
import type { StatusCounts } from "../../view/mesh-view.js";
import { STATUS, ago } from "./theme.js";

/** Golden-signal strip (one row): working/waiting/idle/offline counts + oldest-unattended age.
 *  Pure chrome — reads mesh.signals straight, reuses STATUS colors/glyphs. */
export function Tiles({
  counts,
  oldestWaitingTs,
  width,
}: {
  counts: StatusCounts;
  oldestWaitingTs?: number;
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
        <Text dimColor>{"      oldest unattended "}</Text>
        <Text color={oldestWaitingTs ? "yellow" : "gray"}>
          {oldestWaitingTs ? ago(oldestWaitingTs) : "-"}
        </Text>
      </Text>
    </Box>
  );
}
