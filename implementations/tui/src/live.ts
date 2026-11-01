import { chatWildcard } from "@cotal-ai/core"
import { connectOrThrow, isCommandFailure, isConnectRefusal, oneLine, userViewAuth } from "@cotal-ai/workspace"
import { MeshView, openObserver, type MeshSnapshot } from "@cotal-ai/workspace/view"
import { createSignal, type Accessor } from "solid-js"

export type Mesh = MeshSnapshot
export type Presence = Mesh["agents"][number]
export type { FeedEntry } from "@cotal-ai/workspace/view"

/** The app's connection to one space. `live` needs both the broker socket and the Cotal bind; when
 *  either drops the endpoint re-establishes on its own, so that is `reconnecting`, with the last
 *  model kept on screen. `closed` is the app letting go; `failed` never retries. */
export type Conn =
  | { phase: "connecting"; space?: string }
  | { phase: "live"; space: string; server: string; mesh: Mesh }
  | { phase: "reconnecting"; space: string; server: string; mesh: Mesh; reason?: string }
  | { phase: "closed"; space?: string }
  | { phase: "failed"; space?: string; message: string; remedy?: string }

export type Session = { conn: Accessor<Conn>; close: () => Promise<void> }

const OBSERVER_NAME = "tui"

// MeshView hands out the same feed entry and presence objects until they change, so each is cleaned
// once and keeps its identity, and Solid redraws only rows that changed.
const clean = new WeakMap<object, unknown>()

/** Peers write names, activities and message text, and a control character in a cell reaches the
 *  terminal as is. Every string keeps its line breaks and shows any other control character as an
 *  escape. */
function safe<T>(value: T): T {
  if (typeof value === "object" && value !== null && clean.has(value)) return clean.get(value) as T
  if (typeof value === "string") return value.replace(/\r\n/g, "\n").split("\n").map(oneLine).join("\n") as T
  if (typeof value === "function") return ((...args: unknown[]) => safe((value as (...a: unknown[]) => unknown)(...args))) as T
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(safe) as T
  const out = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, safe(v)])) as T
  clean.set(value, out)
  return out
}

function failed(space: string | undefined, e: unknown): Conn {
  const f = isConnectRefusal(e) ? e.failure() : isCommandFailure(e) ? e : undefined
  return { phase: "failed", space, message: safe(f?.message ?? (e as Error).message), ...(f?.remedy ? { remedy: safe(f.remedy) } : {}) }
}

/** Opens one space read-only: the space named, or with none the one every command in this folder
 *  would pick. The observer is invisible to peers and nothing is written to the registry. */
export function openSpace(space?: string): Session {
  const [conn, setConn] = createSignal<Conn>({ phase: "connecting", space })
  let view: MeshView | undefined
  let closed = false

  void (async () => {
    try {
      const c = await connectOrThrow(space === undefined ? {} : { space }, "admin", { readOnly: true })
      if (closed) return
      const user = c.bearer ? await userViewAuth(c, "admin") : undefined
      if (closed) return
      const ep = openObserver({ space: c.space, server: c.server, name: OBSERVER_NAME, auth: user ? { user } : { creds: c.creds } })
      const v = new MeshView(ep, { tapSubject: c.creds || user ? chatWildcard(c.space) : undefined })
      view = v
      await v.start()
      if (closed) return void (await v.stop())
      const show = (raw: Mesh) => {
        if (closed) return
        const mesh = safe(raw)
        const at = { space: c.space, server: c.server, mesh }
        setConn(raw.status.connected ? { phase: "live", ...at } : { phase: "reconnecting", ...at, ...(mesh.status.error ? { reason: mesh.status.error } : {}) })
      }
      v.on("change", show)
      show(v.snapshot())
    } catch (e) {
      if (!closed) setConn(failed(space, e))
    }
  })()

  return {
    conn,
    close: async () => {
      if (closed) return
      closed = true
      setConn({ phase: "closed", space: conn().space })
      await view?.stop()
    },
  }
}
