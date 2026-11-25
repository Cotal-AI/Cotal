/** Test shim over the production relay: it marks the event named in `RELAY_HOLDS` as held, as a
 *  connector's hook entry marks its own held events. */
const { runHookRelay } = await import("../../src/relay.js");
const held = process.env.RELAY_HOLDS;
void runHookRelay(undefined, undefined, {
  holds: (event) => (event as { hook_event_name?: unknown } | null)?.hook_event_name === held,
}).catch(() => process.exit(0));
