import { getCurrent, loadMeshes } from "@cotal-ai/core";
import { c } from "../ui.js";
import { pruneStaleMeshes } from "../lib/meshes.js";

/** `cotal meshes` — list the running meshes (one `cotal up` each), with a `*` on the `current`
 *  default. The kubectl `get-contexts` analogue: how you see what a bare `cotal spawn` would join,
 *  and which `--space` names are available. Prunes dead entries first. */
export async function meshes(): Promise<void> {
  await pruneStaleMeshes();
  const all = loadMeshes();
  if (all.length === 0) {
    console.log(c.dim("no meshes running — start one with `cotal up`"));
    return;
  }
  const current = getCurrent();
  const pad = Math.max(...all.map((m) => m.space.length));
  for (const m of all) {
    const marker = m.space === current ? c.green("*") : " ";
    console.log(`${marker} ${m.space.padEnd(pad)}  ${c.dim(`${m.server}  ${m.mode}  ${m.root}`)}`);
  }
}
