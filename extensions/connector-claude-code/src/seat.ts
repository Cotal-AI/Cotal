/**
 * The entry Claude Code launches for a Cotal seat (`dist/seat.cjs`).
 *
 * All it does is put Node's compile cache in front of the 4.9 MB `dist/mcp.cjs` bundle and then run
 * it. The cache covers modules compiled after it is enabled, so this has to be a separate file:
 * enabling it from inside the bundle would be too late for the bundle itself, which is where the
 * whole cost is.
 *
 * `dist/mcp.cjs` stays the library entry (`@cotal-ai/connector-claude-code/mcp`) and a working
 * process entry on its own, so nothing that already points at it breaks.
 */
import { createRequire } from "node:module";
import { enableSeatCompileCache, flushSeatCompileCache } from "@cotal-ai/connector-core/seat-cache";

enableSeatCompileCache("cotal-connector");

// `createRequire` keeps the specifier out of the bundler's reach: a plain `require("./mcp.cjs")`
// would resolve against src/ at build time and inline the bundle back into this file, which is
// the one thing this entry exists to avoid. The path is resolved at runtime, inside dist/.
const seat = createRequire(__filename)("./mcp.cjs") as { runClaudeSeat: () => Promise<void> };

// The bundle is compiled by now, so its code cache exists. Write it before the seat starts
// serving, because a seat ends on a signal and Node's own flush at exit never runs.
flushSeatCompileCache();

void seat.runClaudeSeat();
