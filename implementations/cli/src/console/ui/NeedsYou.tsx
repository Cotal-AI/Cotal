import { useEffect, useState } from "react";
import { Box, Text, useFocus, useInput } from "ink";
import { peerLabel, type Presence } from "@cotal-ai/core";
import { activityAge, presenceFacts } from "../../ui.js";
import { agentColor, STATUS, ago } from "./theme.js";
import type { FocusId } from "../mesh.js";

/** NEEDS-YOU rail: agents that are waiting / blocked, oldest-first (already sorted by the model).
 *  Mirrors the web's amber WAITING cards. A selection cursor (↑/↓) highlights one; `Enter` drills
 *  into the agent's existing detail overlay. Each card is three rows: header, status, activity. The
 *  status and its dated facts get a row of their own so a long name never truncates them away. */
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

  const capacity = Math.max(1, Math.floor((boxHeight - 3) / 3)); // border (2) + title (1), 3 rows/card
  let start = 0;
  if (waiting.length > capacity)
    start = Math.min(Math.max(0, selClamped - Math.floor(capacity / 2)), waiting.length - capacity);
  const visible = waiting.slice(start, start + capacity);
  const below = waiting.length - (start + visible.length);

  return (
    <Box
      flexDirection="column"
      width={boxWidth}
      height={boxHeight}
      borderStyle="round"
      borderColor={isFocused ? "cyan" : "gray"}
      paddingX={1}
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
          const { condition, ages } = presenceFacts(p);
          return (
            <Box key={p.card.id} flexDirection="column">
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
              <Text wrap="truncate-end">
                <Text color={STATUS.waiting.color}>{"  " + STATUS.waiting.word}</Text>
                {condition ? <Text>{condition}</Text> : null}
                {ages ? <Text dimColor>{ages}</Text> : null}
              </Text>
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
