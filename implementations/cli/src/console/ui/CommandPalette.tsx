import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { MeshSnapshot } from "../../view/mesh-view.js";
import { COMMANDS } from "../commands.js";

const CAP = 6; // suggestion rows; the palette is a fixed CAP+1 rows tall so the layout doesn't jump

type Sugg = { value: string; label: string; summary?: string; write?: boolean; control?: boolean };

/** Suggestions for the current token: the command name (no space yet), or an @agent / #channel arg. */
function suggest(query: string, snap: MeshSnapshot): { items: Sugg[]; tokenStart: number; matchLen: number } {
  if (!query.includes(" ")) {
    const q = query.toLowerCase();
    const items = COMMANDS.filter((c) => c.name.startsWith(q)).map((c) => ({
      value: c.name,
      label: c.name,
      summary: c.summary,
      write: c.write,
      control: c.control,
    }));
    return { items, tokenStart: 0, matchLen: q.length };
  }
  const tokenStart = query.lastIndexOf(" ") + 1;
  const token = query.slice(tokenStart);
  if (token.startsWith("@")) {
    const q = token.slice(1).toLowerCase();
    const items = snap.agents
      .filter((p) => p.card.name.toLowerCase().startsWith(q))
      .map((p) => ({ value: "@" + p.card.name, label: "@" + p.card.name, summary: p.card.role }));
    return { items, tokenStart, matchLen: token.length };
  }
  if (token.startsWith("#")) {
    const q = token.slice(1).toLowerCase();
    const items = snap.channels
      .filter((c) => c.channel.toLowerCase().startsWith(q))
      .map((c) => ({ value: "#" + c.channel, label: "#" + c.channel, summary: c.messages + " msgs" }));
    return { items, tokenStart, matchLen: token.length };
  }
  return { items: [], tokenStart, matchLen: 0 };
}

/** The `:` operator command palette — Claude-Code-style: a typed line with a live suggestion
 *  dropdown (command names, then @agent / #channel args), match highlighted. Tab completes the
 *  current token, Enter runs the line, Esc cancels. */
export function CommandPalette({
  active,
  query,
  snapshot,
  canWrite,
  canControl,
  width,
  onChange,
  onRun,
  onCancel,
}: {
  active: boolean;
  query: string;
  snapshot: MeshSnapshot;
  canWrite: boolean;
  canControl?: boolean;
  width: number;
  onChange: (q: string) => void;
  onRun: (line: string) => void;
  onCancel: () => void;
}) {
  const { items, tokenStart, matchLen } = suggest(query, snapshot);
  const [sel, setSel] = useState(0);
  const selClamped = Math.min(sel, Math.max(0, items.length - 1));

  useInput(
    (input, key) => {
      if (key.escape) return onCancel();
      if (key.return) return onRun(query);
      if (key.tab) {
        const s = items[selClamped];
        if (s) {
          onChange(query.slice(0, tokenStart) + s.value + " ");
          setSel(0);
        }
        return;
      }
      if (key.upArrow) return setSel((v) => Math.max(0, v - 1));
      if (key.downArrow) return setSel((v) => Math.min(items.length - 1, v + 1));
      if (key.backspace || key.delete) {
        setSel(0);
        return onChange(query.slice(0, -1));
      }
      if (input && !key.ctrl && !key.meta) {
        setSel(0);
        onChange(query + input);
      }
    },
    { isActive: active },
  );

  const start = Math.min(Math.max(0, selClamped - CAP + 1), Math.max(0, items.length - CAP));
  const visible = items.slice(start, start + CAP);

  return (
    <Box flexDirection="column" width={width} paddingX={1}>
      {/* dropdown above the input (bottom-anchored), padded to a fixed height */}
      {Array.from({ length: CAP }).map((_, i) => {
        const s = visible[i];
        if (!s) return <Text key={"blank" + i}> </Text>;
        const idx = start + i;
        const selected = idx === selClamped;
        const m = Math.min(matchLen, s.label.length);
        return (
          <Text key={s.value} wrap="truncate-end">
            {selected ? <Text color="cyan">▸ </Text> : <Text>{"  "}</Text>}
            <Text color="yellow">{s.label.slice(0, m)}</Text>
            <Text color={selected ? "cyan" : undefined} bold={selected}>
              {s.label.slice(m)}
            </Text>
            {s.summary ? <Text dimColor>{"   " + s.summary}</Text> : null}
            {(s.write && !canWrite) || (s.control && !canControl) ? <Text color="red">{"  read-only"}</Text> : null}
          </Text>
        );
      })}
      <Text wrap="truncate-end">
        <Text color="cyan">{": "}</Text>
        <Text>{query}</Text>
        <Text inverse> </Text>
        <Text dimColor>
          {items.length ? "   Tab completes · Enter runs" : "   Enter runs · Esc cancels"}
        </Text>
      </Text>
    </Box>
  );
}
