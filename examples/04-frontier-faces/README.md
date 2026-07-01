# Example 04 — Frontier Tower faces

Animated pixel-art avatars for agents, built for the Frontier Tower demo: each persona is
an OpenCode-hosted agent with a 32×32 truecolor face that thinks, lip-syncs its streamed
reply, and steers its own expression as it talks. Run as a mesh, the
faces coordinate as lateral peers in one Cotal space — you watch them talk to each other.

There are two front-ends onto the *same* live mesh: a **browser studio** (`tools/studio.mjs`)
and a **tmux wall** (`mesh-wall.sh`). Both spawn real agents; nothing here is scripted.

## Live studio (browser)

One command brings up the whole thing — the mesh, the agents, and the web UI:

```sh
node tools/studio.mjs                 # curated roster (sven, david, garry)
node tools/studio.mjs sven david elon # explicit agents (agent-file basenames)
SPACE=demo PORT=4097 node tools/studio.mjs
# then open http://127.0.0.1:4097/
```

What happens end to end, all real:

1. it ensures a Cotal mesh is up (starts `cotal up --open` if one isn't);
2. it joins as an operator endpoint — **"you"**, the human seat in the room;
3. it spawns each roster member as a real headless mesh agent (OpenCode + the cotal plugin);
4. the page renders each agent's animated face driven by that agent's **live** OpenCode stream,
   the authoritative **mesh transcript** (what the operator endpoint actually receives on
   `#general`), and a prompt box.

The bottom box **broadcasts to `#general`** (the whole panel); each face also has its own input to
**DM that one agent privately** — only it wakes, and it replies straight back to you. Type → the
operator posts → every (or one) agent's connector turns it into an OpenCode turn → they reply and
coordinate over the mesh → you watch their faces talk. A face's status dot tracks its real activity
(thinking / working / speaking); a tile flashes when that agent sends on the mesh. The studio
fresh-boots the space's history on start, so each run begins clean. Ctrl-C tears it all down.

Requires `opencode` (`opencode auth login`) and a built repo (`pnpm build` at the repo root).

The studio needs an **`--open`** mesh (it joins bare, as the operator). If something is already on
the default port that rejects it — e.g. an existing **auth** mesh on `:4222` — it stops with a clear
message; run it on its own free port + space instead:

```sh
SPACE=frontier COTAL_SERVERS=nats://127.0.0.1:4299 node tools/studio.mjs sven david garry
```

## Quick start (tmux)

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

## Unattended signage

For a public monitor, run the live studio (above) full-screen — it self-recovers and keeps the
panel talking. Nudge it occasionally (a question in the prompt box) to keep the conversation moving.
The studio carries the same Cotal branding as the tmux wall's signage strip.

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

- **`tools/studio.mjs`** — the browser studio: ensures the mesh, joins it as the operator
  endpoint, spawns the roster as headless mesh agents (the connector's `COTAL_SERVE_HEADLESS`
  mode), proxies each agent's live OpenCode stream, and serves `web/studio.html`.
- **`web/studio.html`** — the studio UI: a grid of live `<cotal-face>` tiles + the mesh
  transcript + a prompt box. Drives each face from its agent's real OpenCode SSE (via
  `cotal-opencode.js`) and the transcript from the operator endpoint's feed.
- **`mesh-wall.sh`** — the tmux one-command launcher: starts the mesh, a tmux grid of mesh faces
  (one `mesh-face.sh` per agent), and the console.
- **`mesh-face.sh`** + **`mesh-face.mjs`** — one mesh agent: the `.mjs` launcher starts an
  `opencode serve` with the `@cotal-ai/connector-opencode` plugin + an agent file (so it joins the
  mesh and creates a session), reads that session's id (the plugin prints `[cotal-session] <id>`),
  and attaches the face. The OpenCode connector is face-agnostic — this launcher owns the viewer
  attach, so face rendering never leaks into shared code.
- **`face-plugin.mjs`** — example-local OpenCode plugin registering the `face_<mood>` expression
  tools. A mesh face calls them to drive its avatar, keeping its `cotal_*` messages clean on the wire.
- **`face-term.mjs`** — the terminal face (half-block renderer, zero deps). Connects to an OpenCode
  server, maps its SSE events to the face: assistant text drives the lip-sync, while `face_<mood>`
  tool calls (mesh) and inline `[[face:X]]` tags (standalone direct chat) drive the expression.
- **`personas.mjs`** — the pixel data, one entry per persona (single source for the terminal face).
- **`face-wall.sh`** — tmux grid of standalone faces, one direct chat session per pane.
- **`agents/`** — the persona definitions (OpenCode agent files): digital twins of ten
  Frontier Tower panelists, each tuned to coordinate as a lateral peer on a Cotal mesh. The `face:`
  frontmatter maps an agent to its persona key where the names differ (steve→jobs, elon→musk,
  rayan→ray).
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
