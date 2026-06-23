# Designing a face

Every persona is one entry in [`personas.mjs`](personas.mjs): a 32×32 grid of color-keys plus the
overlays that animate it. All three renderers (terminal `face-term.mjs`, browser `web/cotal-face.js`,
PNG `tools/render-png.mjs`) read that one file, so a face is defined once.

Start from the reference: [`tools/face-template.mjs`](tools/face-template.mjs) — a plain neutral head
that exercises everything below. Render it with
`node tools/render-png.mjs --file tools/face-template.mjs --out /tmp/face.png --scale 8`.

## The grid

`rows` is 32 strings of single-char color keys (`.` = transparent). `colors` maps each key to a hex.
Features land in these rows (the template follows them):

| zone   | rows  | notes |
|--------|-------|-------|
| hair   | 1–9   | crown down to the hairline |
| brows  | 10–11 | drawn by `expr`, not `rows` |
| eyes   | 12–13 | drawn by `eyes()`, not `rows` |
| nose   | 14–16 | a couple of `s` shadow pixels |
| mouth  | 18–20 | drawn by `mouths`, not `rows` |
| chin   | 21–24 | taper to the neck |
| collar | 26–31 | clothing `T`, with the cotal glow ribbon |

The face sits centered on col ~15; eyes at cols 12–13 (left) and 18–19 (right).

## Color keys (convention)

Reuse these letters so faces stay legible and the eye recipe lines up:

- skin ramp `P` light · `S` mid · `s` shadow
- `E` pupil · `W` catchlight (bright) · `w` catchlight (soft)
- `R` lip · `m` lip-shadow · `b` brow · `h` hair
- `T`/`t` collar/clothing
- **`L` cyan + `M` magenta** — the cotal glow ribbon down the collar's left/right edge. `glow`
  maps a key to a blur radius (`{ L: 8, M: 6 }`) — that's what makes those pixels bloom.

## The eye

`eyes(style, blink)` returns `[[row, col, key], …]` drawn on top of `rows`. The canonical eye:

- **open**: a 2-wide iris (`E`) on the iris row; the row below = catchlight (`W`/`w`, **outer**
  corner) + lid-shadow (`s`, **inner** corner).
- **blink**: a single lid-shadow (`s`) line across the iris columns.

The eyes don't change shape for **surprised** — growing the iris into a block looked weird,
especially behind glasses. Surprise reads from the **raised eyebrows + the open "o" mouth** alone
(see `expr.surprised`), with the eyes left in their open shape. So `eyes()` only needs an `open` and
a `blink` case; that's why most faces take `(_style, blink)`.

Exceptions worth knowing: **neon** is a cyber block (a solid glowing eye); **garry** wears opaque
shades (no eyes — just a steady lens glint, so its `eyes()` takes no args). Both still show surprise
through brows + mouth.

## Expressions & mouths

`expr` has five entries — `neutral, happy, sad, angry, surprised` — each `{ brows, eyes, mouth }`.
`brows` is a pixel list (raise them a row for surprise), `eyes` is the style passed to `eyes()`,
`mouth` names a key in `mouths`.

`mouths` holds the lip shapes: `X` (rest) and the lip-sync visemes `A`–`F` (the renderer cycles
these while a reply streams), plus `smile`/`frown`/`grit`. Use the `rng(row, c1, c2, key)` helper
(exported from `personas.mjs`) for horizontal runs.

## Workflow for a new face

1. `node tools/img2rows.mjs --in reference.png` — roughs a 32×32 base (`rows` + palette) from an image.
2. Copy `tools/face-template.mjs`, paste in your rows/colors, hand-clean the pixels.
3. `node tools/render-png.mjs --file <draft>.mjs --out /tmp/f.png --scale 8` — a 7-state contact sheet.
4. Add the finished entry to `personas.mjs`. It's then live everywhere (`--persona`, `--list`, the
   walls, the browser) — no other wiring.

Reference images for step 1 live in `assets/` and are **gitignored** (authoring-only, local to
your machine). The finished persona is baked into `personas.mjs`, so nothing at runtime needs them.
