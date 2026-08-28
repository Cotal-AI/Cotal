/** Test shim over the exact production relay. The marker lets the parent keep the control socket
 * absent through the first dial, which a plain child-process launch cannot synchronize reliably. */
import { runHookRelay } from "../../src/relay.js";

process.stdout.write("RELAY_READY\n", () => {
  void runHookRelay().catch(() => process.exit(0));
});
