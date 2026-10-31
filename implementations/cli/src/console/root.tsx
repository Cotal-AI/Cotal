import { useMemo, useState } from "react";
import { CotalEndpoint, chatWildcard } from "@cotal-ai/core";
import { openObserver, type ObserverAuth } from "@cotal-ai/workspace/view";
import { App } from "./app.js";
import { SpacePicker } from "./ui/SpacePicker.js";
import type { ControlCtx } from "@cotal-ai/workspace/control";

/** The operator's presence peer: a second endpoint carrying the observer's own card (the same id,
 *  name, and role, so it IS the `from` of everything the observer sends) that does nothing but
 *  register presence. The console starts it on the operator's first send, so a pure-watch session
 *  stays invisible and a speaking operator becomes a roster peer agents can reply to; the replies
 *  arrive over the observer's whole-space tap. Open mesh only: the console's authed observers hold
 *  no presence-write grant and no live read of their own inbox, so Root offers no factory there.
 *  Not started here: App owns its lifecycle (start on first send, stop with the console). */
export function makeParticipant(observer: CotalEndpoint, server: string): CotalEndpoint {
  const peer = new CotalEndpoint({
    space: observer.space,
    servers: server,
    card: { ...observer.card },
    channels: [],
    consume: false,
    registerPresence: true,
    watchPresence: false,
  });
  peer.on("error", () => {});
  return peer;
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
  canControl,
  controlCtx,
  name = "console",
}: {
  server: string;
  auth: ObserverAuth;
  space?: string;
  canWrite?: boolean;
  canControl?: boolean;
  /** Trust material for per-action control mints — space-less; App adds its own space. */
  controlCtx?: Omit<ControlCtx, "space">;
  name?: string;
}) {
  const [selected, setSelected] = useState<string | undefined>(space);

  // Build the observer lazily, once per selected space (App's useMesh owns start/stop). It stays
  // off the roster until the operator speaks (App's participant upgrade).
  const ep = useMemo(
    () => (selected === undefined ? null : openObserver({ space: selected, server, auth, name, operator: true })),
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
      canControl={canControl}
      controlCtx={controlCtx}
      makeParticipant={auth.creds || auth.user ? undefined : () => makeParticipant(ep, server)}
    />
  );
}
