// Preload for supervise-crash-late-join.smoke.ts. The first seat launched with REPRO_JOIN_DELAY_ONCE
// set waits REPRO_JOIN_DELAY_MS before the stub starts, so it joins presence after the manager's
// readiness timeout. The marker file limits that to one launch; later launches start at once.
import { closeSync, openSync } from "node:fs";

const marker = process.env.REPRO_JOIN_DELAY_ONCE;
if (marker) {
  let first = false;
  try {
    closeSync(openSync(marker, "wx"));
    first = true;
  } catch {
    // An earlier launch took the delay.
  }
  if (first) await new Promise((r) => setTimeout(r, Number(process.env.REPRO_JOIN_DELAY_MS)));
}
