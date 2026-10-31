import type { ReactNode } from "react";
import { Box, Text } from "ink";

/** Center one keyboard-owned dialog above the live console. Small terminals get an explicit
 * size request rather than clipped launch controls. */
export function Modal({ title, subtitle, width, children }: {
  title: string; subtitle?: string; width: number; children: ReactNode;
}) {
  return (
    <Box width={Math.min(76, width)} flexDirection="column" borderStyle="round" borderColor="cyan"
      backgroundColor="#1e1e2e" paddingX={2} paddingY={1}>
      <Box justifyContent="space-between"><Text bold>{title}</Text><Text dimColor>esc</Text></Box>
      {subtitle ? <Text dimColor>{subtitle}</Text> : null}
      <Box marginTop={1} flexDirection="column">{children}</Box>
    </Box>
  );
}
