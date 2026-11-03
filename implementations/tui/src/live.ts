import { chatWildcard, DEV_OWNER, parsePrincipalKey, principalKey } from "@cotal-ai/core"
import { connectOrThrow, isCommandFailure, isConnectRefusal, oneLine, userViewAuth } from "@cotal-ai/workspace"
import { control, controlPs, type ControlClient, type ControlCtx, type ManagedRow } from "@cotal-ai/workspace/control"
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

/** What the space's managers last said about the seats they run, keyed by the seat's presence card id.
 *  A failed read is `unavailable` and stops the poll until the space reconnects. `partial` names the
 *  managers that did not answer, whose seats are missing from `byId`. */
export type Managed =
  | { phase: "loading" }
  | { phase: "rows"; byId: ReadonlyMap<string, ManagedRow>; readAt: number; partial?: string }
  | { phase: "unavailable"; reason: string }

export type StopResult = { ok: true } | { ok: false; error: string }

export type Session = {
  conn: Accessor<Conn>
  managed: Accessor<Managed>
  /** Asks the seat's manager to stop the agent by name. Graceful lets it shut down; otherwise the
   *  manager kills the process. */
  stop: (name: string, graceful: boolean) => Promise<StopResult>
  close: () => Promise<void>
}

const OBSERVER_NAME = "tui"
const PS_POLL_MS = 10_000

// A manager names an open- or static-mode seat by its bare actor id, while its presence card carries
// the principal `local.<actor>`; a user-mode seat's id is already the principal.
const principalOf = (row: ManagedRow) => (parsePrincipalKey(row.id) ? row.id : principalKey(DEV_OWNER, row.id).key)

// MeshView hands out the same feed entry and presence objects until they change, so each is cleaned
// once and keeps its identity, and Solid redraws only rows that changed.
const clean = new WeakMap<object, unknown>()

/** Peers write names, activities and message text, and a control character in a cell reaches the
 *  terminal as is. Every string keeps its line breaks and tabs and shows any other control character
 *  as an escape. */
function safe<T>(value: T): T {
  if (typeof value === "object" && value !== null && clean.has(value)) return clean.get(value) as T
  if (typeof value === "string") return value.replace(/\r\n/g, "\n").split("\n").map((line) => line.split("\t").map(oneLine).join("\t")).join("\n") as T
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
  const [managed, setManaged] = createSignal<Managed>({ phase: "loading" })
  let view: MeshView | undefined
  let ctx: ControlCtx | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let reading = false
  let again = false
  let closed = false

  const client: ControlClient = {
    versionSkew: (detail, undeclared, managerVersion) =>
      `${detail}. The manager does not declare "${undeclared}", so it runs another Cotal release than this app${managerVersion ? ` (the manager reports ${managerVersion})` : " and did not report its version"}. Run both at the same release.`,
    roster: async () => view?.snapshot().agents ?? [],
  }

  // One read at a time, so an older answer never lands after a newer one. A poll tick during a read
  // is skipped; a refresh after a stop runs once the read in flight is done.
  const readManaged = async (refresh = false) => {
    if (!ctx || closed) return
    if (reading) return void (again ||= refresh)
    reading = true
    try {
      do {
        again = false
        const r = await controlPs(client, ctx, { readOnly: true })
        if (closed) return
        if (!r.ok) {
          clearInterval(timer)
          timer = undefined
          return void setManaged({ phase: "unavailable", reason: safe(r.error) })
        }
        const missing = [...r.failed.map((f) => `${f.instanceId}: ${f.error}`), ...(r.silent.length ? [`${r.silent.length} manager(s) gave no answer: ${r.silent.join(", ")}`] : [])]
        setManaged({ phase: "rows", byId: new Map(r.rows.map((row) => [principalOf(row), safe(row)])), readAt: Date.now(), ...(missing.length ? { partial: safe(missing.join("; ")) } : {}) })
      } while (again)
    } finally {
      reading = false
    }
  }
  const poll = () => {
    if (timer || !ctx || closed) return
    void readManaged()
    timer = setInterval(() => void readManaged(), PS_POLL_MS)
  }

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
        if (raw.status.connected && conn().phase === "reconnecting") poll()
        const mesh = safe(raw)
        const at = { space: c.space, server: c.server, mesh }
        setConn(raw.status.connected ? { phase: "live", ...at } : { phase: "reconnecting", ...at, ...(mesh.status.error ? { reason: mesh.status.error } : {}) })
      }
      v.on("change", show)
      show(v.snapshot())
      ctx = { space: c.space, server: c.server }
      poll()
    } catch (e) {
      if (!closed) setConn(failed(space, e))
    }
  })()

  return {
    conn,
    managed,
    stop: async (name, graceful) => {
      if (!ctx) return { ok: false, error: "the space is not open yet" }
      const r = await control(client, ctx, "stop", { name, graceful })
      if (!r.ok) return { ok: false, error: safe(r.error ?? "failed") }
      void readManaged(true)
      return { ok: true }
    },
    close: async () => {
      if (closed) return
      closed = true
      clearInterval(timer)
      setConn({ phase: "closed", space: conn().space })
      await view?.stop()
    },
  }
}
