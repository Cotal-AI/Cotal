import { useEffect, useState } from "react";
import { Box, Text, useFocus, useInput } from "ink";
import type { Presence } from "@cotal-ai/core";
import { agentColor, STATUS, ago } from "./theme.js";
import type { FocusId } from "../mesh.js";

/** NEEDS-YOU rail: agents that are waiting / blocked, oldest-first (already sorted by the model).
 *  Mirrors the web's amber WAITING cards. A selection cursor (↑/↓) highlights one; `Enter` drills
 *  into the agent's existing detail overlay. Each card is two rows: header + activity. */
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

  const capacity = Math.max(1, Math.floor((boxHeight - 3) / 2)); // border (2) + title (1), 2 rows/card
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
          const role = p.card.role ? "/" + p.card.role : "";
          return (
            <Box key={p.card.id} flexDirection="column">
              {selected ? (
                <Text inverse bold color="cyan" wrap="truncate-end">
                  {STATUS.waiting.dot + " " + p.card.name + role + "  " + ago(p.ts)}
                </Text>
              ) : (
                <Text wrap="truncate-end">
                  <Text color={STATUS.waiting.color}>{STATUS.waiting.dot + " "}</Text>
                  <Text color={agentColor(p.card.name)}>{p.card.name}</Text>
                  {role ? <Text dimColor>{role}</Text> : null}
                  <Text dimColor>{"  " + ago(p.ts)}</Text>
                </Text>
              )}
              <Text dimColor wrap="truncate-end">
                {"  " + (p.activity ?? "waiting for input")}
              </Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}
