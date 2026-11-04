import { Box, Text } from "ink";
import type { MeshState } from "../mesh.js";
import { Sparkline } from "./Sparkline.js";

/** Bottom bar: connection + space + active channel + msgs/s, then context keybindings. */
export function StatusBar({
  status,
  rates,
  activeChannel,
  agentCount,
  mode,
  canBack,
  canWrite,
  canControl,
  onRoster,
  width,
}: {
  status: MeshState["status"];
  rates: MeshState["rates"];
  activeChannel: string;
  agentCount: number;
  mode: "normal" | "dm" | "topo";
  canBack?: boolean;
  canWrite?: boolean;
  canControl?: boolean;
  /** The operator's presence peer is up (participant mode): agents can reply. */
  onRoster?: boolean;
  width: number;
}) {
  const keys =
    mode === "dm"
      ? "ctrl+p commands · j/k scroll · ←→ pane · esc back · / search"
      : mode === "topo"
        ? "ctrl+p commands · v / 1-3 variant · j/k h/l move · Enter detail · esc back"
        : (canBack ? "esc back · " : "") +
        "ctrl+p commands · j/k select · Enter detail" +
        (canWrite ? " · c compose" : "") +
        (canControl ? " · D kill" : "") +
        " · / search · [ ] chan";
  return (
    <Box width={width} paddingX={1}>
      <Text wrap="truncate-end">
        <Text color={status.connected ? "green" : "red"}>{status.connected ? "● " : "⨯ "}</Text>
        <Text dimColor>
          {status.space + " · #" + activeChannel + " · " + agentCount + " agents · " +
            rates.msgsPerSec.toFixed(1) + " msg/s "}
        </Text>
        <Sparkline values={rates.activity} />
        <Text dimColor>{" 60s"}</Text>
        {status.dmVisible ? null : <Text color="yellow">{"  chat-only"}</Text>}
        {canWrite ? null : <Text color="yellow">{"  read-only"}</Text>}
        {onRoster ? <Text color="green">{"  on roster"}</Text> : null}
        {status.error ? (
          <Text color="red">{"  ! " + status.error}</Text>
        ) : status.warning ? (
          <Text color="yellow">{"  ! " + status.warning}</Text>
        ) : (
          <Text dimColor>{"   " + keys}</Text>
        )}
      </Text>
    </Box>
  );
}
