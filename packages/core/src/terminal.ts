import type { Extension } from "./registry.js";

/**
 * NOTE: this is **not** part of the Cotal wire protocol. It is a host-side integration contract:
 * a way to drive a terminal multiplexer (open/close tabs) that an implementation resolves from the
 * {@link Extension} registry. It lives in `core` only because the consumer (`cotal setup`, an
 * implementation) and the provider (`@cotal-ai/cmux`, an extension) sit in tiers that can't import
 * each other, so the shared type has nowhere lower to live. Nothing here references a Cotal
 * concept (space, identity, subjects) — keep it that way; it describes terminals, not the mesh.
 */

/**
 * One terminal pane in a {@link Tab}: a `command` (+ `args`) to run, optionally in `cwd` with extra
 * `env`. Given in argv form — the backend is responsible for shell-quoting it safely, so callers
 * never build shell strings. `confirm` asks the backend to auto-accept a one-time confirmation
 * prompt the command may show on start (e.g. Claude's dev-channels prompt).
 */
export interface Pane {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  confirm?: boolean;
}

/**
 * A tab to open: a single pane, or several panes split along `direction` at `ratio`.
 *
 * Orientation is **normative** so every backend renders the same shape (this is the only thing
 * that makes layout parity checkable across providers):
 * - `direction: "vertical"` — a vertical divider, i.e. side-by-side **left/right columns**.
 * - `direction: "horizontal"` — a horizontal divider, i.e. stacked **top/bottom rows**.
 * - `ratio` — the **first** pane's fraction of the tab (the second pane gets `1 - ratio`).
 *
 * Backend-agnostic — a {@link TerminalLayout} provider maps it to its own native layout, so no
 * backend-specific layout shape leaks into the caller.
 */
export interface Tab {
  panes: Pane[];
  split?: { direction: "vertical" | "horizontal"; ratio: number };
}

/**
 * A terminal-multiplexer surface an integration drives — an {@link Extension} of kind
 * `"terminal"`. `name` is the backend it provides (e.g. `"cmux"`), the key callers resolve by.
 * Only code that wants a specific backend (e.g. `cotal setup` opening cmux tabs) resolves this by
 * name — never importing the extension package. Self-registers on import, like a connector.
 *
 * Tabs are described by a backend-agnostic {@link Tab} (panes as argv, not a backend-native layout
 * string), so the provider owns all backend-specific construction and none leaks into the caller.
 */
export interface TerminalLayout extends Extension {
  readonly kind: "terminal";
  readonly name: string;
  /** Whether the backend is reachable right now (e.g. the cmux app is running). */
  available(): boolean;
  /** Open a tab labelled `label`, laid out per {@link Tab}; returns its ref (id). */
  open(label: string, tab: Tab, opts?: { focus?: boolean }): string;
  /** Close a previously opened tab by ref. */
  close(ref: string): void;
  /** Refs of every open tab labelled `label` (dead tabs may linger). */
  refs(label: string): string[];
}
