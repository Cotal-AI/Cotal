import { useEffect, useState, type ReactNode } from "react";
import { Box, Text, useFocus, useInput } from "ink";
import { peerLabel, type Presence } from "@cotal-ai/core";
import { progressSignal } from "@cotal-ai/workspace";
import { activityAge, presenceFacts } from "../../ui.js";
import { agentColor, STATUS, ago, windowAround, wrapFacts, type FactRow } from "./theme.js";

function progressText(p: Presence): string {
  if (p.card.kind !== "agent" || p.status !== "working") return ago(p.ts);
  return progressSignal(undefined, Date.now()).kind === "unknown" ? "progress unknown" : "progress observed";
}

/** Short display tag for an agent's harness (which tool it IS): known connectors get a familiar
 *  abbreviation (`cc` = Claude Code, whose manager-default alias is `cotal`), anything else its
 *  first two letters. Pure presentation; undefined in, undefined out (never fake a tag). */
export function harnessTag(connector: string | undefined): string | undefined {
  if (!connector) return undefined;
  const known: Record<string, string> = { claude: "cc", cotal: "cc", opencode: "oc", hermes: "hm", codex: "cx", jcode: "jc", pi: "pi" };
  return known[connector] ?? connector.slice(0, 2).toLowerCase();
}

/** A {@link wrapFacts} row, indented under its seat's head row: the status and its condition in
 *  `color` (dim without one) and the dated facts dim, or plain text for a selected seat's bar. */
export function factRow(row: FactRow, color: string | undefined, selected = false): ReactNode {
  if (selected) return "  " + row.map((f) => f.text).join("");
  return (
    <>
      {"  "}
      {row.map(({ text, dated }, i) => (
        <Text key={i} color={dated ? undefined : color} dimColor={dated || !color}>
          {text}
        </Text>
      ))}
    </>
  );
}

function RosterRow({ p, selected, facts, tag }: { p: Presence; selected: boolean; facts: FactRow[]; tag?: string }) {
  const isAgent = p.card.kind === "agent";
  const s = STATUS[p.status];
  const age = progressText(p);
  const act = p.activity ? "  " + p.activity + activityAge(p) : "";
  let head: ReactNode, tail: ReactNode;
  // Selected: one uniform cyan bar (like the tabs); unselected: the normal colored row.
  if (selected) {
    head = (isAgent ? s.dot : "⚙") + " " + peerLabel(p.card) + (tag ? " " + tag : "");
    tail = act + "  " + age;
  } else {
    head = (
      <>
        <Text color={isAgent ? s.color : "gray"}>{isAgent ? s.dot : "⚙"} </Text>
        <Text color={isAgent ? agentColor(p.card.name) : undefined} dimColor={!isAgent}>
          {peerLabel(p.card)}
        </Text>
        {tag ? <Text dimColor>{" " + tag}</Text> : null}
      </>
    );
    tail = (
      <>
        {act ? <Text dimColor>{act}</Text> : null}
        <Text dimColor>{"  " + age}</Text>
      </>
    );
  }
  const line = (parts: ReactNode, key?: number) =>
    selected ? (
      <Text key={key} inverse bold color="cyan" wrap="truncate-end">
        {parts}
      </Text>
    ) : (
      <Text key={key} wrap="truncate-end">
        {parts}
      </Text>
    );
  return (
    <Box flexDirection="column" flexShrink={0}>
      {line(<>{head}{tail}</>)}
      {facts.map((row, r) => line(factRow(row, isAgent ? s.color : undefined, selected), r))}
    </Box>
  );
}

/** A seat's status word, or `endpoint`, then its condition and dated facts, for {@link wrapFacts}. */
export function statusLine(p: Presence): string {
  const { condition, ages } = presenceFacts(p);
  return (p.card.kind === "agent" ? STATUS[p.status].word : "endpoint") + condition + ages;
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
  blocked,
  onFocus,
  onOpenDetail,
  onKill,
  onAttach,
  harness,
  onCompose,
}: {
  agents: Presence[];
  endpoints: Presence[];
  query: string;
  boxWidth: number;
  boxHeight: number;
  blocked: boolean;
  onFocus: (id: "roster" | "feed") => void;
  onOpenDetail: (p: Presence) => void;
  onKill?: (p: Presence) => void;
  /** Attach to the selected agent's live terminal. */
  onAttach?: (p: Presence) => void;
  /** id → short harness tag (see {@link harnessTag}); rows without an entry show no tag. */
  harness?: Map<string, string>;
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
      else if (key.downArrow || input === "j") setSel((v) => Math.min(Math.max(0, list.length - 1), v + 1));
      else if (input === "D" && onKill && list[selClamped]?.card.kind === "agent")
        onKill(list[selClamped]);
      else if (input === "a" && onAttach && list[selClamped]?.card.kind === "agent")
        onAttach(list[selClamped]);
      else if (input === "c" && onCompose && list[selClamped]?.card.kind === "agent")
        onCompose(list[selClamped]);
      else if (key.return && list.length) onOpenDetail(list[selClamped]);
    },
    { isActive: isFocused && !blocked },
  );

  // A seat's status and dated facts wrap onto rows of their own under its head row, so no width
  // cuts them, and the window counts those rows.
  const facts = list.map((p) => wrapFacts(statusLine(p), boxWidth - 6)); // border (2) + padding (2) + indent (2)
  const [start, end] = windowAround(
    facts.map((f) => 1 + f.length),
    selClamped,
    boxHeight - 3, // border (2) + title (1)
  );
  const visible = list.slice(start, end);

  return (
    <Box
      flexDirection="column"
      width={boxWidth}
      height={boxHeight}
      borderStyle="round"
      borderColor={isFocused ? "cyan" : "gray"}
      paddingX={1}
      // A seat's rows never shrink, so one taller than the box (a short terminal, a hostile condition
      // code) displaces the title and is then cut at the bottom, keeping its name row, rather than being
      // squeezed or drawn over the panes below.
      overflowY="hidden"
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
            facts={facts[start + i]}
            tag={harness?.get(p.card.id)}
          />
        ))
      )}
    </Box>
  );
}
