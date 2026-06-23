# Demo 3 — Frontier Tower faces

Animated pixel-art avatars for agents, built for the Frontier Tower demo: each persona is
an OpenCode-hosted agent with a 32×32 truecolor face that thinks, lip-syncs its streamed
reply, and steers its own expression with hidden `[[face:X]]` tags. Run as a mesh, the
faces coordinate as lateral peers in one Cotal space — you watch them talk to each other.

## Quick start

Requirements: Node ≥ 20, [OpenCode](https://opencode.ai) (run `opencode auth login` once —
the personas default to `opencode-go/glm-5.1`), and `tmux`. The mesh's `nats-server` is
bundled by the CLI, so there's nothing else to install.

```sh
# the whole demo: start the mesh, a grid of mesh faces, and the console — one command
./mesh-wall.sh                 # curated roster + console
./mesh-wall.sh sven david      # pick agents (agent-file basenames)
./mesh-wall.sh all             # every agent (capped at 9 panes)
./mesh-wall.sh --stop          # tear it all down
```

Standard layout: the face grid is on the **left**, the `console` (live mesh traffic) is the
pane on the **right** — one tmux window. Each face is a real Cotal mesh peer; type into one and
the others can see and answer it on the shared space. Switch focus with the mouse or `Ctrl-b
←/→`. Override the model, space, or console width with `MODEL=opencode/<free-model>`,
`SPACE=demo`, or `CONSOLE_WIDTH=40% ./mesh-wall.sh`.

## Without the mesh (standalone faces)

Each face is its own OpenCode chat — no mesh, no shared space:

```sh
# one face, one live agent
opencode serve --port 4096
node face-term.mjs --persona sven

# no server? scripted preview
node face-term.mjs --demo

# a wall of them in the terminal (one shared server, one session per pane)
./face-wall.sh                 # every persona, capped at 9
./face-wall.sh ray sven garry

# the same wall in the browser (serves web/ + proxies the opencode API, no CORS)
node tools/serve-wall.mjs      # then open the printed URL
```

`face-term.mjs` flags: `--persona <key>` (`--list` prints all), `--server`, `--model
<provider/id>`, `--session <id>` to attach to an existing session, `--password` for
`OPENCODE_SERVER_PASSWORD`-protected servers, `--dump` to print the grid as ASCII.

## What's here

- **`mesh-wall.sh`** — the one-command launcher: starts the mesh, a tmux grid of mesh faces
  (one `mesh-face.sh` per agent), and the console.
- **`mesh-face.sh`** — one mesh agent: starts an `opencode serve` with the
  `@cotal-ai/connector-opencode` plugin + an agent file, so it joins the mesh and creates a
  session; the script reads that session's id (the plugin prints `[cotal-session] <id>`)
  and attaches the face, so the face renders the agent's real mesh turns.
- **`face-term.mjs`** — the terminal face (half-block renderer, zero deps). Connects to an
  OpenCode server, maps its SSE events to the face, strips `[[face:X]]` tags into expressions.
- **`personas.mjs`** — the pixel data, one entry per persona (single source for the terminal face).
- **`face-wall.sh`** — tmux grid of standalone faces, one direct chat session per pane.
- **`agents/`** — the persona definitions (OpenCode agent files): digital twins of ten
  Frontier Tower panelists, each tuned to coordinate as a lateral peer on a Cotal mesh and
  to emit face tags. The `face:` frontmatter maps an agent to its persona key where the
  names differ (steve→jobs, elon→musk, rayan→ray).
- **`research/`** — the public-record research the agent files are distilled from.
- **`web/`** — the same engine as a `<cotal-face>` custom element (`cotal-face.js`, drawing
  its personas straight from `personas.mjs`), a live `wall.html` (a browser twin of the tmux
  wall), and a userscript that overlays a face on OpenCode's web UI (its CSP blocks plain
  script injection).
- **`tools/`** — persona authoring: `img2rows.mjs` roughs a reference image into rows+palette,
  `render-png.mjs` renders a contact sheet for review, `face-template.mjs` is the copy-me
  reference face. `preview.html` shows every persona straight from `personas.mjs`.

## Adding a persona

Append an entry to `personas.mjs` (rows, colors, glow, mouths, expr, eyes, lines) — it's
immediately available everywhere: `--persona`, `--list`, the walls, and the browser
(`web/cotal-face.js` imports `personas.mjs`, so no manual sync). Copy `tools/face-template.mjs`
to start from a known-good face; **[FACE-DESIGN.md](FACE-DESIGN.md)** documents the grid zones,
the color keys, the eye recipe, and the expression/viseme conventions.
