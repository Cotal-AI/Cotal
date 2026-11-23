import { PERSONA_SOURCE_META_KEY, isPersonaSourceRef, personaSourceRef } from "@cotal-ai/core";
import { openTransient, type ConnectValues } from "./transient.js";

/** Resolve the overlay from one presence snapshot. A legacy peer leaves absence unconfirmed. */
export async function readPersonaPresence(values: ConnectValues) {
  const { ep, space } = await openTransient(values, "personas");
  try {
    const sources = new Set<string>();
    let unattributed = false;
    for (const { card, status } of ep.getRoster()) {
      if (status === "offline") continue;
      const source = card.meta?.[PERSONA_SOURCE_META_KEY];
      if (source === "none") continue;
      if (isPersonaSourceRef(source)) sources.add(source);
      else unattributed = true;
    }
    const fresh = ep.presenceView().fresh;
    const complete = fresh && ep.presenceBindingDropCount === 0;
    return {
      space,
      status(path: string): "running" | "not running" | "unknown" {
        if (!fresh) return "unknown";
        const source = personaSourceRef(path);
        if (source !== undefined && sources.has(source)) return "running";
        return !complete || unattributed || (source === undefined && sources.size > 0) ? "unknown" : "not running";
      },
    };
  } finally {
    await ep.stop();
  }
}
