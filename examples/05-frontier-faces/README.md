# Demo 5 — Frontier Tower faces

Animated pixel-art avatars for agents, built for the Frontier Tower demo: each persona is
an OpenCode-hosted agent with a 32×32 truecolor face that thinks, lip-syncs its streamed
reply, and steers its own expression with hidden `[[face:X]]` tags.

## What's here

- **`face-term.mjs`** — the terminal face (half-block renderer, zero deps). Connects to an
  OpenCode server, maps its SSE events to the face, strips `[[face:X]]` tags into expressions.
- **`personas.mjs`** — the pixel data, one entry per persona (single source for the terminal face).
- **`face-wall.sh`** — tmux grid of faces, one live agent session per pane.
- **`agents/`** — the persona definitions (OpenCode agent files): digital twins of ten
  Frontier Tower panelists, each tuned to coordinate as a lateral peer on a Cotal mesh and
  to emit face tags. The `face:` frontmatter maps an agent to its persona key where the
  names differ (steve→jobs, elon→musk, rayan→ray).
- **`research/`** — the public-record research the agent files are distilled from.
- **`web/`** — the same engine as a `<cotal-face>` custom element, plus a userscript that
  overlays it on OpenCode's web UI (its CSP blocks plain script injection).
- **`tools/`** — persona authoring: `img2rows.mjs` roughs a reference image into rows+palette,
  `render-png.mjs` renders a contact sheet for review. `preview.html` shows every persona
  straight from `personas.mjs`.

## Run it

Requirements: Node ≥ 20, a recent OpenCode (the bun build, ≥1.17), tmux for the wall.

```sh
# one face, one live agent
opencode serve --port 4096
node examples/05-frontier-faces/face-term.mjs --persona sven

# no server? scripted preview
node examples/05-frontier-faces/face-term.mjs --demo

# a wall of them (one shared server, one session per pane)
./examples/05-frontier-faces/face-wall.sh            # every persona, capped at 9
./examples/05-frontier-faces/face-wall.sh ray sven garry
```

`face-term.mjs` flags: `--persona <key>` (`--list` prints all), `--server`, `--model
<provider/id>`, `--session <id>` to attach to an existing session, `--password` for
`OPENCODE_SERVER_PASSWORD`-protected servers, `--dump` to print the grid as ASCII.

To put the personas on a Cotal mesh, run each as an OpenCode agent (drop `agents/*.md`
into the project's `.opencode/agent/`) with `@cotal-ai/connector-opencode` loaded — the
faces then voice real peer traffic, not just direct chat.

## Adding a persona

Append an entry to `personas.mjs` (rows, colors, glow, mouths, expr, eyes, lines) — it's
immediately available to `--persona`, `--list`, and the wall. Use `tools/img2rows.mjs` to
rough in the pixel art from a reference image and `tools/render-png.mjs` to review it.
The browser engine in `web/cotal-face.js` keeps its own persona packs; sync it manually.
