/**
 * Type-only compatibility cells for the exported `GatewayWake` interface. They are checked by
 * `tsc -p tsconfig.smoke.json`, which is part of `pnpm --filter @cotal-ai/connector-core typecheck`.
 * Nothing here runs. The bodies sit inside functions that are never called.
 *
 * `signal` gained a required `preview` argument. Callers must pass it.
 */
import type { GatewayConnection, GatewayWake, RenderedInboxPreview } from "../src/index.js";

// Cell 1: an embedder that implemented the earlier one-argument `signal` still conforms. A method
// with fewer parameters is assignable, so existing implementations keep compiling.
export function oneArgumentImplementerStillConforms(): GatewayWake {
  const wake: GatewayWake = {
    signal: (connection: GatewayConnection) => connection.id.length > 0,
    listening: () => "",
  };
  return wake;
}

// Cell 2: a caller that invokes `signal` with only the connection no longer compiles. This is the
// documented break for direct callers of the exported interface, which is why the change is minor.
export function oneArgumentCallIsRefused(wake: GatewayWake, connection: GatewayConnection, preview: RenderedInboxPreview): boolean {
  // @ts-expect-error signal requires the rendered preview as its second argument
  const refused = wake.signal(connection);
  return refused && wake.signal(connection, preview);
}
