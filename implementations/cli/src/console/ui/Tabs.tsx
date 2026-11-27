import { Box, Text } from "ink";

/** The channel tab strip. `all` (firehose) is tab 1; channels follow. 1–9 jump directly.
 *  `unread` adds a yellow `+N` badge (messages since the channel was last viewed) on inactive tabs. */
export function Tabs({
  tabs,
  active,
  counts,
  unread,
  width,
}: {
  tabs: (string | null)[];
  active: string | null;
  counts: Record<string, number>;
  unread?: Record<string, number>;
  width: number;
}) {
  return (
    <Box width={width} height={3} borderStyle="round" borderColor="gray" paddingX={1}>
      <Text wrap="truncate-end">
        {tabs.map((t, i) => {
          const isActive = t === active;
          const label = t === null ? "all" : "#" + t;
          const count = t === null ? undefined : counts[t];
          const fresh = t !== null && !isActive ? unread?.[t] : undefined;
          return (
            <Text key={label}>
              {i > 0 ? <Text dimColor>{"   "}</Text> : null}
              <Text dimColor>{i + 1}:</Text>
              <Text color={isActive ? "cyan" : undefined} inverse={isActive} bold={isActive}>
                {" " + label + (count !== undefined ? " " + count : "") + " "}
              </Text>
              {fresh ? <Text color="yellow">{"+" + fresh}</Text> : null}
            </Text>
          );
        })}
      </Text>
    </Box>
  );
}
