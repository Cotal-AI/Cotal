import { PERSONA_SOURCE_META_KEY, isContractDigest, personaSourceRef, type EndpointKind } from "@cotal-ai/core";
import { openTransient, type ConnectValues } from "./transient.js";

/** Resolve the overlay from one presence snapshot. A legacy peer leaves absence unconfirmed. */
export async function readPersonaPresence(values: ConnectValues) {
  const { ep, space } = await openTransient(values, "personas");
  try {
    const sources = new Set<string>();
    const unknownKinds = new Set<EndpointKind>();
    for (const { card, status } of ep.getRoster()) {
      if (status === "offline") continue;
      const source = card.meta?.[PERSONA_SOURCE_META_KEY];
      if (source === "none") continue;
      if (isContractDigest(source)) sources.add(source);
      else unknownKinds.add(card.kind);
    }
    const fresh = ep.presenceView().fresh;
    return {
      space,
      status(path: string, kind: EndpointKind): "running" | "not running" | "unknown" {
        if (!fresh) return "unknown";
        const source = personaSourceRef(path);
        if (source !== undefined && sources.has(source)) return "running";
        return source === undefined || unknownKinds.has(kind) ? "unknown" : "not running";
      },
    };
  } finally {
    await ep.stop();
  }
}
