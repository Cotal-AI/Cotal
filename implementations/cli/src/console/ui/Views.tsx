import { Box, Text } from "ink";
import type { ViewItem } from "../mesh.js";
import { SpecView } from "../render/SpecView.js";
import { asSpec, validateView } from "../render/catalog.js";
import { agentColor, fmtTime } from "./theme.js";

/** The view lens (`V`): renders the most recent peer-published view through json-render's Ink
 *  renderer, headed by who sent it. The spec is re-checked against the component catalog here
 *  (defense in depth) — a malformed or over-catalog view shows its rejection reason, not code. */
export function Views({ views, width, height }: { views: ViewItem[]; width: number; height: number }) {
  const latest = views[views.length - 1];
  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor="cyan" paddingX={1}>
      {latest ? (
        <ViewPanel item={latest} count={views.length} />
      ) : (
        <Text dimColor>no views yet — a peer can publish one with endpoint.publishView(spec)</Text>
      )}
    </Box>
  );
}

function ViewPanel({ item, count }: { item: ViewItem; count: number }) {
  const spec = asSpec(item.spec);
  const check = validateView(spec);
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text color={agentColor(item.from.name)} bold>
          {item.from.name}
        </Text>
        <Text dimColor>
          {(item.channel ? " · #" + item.channel : "") +
            " · " +
            fmtTime(item.ts) +
            " · " +
            count +
            (count === 1 ? " view" : " views")}
        </Text>
      </Text>
      <Box marginTop={1}>
        {check.ok ? <SpecView spec={spec} /> : <Text color="red">{"rejected view — " + check.reason}</Text>}
      </Box>
    </Box>
  );
}
