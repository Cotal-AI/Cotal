import { useMemo, useState } from "react";
import { CotalEndpoint, chatWildcard, mintLifecycleUid } from "@cotal-ai/core";
import { App } from "./app.js";
import { SpacePicker } from "./ui/SpacePicker.js";

/** How the observer authenticates: a static/open creds file, OR the user-mode admin-view material
 *  (a bearer SOURCE so the standing tap survives the ≤5-min token life, plus the pinned principal a
 *  source-mode endpoint requires). Never both. */
export interface ObserverAuth {
  creds?: string;
  user?: { source: () => Promise<string>; sentinelCreds: string; owner: string; actor: string };
}

/** The read-only observer the console watches a space through — invisible to peers. Built once
 *  per selected space (the picker can switch spaces at runtime). */
export function makeObserver(
  space: string,
  server: string,
  auth: ObserverAuth = {},
  name = "console",
): CotalEndpoint {
  const ep = new CotalEndpoint({
    space,
    servers: server,
    // A synthesized incarnation uid so the palette's `ps`/`stop` can invoke the manager service
    // over the ep rails (1d: the console's ctl door is gone). On an open mesh the broker enforces
    // nothing; on an authed mesh the console's read-only cred simply gets a clean publish denial
    // (its ps/stop never functioned there - the reclassified-out surface).
    lifecycleUid: mintLifecycleUid(),
    ...(auth.user
      ? {
          bearer: auth.user.source,
          sentinelCreds: auth.user.sentinelCreds,
          card: { owner: auth.user.owner, actor: auth.user.actor, name, kind: "endpoint" as const },
        }
      : { creds: auth.creds, card: { name, kind: "endpoint" as const } }),
    channels: [],
    consume: false, // observer: reads via tap + history + presence-watch, binds no durables
    registerPresence: false, // invisible on the roster; sent messages still carry `name` as `from`
    watchPresence: true,
  });
  ep.on("error", () => {});
  return ep;
}

/**
 * Console root. With a fixed `space` (explicit `--space`, or the single space under auth) it goes
 * straight into the per-space console. Without one (open mesh) it shows the space overview first;
 * picking a space mounts the console for it — `key={space}` forces a clean MeshView remount, and
 * `onBack` tears it down to return to the overview.
 */
export function Root({
  server,
  auth,
  space,
  canWrite,
  name,
}: {
  server: string;
  auth: ObserverAuth;
  space?: string;
  canWrite?: boolean;
  name?: string;
}) {
  const [selected, setSelected] = useState<string | undefined>(space);

  // Build the observer lazily, once per selected space (App's useMesh owns start/stop).
  const ep = useMemo(
    () => (selected === undefined ? null : makeObserver(selected, server, auth, name)),
    [selected, server, auth, name],
  );

  if (selected === undefined || ep === null)
    return <SpacePicker server={server} creds={auth.creds} canWrite={canWrite} onSelect={setSelected} />;

  return (
    <App
      key={selected}
      ep={ep}
      tapSubject={auth.creds || auth.user ? chatWildcard(selected) : undefined}
      onBack={space === undefined ? () => setSelected(undefined) : undefined}
      canWrite={canWrite}
    />
  );
}
