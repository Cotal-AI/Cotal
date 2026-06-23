> **Note for `research`:** this project was renamed **Swarl → cotal**. Where this doc says
> "Swarl"/`swarl_*`/`@swarl/*`, read **cotal**/`cotal_*`/`@cotal/*`. The MCP tools are
> `cotal_roster`/`cotal_dm`/`cotal_inbox`/etc. The current console lives at
> `implementations/cli/src/render.ts` + `commands/console.ts` and already uses the read-only
> `CotalEndpoint` observer — render the new TUI over THAT, not a new NATS client. Distill this
> into `implementations/cli/src/console/SPEC.md` and broadcast a summary to the team.

---

# Building a Polished TUI for the Swarl Console: Lazygit-Inspired, TypeScript-First

## TL;DR
- **Use Ink (vadimdemedes/ink) as the TUI framework for the Swarl console.** It is the de facto standard for production Node/TypeScript TUIs in 2026 — Anthropic's Claude Code, Google's Gemini CLI, GitHub Copilot CLI, Prisma, Shopify, and Linear all ship Ink-based interfaces — and its React component model is the right level of abstraction for a multi-panel dashboard wired to a NATS JetStream stream.
- **Borrow lazygit's *architecture*, not its *framework*.** Lazygit's "everything visible at once" panel layout, context-sensitive keybindings, and strict separation between a UI layer (gocui + controllers + contexts) and a domain layer (git command package) are language-agnostic patterns. Replicate them in Ink with a `ContextManager` (which panel is focused, what keys are bound), a thin `SwarlClient` wrapping NATS JetStream, and per-panel controller components.
- **Skip OpenTUI for now.** OpenTUI is the most interesting newcomer (TypeScript bindings, Zig core, powers OpenCode in production) but its docs at `opentui.com/docs/getting-started/` state verbatim: *"OpenTUI is currently Bun exclusive but Deno and Node support in-progress."* That makes it a non-starter for a Node ESM monorepo today. Revisit once Node support ships.

## Key Findings

### 1. Lazygit's design philosophy is reproducible in any language

Jesse Duffield, lazygit's creator, has said the visual design was driven by a single principle: **show as much context on the screen as possible**. This led to side windows for files, branches, etc, and a main window for the currently selected item. This is the opposite of `git` itself — `git status`, `git diff`, `git log` are three separate commands; lazygit shows them as five always-visible panels (Status, Files, Branches, Commits, Stash) plus a main panel.

Other deliberate UX decisions worth copying:
- **Context-sensitive `?` cheatsheet.** Every panel binds `?` to a help popup that lists only the keybindings valid for that context. Discoverable without a manual.
- **One-character mnemonic keybindings** (`c` commit, `s` squash, `p` pull, `P` push, `d` drop, `f` fixup).
- **Inline status indicators.** Loading text appears on the affected row (e.g., "fetching...") rather than in a global status bar.
- **Yellow/green/red commit colorization** to encode three independent booleans into a single glance.
- **Performance is non-negotiable.**

Internally, lazygit's `pkg/gui` layer is organized around three concepts:
- **Views** — the rendering primitive (a rectangular region on screen).
- **Contexts** — one per panel/tab; each carries its own keybindings, focus/render callbacks, and the view it renders to.
- **Controllers** — handle input for a class of context; shared logic lives in `helpers`.

Below that, command execution lives in small typed structs that shell out to git. This **controller-helper-command** stratification is exactly what to copy: UI never touches the wire; helpers translate UI intent into protocol operations; the protocol layer is a thin wrapper over NATS.

### 2. Claude Code uses Ink — confirmed, with a custom renderer fork

The Ink README lists Claude Code by name as a showcase user. Claude Code uses a custom fork of the Ink renderer for advanced terminal features (bidi text, layout optimizations via yoga-layout, frame scheduling): cell-level dirty tracking, double-buffering, interning of repeated styles, Suspense-based async syntax highlighting. Most of these optimizations are unnecessary at swarl-console scale — **stock Ink ≥ 6 is enough for a pub/sub dashboard**.

Interface elements worth borrowing:
- **Streaming output via incremental React state updates**, not via Ink's `<Static>`. `<Static>` is for *finalized* lines; streaming live text wants a normal component that re-renders.
- **Permission dialogs as modal overlays** that take focus until dismissed.
- **A persistent input** at the bottom that's always available regardless of which scrollback is showing.

### 3. The TUI framework landscape for Node/TypeScript in 2026

| Framework | Maintained? | Model | Verdict |
|---|---|---|---|
| **Ink** (vadimdemedes/ink) | Yes, active; v6 ESM-only, Ink-6 + React-19 | React renderer to terminal via Yoga (Flexbox) | **Recommended.** Huge ecosystem (`@inkjs/ui`, `ink-text-input`, `ink-spinner`, `ink-testing-library`); `useFocus`/`useInput`/`useFocusManager`/`<Static>`; powers Claude Code, Gemini CLI, Copilot CLI |
| **OpenTUI** (anomalyco/opentui) | Very active | Zig core + React/Solid/Vue reconcilers | **Not yet.** "currently Bun exclusive but Deno and Node support in-progress" |
| **blessed** (chjj/blessed) | No (last release 2015) | Imperative widget tree | Avoid (unmaintained). |
| **neo-blessed** | Light | Same as blessed | Only if you want gocui-like imperative widgets. |
| **terminal-kit** | Light | Lower-level chainable API | Skip — wrong abstraction level. |

**Ink's real downsides you must plan around.** Ink performs full tree traversals and redraws on every state change. If dynamic output height ≥ terminal height, Ink falls back to a fullscreen clear-and-redraw path — the biggest flicker trigger. Mitigations, in order:
1. **Enable incremental rendering and FPS clamping** in `render()`: `incrementalRendering: true`, `maxFps: 30`.
2. **Keep dynamic output shorter than the terminal height.**
3. **Use `<Static>` for the finalized scrollback** of the message feed; keep only the live "tail" in dynamic output.
4. **Coalesce updates.** Batch JetStream messages with a 50–100 ms ticker into local React state, rather than `setState`-ing once per message.
5. **Enable Ink's `concurrent: true`** and use `useDeferredValue` for the message feed if message volume is bursty.

### 4. Practical architecture for the console

Mirror lazygit's stratification:

```
src/console/
  app.tsx              # root component; global keybindings; ContextManager
  ui/                  # primitives: PanelBox, FocusableList, StatusBar, panels
  mesh.ts              # data layer: a thin hook/store over the EXISTING CotalEndpoint observer
```

**Critical separation principle:** the data layer must be importable from a non-TUI context. In cotal it is already the `CotalEndpoint` observer (`implementations/cli/src/commands/console.ts`): `{consume:false, registerPresence:false, watchPresence:true}`, with `getRoster()`, `on("roster"|"presence")`, `tap()`, `listChannels()`, `channelHistory()`. **Do NOT open a new raw NATS connection** — wrap the endpoint into a `useMesh()` hook.

Patterns that pay off:
- **Presence as a Map keyed by agent name.** Render the *current state*, not an event log.
- **Channels as tabs at the top.** Bind `1`–`9` to direct-jump; `Tab` cycles. Switching channels swaps the feed filter.
- **Feed is the "main panel."** Auto-scroll to bottom unless the user scrolled up — track a `pinnedToBottom` boolean.
- **Status bar at the bottom.** Connected state, current channel, message rate (`msgs/s`), most relevant keybindings.
- **Help popup bound to `?`.** Derive the list from the focused context's keymap so it's automatically context-sensitive.

**Resize handling** is built into Ink: `useStdout()` exposes `columns`/`rows`. Test below ~80 cols — plan a stacked (portrait) fallback like lazygit.

**Color theming.** Pass colors via React Context; keep the theme as a single TS object. Use semantic names (`focusedBorder`, `agentIdle`, `agentWorking`).

### 5. Inspiration projects (in order of usefulness)
1. **ORCH** (oxgeneral/ORCH) — Ink command center for multi-agent orchestration: live agent roster with per-agent status, a task queue panel, a streaming event log. Closest 1:1 match to "agent presence + message feed."
2. **Gemini CLI** (google-gemini/gemini-cli) — `packages/cli` (Ink UI) + `packages/core` (backend); almost exactly this monorepo topology.
3. **Kubelive** — horizontal namespace tabs, vertical pod list with `↑/↓`, single-key actions. Exact lazygit pattern in Ink (UX reference only).
4. **@assistant-ui/react-ink** — composable Ink chat primitives; requires React 19 + ink 6.

## Recommendation
**Go with Ink, today, in this monorepo.**
1. Reuse the existing `CotalEndpoint` observer; wrap it in `useMesh()` (data layer in `src/console/mesh.ts`).
2. Lay out three contexts mirroring lazygit: roster (left top), channels (left bottom / tabs), feed (main).
3. Focus with `useFocus` + `useFocusManager`, plus number keys `1`/`2`/`3` for direct jumps.
4. Feed = a windowed slice of state (never unbounded); auto-scroll unless pinned.
5. `render()` with `incrementalRendering: true, maxFps: 30`. Profile with a synthetic firehose.
6. Status bar wired to `useStdout()` resize; `?` overlay reads the focused context's keymap.

## Caveats
- Ink 6 is ESM-only, Node ≥ 20, React ≥ 19 — fine here (cotal is ESM + Node ≥20, runs `.tsx` via tsx).
- `<Static>` is not a scroll view — append-only finalized output only.
- Flicker is real on tmux/Windows terminals if you ignore the guidance above.
