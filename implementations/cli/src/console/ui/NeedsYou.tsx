import { useEffect, useState } from "react";
import { Box, Text, useFocus, useInput } from "ink";
import { peerLabel, type Presence } from "@cotal-ai/core";
import { activityAge } from "../../ui.js";
import { factRow, statusLine } from "./Roster.js";
import { agentColor, STATUS, ago, windowAround, wrapFacts } from "./theme.js";
import type { FocusId } from "../mesh.js";

/** NEEDS-YOU rail: agents that are waiting / blocked, oldest-first (already sorted by the model).
 *  Mirrors the web's amber WAITING cards. A selection cursor (↑/↓) highlights one; `Enter` drills
 *  into the agent's existing detail overlay. Each card is its header row, the status and its dated
 *  facts wrapped onto as many rows as the column needs (so neither a long name nor a narrow column
 *  cuts them), and the activity row. */
export function NeedsYou({
  waiting,
  boxWidth,
  boxHeight,
  blocked,
  onFocus,
  onOpenDetail,
}: {
  waiting: Presence[];
  boxWidth: number;
  boxHeight: number;
  blocked: boolean;
  onFocus: (id: FocusId) => void;
  onOpenDetail: (p: Presence) => void;
}) {
  const { isFocused } = useFocus({ id: "needsyou" });
  useEffect(() => {
    if (isFocused) onFocus("needsyou");
  }, [isFocused, onFocus]);

  const [sel, setSel] = useState(0);
  const selClamped = Math.min(sel, Math.max(0, waiting.length - 1));
  useInput(
    (input, key) => {
      if (key.upArrow || input === "k") setSel((v) => Math.max(0, v - 1));
      else if (key.downArrow || input === "j") setSel((v) => Math.min(waiting.length - 1, v + 1));
      else if (key.return && waiting.length) onOpenDetail(waiting[selClamped]);
    },
    { isActive: isFocused && !blocked },
  );

  const facts = waiting.map((p) => wrapFacts(statusLine(p), boxWidth - 6)); // border (2) + padding (2) + indent (2)
  const [start, end] = windowAround(
    facts.map((f) => 2 + f.length),
    selClamped,
    boxHeight - 3, // border (2) + title (1)
  );
  const visible = waiting.slice(start, end);
  const below = waiting.length - end;

  return (
    <Box
      flexDirection="column"
      width={boxWidth}
      height={boxHeight}
      borderStyle="round"
      borderColor={isFocused ? "cyan" : "gray"}
      paddingX={1}
      // A card's rows never shrink, so one taller than the box (a short terminal, a hostile condition
      // code) displaces the title and is then cut at the bottom, keeping its name row, rather than being
      // squeezed or drawn over the panes below.
      overflowY="hidden"
    >
      <Text wrap="truncate-end">
        <Text bold color="yellow">NEEDS YOU</Text>
        <Text dimColor>{" · " + waiting.length}</Text>
        {below > 0 ? <Text color="yellow">{"  ↓" + below + " more"}</Text> : null}
      </Text>
      {visible.length === 0 ? (
        <Text dimColor>nothing waiting - all clear ✓</Text>
      ) : (
        visible.map((p, i) => {
          const selected = isFocused && start + i === selClamped;
          const label = peerLabel(p.card);
          return (
            <Box key={p.card.id} flexDirection="column" flexShrink={0}>
              {selected ? (
                <Text inverse bold color="cyan" wrap="truncate-end">
                  {STATUS.waiting.dot + " " + label + "  seen " + ago(p.ts)}
                </Text>
              ) : (
                <Text wrap="truncate-end">
                  <Text color={STATUS.waiting.color}>{STATUS.waiting.dot + " "}</Text>
                  <Text color={agentColor(p.card.name)}>{label}</Text>
                  <Text dimColor>{"  seen " + ago(p.ts)}</Text>
                </Text>
              )}
              {facts[start + i].map((row, r) => (
                <Text key={r} wrap="truncate-end">
                  {factRow(row, STATUS.waiting.color)}
                </Text>
              ))}
              <Text dimColor wrap="truncate-end">
                {"  " + (p.activity ?? "waiting for input") + activityAge(p)}
              </Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}
