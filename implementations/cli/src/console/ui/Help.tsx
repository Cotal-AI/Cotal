import { Box, Text } from "ink";
import type { FocusId } from "../mesh.js";

/** Context-sensitive `?` overlay: the focused panel's keys first, then the global ones. */
export function Help({
  focusedId,
  width,
  height,
}: {
  focusedId: FocusId;
  width: number;
  height: number;
}) {
  const panel: [string, string][] =
    focusedId === "feed"
      ? [
          ["↑↓ / j k", "scroll a line"],
          ["Ctrl-d / Ctrl-u", "half-page down / up"],
          ["PgUp / PgDn", "page up / down"],
          ["g / G", "oldest / newest"],
          ["{ } / K J", "previous / next message"],
          ["Enter", "open current message"],
        ]
      : focusedId === "dmpeers" || focusedId === "dmthread"
        ? [
            ["↑↓ / j k", "peer / conversation · scroll"],
            ["← → / Tab", "switch peer list ↔ thread"],
            ["Esc", "leave DM lens"],
          ]
        : focusedId === "topo"
          ? [
              ["v / 1 2 3", "cycle / pick variant (sequence · matrix · map)"],
              ["↑↓ / j k", "scroll · move cursor · select node"],
              ["h l", "matrix column cursor"],
              ["Enter", "open message / agent detail"],
              ["Esc", "leave topology lens"],
            ]
          : [
              ["↑↓ / j k", "move selection"],
              ["Enter", "open agent detail"],
              ["D", "kill agent (confirm)"],
            ];
  const global: [string, string][] = [
    ["Tab / ← → / h l", "switch panel"],
    ["[ / ]", "prev / next channel"],
    ["1 – 9", "jump to channel tab"],
    ["n", "toggle needs-you rail"],
    ["d", "direct-message lens"],
    ["t", "topology lens (v / 1-3 variants)"],
    ["V", "views lens (peer-pushed views)"],
    [":", "command palette (send / call / ask)"],
    ["c", "compose to channel / DM selected agent"],
    ["r", "reply to current message"],
    ["D", "delete — kill agent / drop space"],
    ["/", "search / filter"],
    ["Esc / b", "back / cancel (→ spaces)"],
    ["?", "toggle this help"],
    ["q / Ctrl-C", "quit"],
  ];
  // Pad the key column to the longest key (across both lists) + a gap, so a long key like
  // "Ctrl-d / Ctrl-u" never sits flush against its description.
  const colW = Math.max(...[...panel, ...global].map(([k]) => k.length)) + 2;
  const section = (title: string, rows: [string, string][]) => (
    <Box marginTop={1} flexDirection="column">
      <Text bold>{title}</Text>
      {rows.map(([k, d], i) => (
        <Text key={i}>
          {"  "}
          <Text color="yellow">{k.padEnd(colW)}</Text>
          <Text dimColor>{d}</Text>
        </Text>
      ))}
    </Box>
  );
  return (
    <Box
      width={width}
      height={height}
      borderStyle="round"
      borderColor="cyan"
      paddingX={2}
      paddingY={1}
      flexDirection="column"
    >
      <Text bold color="cyan">
        cotal console — help
      </Text>
      <Text dimColor>{"context: " + focusedId + " panel"}</Text>
      {section(focusedId + " panel", panel)}
      {section("global", global)}
      <Box marginTop={1}>
        <Text dimColor>press any key to close</Text>
      </Box>
    </Box>
  );
}
