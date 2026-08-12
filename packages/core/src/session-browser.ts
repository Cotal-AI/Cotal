/**
 * The BROWSER-SAFE subset of the §13.6 session composite, for the manager console's session-client
 * bundle (P2 item 6): the rails + the terminal-session frame codec, with ZERO node-only
 * dependencies. The console bundle (esbuild) imports ONLY this subpath
 * (`@cotal-ai/core/session-browser`), NEVER the package root — the root pulls `node:crypto` through
 * the grant mint/verify/redeem + the KV ledger, which a browser has no business bundling.
 *
 * This is a re-export barrel over the two already-split node-free modules; it adds no logic, so the
 * SAME core rail + frame codec that runs on the manager runs in the browser (the point of item 6:
 * a remote holder speaks the identical wire).
 */
export {
  openSessionRail,
  encodeSessionFrame,
  parseSessionFrame,
  assertWindow,
  SESSION_WINDOW_DEFAULT,
  SESSION_WINDOW_MAX,
  type SessionFrame,
  type SessionRail,
  type SessionRailOpts,
  type SessionRole,
} from "./endpoint-session-rail.js";
export {
  encodeTerminalData,
  terminalFrameBytes,
  decodeTerminalFrame,
  type TerminalFrame,
} from "./session-terminal-frames.js";
// Type-only (esbuild erases it — no runtime import of endpoint-session.js, so no node:crypto).
export type { SessionGrant } from "./endpoint-session.js";
