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
  railOpen,
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
  railOpen: boolean;
  canBack?: boolean;
  canWrite?: boolean;
  canControl?: boolean;
  /** The operator's presence peer is up (participant mode): agents can reply. */
  onRoster?: boolean;
  width: number;
}) {
  const keys =
    mode === "dm"
      ? "j/k scroll · ←→ pane · esc back · / search · ? help · q quit"
      : mode === "topo"
        ? "v / 1-3 variant · j/k h/l move · Enter detail · esc back · ? help · q quit"
        : (canBack ? "esc back · " : "") +
        ": cmd · j/k select · Enter detail · " +
        (railOpen ? "n hide-rail" : "n needs-you") +
        " · d DMs" +
        (canWrite ? " · c compose" : "") +
        (canControl ? " · a attach · D kill" : "") +
        " · / search · [ ] chan · ? help · q quit";
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
