import { useMemo, useState } from "react";
import { CotalEndpoint, chatWildcard } from "@cotal-ai/core";
import type { MeshEntry } from "@cotal-ai/workspace";
import { App } from "./app.js";
import { MeshPicker } from "./ui/MeshPicker.js";
import { SpacePicker } from "./ui/SpacePicker.js";

/** The read-only observer the console watches a space through — invisible to peers. Built once
 *  per selected space (the picker can switch spaces at runtime). */
export function makeObserver(
  space: string,
  server: string,
  creds?: string,
  name = "console",
): CotalEndpoint {
  const ep = new CotalEndpoint({
    space,
    servers: server,
    creds,
    channels: [],
    consume: false, // observer: reads via tap + history + presence-watch, binds no durables
    registerPresence: false, // invisible on the roster; sent messages still carry `name` as `from`
    watchPresence: true,
    card: { name, kind: "endpoint" },
  });
  ep.on("error", () => {});
  return ep;
}

/** A picked mesh's live connection — what {@link Root}'s `enterMesh` resolves a registry entry
 *  to. `space` set means the mesh pins one (auth); undefined opens its space overview. */
export interface MeshConn {
  server: string;
  creds?: string;
  space?: string;
  canWrite: boolean;
}

/**
 * Console root. Two entry modes:
 *  • **Resolved** (`server` given — explicit flags, or a single registered mesh): with a fixed
 *    `space` it goes straight into the per-space console; without one (open mesh) the space
 *    overview shows first.
 *  • **Registry** (`meshes` + `enterMesh` given — several meshes, bare invocation): the mesh
 *    overview shows first; picking one connects and drills in — its space overview on an open
 *    broker, its one pinned space under auth.
 * Each level's back (`b`) tears down to the one above; `key={space}` forces a clean MeshView
 * remount per selected space.
 */
export function Root({
  server,
  creds,
  space,
  canWrite,
  name,
  meshes,
  enterMesh,
}: {
  server?: string;
  creds?: string;
  space?: string;
  canWrite?: boolean;
  name?: string;
  /** Registry mode: the meshes to pick from (mutually exclusive with `server`). */
  meshes?: MeshEntry[];
  /** Registry mode: connect to a picked mesh — rejects with the rendered one-line error. */
  enterMesh?: (m: MeshEntry) => Promise<MeshConn>;
}) {
  const [conn, setConn] = useState<MeshConn | undefined>(
    server === undefined ? undefined : { server, creds, space, canWrite: canWrite ?? true },
  );
  const [selected, setSelected] = useState<string | undefined>(space);

  // Build the observer lazily, once per selected space (App's useMesh owns start/stop).
  const ep = useMemo(
    () =>
      selected === undefined || conn === undefined
        ? null
        : makeObserver(selected, conn.server, conn.creds, name),
    [selected, conn, name],
  );

  if (conn === undefined)
    return (
      <MeshPicker
        meshes={meshes ?? []}
        onSelect={async (m) => {
          const c = await enterMesh!(m);
          setConn(c);
          setSelected(c.space);
        }}
      />
    );

  const backToMeshes =
    meshes === undefined
      ? undefined
      : () => {
          setConn(undefined);
          setSelected(undefined);
        };

  if (selected === undefined || ep === null)
    return (
      <SpacePicker
        server={conn.server}
        creds={conn.creds}
        canWrite={conn.canWrite}
        onSelect={setSelected}
        onBack={backToMeshes}
      />
    );

  return (
    <App
      key={selected}
      ep={ep}
      tapSubject={conn.creds ? chatWildcard(selected) : undefined}
      // A pinned space (explicit --space, or the auth mesh's one space) has no space overview to
      // return to — back goes to the mesh overview when there is one, else nowhere.
      onBack={conn.space === undefined ? () => setSelected(undefined) : backToMeshes}
      canWrite={conn.canWrite}
    />
  );
}
