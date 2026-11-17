/** Test shim over the exact production relay. It observes the first real connect error without
 * changing it, so the parent binds the replacement only after the startup failure actually happened. */
import net from "node:net";
import { writeSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const originalConnect = net.connect;
let reported = false;
(net as { connect: typeof net.connect }).connect = ((...args: unknown[]) => {
  const socket = (originalConnect as (...values: unknown[]) => ReturnType<typeof net.connect>)(...args);
  socket.once("error", () => {
    if (reported) return;
    reported = true;
    writeSync(2, "RELAY_DIAL_FAILED\n");
  });
  return socket;
}) as typeof net.connect;
syncBuiltinESMExports();

const { runHookRelay } = await import("../../src/relay.js");
process.stdout.write("RELAY_READY\n", () => {
  void runHookRelay().catch(() => process.exit(0));
});
