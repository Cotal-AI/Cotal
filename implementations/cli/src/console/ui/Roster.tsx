import { useEffect, useState } from "react";
import { Box, Text, useFocus, useInput } from "ink";
import type { Presence } from "@cotal-ai/core";
import { agentColor, STATUS, ago } from "./theme.js";

function RosterRow({ p, selected, wide, paused }: { p: Presence; selected: boolean; wide: boolean; paused: boolean }) {
  const isAgent = p.card.kind === "agent";
  const s = STATUS[p.status];
  // A manager-paused (SIGSTOPped) agent can't heartbeat, so presence soon reads "offline" — the
  // managed-state badge is authoritative and replaces the status so a frozen agent isn't misread
  // as dead.
  if (selected) {
    const kind = wide ? (paused && isAgent ? "  paused" : isAgent ? "  " + s.word : "  endpoint") : "";
    const act = p.activity ? "  " + p.activity : "";
    return (
      <Text inverse bold color="cyan" wrap="truncate-end">
        {(isAgent ? (paused ? "⏸" : s.dot) : "⚙") + " " + p.card.name + kind + act + "  " + ago(p.ts)}
      </Text>
    );
  }
  return (
    <Text wrap="truncate-end">
      <Text color={isAgent ? (paused ? "yellow" : s.color) : "gray"}>{isAgent ? (paused ? "⏸" : s.dot) : "⚙"} </Text>
      <Text color={isAgent ? agentColor(p.card.name) : undefined} dimColor={!isAgent}>
        {p.card.name}
      </Text>
      {wide ? (
        isAgent ? (
          paused ? (
            <Text color="yellow">{"  paused"}</Text>
          ) : (
            <Text color={s.color}>{"  " + s.word}</Text>
          )
        ) : (
          <Text dimColor>{"  endpoint"}</Text>
        )
      ) : null}
      {p.activity ? <Text dimColor>{"  " + p.activity}</Text> : null}
      <Text dimColor>{"  " + ago(p.ts)}</Text>
    </Text>
  );
}

function matches(p: Presence, q: string): boolean {
  return [p.card.name, p.card.role ?? "", p.activity ?? ""].join(" ").toLowerCase().includes(q);
}

/** Always-visible roster: agents (status dot + color + activity + age) then endpoints (dimmed).
 *  A selection cursor (↑/↓) highlights one row; `Enter` opens its detail; `/` filters the list. */
export function Roster({
  agents,
  endpoints,
  query,
  boxWidth,
  boxHeight,
  wide,
  blocked,
  onFocus,
  onOpenDetail,
  onKill,
  onPause,
  paused,
  onCompose,
}: {
  agents: Presence[];
  endpoints: Presence[];
  query: string;
  boxWidth: number;
  boxHeight: number;
  wide: boolean;
  blocked: boolean;
  onFocus: (id: "roster" | "feed") => void;
  onOpenDetail: (p: Presence) => void;
  onKill?: (p: Presence) => void;
  /** Pause/resume toggle on the selected agent — recoverable, so it fires without a confirm. */
  onPause?: (p: Presence) => void;
  /** Ids the manager reports as paused — authoritative over presence for the badge. */
  paused?: Set<string>;
  onCompose?: (p: Presence) => void;
}) {
  const { isFocused } = useFocus({ id: "roster" });
  useEffect(() => {
    if (isFocused) onFocus("roster");
  }, [isFocused, onFocus]);

  const q = query.trim().toLowerCase();
  const filt = (l: Presence[]) => (q ? l.filter((p) => matches(p, q)) : l);
  const list = [...filt(agents), ...filt(endpoints)];
  const [sel, setSel] = useState(0);
  const selClamped = Math.min(sel, Math.max(0, list.length - 1));

  useInput(
    (input, key) => {
      if (key.upArrow || input === "k") setSel((v) => Math.max(0, v - 1));
      else if (key.downArrow || input === "j") setSel((v) => Math.min(list.length - 1, v + 1));
      else if (input === "D" && onKill && list[selClamped]?.card.kind === "agent")
        onKill(list[selClamped]);
      else if (input === "p" && onPause && list[selClamped]?.card.kind === "agent")
        onPause(list[selClamped]);
      else if (input === "c" && onCompose && list[selClamped]?.card.kind === "agent")
        onCompose(list[selClamped]);
      else if (key.return && list.length) onOpenDetail(list[selClamped]);
    },
    { isActive: isFocused && !blocked },
  );

  const capacity = Math.max(1, boxHeight - 3); // border (2) + title (1)
  let start = 0;
  if (list.length > capacity) {
    start = Math.min(Math.max(0, selClamped - Math.floor(capacity / 2)), list.length - capacity);
  }
  const visible = list.slice(start, start + capacity);

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
        <Text bold>roster</Text>
        <Text dimColor>
          {" · " + agents.length + " agent" + (agents.length === 1 ? "" : "s")}
        </Text>
        {endpoints.length ? <Text dimColor>{" · " + endpoints.length + " ep"}</Text> : null}
        {q ? <Text color="yellow">{"  /" + query}</Text> : null}
      </Text>
      {visible.length === 0 ? (
        <Text dimColor>{q ? "(no match)" : "(nobody present)"}</Text>
      ) : (
        visible.map((p, i) => (
          <RosterRow
            key={p.card.id}
            p={p}
            selected={isFocused && start + i === selClamped}
            wide={wide}
            paused={paused?.has(p.card.id) ?? false}
          />
        ))
      )}
    </Box>
  );
}
