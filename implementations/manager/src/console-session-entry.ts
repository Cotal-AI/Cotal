/**
 * The manager console's browser session-client bundle ENTRY (P2 item 6). esbuild bundles this (and
 * ONLY this: the browser-safe core subpath + nats-core's ws connect) into
 * `dist/console/session-bundle.js`, served as a static asset. It runs IN THE BROWSER — the manager's
 * node side never imports it (nats-core's ws path is baked into the bundle at build time; node rides
 * `@nats-io/transport-node`).
 *
 * It exposes the core §13.6 rail + terminal-frame codec + `wsconnect` on one global so the console
 * page can open a mesh session CALLER without a module loader: connect over the broker's websocket
 * listener with the per-session, rails-only credential the loopback face hands it, open the caller
 * rail with the redeemed grant, and drive xterm — the SAME core rail code the manager serves.
 */
import { wsconnect } from "@nats-io/nats-core";
import {
  openSessionRail,
  encodeTerminalData,
  terminalFrameBytes,
  decodeTerminalFrame,
} from "@cotal-ai/core/session-browser";

// A single browser global (no module system in the served console page).
(globalThis as unknown as { CotalSession: unknown }).CotalSession = {
  wsconnect,
  openSessionRail,
  encodeTerminalData,
  terminalFrameBytes,
  decodeTerminalFrame,
};
