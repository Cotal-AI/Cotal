---
name: pixel-face
description: Create or improve a 32×32 pixel-art persona face for the Frontier Faces demo (examples/04-frontier-faces/personas.mjs) — the animated agent avatars rendered by face-term.mjs / the browser <cotal-face> / the gallery. Use when the user asks to add a new persona/face/avatar, improve an existing one (hair, eyes, likeness, expression), make it "look more like" someone, or fix a face that "doesn't read". Drives the example's own tools (img2rows.mjs, render-png.mjs) and follows FACE-DESIGN.md; uses a multi-agent variant loop for likeness.
---

# pixel-face — author & refine the Frontier Faces pixel art

A persona face is pure data in **`examples/04-frontier-faces/personas.mjs`** (one entry per
persona). The same data drives the terminal renderer (`face-term.mjs`), the browser element
(`web/cotal-face.js`), and the PNG tool — so edit `personas.mjs` once and it's live everywhere.
**Always work from `examples/04-frontier-faces/`.**

## Where things are
- `personas.mjs` — the entries (rows, colors, glow, mouths, expr, eyes, lines). Single source of truth.
- `FACE-DESIGN.md` — the full conventions (grid zones, color keys, eye recipe, visemes). **Read it first.**
- `tools/img2rows.mjs` — rough a reference photo into a 32×32 `rows`+palette.
- `tools/render-png.mjs` — render a 7-state contact sheet (PNG) for review. **This is the validator.**
- `tools/face-template.mjs` — copy-me starter entry that encodes the conventions.
- `gallery.html` (all personas, original-vs-pixel) and `preview.html?p=<key>` (one persona) — served
  via `python3 -m http.server` or `tools/serve-wall.mjs`; for visual QA.
- `assets/<persona-key>.<ext>` — reference photos. **Gitignored / local-only — never commit them.**

**Persona key ≠ agent name.** The roster uses agent-file basenames; the face comes from each agent's
`face:` frontmatter: `elon`→`musk`, `steve`→`jobs`, `rayan`→`ray` (others match). Persona keys:
`neon david ray sven garry jobs musk dario mira bernie michelle`.

## Conventions (condensed — full detail in FACE-DESIGN.md)
- **Grid 32×32**, `.` = transparent, face centered ~col 15. Zones: hair **1–9** · brows **10–11**
  (drawn by `expr`, not `rows`) · eyes **12–13** (drawn by `eyes()`) · nose **14–16** · mouth
  **18–20** (drawn by `mouths`) · chin **21–24** · collar **26–31**.
- **Color keys:** skin `P` light / `S` mid / `s` shadow · `E` pupil · `W`/`w` catchlight · `R` lip ·
  `m` lip-shadow · `b` brow · `h` hair · **`L` cyan + `M` magenta** = the cotal glow ribbon
  (`glow: { L: 8, M: 6 }` blurs them). Use `rng(row, c1, c2, key)` (exported from personas.mjs) for runs.
- **Eye recipe:** 2-wide iris (`E`) on the iris row; row below = catchlight (`W`/`w`, OUTER corner)
  + lid-shadow (`s`, INNER). `jobs` is the "alive" benchmark — match its eye, don't use flat black blocks.
- **Surprise = raised brows + open mouth, eyes stay `open`** (growing the iris behind glasses looks
  wrong). Don't reintroduce a `wide` eye style.
- The face renders at a **fixed 32×16** (not scaled to the pane), so faces look the same size as long
  as the pane is ≥ ~32 cols.

## Tools (exact)
```sh
# rough a reference photo → 32×32 rows + palette (macOS: uses sips)
node tools/img2rows.mjs --in assets/<key>.png --w 24 --h 30 [--colors 12] [--x0 4] [--y0 0]

# render a 7-state contact sheet (neutral·happy·sad·angry·surprised·talking·blink) to review
node tools/render-png.mjs --file <draft>.mjs --out /tmp/<key>.png --scale 8     # draft: export const entry = {…}
node tools/render-png.mjs --file personas.mjs --persona <key> --out /tmp/<key>.png --scale 8   # existing
```
A draft module must `export const entry = {…}` and (if it uses `rng` in expr/mouths)
`import { rng } from '/abs/path/examples/04-frontier-faces/personas.mjs'`.
**After every render, Read the PNG and compare it to `assets/<key>.<ext>`.** Iterate.

## Create a new persona
1. Pick a `key`. If you have a photo, save it as `assets/<key>.png` and `img2rows` it for a rough base;
   otherwise copy `tools/face-template.mjs`.
2. Hand-edit a `/tmp/<key>-draft.mjs` (`export const entry`) following the conventions above.
3. `render-png` → Read the PNG → compare to the reference → iterate until all 7 states read well.
4. Splice the finished entry into `personas.mjs` (keep the file's style; reuse color keys).
5. Review in the gallery; confirm no other persona changed.

## Improve an existing persona
1. Read its entry in `personas.mjs` + its reference `assets/<key>.<ext>` and the current render.
2. Edit **only the in-scope rows** (e.g. hair = rows 1–9). **Preserve** `eyes()`, glasses/beard,
   `expr`, `mouths`, `colors` of other features, and the collar/glow — change the minimum.
3. `render-png` the draft → Read → compare → iterate (≥3 passes). Then splice the rows back into
   `personas.mjs` and confirm the diff is limited to that entry.

## Multi-agent variant loop (use for likeness — "doesn't look like them")
When matching a real person, generate options instead of guessing:
1. Spawn ~3 subagents **on the main working tree** (NOT git worktrees — `assets/` is gitignored, so
   reference photos are absent from a fresh worktree). Give each: the reference path, the current
   entry, the conventions, and a distinct direction.
2. Each agent writes its OWN `/tmp/<key>-<n>.mjs` draft (never edits `personas.mjs` — avoids
   conflicts), renders it, Reads the PNG, compares to the photo, iterates, and **returns the final
   `rows`**.
3. You pick the best, splice it in, review in the gallery. Refine **one axis per pass** (e.g. head
   shape, then hair). This is the loop used for garry/musk.

## QA bar
- Always review **visually** — the `render-png` contact sheet and the `gallery.html` original-vs-pixel
  view — never blind. Judge: does it **read** / look like the person across all 5 expressions + blink?
- `jobs` is the reference standard. Keep faces front-facing/symmetric unless intentional.
- Don't commit `assets/` (reference photos stay local). Persona edits to `personas.mjs` ARE committable.
