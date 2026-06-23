import { loadMeshes, probeConnect, removeMesh } from "@cotal-ai/core";

/**
 * Drop registry entries whose broker is gone — a `cotal up` that crashed or was `kill -9`'d without
 * `cotal down` leaves a record behind. Probe each in parallel; only `unreachable` (refused/timeout)
 * is stale, an auth broker answering `auth-required` is alive. Called by `spawn`/`use`/`meshes`
 * before they act on the registry — never by completion (a `<TAB>` must not open the network).
 */
export async function pruneStaleMeshes(): Promise<void> {
  await Promise.all(
    loadMeshes().map(async (m) => {
      const r = await probeConnect(m.server);
      if (!r.ok && r.reason === "unreachable") removeMesh(m.space);
    }),
  );
}
