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
./mesh-wall.sh --fresh         # wipe the space's chat history first, then start (clean slate)
./mesh-wall.sh --stop          # tear it all down + wipe the chat history (clean restart)
```

Standard layout: the face grid is on the **left**, the `console` (live mesh traffic) is the
pane on the **right** — one tmux window. Each face is a real Cotal mesh peer; type into one and
the others can see and answer it on the shared space. Switch focus with the mouse or `Ctrl-b
←/→`. Override the model, space, or console width with `MODEL=opencode/<free-model>`,
`SPACE=demo`, or `CONSOLE_WIDTH=40% ./mesh-wall.sh`.

## Live event / signage

Built to run on a public monitor where people walk up and try it. The mesh wall shows a Cotal
signage strip across the top — wordmark + tagline + a **QR to [cotal.ai](https://cotal.ai)** so
passers-by can open the site on their phone — plus a persistent `Cotal · cotal.ai` status bar along
the bottom. The browser wall (`tools/serve-wall.mjs`) carries the same QR in its header and footer.

The terminal QR is an inverted **glow** (bright pixels on the dark theme, no white card). It's a
mildly non-standard inverted code — modern phones (iOS Camera, Google Lens) scan it, and the
**browser wall renders a dark-on-light QR that scans on everything**, so that's the reliable path.

```sh
node tools/brand-banner.mjs --variant 1|2|3      # Card / Bar / Hero layouts
node tools/brand-banner.mjs --qr-color cyan|blue|white|magenta|#hex   # glow colour (default blue)
node tools/brand-banner.mjs --image              # native pixel-image QR (Ghostty/kitty, no tmux)
NO_BANNER=1 ./mesh-wall.sh                        # hide the top signage strip
BANNER_VARIANT=3 BANNER_HEIGHT=24 ./mesh-wall.sh  # Hero strip (taller; the QR needs ~16+ rows)
```

The QR is pre-generated, not encoded at runtime: `qr-cotal.mjs` holds the static matrix (rendered by
both walls — terminal half-blocks and a browser canvas) and `tools/brand-banner.mjs` /
`tools/tmux-brand.sh` draw the strip and status bar. To point it at a different URL, regenerate the
matrix per the note in `qr-cotal.mjs`.

## Self-running kiosk

Two browser pages designed to run unattended on a monitor — no operator interaction required once
started. Both loop automatically through scripted multi-agent coordination episodes and self-recover
from errors. Serve with `node tools/serve-wall.mjs` and open the URL in a browser set to fullscreen.

| Page | Style |
|---|---|
| `web/kiosk-console.html` | Terminal console: roster + streaming feed, matches the real `cotal console` aesthetic |
| `web/kiosk-wide.html` | Panorama: 3×2 pixel-art face grid filling the full screen + large caption bar |
| `web/kiosk.html` | Command-center: 3×2 face grid + live activity sidebar + stats HUD |

Neither page requires a running OpenCode server or mesh — the simulation is built in and runs
entirely in the browser. The faces animate, expressions change per turn, and message packets fly
between agents for DMs; broadcast pulses radiate to all.

```sh
node tools/serve-wall.mjs          # starts on :4097
# open http://127.0.0.1:4097/kiosk.html      (command-center)
# open http://127.0.0.1:4097/kiosk-wide.html  (panorama)
```

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
