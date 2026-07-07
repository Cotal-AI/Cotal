// useMesh() — the React binding for the Ink console. A thin adapter over the shared
// `MeshView` model in @cotal-ai/core: it owns one MeshView over the read-only observer endpoint
// (built by the console command), subscribes to its batched "change" snapshots, and pushes
// them into React state. All the normalization (classification, coalescing, windowing, roster
// sort, rates, derived signals) lives in MeshView — see docs/mesh-view.md.

import { useCallback, useEffect, useRef, useState } from "react";
import type { CotalEndpoint } from "@cotal-ai/core";
import type { MeshSnapshot, MeshViewOptions } from "../view/mesh-view.js";
import { MeshView } from "../view/mesh-view.js";

// Re-exported so the UI components keep importing the model shape from one place.
export type { FeedEntry, MeshViewOptions, FeedDelivery, ViewItem } from "../view/mesh-view.js";
export type MeshState = MeshSnapshot;

/** Focusable panes across the console (normal panels + the DM and topology lenses). */
export type FocusId = "roster" | "feed" | "needsyou" | "dmpeers" | "dmthread" | "topo";

export interface UseMesh {
  state: MeshSnapshot;
  /** Turn the read-only model into participant mode (reveal the DM lens + capture the operator's
   *  own inbox). Paired with the endpoint's `startPresence()` at the App layer. Idempotent. */
  activateParticipant: (selfId: string, selfName: string) => void;
  /** Record an outbound DM locally so a thread shows both sides. */
  recordOutboundDm: (toId: string, text: string) => void;
}

export function useMesh(ep: CotalEndpoint, opts?: MeshViewOptions): UseMesh {
  const viewRef = useRef<MeshView | null>(null);
  if (!viewRef.current) viewRef.current = new MeshView(ep, opts ?? {});
  const [state, setState] = useState<MeshSnapshot>(() => viewRef.current!.snapshot());
  useEffect(() => {
    const view = viewRef.current!;
    const onChange = (s: MeshSnapshot) => setState(s);
    view.on("change", onChange);
    void view.start();
    return () => {
      view.off("change", onChange);
      void view.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const activateParticipant = useCallback(
    (id: string, name: string) => viewRef.current?.activateParticipant(id, name),
    [],
  );
  const recordOutboundDm = useCallback(
    (toId: string, text: string) => viewRef.current?.recordOutboundDm(toId, text),
    [],
  );
  return { state, activateParticipant, recordOutboundDm };
}
