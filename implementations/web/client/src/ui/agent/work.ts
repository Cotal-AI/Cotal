// What the agent page and the panel's peek share about one agent's work, kept apart from the page
// itself: the page loads on demand, and the peek must not pull it into the first load.
import { useEffect, useMemo } from "react";
import type { Controller } from "../../state/controller.js";
import { useStore } from "../../state/hooks.js";
import type { Store } from "../../state/store.js";
import type { DashboardState, StoredMessage } from "../../state/types.js";
import type { RunErrorCondition } from "../session/RunError.tsx";

/** A stable empty list, so a fold over it is not redone while nothing is held. */
const NO_POSTS: StoredMessage[] = [];

/** One view of `id`'s work on this page: open on mount, closed on unmount, in the same effect, so the
 *  store's count of views stays paired however React runs it. */
export function useSession(controller: Controller | null, id: string): void {
  useEffect(() => {
    if (!controller) return;
    controller.openSession(id);
    return () => controller.closeSession(id);
  }, [controller, id]);
}

/** Presence's condition for the agent, taken only when its code is text: it is quoted on the page. */
export function conditionOf(entry: DashboardState["roster"][number] | undefined): RunErrorCondition | undefined {
  const c = (entry as { condition?: { code?: unknown; since?: unknown } } | undefined)?.condition;
  if (typeof c !== "object" || c === null || typeof c.code !== "string") return undefined;
  return typeof c.since === "number" ? { code: c.code, since: c.since } : { code: c.code };
}

/** The agent's own verified messages for its work: the channel posts its session holds, then its
 *  direct messages from the page's DMs (`senderId === id`), each message once. A history row carries
 *  no sender, so it never counts. */
export function useOwnMessages(store: Store<DashboardState>, id: string): StoredMessage[] {
  const posts = useStore(store, (s) => s.sessions[id]?.posts) ?? NO_POSTS;
  const dms = useStore(store, (s) => s.dms);
  return useMemo(() => {
    const held = new Set(posts.map((p) => p.msg.id));
    const sent = dms.filter((m) => m.senderId === id && typeof m.msg.to === "string" && !held.has(m.msg.id));
    return sent.length === 0 ? posts : [...posts, ...sent];
  }, [posts, dms, id]);
}
