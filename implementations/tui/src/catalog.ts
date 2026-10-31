import {
  homeCotalDir,
  isMeshRegistryError,
  loadPreparedSpaces,
  preparedSpacesDir,
  readCurrent,
  readMeshRegistry,
  type MeshEntry,
} from "@cotal-ai/workspace"

/** One row of the local machine catalog, as the tree shows it. Only display fields are kept: a
 *  registration also holds user-auth and catalog metadata the shell has no use for. */
export type Entry =
  | { kind: "space"; space: string; mode: MeshEntry["mode"]; origin: NonNullable<MeshEntry["origin"]>; server: string; root: string }
  | { kind: "prepared"; space: string; root: string; preparedAt: string }
  | { kind: "unusable"; source: string; message: string }

export type Catalog = { home: string; current?: string; entries: Entry[] }

/** Reads this machine's registrations offline: no broker is dialed and nothing is written. A record
 *  workspace refuses becomes an `unusable` entry naming it, so one damaged file never hides the
 *  rest. A prepared-space reader that refuses hides every prepared space, because workspace reads
 *  that directory all or nothing. */
export function readCatalog(): Catalog {
  const entries: Entry[] = []
  const refuse = (source: string, e: unknown) => entries.push({ kind: "unusable", source, message: (e as Error).message })

  try {
    const registry = readMeshRegistry()
    for (const m of registry.entries)
      entries.push({ kind: "space", space: m.space, mode: m.mode, origin: m.origin ?? "up", server: m.server, root: m.root })
    for (const e of registry.unusable) refuse(e.file, e)
  } catch (e) {
    if (!isMeshRegistryError(e)) throw e
    refuse(e.file, e)
  }

  try {
    for (const p of loadPreparedSpaces()) entries.push({ kind: "prepared", space: p.space, root: p.root, preparedAt: p.ts })
  } catch (e) {
    refuse(preparedSpacesDir(), e)
  }

  let current: string | undefined
  try {
    current = readCurrent()
  } catch (e) {
    if (!isMeshRegistryError(e)) throw e
    refuse(e.file, e)
  }

  const rank = (e: Entry) => (e.kind === "unusable" ? 1 : 0)
  const key = (e: Entry) => (e.kind === "unusable" ? e.source : e.space)
  entries.sort((a, b) => rank(a) - rank(b) || key(a).localeCompare(key(b)))
  return { home: homeCotalDir(), current, entries }
}
