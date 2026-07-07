// SpecView — the single seam between Cotal's MeshView data and json-render's Ink Renderer.
// The console hands it a flat spec (its own chrome, or a view a peer published) and it paints
// it with the standard Ink catalog (Box/Text/Table/StatusLine/…), included by default. An
// unknown component type renders as an inert notice via `fallback` rather than throwing.

import { Text } from "ink";
import { JSONUIProvider, Renderer } from "@json-render/ink";
import type { Spec } from "@json-render/ink";

export function SpecView({ spec }: { spec: Spec }) {
  return (
    <JSONUIProvider initialState={spec.state ?? {}}>
      <Renderer spec={spec} fallback={Unsupported} />
    </JSONUIProvider>
  );
}

function Unsupported() {
  return <Text dimColor>[unsupported component]</Text>;
}
