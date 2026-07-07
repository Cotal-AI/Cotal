// Spec emitters for the console's OWN chrome — building json-render specs from the live
// MeshSnapshot so Cotal's dashboard renders through the very same catalog an agent's pushed
// view does (dogfooding the guardrail). These never leave the process, so they're plain Spec
// objects, not wire ViewSpecs.

import type { Spec } from "@json-render/ink";
import type { StatusCounts } from "../../view/mesh-view.js";
import { STATUS, ago } from "../ui/theme.js";

/** The golden-signal strip: working/waiting/idle/offline counts + oldest-unattended age, as a
 *  row of standard Text components (one color each) inside a Box — the spec form of `Tiles`. */
export function tilesSpec(counts: StatusCounts, oldestWaitingTs: number | undefined, width: number): Spec {
  const order: (keyof StatusCounts)[] = ["working", "waiting", "idle", "offline"];
  const elements: Spec["elements"] = {};
  const children: string[] = [];
  for (const [i, k] of order.entries()) {
    const id = `tile-${k}`;
    elements[id] = {
      type: "Text",
      props: {
        text: (i > 0 ? "   " : "") + STATUS[k].dot + " " + counts[k] + " " + STATUS[k].word,
        color: STATUS[k].color,
        wrap: "truncate-end",
      },
    };
    children.push(id);
  }
  elements["tile-label"] = { type: "Text", props: { text: "      oldest unattended ", dimColor: true } };
  elements["tile-age"] = {
    type: "Text",
    props: { text: oldestWaitingTs ? ago(oldestWaitingTs) : "—", color: oldestWaitingTs ? "yellow" : "gray" },
  };
  children.push("tile-label", "tile-age");
  elements["tiles"] = { type: "Box", props: { flexDirection: "row", width, paddingX: 1 }, children };
  return { root: "tiles", elements };
}
