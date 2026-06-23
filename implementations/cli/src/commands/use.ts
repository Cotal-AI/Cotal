import { findMesh, loadMeshes, setCurrent, type CompletionResult } from "@cotal-ai/core";
import { c } from "../ui.js";
import { pruneStaleMeshes } from "../lib/meshes.js";

/** `cotal use <space>` — set the default mesh a bare `cotal spawn` (and friends) targets when more
 *  than one is running. The kubectl `use-context` analogue. Validated against the live registry, so
 *  you can't point `current` at a mesh that isn't up. */
export async function use(argv: string[]): Promise<void> {
  const space = argv[0];
  if (!space) {
    console.error(c.red("usage: cotal use <space>"));
    process.exit(1);
  }
  await pruneStaleMeshes();
  const m = findMesh(space);
  if (!m) {
    console.error(c.red(`✗ no mesh named "${space}" is running — see \`cotal meshes\``));
    process.exit(1);
  }
  setCurrent(space);
  console.log(c.green(`✓ current mesh → ${space}`), c.dim(`(${m.server})`));
}

export function useComplete(argv: string[]): CompletionResult {
  if (argv.length <= 1)
    return { items: loadMeshes().map((m) => ({ value: m.space })), directive: "nofiles" };
  return { items: [], directive: "nofiles" };
}
