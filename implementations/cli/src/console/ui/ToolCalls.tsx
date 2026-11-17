import { useEffect, useReducer, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { CotalEndpoint } from "@cotal-ai/core";
import { displaySafe } from "../mesh.js";
import { consoleTools, payloadText } from "../tool-calls.js";
import { wrapText } from "./theme.js";

/** Names stay visible while arguments and results open only on explicit input. */
export function ToolCalls({ ep, owner, actor, width, height }: {
  ep: CotalEndpoint; owner: string; actor: string; width: number; height: number;
}) {
  const model = consoleTools(ep, owner, actor);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [expanded, setExpanded] = useState(false);
  const [top, setTop] = useState(0);
  useEffect(() => model.subscribe(redraw), [model]);
  const lines = ["tool calls · p toggles payloads · ↑/↓ scroll · Esc closes"];
  if (model.error) lines.push("payload unavailable: " + model.error);
  for (const call of model.calls.values()) {
    lines.push(call.name + (expanded ? "" : " [payloads collapsed]"));
    if (expanded) {
      for (const [label, body] of [["arguments", call.args], ["result", call.result]] as const) {
        lines.push("  " + label + ":");
        for (const line of wrapText(displaySafe(body === undefined ? "(not received or withheld)" : payloadText(body)), Math.max(8, width - 8))) lines.push("    " + line);
      }
    }
  }
  if (!model.calls.size) lines.push("(no tool calls received)");
  const room = Math.max(1, height - 6);
  const maxTop = Math.max(0, lines.length - room);
  useInput((input, key) => {
    if (input === "p") { setExpanded((v) => !v); setTop(0); }
    if (key.downArrow || input === "j") setTop((n) => Math.min(maxTop, n + 1));
    if (key.upArrow || input === "k") setTop((n) => Math.max(0, n - 1));
  });
  return <Box flexDirection="column">{lines.slice(Math.min(top, maxTop), Math.min(top, maxTop) + room).map((line, i) => <Text key={i}>{displaySafe(line)}</Text>)}</Box>;
}
