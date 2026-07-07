// The view catalog + render guardrail. An agent-pushed view (a json-render flat spec) may only
// use the standard Ink component vocabulary — Box/Text/Table/StatusLine/Sparkline/Badge/… — so
// a peer can publish *data*, never code. `validateView` rejects a spec that is malformed or
// references a component outside the catalog BEFORE it reaches the Renderer; the Renderer's
// `fallback` (see SpecView) is the second line of defense at render time.

import { validateSpec, type Spec } from "@json-render/core";
import { standardComponentDefinitions } from "@json-render/ink/catalog";
import type { ViewSpec } from "@cotal-ai/core";

/** Coerce a wire {@link ViewSpec} (core keeps `props` optional) into a json-render {@link Spec}
 *  (which requires `props`) — the single ViewSpec→Spec boundary for the renderer. */
export function asSpec(view: ViewSpec): Spec {
  const elements: Spec["elements"] = {};
  for (const [key, el] of Object.entries(view.elements))
    elements[key] = { type: el.type, props: el.props ?? {}, children: el.children };
  return { root: view.root, elements, state: view.state };
}

/** The allowed component vocabulary — every standard Ink catalog component, by name. */
export const ALLOWED_COMPONENTS = new Set(Object.keys(standardComponentDefinitions));

export type ViewCheck = { ok: true } | { ok: false; reason: string };

/** Structurally validate a spec, then enforce the catalog: every element's `type` must be a
 *  known component. Returns `{ ok: false, reason }` on the first violation. */
export function validateView(spec: Spec): ViewCheck {
  const structural = validateSpec(spec);
  if (!structural.valid)
    return { ok: false, reason: structural.issues.map((i) => i.code).join(", ") };
  for (const [key, el] of Object.entries(spec.elements)) {
    if (!ALLOWED_COMPONENTS.has(el.type))
      return { ok: false, reason: `unknown component "${el.type}" at "${key}"` };
  }
  return { ok: true };
}
