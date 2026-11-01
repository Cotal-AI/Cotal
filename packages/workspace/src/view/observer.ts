import { CotalEndpoint, mintLifecycleUid } from "@cotal-ai/core";
import type { UserViewAuth } from "../connect.js";

/** How an observer authenticates: a static or open creds file, or the user-mode admin-view
 *  material (a bearer source, so a standing tap outlives one bearer's life, plus the pinned
 *  principal a source-mode endpoint requires). Never both. */
export interface ObserverAuth {
  creds?: string;
  user?: Pick<UserViewAuth, "source" | "sentinelCreds" | "owner" | "actor">;
}

export interface ObserverOptions {
  space: string;
  server: string;
  /** The card name, which is also the `from` of anything the observer sends. */
  name: string;
  auth?: ObserverAuth;
  /** Sign as the operator: role "operator" on the card, and a synthesized incarnation uid so the
   *  observer can invoke endpoint services such as the manager's `ps` and `stop`. On an open mesh
   *  the broker enforces nothing; on an authed mesh a read-only credential gets a clean publish
   *  denial. */
  operator?: boolean;
}

/** A read-only endpoint over one space, invisible to peers: it registers no presence, binds no
 *  durables, and reads through tap, history and presence watch. It is returned unstarted; the
 *  caller's `MeshView` or lifecycle owns `start` and `stop`. */
export function openObserver({ space, server, name, auth = {}, operator = false }: ObserverOptions): CotalEndpoint {
  const role = operator ? { role: "operator" } : {};
  const ep = new CotalEndpoint({
    space,
    servers: server,
    ...(operator ? { lifecycleUid: mintLifecycleUid() } : {}),
    ...(auth.user
      ? {
          bearer: auth.user.source,
          sentinelCreds: auth.user.sentinelCreds,
          card: { owner: auth.user.owner, actor: auth.user.actor, name, ...role, kind: "endpoint" as const },
        }
      : { creds: auth.creds, card: { name, ...role, kind: "endpoint" as const } }),
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: true,
  });
  ep.on("error", () => {});
  return ep;
}
