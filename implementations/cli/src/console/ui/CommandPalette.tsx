import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { MeshSnapshot } from "../../view/mesh-view.js";
import { COMMANDS } from "../commands.js";
import { Modal } from "./Modal.js";
import type { PsReply } from "../control.js";

const CAP = 6; // suggestion rows; the palette is a fixed CAP+1 rows tall so the layout doesn't jump

type Sugg = { value: string; label: string; summary?: string; write?: boolean; control?: boolean; run?: boolean };
type Suggestions = { items: Sugg[]; tokenStart: number; matchLen: number; mode: "command" | "target" | "token"; hint?: string };

/** The command's first argument opens choices immediately. Later @/# tokens retain the old
 * Tab completion, while Enter submits the complete command rather than replacing message text. */
function suggest(query: string, snap: MeshSnapshot, managed: PsReply | undefined): Suggestions {
  const command = query.split(" ")[0]!.toLowerCase();
  if (!query.includes(" ") || !COMMANDS.some((item) => item.name === command)) {
    const q = query.toLowerCase();
    const commands: Sugg[] = COMMANDS.map((c) => ({
      value: c.name, label: c.name === "spawn" ? "Spawn agent" : c.name,
      summary: c.name === "spawn" ? "Choose an application, model and first task" : c.summary,
      write: c.write, control: c.control,
    }));
    const items = commands
      .filter((item) => `${item.label} ${item.value} ${item.summary ?? ""} ${item.value === "spawn" ? "new agent" : ""}`.toLowerCase().includes(q));
    const rank = (item: Sugg) => !q ? (item.value === "spawn" ? 0 : 1)
      : [item.value, item.label.toLowerCase()].includes(q) ? 0
      : item.value.startsWith(q) || item.label.toLowerCase().startsWith(q) ? 1 : 2;
    items.sort((a, b) => rank(a) - rank(b));
    return { items, tokenStart: 0, matchLen: q.length, mode: "command", hint: "No matching commands" };
  }
  const tokenStart = query.lastIndexOf(" ") + 1;
  const token = query.slice(tokenStart);
  const firstArgument = query.indexOf(" ") === tokenStart - 1;
  const q = token.replace(/^[@#]/, "").toLowerCase();
  const peers = [...snap.agents, ...snap.endpoints];
  const agents = (): Sugg[] => peers
    .filter((p) => p.card.name.toLowerCase().startsWith(q) || p.card.id.toLowerCase().startsWith(q))
    .map((p) => {
      const duplicate = peers.some((other) => other.card.id !== p.card.id && other.card.name === p.card.name);
      return { value: "@" + (duplicate ? p.card.id : p.card.name),
        label: "@" + p.card.name + (duplicate ? ` (${p.card.id.slice(0, 8)})` : ""),
        summary: [p.card.role, p.status].filter(Boolean).join(" · "), run: command === "call" };
    });
  const channels = (): Sugg[] => snap.channels
    .filter((c) => c.channel.toLowerCase().startsWith(q))
    .map((c) => ({ value: "#" + c.channel, label: "#" + c.channel, summary: c.messages + " msgs", run: command === "delchan" }));
  if (firstArgument) {
    let items: Sugg[] | undefined;
    let hint: string | undefined;
    if (command === "attach" || command === "status") {
      items = managed?.ok ? managed.rows
        .filter((row) => row.name.toLowerCase().startsWith(q))
        .map((row) => ({ value: row.name, label: row.name, summary: `${row.agent} · ${row.status} · mesh ${row.mesh}`, run: true })) : [];
      hint = !managed ? "Loading managed agents…" : !managed.ok ? managed.error : managed.rows.length ? "No matching managed agents" : "No managed agents available";
    } else if (command === "dm" || command === "call") {
      items = agents(); hint = peers.length ? "No matching agents or endpoints" : "No agents or endpoints available";
    } else if (command === "msg" || command === "delchan") {
      items = channels(); hint = snap.channels.length ? "No matching channels" : "No channels available";
    } else if (command === "ask") {
      const roles = [...new Set(peers.map((p) => p.card.role).filter((role): role is string => !!role))];
      items = roles.filter((role) => role.toLowerCase().startsWith(q))
        .map((role) => ({ value: "@" + role, label: "@" + role, summary: "role" }));
      hint = roles.length ? "No matching roles" : "No advertised roles available";
    }
    if (items) return { items, tokenStart, matchLen: token.length, mode: "target", hint };
  }
  const hint = ["dm", "msg", "ask"].includes(command) && !firstArgument
    ? "Type a message, then press Enter."
    : COMMANDS.find((c) => c.name === command)?.usage;
  return { items: token.startsWith("@") ? agents() : token.startsWith("#") ? channels() : [],
    tokenStart, matchLen: token.length, mode: "token", hint };
}

/** Ctrl+P opens operator actions and typed commands with agent and channel suggestions. */
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
  onNewAgent,
  readManaged,
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
  onNewAgent: () => void;
  readManaged: () => Promise<PsReply>;
}) {
  const [managed, setManaged] = useState<PsReply>();
  const needsManaged = /^(attach|status) [^ ]*$/i.test(query);
  useEffect(() => {
    setManaged(undefined);
    if (!active || !needsManaged || !canControl) return;
    let alive = true;
    void readManaged().then((reply) => { if (alive) setManaged(reply); }, (error: unknown) => {
      if (alive) setManaged({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return () => { alive = false; };
  }, [active, needsManaged, canControl, readManaged]);
  const { items, tokenStart, matchLen, mode, hint } = suggest(query, snapshot, managed);
  const [sel, setSel] = useState(0);
  const [choosingTarget, setChoosingTarget] = useState(false);
  const selClamped = Math.min(sel, Math.max(0, items.length - 1));

  useInput(
    (input, key) => {
      if (key.escape) return onCancel();
      if (key.return) {
        const selected = items[selClamped];
        if (mode === "command" && selected) {
          if (selected.control && !canControl || selected.write && !canWrite) return;
          if (selected.value === "spawn") return onNewAgent();
          const command = COMMANDS.find((item) => item.name === selected.value);
          if (command?.usage) { setChoosingTarget(true); onChange(`${selected.value} `); setSel(0); return; }
          return onRun(selected.value);
        }
        if (mode === "target" && choosingTarget && selected) {
          const line = query.slice(0, tokenStart) + selected.value;
          setChoosingTarget(false);
          if (selected.run) return onRun(line);
          onChange(line + " "); setSel(0); return;
        }
        if (mode === "target" && !query.slice(tokenStart)) return;
        return onRun(query);
      }
      if (key.tab) {
        const s = items[selClamped];
        if (s) {
          if (s.value === "spawn") { if (canControl) onNewAgent(); return; }
          setChoosingTarget(mode === "command");
          onChange(query.slice(0, tokenStart) + s.value + " ");
          setSel(0);
        }
        return;
      }
      if (key.upArrow || key.downArrow) {
        if (mode === "target") setChoosingTarget(true);
        setSel((v) => key.upArrow ? Math.max(0, v - 1) : Math.min(items.length - 1, v + 1));
        return;
      }
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
  const labelWidth = Math.min(24, Math.max(9, ...items.map((item) => item.label.length)));

  return (
    <Modal title="Commands" width={width}>
      <Text wrap="truncate-end">
        <Text color="cyan">{"› "}</Text>
        {query ? <><Text>{query}</Text><Text inverse> </Text></>
          : <Text dimColor><Text inverse>S</Text>earch</Text>}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {needsManaged && managed?.ok && (managed.silent.length || managed.failed.length) ?
          <Text color="yellow" wrap="truncate-end">{[
            ...managed.failed.map((failure) => `${failure.instanceId}: ${failure.error}`),
            ...(managed.silent.length ? [`No answer from ${managed.silent.join(", ")}`] : []),
          ].join("; ")}</Text> : null}
        {/* Keep the suggestion area the same height while filtering. */}
        {Array.from({ length: CAP }).map((_, i) => {
          const s = visible[i];
          if (!s) return <Text dimColor key={"blank" + i} wrap="truncate-end">{i === 0 && !items.length ? hint ?? "No suggestions" : " "}</Text>;
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
              {s.summary ? <Text dimColor>{" ".repeat(Math.max(3, labelWidth - s.label.length + 3)) + s.summary}</Text> : null}
              {/* Two different refusals, named apart: a raw --creds session CAN publish but cannot
                  drive the manager, so labelling its control commands "read-only" tells the operator
                  the session is something it is not. Same words the refusal itself uses. */}
              {s.write && !canWrite ? (
                <Text color="red">{"  read-only"}</Text>
              ) : s.control && !canControl ? (
                <Text color="red">{"  no control path"}</Text>
              ) : null}
            </Text>
          );
        })}
      </Box>
    </Modal>
  );
}
