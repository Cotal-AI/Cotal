import { useEffect, useState } from "react";
import { Box, Text, useFocus, useInput } from "ink";
import { peerLabel } from "@cotal-ai/core";
import type { DmMessage, DmThread, DmPeer } from "../../view/mesh-view.js";
import { agentColor, STATUS, fmtTime, wrapText } from "./theme.js";
import type { FocusId } from "../mesh.js";

type PRow = { kind: "peer"; pi: number } | { kind: "conv"; pi: number; ci: number };
type TRow = { head: true; m: DmMessage } | { head: false; text: string };

/** Flatten the peer list for display: every peer, and — under the selected peer — its
 *  conversations (indented). The cursor walks this flat list. */
function flattenPeers(dms: DmPeer[], selPeer: number): PRow[] {
  const out: PRow[] = [];
  dms.forEach((p, pi) => {
    out.push({ kind: "peer", pi });
    if (pi === selPeer) p.conversations.forEach((_c, ci) => out.push({ kind: "conv", pi, ci }));
  });
  return out;
}

function threadRows(conv: DmThread | undefined, width: number): TRow[] {
  if (!conv) return [];
  const out: TRow[] = [];
  for (const m of conv.messages) {
    out.push({ head: true, m });
    for (const seg of wrapText(m.text, width)) out.push({ head: false, text: seg });
  }
  return out;
}

/** The direct-message lens (god-view only): a per-peer roll-up on the left, the selected
 *  conversation's thread on the right. Both panes read `mesh.signals.dms` straight — the model
 *  already grouped raw unicast into per-peer conversations. Two focus regions; `←→`/Tab switch. */
export function Dm({
  dms,
  dmVisible,
  width,
  height,
  narrow,
  blocked,
  onFocus,
}: {
  dms: DmPeer[];
  dmVisible: boolean;
  width: number;
  height: number;
  narrow: boolean;
  blocked: boolean;
  onFocus: (id: FocusId) => void;
}) {
  const peers = useFocus({ id: "dmpeers" });
  const thread = useFocus({ id: "dmthread" });
  useEffect(() => {
    if (peers.isFocused) onFocus("dmpeers");
    else if (thread.isFocused) onFocus("dmthread");
  }, [peers.isFocused, thread.isFocused, onFocus]);

  // selConv < 0 → the peer header is selected (thread shows its newest conversation).
  const [selPeer, setSelPeer] = useState(0);
  const [selConv, setSelConv] = useState(-1);
  const [up, setUp] = useState(0); // thread scroll: rows up from the bottom

  const peerClamped = Math.min(selPeer, Math.max(0, dms.length - 1));
  const peer = dms[peerClamped];
  const convCount = peer ? peer.conversations.length : 0;
  const convIdx = Math.min(Math.max(0, selConv), Math.max(0, convCount - 1));
  const conv = peer?.conversations[convIdx];

  // Reset the thread scroll whenever the selected conversation changes.
  useEffect(() => setUp(0), [peerClamped, convIdx]);

  useInput(
    (input, key) => {
      if (key.downArrow || input === "j") {
        if (selConv < 0) convCount > 0 ? setSelConv(0) : nextPeer();
        else if (selConv < convCount - 1) setSelConv((c) => c + 1);
        else nextPeer();
      } else if (key.upArrow || input === "k") {
        if (selConv >= 0) setSelConv((c) => c - 1);
        else if (peerClamped > 0) {
          setSelPeer(peerClamped - 1);
          setSelConv(-1);
        }
      }
      function nextPeer() {
        if (peerClamped < dms.length - 1) {
          setSelPeer(peerClamped + 1);
          setSelConv(-1);
        }
      }
    },
    { isActive: peers.isFocused && !blocked },
  );

  const tRows = threadRows(conv, Math.max(8, (narrow ? width : width - peerPaneW(width, narrow)) - 4 - 3));
  const tRoom = Math.max(1, (narrow ? height - peerPaneH(height) : height) - 3);
  const maxUp = Math.max(0, tRows.length - tRoom);
  useInput(
    (input, key) => {
      const half = Math.max(1, Math.floor(tRoom / 2));
      if (key.upArrow || input === "k") setUp((u) => Math.min(maxUp, u + 1));
      else if (key.downArrow || input === "j") setUp((u) => Math.max(0, u - 1));
      else if (key.pageUp || (key.ctrl && input === "u"))
        setUp((u) => Math.min(maxUp, u + (key.ctrl ? half : tRoom)));
      else if (key.pageDown || (key.ctrl && input === "d"))
        setUp((u) => Math.max(0, u - (key.ctrl ? half : tRoom)));
      else if (input === "g" || key.home) setUp(maxUp);
      else if (input === "G" || key.end) setUp(0);
    },
    { isActive: thread.isFocused && !blocked },
  );

  if (!dmVisible)
    return (
      <Box width={width} height={height} alignItems="center" justifyContent="center">
        <Text dimColor>DMs hidden (chat-only creds)</Text>
      </Box>
    );
  if (dms.length === 0)
    return (
      <Box width={width} height={height} alignItems="center" justifyContent="center">
        <Text dimColor>no direct messages</Text>
      </Box>
    );

  const pW = peerPaneW(width, narrow);
  const pH = peerPaneH(height);
  const peerBox = narrow ? { w: width, h: pH } : { w: pW, h: height };
  const threadBox = narrow ? { w: width, h: height - pH } : { w: width - pW, h: height };

  const flat = flattenPeers(dms, peerClamped);
  const selFlat = flat.findIndex((r) =>
    selConv < 0 ? r.kind === "peer" && r.pi === peerClamped : r.kind === "conv" && r.pi === peerClamped && r.ci === convIdx,
  );
  const pCap = Math.max(1, peerBox.h - 3);
  let pStart = 0;
  if (flat.length > pCap)
    pStart = Math.min(Math.max(0, selFlat - Math.floor(pCap / 2)), flat.length - pCap);
  const pVisible = flat.slice(pStart, pStart + pCap);

  const end = tRows.length - Math.min(up, maxUp);
  const top = Math.max(0, end - tRoom);
  const tVisible = tRows.slice(top, end);
  const tBelow = tRows.length - end;

  return (
    <Box flexDirection={narrow ? "column" : "row"} height={height}>
      <Box
        flexDirection="column"
        width={peerBox.w}
        height={peerBox.h}
        borderStyle="round"
        borderColor={peers.isFocused ? "cyan" : "gray"}
        paddingX={1}
      >
        <Text wrap="truncate-end">
          <Text bold>direct messages</Text>
          <Text dimColor>{" · " + dms.length + " peer" + (dms.length === 1 ? "" : "s")}</Text>
        </Text>
        {pVisible.map((r, i) => {
          const sel = peers.isFocused && pStart + i === selFlat;
          if (r.kind === "peer") {
            const p = dms[r.pi];
            const caret = r.pi === peerClamped ? "▾" : "▸";
            const label = peerLabel(p);
            if (sel)
              return (
                <Text key={"p" + r.pi} inverse bold color="cyan" wrap="truncate-end">
                  {caret + " " + STATUS[p.status].dot + " " + label}
                </Text>
              );
            return (
              <Text key={"p" + r.pi} wrap="truncate-end">
                <Text dimColor>{caret + " "}</Text>
                <Text color={STATUS[p.status].color}>{STATUS[p.status].dot + " "}</Text>
                <Text color={agentColor(p.name)}>{label}</Text>
                <Text dimColor>{"  " + p.conversations.length + "t"}</Text>
              </Text>
            );
          }
          const c = dms[r.pi].conversations[r.ci];
          const label = peerLabel({ name: c.with, role: c.role });
          if (sel)
            return (
              <Text key={"c" + r.pi + "." + r.ci} inverse bold color="cyan" wrap="truncate-end">
                {"  ↳ " + STATUS[c.status].dot + " " + label}
              </Text>
            );
          return (
            <Text key={"c" + r.pi + "." + r.ci} wrap="truncate-end">
              <Text dimColor>{"  ↳ "}</Text>
              <Text color={STATUS[c.status].color}>{STATUS[c.status].dot + " "}</Text>
              <Text color={agentColor(c.with)}>{label}</Text>
            </Text>
          );
        })}
      </Box>
      <Box
        flexDirection="column"
        width={threadBox.w}
        height={threadBox.h}
        borderStyle="round"
        borderColor={thread.isFocused ? "cyan" : "gray"}
        paddingX={1}
      >
        <Text wrap="truncate-end">
          {conv ? (
            <>
              <Text bold color={agentColor(peer.name)}>{peer.name}</Text>
              <Text dimColor> ↔ </Text>
              <Text bold color={agentColor(conv.with)}>{conv.with}</Text>
              <Text dimColor>{"  · " + conv.messages.length + " msg"}</Text>
            </>
          ) : (
            <Text dimColor>no conversation</Text>
          )}
          {tBelow > 0 ? <Text color="yellow">{"  ↓" + tBelow + " · G newest"}</Text> : null}
        </Text>
        {tVisible.map((r, i) =>
          r.head ? (
            <Text key={top + i} wrap="truncate-end">
              <Text dimColor>{fmtTime(r.m.ts) + " "}</Text>
              <Text color={agentColor(r.m.from)}>{r.m.from}</Text>
              <Text dimColor>{" → " + r.m.to + ":"}</Text>
            </Text>
          ) : (
            <Text key={top + i} wrap="truncate-end">
              {"   " + r.text}
            </Text>
          ),
        )}
      </Box>
    </Box>
  );
}

// Pane geometry — mirrors app.tsx's wide/narrow split so the lens reads like the main view.
function peerPaneW(width: number, narrow: boolean): number {
  return narrow ? width : Math.min(36, Math.max(24, Math.floor(width * 0.3)));
}
function peerPaneH(height: number): number {
  return Math.min(8, Math.max(3, Math.floor(height * 0.35)));
}
