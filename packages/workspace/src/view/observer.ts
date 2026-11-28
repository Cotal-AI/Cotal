import { CotalEndpoint, PLUGIN_CHANNEL_ROOT, credsClaims, importNativeSubjectPermissions, mintLifecycleUid, projectChannelGrants } from "@cotal-ai/core";
import { CommandFailure } from "../output.js";
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
  /** The lifecycle of a user-mode sign-in, so the observer can read history through that
   *  lifecycle's own `chathist_` reader ({@link CotalEndpoint.channelHistoryPage}). */
  lifecycleUid?: string;
}

const observerSubjects = new WeakMap<CotalEndpoint, readonly string[]>();

/** Scoped static channel taps for this admitted observer. Undefined keeps the default CHAT tap. */
export function observerChannelTapSubjects(ep: CotalEndpoint): readonly string[] | undefined {
  const subjects = observerSubjects.get(ep);
  return subjects && ep.channelRoutingMode() === "isolated" ? subjects : undefined;
}

/** A read-only endpoint over one space, invisible to peers: it registers no presence, binds no
 *  durables, and reads through tap, history and presence watch. It is returned unstarted; the
 *  caller's `MeshView` or lifecycle owns `start` and `stop`. */
export function openObserver({ space, server, name, auth = {}, operator = false, lifecycleUid }: ObserverOptions): CotalEndpoint {
  const claims = auth.creds ? credsClaims(auth.creds) : undefined;
  if (claims?.name === "agent") {
    throw new CommandFailure("refused", "PERMISSION_DENIED", "an agent-profile credential cannot watch the space's chat feed", {
      remedy: "mint a separate observer credential with `cotal auth mint <label> --profile observer --out <file>`, then pass that file with --creds",
    });
  }
  const role = operator ? { role: "operator" } : {};
  const ep = new CotalEndpoint({
    space,
    servers: server,
    ...(operator ? { lifecycleUid: mintLifecycleUid() } : lifecycleUid !== undefined ? { lifecycleUid } : {}),
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
    readChannelRoutingProjection: true,
  });
  if (claims !== undefined) {
    const { pub, sub } = claims.nats ?? {};
    try {
      const permissions = importNativeSubjectPermissions({ ...(pub ? { pub } : {}), ...(sub ? { sub } : {}) });
      const chat = projectChannelGrants(permissions, { space, mode: "legacy" }).read
        .filter(({ channel }) => channel !== PLUGIN_CHANNEL_ROOT && !channel.startsWith(`${PLUGIN_CHANNEL_ROOT}.`));
      const routed = projectChannelGrants(permissions, { space, mode: "isolated" }).read;
      observerSubjects.set(ep, Object.freeze([...new Set([...chat, ...routed].map(({ subject }) => subject))]));
    } catch { /* An unrecognized permission shape cannot add a plugin tap. */ }
  }
  ep.on("error", () => {});
  return ep;
}
