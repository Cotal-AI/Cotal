import { useEffect, type ReactNode } from "react";
import { Box, Text, useFocus, useInput } from "ink";
import { peerLabel, presenceText, type Presence } from "@cotal-ai/core";
import { activityAge, presenceFacts } from "../../ui.js";
import { agentColor, STATUS, ago, windowAround, wrapFacts, wrapPieces, type FactRow, type Piece } from "./theme.js";
import { useListCursor } from "./useListCursor.js";

function progressText(p: Presence): string {
  if (p.card.kind !== "agent" || p.status !== "working") return ago(p.ts);
  // The roster has no last-assistant observation to pass, so a working agent can only be named unknown.
  return "progress unknown";
}

/** Short display tag for an agent's harness (which tool it IS): known connectors get a familiar
 *  abbreviation (`cc` = Claude Code, whose manager-default alias is `cotal`), anything else its
 *  first two letters. Pure presentation; undefined in, undefined out (never fake a tag). */
export function harnessTag(connector: string | undefined): string | undefined {
  if (!connector) return undefined;
  const known: Record<string, string> = { claude: "cc", cotal: "cc", opencode: "oc", hermes: "hm", codex: "cx", jcode: "jc", pi: "pi" };
  return known[connector] ?? connector.slice(0, 2).toLowerCase();
}

/** A {@link wrapPieces} row behind `mark`, or indented under its seat's first row without one: the
 *  pieces that are not dated in `color` (dim without one) and the dated ones dim, or plain text for
 *  a selected seat's bar. */
export function factRow(row: FactRow, color: string | undefined, selected = false, mark?: { text: string; color: string }): ReactNode {
  if (selected) return (mark?.text ?? "  ") + row.map((f) => f.text).join("");
  return (
    <>
      {mark ? <Text color={mark.color}>{mark.text}</Text> : "  "}
      {row.map(({ text, dated }, i) => (
        <Text key={i} color={dated ? undefined : color} dimColor={dated || !color}>
          {text}
        </Text>
      ))}
    </>
  );
}

/** A seat's head rows at `width` columns: its name/role label, then its harness tag, its activity,
 *  the activity's age and the progress or heartbeat age. They wrap at those boundaries as the status
 *  rows do, so no width cuts the name or an age. Only the label takes the seat's color, so every
 *  other piece is marked dated, which paints it dim. */
function headRows(p: Presence, tag: string | undefined, width: number): FactRow[] {
  const piece = (separator: string, alone: string, dated = true): Piece => ({ shared: separator + alone, alone, dated });
  const activity = p.activity ? presenceText(p.activity) : "";
  const since = activityAge(p).trimStart();
  return wrapPieces(
    [
      piece("", peerLabel(p.card), false),
      ...(tag ? [piece(" ", tag)] : []),
      ...(activity ? [piece("  ", activity)] : []),
      ...(since ? [piece(" ", since)] : []),
      piece("  ", progressText(p)),
    ],
    width,
  );
}

function RosterRow({ p, selected, head, facts }: { p: Presence; selected: boolean; head: FactRow[]; facts: FactRow[] }) {
  const isAgent = p.card.kind === "agent";
  const s = STATUS[p.status];
  const mark = { text: (isAgent ? s.dot : "⚙") + " ", color: isAgent ? s.color : "gray" };
  // Selected: one uniform cyan bar (like the tabs); unselected: the normal colored row.
  const line = (parts: ReactNode, key: number) =>
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
      {head.map((row, r) => line(factRow(row, isAgent ? agentColor(p.card.name) : undefined, selected, r ? undefined : mark), r))}
      {facts.map((row, r) => line(factRow(row, isAgent ? s.color : undefined, selected), head.length + r))}
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
  const { index: selClamped, up, down } = useListCursor(list.length);

  useInput(
    (input, key) => {
      if (key.upArrow || input === "k") up();
      else if (key.downArrow || input === "j") down();
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

  // A seat's head and its status and dated facts wrap onto rows of their own, so no width cuts its
  // name or a fact, and the window counts those rows.
  const rowWidth = boxWidth - 6; // border (2) + padding (2) + indent (2)
  const heads = list.map((p) => headRows(p, harness?.get(p.card.id), rowWidth));
  const facts = list.map((p) => wrapFacts(statusLine(p), rowWidth));
  const [start, end] = windowAround(
    list.map((_, i) => heads[i].length + facts[i].length),
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
      // A seat's rows never shrink, so one taller than the box (a short terminal, a long activity or
      // condition) displaces the title and is then cut at the bottom, keeping its name row, rather than
      // being squeezed or drawn over the panes below.
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
            head={heads[start + i]}
            facts={facts[start + i]}
          />
        ))
      )}
    </Box>
  );
}
