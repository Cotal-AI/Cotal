/** How the screen splits at a terminal width. Three columns whenever the conversation keeps
 *  `MIDDLE_MIN` columns; otherwise the tree and the conversation, with the inspector reduced to a
 *  one-line summary. Never a fourth column. */
export type Layout = { kind: "three"; tree: number; inspector: number } | { kind: "two"; tree: number }

const MIDDLE_MIN = 40
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)))

export function layoutFor(width: number): Layout {
  const tree = clamp(width * 0.2, 24, 40)
  const inspector = clamp(width * 0.3, 28, 84)
  return width - tree - inspector >= MIDDLE_MIN ? { kind: "three", tree, inspector } : { kind: "two", tree }
}
