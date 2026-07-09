import { useState } from "react";
import { Box, Text, useInput } from "ink";

/** A destructive action awaiting confirmation. `kill` is a quick y/n; `deleteSpace` (irreversible)
 *  requires typing the space name. */
export type ConfirmTarget =
  | { kind: "kill"; name: string }
  | { kind: "deleteSpace"; space: string };

/** Full-screen red danger overlay. Owns input while shown. Calls onConfirm only when the gate is
 *  satisfied (y for kill, exact name typed for deleteSpace); Esc/n cancels. */
export function Confirm({
  target,
  width,
  height,
  onConfirm,
  onCancel,
}: {
  target: ConfirmTarget;
  width: number;
  height: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const match = target.kind === "deleteSpace" && typed === target.space;

  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (target.kind === "kill") {
      if (input === "y" || input === "Y") return onConfirm();
      if (input === "n" || input === "N" || key.return) return onCancel();
      return;
    }
    // deleteSpace: type the name to arm Enter
    if (key.return) {
      if (match) onConfirm();
      return;
    }
    if (key.backspace || key.delete) return setTyped((t) => t.slice(0, -1));
    if (input && !key.ctrl && !key.meta) setTyped((t) => t + input);
  });

  return (
    <Box
      width={width}
      height={height}
      borderStyle="round"
      borderColor="red"
      paddingX={2}
      paddingY={1}
      flexDirection="column"
    >
      <Text bold color="red">
        ⚠ danger
      </Text>
      {target.kind === "kill" ? (
        <Box marginTop={1} flexDirection="column">
          <Text>
            Stop agent <Text bold>{target.name}</Text> via the manager?
          </Text>
          <Box marginTop={1}>
            <Text dimColor>y = stop · n / Esc = cancel</Text>
          </Box>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          <Text>
            Delete space <Text bold>{target.space}</Text> -{" "}
            <Text color="red">irreversible</Text> (all history + presence gone).
          </Text>
          <Box marginTop={1}>
            <Text dimColor>type the name to confirm: </Text>
            <Text color={match ? "green" : undefined}>{typed}</Text>
            <Text inverse> </Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>{match ? "Enter = delete" : "Esc = cancel"}</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
