import { displayWidth } from "@cotal-ai/workspace";
import { Box, Text, useInput } from "ink";
import { useEffect, useState, type ReactNode } from "react";
import type { FocusId } from "../mesh.js";
import { wrapText } from "./theme.js";

/** Context-sensitive `?` overlay: the focused panel's keys first, then the global ones. */
export function Help({
  focusedId,
  width,
  height,
  onClose,
}: {
  focusedId: FocusId;
  width: number;
  height: number;
  onClose: () => void;
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
              ["a", "attach agent terminal (Ctrl-] detach)"],
              ["D", "kill agent (y stop · f force)"],
            ];
  const global: [string, string][] = [
    ["Tab / ← → / h l", "switch panel"],
    ["[ / ]", "prev / next channel"],
    ["1 – 9", "jump to channel tab"],
    ["n", "toggle needs-you rail"],
    ["d", "direct-message lens"],
    ["t", "topology lens (v / 1-3 variants)"],
    ["Ctrl-p", "commands (spawn / send / attach / status / purge / delchan)"],
    ["c", "compose to channel / DM selected agent"],
    ["r", "reply to current message"],
    ["D", "delete - kill agent / drop space"],
    ["/", "search / filter"],
    ["Esc / b", "back / cancel (→ spaces)"],
    ["?", "toggle this help"],
    ["q / Ctrl-C", "quit"],
  ];
  const [offset, setOffset] = useState(0);
  const bordered = height >= 3 && width >= 4;
  const paddingX = width >= 24 ? 2 : 0;
  const paddingY = height >= 8 ? 1 : 0;
  const innerWidth = width - (bordered ? 2 : 0) - 2 * paddingX;
  const innerHeight = height - (bordered ? 2 : 0) - 2 * paddingY;
  const showTitle = innerHeight >= 3;
  const showContext = innerHeight >= 4;
  const showHint = innerHeight >= 2;
  const room = innerHeight - Number(showTitle) - Number(showContext) - Number(showHint);
  const colW = Math.max(...[...panel, ...global].map(([key]) => displayWidth(key))) + 2;
  const lines: ReactNode[] = [];
  for (const [title, bindings] of [[focusedId + " panel", panel], ["global", global]] as const) {
    lines.push(" ", <Text bold>{title}</Text>);
    for (const [key, description] of bindings) {
      if (innerWidth < colW + 12) {
        for (const part of wrapText(key, innerWidth)) lines.push(<Text color="yellow">{part}</Text>);
        for (const part of wrapText(description, innerWidth)) lines.push(<Text dimColor>{part}</Text>);
        continue;
      }
      const indent = "  ";
      const space = " ".repeat(colW - displayWidth(key));
      for (const [i, part] of wrapText(description, innerWidth - colW - indent.length).entries()) {
        lines.push(i === 0 ? <>{indent}<Text color="yellow">{key + space}</Text><Text dimColor>{part}</Text></> :
          <Text dimColor>{indent + " ".repeat(colW) + part}</Text>);
      }
    }
  }
  const maxOffset = Math.max(0, lines.length - room);
  const top = Math.min(offset, maxOffset);
  useEffect(() => { setOffset((n) => Math.min(n, maxOffset)); }, [maxOffset]);
  useInput((_input, key) => {
    if (maxOffset > 0 && (key.upArrow || key.downArrow || key.pageUp || key.pageDown)) {
      const delta = key.pageUp ? -room : key.pageDown ? room : key.upArrow ? -1 : 1;
      setOffset((n) => Math.max(0, Math.min(maxOffset, n + delta)));
    } else onClose();
  });

  return (
    <Box
      width={width}
      height={height}
      borderStyle={bordered ? "round" : undefined}
      borderColor="cyan"
      paddingX={paddingX}
      paddingY={paddingY}
      flexDirection="column"
    >
      {showTitle && <Text bold color="cyan" wrap="truncate-end">cotal console - help</Text>}
      {showContext && <Text dimColor wrap="truncate-end">{"context: " + focusedId + " panel"}</Text>}
      {lines.slice(top, top + room).map((line, i) => <Text key={top + i} wrap="truncate-end">{line}</Text>)}
      {showHint && <Text dimColor wrap="truncate-end">{maxOffset ? "↑↓ scroll · PgUp/PgDn page · any other key closes" : "press any key to close"}</Text>}
    </Box>
  );
}
