import { useEffect, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { listSpaces, deleteSpace, type SpaceInfo } from "@cotal-ai/core";
import { agentColor } from "./theme.js";
import { Confirm } from "./Confirm.js";

/** The admin landing view: an overview of every space on the server (agents present, channels,
 *  messages) with a selection cursor. Enter drops into that space's console; `r` re-enumerates.
 *  Self-sizing (mirrors App) so the command just renders it. See docs/protocol-view.md. */
export function SpacePicker({
  server,
  creds,
  canWrite,
  onSelect,
}: {
  server: string;
  creds?: string;
  canWrite?: boolean;
  onSelect: (space: string) => void;
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
  useEffect(() => {
    const onResize = () => setSize({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  const [spaces, setSpaces] = useState<SpaceInfo[] | null>(null); // null = loading
  const [error, setError] = useState<string | undefined>();
  const [sel, setSel] = useState(0);
  const [nonce, setNonce] = useState(0); // bump to re-enumerate
  const [del, setDel] = useState<SpaceInfo | null>(null); // space pending deletion

  useEffect(() => {
    let alive = true;
    setSpaces(null);
    setError(undefined);
    listSpaces({ servers: server, creds })
      .then((s) => alive && setSpaces(s))
      .catch((e) => {
        if (!alive) return;
        setSpaces([]);
        setError((e as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [server, creds, nonce]);

  const list = spaces ?? [];
  const selClamped = Math.min(sel, Math.max(0, list.length - 1));

  useInput(
    (input, key) => {
      if (input === "q") return exit();
      if (input === "r") return setNonce((n) => n + 1);
      if (input === "D" && canWrite && list.length) return setDel(list[selClamped]);
      if (key.upArrow || input === "k") return setSel((v) => Math.max(0, v - 1));
      if (key.downArrow || input === "j") return setSel((v) => Math.min(list.length - 1, v + 1));
      if (key.return && list.length) return onSelect(list[selClamped].space);
    },
    { isActive: !del }, // the Confirm overlay owns input while a deletion is pending
  );

  if (del)
    return (
      <Confirm
        target={{ kind: "deleteSpace", space: del.space }}
        width={size.cols}
        height={size.rows}
        onConfirm={() => {
          const space = del.space;
          setDel(null);
          void deleteSpace({ servers: server, creds, space }).then(() => setNonce((n) => n + 1));
        }}
        onCancel={() => setDel(null)}
      />
    );

  const capacity = Math.max(1, size.rows - 4); // border (2) + title (1) + footer (1)
  let start = 0;
  if (list.length > capacity)
    start = Math.min(Math.max(0, selClamped - Math.floor(capacity / 2)), list.length - capacity);
  const visible = list.slice(start, start + capacity);

  return (
    <Box
      flexDirection="column"
      width={size.cols}
      height={size.rows}
      borderStyle="round"
      borderColor="cyan"
      paddingX={2}
    >
      <Text wrap="truncate-end">
        <Text bold color="cyan">spaces</Text>
        <Text dimColor>{" · " + server}</Text>
        {spaces && list.length ? <Text dimColor>{"  · " + list.length}</Text> : null}
      </Text>
      <Box flexDirection="column" flexGrow={1}>
        {spaces === null ? (
          <Text dimColor>loading spaces…</Text>
        ) : error ? (
          <Text color="red">{"! " + error}</Text>
        ) : list.length === 0 ? (
          <Text dimColor>no spaces found - run `cotal up` then `cotal demo`</Text>
        ) : (
          visible.map((s, i) => <Row key={s.space} s={s} selected={start + i === selClamped} />)
        )}
      </Box>
      <Text dimColor wrap="truncate-end">
        ↑↓ select · Enter open · r refresh{canWrite ? " · D delete" : ""} · q quit
      </Text>
    </Box>
  );
}

function Row({ s, selected }: { s: SpaceInfo; selected: boolean }) {
  const stats = s.agents + " agents · " + s.channels + " ch · " + s.messages + " msgs";
  if (selected)
    return (
      <Text inverse bold color="cyan" wrap="truncate-end">
        {"▸ " + s.space + "   " + stats}
      </Text>
    );
  return (
    <Text wrap="truncate-end">
      <Text dimColor>{"  "}</Text>
      <Text color={agentColor(s.space)}>{s.space}</Text>
      <Text dimColor>{"   " + stats}</Text>
    </Text>
  );
}
